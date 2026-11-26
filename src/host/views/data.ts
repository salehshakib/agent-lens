import { basename } from 'node:path';
import type { Provider } from '../adapters/types';
import type { ChatScope, CompactMeasurement } from '../chat/types';
import { projectChatStatus } from './chat-status';
import { displayRecordedChatRow } from '../chat/session';
import type { ChatPresentation } from '../chat/session';
import { safeText } from '../privacy/projection';
import { profileKey } from '../accounts/profiles';
import { buildAccounts, profileOptions } from '../accounts/view';
import { limitSamples as relaySamples, relayContext } from '../limits/claude-relay';
import type { RelaySnapshot } from '../limits/claude-relay';
import { buildGauges } from '../limits/model';
import type { Gauge, LimitSample } from '../limits/model';
import type { RefreshGate } from '../limits/refresh';
import type { Session } from '../sessions/types';
import { pathKey } from '../discovery/local-path';
import type { Thresholds } from './signal-models';
import type { UsageTotal } from '../usage/ledger';
import type {
  ChatRow, ChatView, Filters, GaugeView, PanelModel, ParentInfo, RelayView, SessionDetail, SessionRow, SidebarModel, SourceView,
  UsageFilters, UsageModel,
} from '../../shared/protocol';
import {
  buildDetail, buildTasks, buildTree, buildUsage, earlierPage, filterOptions, gaugeView, namesFor, providerLabels,
} from './models';
import { laneContext, parentInfo } from './signal-models';
import { directAgentEdges, projectTranscript } from './chat-transcript';
import type { AgentEdge, AgentScope, TranscriptRow } from './chat-transcript';
import { chatContextEvidence } from './chat-cards';
import type { ContextCandidate } from './alerts';

export interface ProfileInfo {
  provider: Provider;
  id: string;
  label: string;
  /** Canonical home folder of the profile. */
  home: string;
}

export interface LensDeps {
  sessions(): Promise<readonly Session[]>;
  usageTotals(): UsageTotal[];
  limitSamples(): LimitSample[];
  now(): number;
  timeZone?: string;
  privateMode(): boolean;
  profiles(): ProfileInfo[];
  /** The user home folder, shortened to a tilde in the Accounts view. */
  userHome: string;
  /** Cached relay snapshots and samples for one Claude profile id. */
  relay(profileId: string): { snapshots: RelaySnapshot[]; samples: LimitSample[] };
  relayViews(): RelayView[];
  sources(): SourceView[];
  refresh(): RefreshGate;
  /** Context level thresholds from settings. The defaults apply when absent. */
  thresholds?(): Thresholds;
  canContinue?(session: Session): boolean;
}

export interface RootAgentProjection {
  limit: number;
  snapshotStartRow?: string;
  detailFocus?: { lane: string; row: string };
  loadEarlier(): boolean;
  issueEdge(edge: AgentEdge): string | undefined;
}

export interface AgentGraph {
  sessions: readonly Session[];
  root?: AgentScope;
  edges: readonly AgentEdge[];
  now: number;
  privateMode: boolean;
}

/** Builds every view model from host state. It holds only paging state, never provider data. */
export class LensData {
  private readonly earlierLimits = new Map<string, number>();

  constructor(private readonly deps: LensDeps) {}

  loadOlder(project: string): void {
    if (!/^[a-f0-9]{16}$/.test(project)) return;
    this.earlierLimits.set(project, (this.earlierLimits.get(project) ?? earlierPage) + earlierPage);
  }

  gauges(): { main: Gauge[]; other: Gauge[]; samples: LimitSample[] } {
    const profiles = this.deps.profiles();
    const samples = [
      ...this.deps.limitSamples(),
      ...profiles.filter(profile => profile.provider === 'claude-code').flatMap(profile => this.deps.relay(profile.id).samples),
    ];
    const built = buildGauges(profiles.map(profile => ({ provider: profile.provider, profile: profile.id })), samples, this.deps.now());
    return { ...built, samples };
  }

  private views(gauges: readonly Gauge[]): GaugeView[] {
    const labels = new Map(this.deps.profiles().map(profile => [profile.provider + '\n' + profile.id, profile.label]));
    return gauges.map(gauge => ({ ...gaugeView(gauge), profile: labels.get(gauge.provider + '\n' + gauge.profile) ?? gauge.profile }));
  }

  chatGauges(scope: ChatScope | undefined, session: Session | undefined): GaugeView[] {
    const provider = session ? session.provider : scope?.provider;
    const id = session ? session.profile : scope?.profile;
    const profile = this.deps.profiles().find(item => item.provider === provider && item.id === id
      && (!scope || (scope.provider === item.provider && scope.profile === item.id && pathKey(scope.home) === pathKey(item.home))));
    if (!profile) return [];
    const observed = this.deps.limitSamples().filter(sample => sample.provider === profile.provider && sample.profile === profile.id);
    const relay = profile.provider === 'claude-code' ? this.deps.relay(profile.id) : undefined;
    const statusLine = relay ? relaySamples(relay.snapshots, profile.id) : [];
    const { main } = buildGauges([{ provider: profile.provider, profile: profile.id }], [...observed, ...relay?.samples ?? []], this.deps.now());
    return main.map(gauge => {
      const match = (sample: LimitSample) => sample.minutes === gauge.minutes && sample.at === gauge.observedAt
        && sample.resetsAt === gauge.resetsAt && (gauge.percent === undefined || sample.usedPercent === gauge.percent);
      const fromChat = relay?.samples.some(sample => sample.source === 'chat' && match(sample));
      const source = gauge.observedAt === undefined ? undefined : statusLine.some(match) ? 'Status-line relay'
        : observed.some(match) ? 'Recorded runtime observation' : fromChat ? 'Chat turn event' : 'Agent Lens limits refresh';
      return { ...gaugeView(gauge), profile: profile.label, source };
    });
  }

  chatContext(session: Session, detail: SessionDetail, scope: ChatScope | undefined, laneId?: string, compact?: CompactMeasurement) {
    const lane = laneId ? session.lanes.find(item => item.id === laneId) : session.lanes[0];
    if (!lane) return undefined;
    const profile = this.deps.profiles().find(item => item.provider === 'claude-code' && item.id === session.profile);
    const relay = session.provider === 'claude-code' && lane === session.lanes[0] && profile
      && (!scope || pathKey(scope.home) === pathKey(profile.home))
      ? relayContext(this.deps.relay(profile.id).snapshots, session.nativeId, this.deps.now()) : undefined;
    return chatContextEvidence(session, lane, detail.lanes.find(item => item.id === lane.id)?.label ?? 'Main lane',
      relay, this.deps.thresholds?.(), compact);
  }

  /** Providers shown in the quota rows. A provider without a profile is skipped. */
  liveCount(sessions: readonly Session[]): number {
    return sessions.filter(session => session.status === 'Live').length;
  }

  /** Fresh status-line context samples for Claude sessions, by session id. */
  private relayContexts(sessions: readonly Session[]): Map<string, { percent: number; at: number }> {
    const found = new Map<string, { percent: number; at: number }>();
    const snapshots = new Map<string, RelaySnapshot[]>();
    const profiles = new Map(this.deps.profiles().filter(profile => profile.provider === 'claude-code').map(profile => [profile.id, profile]));
    for (const session of sessions) {
      if (session.provider !== 'claude-code' || !session.profile || !profiles.has(session.profile)) continue;
      let cached = snapshots.get(session.profile);
      if (!cached) snapshots.set(session.profile, cached = this.deps.relay(session.profile).snapshots);
      const context = relayContext(cached, session.nativeId, this.deps.now());
      if (context?.percent !== undefined) found.set(session.id, { percent: context.percent, at: context.at });
    }
    return found;
  }

  async sidebar(filters: Filters): Promise<SidebarModel> {
    const sessions = await this.deps.sessions();
    const privateMode = this.deps.privateMode();
    const profiles = this.deps.profiles();
    const { tree, total } = buildTree(sessions, {
      now: this.deps.now(), timeZone: this.deps.timeZone, privateMode, filters, earlierLimits: this.earlierLimits,
      relayContexts: new Map([...this.relayContexts(sessions)].map(([id, sample]) => [id, sample.percent])),
      thresholds: this.deps.thresholds?.(),
      profileLabels: new Map(profiles.map(profile => [profileKey(profile.provider, profile.id), profile.label])),
    });
    const { adapters, projects } = filterOptions(sessions);
    if (this.deps.canContinue) {
      const eligible = new Set(sessions.filter(this.deps.canContinue).map(session => session.id));
      function mark(rows: SessionRow[]): void {
        for (const row of rows) {
          if (eligible.has(row.id)) row.continueChat = true;
          mark(row.children);
        }
      }
      for (const project of tree) for (const group of project.groups) mark(group.rows);
    }
    return {
      gauges: this.views(this.gauges().main), liveCount: this.liveCount(sessions),
      backgroundCount: buildTasks(sessions, privateMode).filter(task => task.status === 'Live' || task.status === 'Waiting').length,
      adapters, projects, tree, sources: this.deps.sources(), profiles: profileOptions(profiles, sessions),
      accounts: buildAccounts({ profiles, sessions, totals: this.deps.usageTotals(), userHome: this.deps.userHome }),
      relays: this.deps.relayViews(), refresh: this.deps.refresh(),
      filters, privateMode, total,
    };
  }

  async detail(id: string): Promise<PanelModel> {
    return this.detailFrom(await this.deps.sessions(), id, this.deps.privateMode());
  }

  private detailFrom(sessions: readonly Session[], id: string, privateMode: boolean, focus?: RootAgentProjection['detailFocus']): PanelModel {
    const session = sessions.find(item => item.id === id);
    if (!session) return { mode: 'empty', message: 'This session is no longer available. It may have been removed or its source is disabled.' };
    const profiles = this.deps.profiles();
    const profile = profiles.find(item => item.provider === 'claude-code' && item.id === session.profile);
    const named = profiles.find(item => item.provider === session.provider && item.id === session.profile);
    const several = profiles.filter(item => item.provider === session.provider).length > 1;
    const snapshots = profile ? this.deps.relay(profile.id).snapshots : [];
    const context = session.provider === 'claude-code' ? relayContext(snapshots, session.nativeId, this.deps.now()) : undefined;
    return { mode: 'session', session: buildDetail(session, sessions, {
      now: this.deps.now(), privateMode, focus, relayContext: context?.percent,
      thresholds: this.deps.thresholds?.(),
      profileLabel: named && (several || named.id !== 'default') ? named.label : undefined,
    }) };
  }

  privateDisplay(): boolean {
    return this.deps.privateMode();
  }

  private approvedAgentSessions(snapshot: readonly Session[]): Session[] {
    const approved = new Set(this.deps.profiles().map(profile => profileKey(profile.provider, profile.id)));
    return snapshot.filter(session => !session.profile || approved.has(profileKey(session.provider, session.profile)));
  }

  /** Follow the exact offered edge IDs from the main lane using a fresh approved source snapshot. */
  async agentGraph(id: string, path: readonly string[]): Promise<AgentGraph> {
    const sessions = this.approvedAgentSessions(await this.deps.sessions());
    const lane = sessions.find(session => session.id === id)?.lanes[0];
    const root = lane && { sessionId: id, laneId: lane.id };
    const edges: AgentEdge[] = [];
    let parent: AgentScope | undefined = root;
    const visited = new Set(root ? [agentScopeKey(root)] : []);
    for (const edgeId of path) {
      if (!parent) break;
      const edge = directAgentEdges(sessions, parent).find(candidate => candidate.id === edgeId);
      if (!edge || visited.has(agentScopeKey(edge.target))) break;
      visited.add(agentScopeKey(edge.target));
      edges.push(edge);
      parent = edge.target;
    }
    return { sessions, root, edges, now: this.deps.now(), privateMode: this.deps.privateMode() };
  }

  async chat(
    key: string, id: string | undefined, scope: ChatScope | undefined,
    view: (presentation: ChatPresentation) => ChatView | undefined, reason?: string, reader?: RootAgentProjection,
  ): Promise<PanelModel> {
    const sessions = id ? await this.deps.sessions() : [];
    const privateMode = this.deps.privateMode();
    const detail = id ? this.detailFrom(sessions, id, privateMode, reader?.detailFocus) : undefined;
    const session = detail?.mode === 'session' ? detail.session : undefined;
    const raw = id ? sessions.find(item => item.id === id) : undefined;
    const history: TranscriptRow[] = session ? projectTranscript(session, raw?.files ?? [], privateMode, {
      sessions: this.approvedAgentSessions(sessions), now: this.deps.now(), limit: reader?.limit,
      snapshotStartRow: reader?.snapshotStartRow, issueEdge: reader?.issueEdge,
    }) : [];
    const profile = scope && this.deps.profiles().find(item => item.provider === scope.provider && item.id === scope.profile);
    const presentation: ChatPresentation = {
      title: session?.title ?? (id ? 'Session' : 'New chat'),
      project: session?.project ?? (scope ? safeText(basename(scope.cwd), 100) : undefined),
      provider: session?.provider ?? (scope ? providerLabels[scope.provider] : undefined),
      profile: profile?.label ?? session?.profile,
      privateMode, history, reason, sessionId: id, loadEarlier: reader?.loadEarlier(),
    };
    const chat = view(presentation) ?? {
      key, title: presentation.title, project: presentation.project, provider: presentation.provider, profile: presentation.profile,
      privateMode, rows: history.map(row => displayRecordedChatRow(row, privateMode)), draft: '', revision: 0, state: 'view-only',
      reason: reason ?? (detail?.mode === 'empty' ? detail.message : 'This recorded session is available for inspection.'),
      canSend: false, canContinue: false, canInterrupt: false, canRetry: false, canChooseScope: false,
    };
    chat.status = projectChatStatus({
      chat, gauges: this.chatGauges(scope, raw), now: this.deps.now(),
      context: raw && session ? this.chatContext(raw, session, scope) : undefined,
      tokens: raw?.usage?.total, tokensScope: raw?.usageScope ? 'Scope: ' + raw.usageScope : undefined,
    });
    return { mode: 'chat', chat, id, session };
  }

  /** Every lane that currently has a High or Critical context level, for the optional alerts. */
  async contextCandidates(): Promise<ContextCandidate[]> {
    const sessions = await this.deps.sessions();
    const relays = this.relayContexts(sessions);
    const names = namesFor(this.deps.privateMode());
    const found: ContextCandidate[] = [];
    for (const session of sessions) {
      for (const lane of session.lanes) {
        const relay = lane === session.lanes[0] ? relays.get(session.id) : undefined;
        const context = laneContext(session, lane, relay?.percent, this.deps.thresholds?.());
        if (!context.level) continue;
        found.push({ sessionId: session.id, laneId: lane.id,
          title: names.session(session) + (lane === session.lanes[0] || this.deps.privateMode() ? '' : ', ' + (safeText(lane.title, 60) ?? 'agent')),
          level: context.level, percent: context.percent, approximate: context.approximate,
          at: relay?.at ?? lane.context?.at, epoch: lane.rows.filter(row => row.kind === 'compact').length });
      }
    }
    return found;
  }

  /** Parent targets of a lane, newest first. An empty lane id means the session's main lane. */
  async parent(sessionId: string, laneId: string): Promise<ParentInfo> {
    const sessions = await this.deps.sessions();
    const session = sessions.find(item => item.id === sessionId);
    const lane = session && (laneId ? session.lanes.find(item => item.id === laneId) : session.lanes[0]);
    if (!session || !lane) return { state: 'unresolved', reason: 'This session is no longer available.', targets: [] };
    return parentInfo(session, lane, new Map(sessions.map(item => [item.id, item])), namesFor(this.deps.privateMode()));
  }

  async tasks(): Promise<PanelModel> {
    return { mode: 'tasks', tasks: buildTasks(await this.deps.sessions(), this.deps.privateMode()), privateMode: this.deps.privateMode() };
  }

  async usage(filters: UsageFilters): Promise<PanelModel> {
    const sessions = await this.deps.sessions();
    const { main, other } = this.gauges();
    const { adapters, projects } = filterOptions(sessions);
    const usage: UsageModel = {
      gauges: this.views(main), otherGauges: this.views(other), filters, projects, adapters,
      ...buildUsage({ now: this.deps.now(), timeZone: this.deps.timeZone, filters, totals: this.deps.usageTotals(), sessions }),
      relays: this.deps.relayViews(), refresh: this.deps.refresh(),
    };
    return { mode: 'usage', usage };
  }
}

export function agentScopeKey(scope: AgentScope): string {
  return JSON.stringify([scope.sessionId, scope.laneId, scope.turnId]);
}

/** Compact provider quota text for the status bar. */
export function providerQuota(gauges: readonly Gauge[], provider: Provider): { text: string; tooltip: string } | undefined {
  const own = gauges.filter(gauge => gauge.provider === provider);
  if (!own.length) return undefined;
  const label = providerLabels[provider];
  const parts = own.slice(0, 2).map(gauge => gauge.label + ' ' + (gauge.percent === undefined ? '-' : Math.round(gauge.percent) + '%'));
  const tooltip = own.slice(0, 2).map(gauge => label + ' ' + gauge.label + ': ' +
    (gauge.percent === undefined ? 'no data. ' + gauge.reason : Math.round(gauge.percent) + '% used. ' + gauge.reason)).join('\n');
  return { text: (provider === 'codex' ? 'Codex ' : 'Claude ') + parts.join(' '), tooltip };
}
