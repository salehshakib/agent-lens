import type { Provider } from '../adapters/types';
import { profileKey } from '../accounts/profiles';
import { buildAccounts, profileOptions } from '../accounts/view';
import { relayContext } from '../limits/claude-relay';
import type { RelaySnapshot } from '../limits/claude-relay';
import { buildGauges } from '../limits/model';
import type { Gauge, LimitSample } from '../limits/model';
import type { RefreshGate } from '../limits/refresh';
import type { Session } from '../sessions/types';
import type { UsageTotal } from '../usage/ledger';
import type {
  Filters, GaugeView, PanelModel, RelayView, SidebarModel, SourceView, UsageFilters, UsageModel,
} from '../../shared/protocol';
import {
  buildDetail, buildTasks, buildTree, buildUsage, earlierPage, filterOptions, gaugeView, providerLabels,
} from './models';

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

  /** Providers shown in the quota rows. A provider without a profile is skipped. */
  liveCount(sessions: readonly Session[]): number {
    return sessions.filter(session => session.status === 'Live').length;
  }

  async sidebar(filters: Filters): Promise<SidebarModel> {
    const sessions = await this.deps.sessions();
    const privateMode = this.deps.privateMode();
    const profiles = this.deps.profiles();
    const { tree, total } = buildTree(sessions, {
      now: this.deps.now(), timeZone: this.deps.timeZone, privateMode, filters, earlierLimits: this.earlierLimits,
      profileLabels: new Map(profiles.map(profile => [profileKey(profile.provider, profile.id), profile.label])),
    });
    const { adapters, projects } = filterOptions(sessions);
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
    const sessions = await this.deps.sessions();
    const session = sessions.find(item => item.id === id);
    if (!session) return { mode: 'empty', message: 'This session is no longer available. It may have been removed or its source is disabled.' };
    const profiles = this.deps.profiles();
    const profile = profiles.find(item => item.provider === 'claude-code' && item.id === session.profile);
    const named = profiles.find(item => item.provider === session.provider && item.id === session.profile);
    const several = profiles.filter(item => item.provider === session.provider).length > 1;
    const snapshots = profile ? this.deps.relay(profile.id).snapshots : [];
    const context = session.provider === 'claude-code' ? relayContext(snapshots, session.nativeId, this.deps.now()) : undefined;
    return { mode: 'session', session: buildDetail(session, sessions, {
      now: this.deps.now(), privateMode: this.deps.privateMode(), relayContext: context?.percent,
      profileLabel: named && (several || named.id !== 'default') ? named.label : undefined,
    }) };
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
