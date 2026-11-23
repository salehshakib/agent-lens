import { createHash } from 'node:crypto';
import type { Provider } from '../adapters/types';
import type { Gauge } from '../limits/model';
import { safeText } from '../privacy/projection';
import { mergeTimeline } from '../sessions/items';
import type { BackgroundTask, FileAction, Lane, Session, State, TimelineRow, TokenCounts } from '../sessions/types';
import type { UsageTotal } from '../usage/ledger';
import type {
  AgentNode, AgentRow, DayBar, FileGroup, FilterOption, Filters, GaugeView, GroupNode, ModelRow, ProjectNode,
  RowView, SessionDetail, SessionRow, StatusTone, TaskView, TokenRow, ToolView, UsageFilters, UsageModel, UsageView,
} from '../../shared/protocol';

export const providerLabels: Record<Provider, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const maxText = 20_000;
const maxRows = 1500;
const maxTools = 60;
const maxDepth = 4;
const maxAgentRows = 8;
export const earlierPage = 20;

export function toneFor(state: State): StatusTone {
  switch (state) {
    case 'Live': return 'live';
    case 'Completed': return 'ok';
    case 'Failed': return 'fail';
    case 'Interrupted':
    case 'Aborted':
    case 'Stopped':
    case 'Waiting': return 'warn';
    default: return 'neutral';
  }
}

export function projectId(session: Pick<Session, 'project' | 'id'>): string {
  return createHash('sha256').update(session.project ?? 'unknown').digest('hex').slice(0, 16);
}

export function projectLabel(session: Pick<Session, 'projectRoot' | 'cwd'>): string {
  const path = session.projectRoot ?? session.cwd;
  const segment = path?.split(/[\\/]/).filter(Boolean).pop();
  return safeText(segment, 80) ?? 'Unknown project';
}

function title(session: Session, privateMode: boolean): string {
  if (privateMode) return providerLabels[session.provider] + ' session';
  return safeText(session.title, 160)?.replace(/\s+/g, ' ') ?? 'Untitled session';
}

/** Local calendar day, YYYY-MM-DD, in the given IANA time zone or the host's. */
export function localDay(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return get('year') + '-' + get('month') + '-' + get('day');
}

export interface TreeOptions {
  now: number;
  timeZone?: string;
  privateMode: boolean;
  filters: Filters;
  /** Loaded Earlier rows per project id. */
  earlierLimits: ReadonlyMap<string, number>;
  pageSize?: number;
}

function matchesSearch(session: Session, search: string, privateMode: boolean): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  const haystack = [privateMode ? '' : session.title, projectLabel(session), providerLabels[session.provider],
    session.branch ?? ''].join('\n').toLowerCase();
  return haystack.includes(needle);
}

function parentOf(session: Session): string | undefined {
  return session.parents.find(edge => edge.relation === 'child' || edge.relation === 'launch')?.sessionId
    ?? session.lanes[0]?.parentSessionId;
}

function agentRows(session: Session): AgentRow[] {
  return session.lanes.slice(1, 1 + maxAgentRows).map(lane => ({
    title: safeText(lane.title, 80) ?? 'Agent',
    status: lane.pending ? 'Pending' : lane.status,
    tone: lane.pending ? 'neutral' : toneFor(lane.status),
  }));
}

function sessionRow(session: Session, privateMode: boolean, children: SessionRow[], project?: string): SessionRow {
  return {
    id: session.id, provider: providerLabels[session.provider], title: title(session, privateMode), status: session.status,
    tone: toneFor(session.status), updatedAt: session.updatedAt, project, agents: agentRows(session), children,
  };
}

/** Build the project tree: project, then Live, Today and Earlier, with children nested under their parent. */
export function buildTree(sessions: readonly Session[], options: TreeOptions): { tree: ProjectNode[]; total: number } {
  const { filters } = options;
  const visible = sessions.filter(session =>
    (!filters.adapter || session.provider === filters.adapter) &&
    (!filters.project || projectId(session) === filters.project) &&
    matchesSearch(session, filters.search.trim(), options.privateMode));
  const byId = new Map(visible.map(session => [session.id, session]));
  const childrenOf = new Map<string, Session[]>();
  const nested = new Set<string>();
  for (const session of visible) {
    const parent = parentOf(session);
    if (!parent || parent === session.id || !byId.has(parent)) continue;
    // Reject a cycle by walking up from the candidate parent.
    let cursor: string | undefined = parent;
    let cyclic = false;
    for (let hops = 0; cursor && hops < 16; hops++) {
      if (cursor === session.id) { cyclic = true; break; }
      cursor = byId.get(cursor) && parentOf(byId.get(cursor)!);
    }
    if (cyclic) continue;
    nested.add(session.id);
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), session]);
  }
  const rank = (a: Session, b: Session) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id);
  function build(session: Session, depth: number, parentProject: string): SessionRow {
    const own = projectId(session);
    const kids = depth >= maxDepth ? [] : (childrenOf.get(session.id) ?? []).sort(rank).map(child => build(child, depth + 1, own));
    return sessionRow(session, options.privateMode, kids, own === parentProject || !parentProject ? undefined : projectLabel(session));
  }
  const today = localDay(options.now, options.timeZone);
  const projects = new Map<string, { label: string; live: SessionRow[]; today: SessionRow[]; earlier: SessionRow[] }>();
  for (const session of [...visible].sort(rank)) {
    if (nested.has(session.id)) continue;
    const id = projectId(session);
    const entry = projects.get(id) ?? { label: projectLabel(session), live: [], today: [], earlier: [] };
    projects.set(id, entry);
    const row = build(session, 0, '');
    if (session.status === 'Live' || session.status === 'Waiting') entry.live.push(row);
    else if (session.updatedAt !== undefined && localDay(session.updatedAt, options.timeZone) === today) entry.today.push(row);
    else entry.earlier.push(row);
  }
  const page = options.pageSize ?? earlierPage;
  const tree: ProjectNode[] = [...projects.entries()].map(([id, entry]) => {
    const limit = Math.max(page, options.earlierLimits.get(id) ?? page);
    const groups: GroupNode[] = [];
    if (entry.live.length) groups.push({ key: 'live', label: 'Live', rows: entry.live, more: 0 });
    if (entry.today.length) groups.push({ key: 'today', label: 'Today', rows: entry.today, more: 0 });
    if (entry.earlier.length) {
      groups.push({ key: 'earlier', label: 'Earlier', rows: entry.earlier.slice(0, limit), more: Math.max(0, entry.earlier.length - limit) });
    }
    return { id, label: entry.label, groups };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return { tree, total: visible.length };
}

export function filterOptions(sessions: readonly Session[]): { adapters: FilterOption[]; projects: FilterOption[] } {
  const adapters = new Map<string, string>();
  const projects = new Map<string, string>();
  for (const session of sessions) {
    adapters.set(session.provider, providerLabels[session.provider]);
    projects.set(projectId(session), projectLabel(session));
  }
  const sort = (map: Map<string, string>) => [...map].map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { adapters: sort(adapters), projects: sort(projects) };
}

function clip(value: string | undefined): { text?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  const clean = safeText(value, maxText);
  if (clean === undefined) return { truncated: false };
  return { text: clean, truncated: clean.length > maxText };
}

function rowView(row: TimelineRow, lanes: ReadonlyMap<string, Lane>, privateMode: boolean): RowView {
  const text = privateMode ? { truncated: false } : clip(row.text);
  const output = privateMode ? { truncated: false } : clip(row.output);
  return {
    id: row.id, laneId: row.laneId, lane: lanes.get(row.laneId)?.title ?? 'Agent', at: row.at, kind: row.kind,
    label: safeText(row.label, 80) ?? 'Event', text: text.text, textTruncated: text.truncated || undefined,
    output: output.text, outputTruncated: output.truncated || undefined, status: row.status,
    command: privateMode ? undefined : safeText(row.command, 2000), exitCode: row.exitCode,
    durationMs: row.durationMs, file: row.file,
  };
}

const scopeText: Record<NonNullable<Lane['usageScope']>, string> = {
  response: 'recorded responses', turn: 'turn totals', thread: 'thread total', reported: 'reported total', last: 'last request',
};

function laneTokens(counts: TokenCounts | undefined): number | undefined {
  if (!counts) return undefined;
  if (counts.total !== undefined) return counts.total;
  const parts = [counts.input, counts.cacheRead, counts.cacheWrite, counts.output].filter((value): value is number => value !== undefined);
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : undefined;
}

function elapsed(lane: Lane, now: number): number | undefined {
  if (lane.startedAt === undefined) return undefined;
  const end = lane.status === 'Live' ? now : lane.updatedAt;
  return end === undefined ? undefined : Math.max(0, end - lane.startedAt);
}

function laneTools(session: Session, lane: Lane, privateMode: boolean): ToolView[] {
  const ranges = new Map(session.files.filter(file => file.laneId === lane.id && file.range)
    .map(file => [file.rowId, file.range!]));
  return lane.rows.filter(row => row.kind === 'tool').slice(-maxTools).map(row => {
    const range = ranges.get(row.id);
    return {
      name: safeText(row.label, 60) ?? 'Tool',
      target: row.file ?? (privateMode ? undefined : safeText(row.command, 120)?.split('\n')[0]),
      line: range ? 'lines ' + range.start + (range.count ? '-' + (range.start + range.count - 1) : '') : undefined,
    };
  });
}

function agentNode(session: Session, lane: Lane, opts: { now: number; privateMode: boolean; kind: AgentNode['kind'];
  id: string; parent?: string; parentTitle?: string; contextPercent?: number; contextApproximate?: boolean; note?: string }): AgentNode {
  const tokens = laneTokens(lane.usage);
  const status = lane.pending ? 'Pending' : lane.status;
  const context = lane.context;
  return {
    id: opts.id, laneId: lane.id, parent: opts.parent, title: safeText(lane.title, 100) ?? 'Agent', kind: opts.kind,
    status, tone: lane.pending ? 'neutral' : toneFor(lane.status), model: lane.model ?? session.model,
    elapsedMs: elapsed(lane, opts.now), tokens,
    tokenLabel: tokens === undefined ? 'tokens unavailable'
      : 'tokens used' + (lane.usageScope ? ' (' + scopeText[lane.usageScope] + ')' : ''),
    contextPercent: opts.contextPercent ?? context?.percent, contextApproximate: opts.contextPercent === undefined ? context?.approximate : false,
    parentTitle: opts.parentTitle, transcript: lane.transcriptAvailable === true, sessionId: session.id,
    tools: laneTools(session, lane, opts.privateMode), note: opts.note ?? lane.parentReason,
  };
}

export interface DetailOptions {
  now: number;
  privateMode: boolean;
  /** Relay context fill for the Claude main session, when fresh. */
  relayContext?: number;
}

function countsRow(label: string, counts: TokenCounts | undefined): TokenRow {
  return { label, input: counts?.input, cacheRead: counts?.cacheRead, cacheWrite: counts?.cacheWrite,
    output: counts?.output, reasoning: counts?.reasoning, total: counts?.total };
}

function usageView(session: Session): UsageView {
  const tokens = session.lanes.filter(lane => lane.usage).map(lane => countsRow(safeText(lane.title, 60) ?? 'Agent', lane.usage));
  if (session.usage) tokens.push(countsRow('Session', session.usage));
  return {
    tokens, partial: session.usagePartial === true || session.coverage === 'partial',
    scope: session.usageScope ? 'Counts are ' + scopeText[session.usageScope] + '.' : 'Scope not recorded.',
  };
}

function fileGroups(files: readonly FileAction[], lanes: ReadonlyMap<string, Lane>, privateMode: boolean): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const action of files) {
    const group = groups.get(action.path) ?? { path: action.path, read: 0, changed: 0, mentioned: 0, agents: [], items: [] };
    groups.set(action.path, group);
    if (action.kind === 'read') group.read++;
    else if (action.kind === 'mention' || action.kind === 'checkpoint') group.mentioned++;
    else group.changed++;
    const lane = safeText(lanes.get(action.laneId)?.title, 60) ?? 'Agent';
    if (!group.agents.includes(lane)) group.agents.push(lane);
    const hasDiff = !privateMode && action.diff !== undefined;
    group.openId = action.id;
    if (hasDiff) group.diffId = action.id;
    else if (!privateMode && action.diffUnavailable && !group.diffNote) group.diffNote = safeText(action.diffUnavailable, 120);
    if (group.items.length < 20) {
      group.items.push({ actionId: action.id, kind: action.kind, status: action.status, laneTitle: lane, hasDiff });
    }
  }
  for (const group of groups.values()) {
    if (group.diffId === undefined && group.changed > 0 && !group.diffNote) {
      group.diffNote = privateMode ? 'Diffs are hidden in private mode.' : 'No patch was recorded for this change.';
    }
  }
  return [...groups.values()];
}

export function buildTasks(sessions: readonly Session[], privateMode: boolean): TaskView[] {
  const tasks: TaskView[] = [];
  for (const session of sessions) {
    const lanes = new Map(session.lanes.map(lane => [lane.id, lane]));
    for (const task of session.background) tasks.push(taskView(session, task, lanes, privateMode));
  }
  return tasks.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id));
}

function taskView(session: Session, task: BackgroundTask, lanes: ReadonlyMap<string, Lane>, privateMode: boolean): TaskView {
  return {
    id: task.id, sessionId: session.id, title: privateMode ? 'Background task' : safeText(task.title, 120) ?? 'Background task',
    status: task.status, tone: toneFor(task.status), provider: providerLabels[session.provider], project: projectLabel(session),
    lane: safeText(lanes.get(task.laneId)?.title, 60) ?? 'Agent', at: task.at,
  };
}

function contextText(session: Session, relay: number | undefined): { percent?: number; approximate?: boolean; text: string } {
  if (relay !== undefined) return { percent: relay, approximate: false, text: 'Context ' + Math.round(relay) + '% (status line)' };
  const context = session.context;
  if (context?.percent !== undefined) {
    return { percent: context.percent, approximate: context.approximate,
      text: 'Context ' + Math.round(context.percent) + '%' + (context.approximate ? ' (approximate)' : '') };
  }
  if (context?.input !== undefined) return { text: 'Last request input ' + context.input + ' tokens, capacity unknown' };
  return { text: 'Context unavailable' };
}

export function buildDetail(session: Session, sessions: readonly Session[], options: DetailOptions): SessionDetail {
  const { now, privateMode } = options;
  const lanes = new Map(session.lanes.map(lane => [lane.id, lane]));
  const merged = mergeTimeline(session.lanes);
  const rows = merged.slice(-maxRows).map(row => rowView(row, lanes, privateMode));
  const main = session.lanes[0];
  const byId = new Map(sessions.map(item => [item.id, item]));
  const agents: AgentNode[] = [];
  if (main) {
    agents.push(agentNode(session, main, { now, privateMode, kind: 'main', id: main.id,
      contextPercent: options.relayContext }));
  }
  for (const lane of session.lanes.slice(1)) {
    const parent = lane.parent && lanes.has(lane.parent.laneId) ? lane.parent.laneId : main?.id;
    const unresolved = !lane.parent;
    agents.push(agentNode(session, lane, { now, privateMode, kind: 'agent', id: lane.id, parent,
      parentTitle: parent ? lanes.get(parent)?.title : undefined,
      note: unresolved ? (lane.parentReason ?? 'Parent not resolved yet') : undefined }));
  }
  for (const edge of session.children) {
    const child = byId.get(edge.sessionId);
    const childMain = child?.lanes[0];
    if (!child || !childMain || agents.some(agent => agent.id === child.id)) continue;
    agents.push(agentNode(child, childMain, { now, privateMode, kind: 'codex-run', id: child.id,
      parent: lanes.has(edge.laneId) ? edge.laneId : main?.id, parentTitle: lanes.get(edge.laneId)?.title ?? main?.title }));
  }
  const context = contextText(session, options.relayContext);
  const total = laneTokens(session.usage);
  const agentCount = session.lanes.length + session.children.length;
  return {
    id: session.id, title: title(session, privateMode), provider: providerLabels[session.provider], profile: session.profile,
    project: projectLabel(session), branch: safeText(session.branch, 80), status: session.status, tone: toneFor(session.status),
    model: session.model, effort: session.effort,
    elapsedMs: main ? elapsed(main, now) : undefined, agentCount,
    contextPercent: context.percent, contextApproximate: context.approximate, contextText: context.text,
    usageText: total === undefined ? 'Usage unavailable' : total + ' tokens' + (session.usagePartial ? ' (partial)' : ''),
    rows, rowsOmitted: Math.max(0, merged.length - rows.length), agents,
    files: fileGroups(session.files, lanes, privateMode), usage: usageView(session),
    tasks: buildTasks([session], privateMode),
    lanes: session.lanes.map(lane => ({ id: lane.id, label: safeText(lane.title, 60) ?? 'Agent' })),
    privateMode, partial: session.coverage === 'partial',
    note: session.coverage === 'partial' ? 'Some evidence for this session is partial or still loading.' : undefined,
  };
}

export function gaugeView(gauge: Gauge): GaugeView {
  return {
    provider: providerLabels[gauge.provider], profile: gauge.profile, label: gauge.label,
    state: gauge.state === 'fresh' ? 'Fresh' : gauge.state === 'stale' ? 'Stale' : gauge.state === 'expired' ? 'Reset' : 'No data',
    percent: gauge.percent, resetsAt: gauge.resetsAt, observedAt: gauge.observedAt, reason: gauge.reason, bucket: gauge.bucket,
  };
}

function dayTokens(row: UsageTotal): number {
  return laneTokens(row.counts) ?? 0;
}

export interface UsageOptions {
  now: number;
  timeZone?: string;
  filters: UsageFilters;
  totals: readonly UsageTotal[];
  sessions: readonly Session[];
}

/** Build the global usage tables and the daily chart data from the ledger. Tokens only. */
export function buildUsage(options: UsageOptions): Pick<UsageModel, 'days' | 'models' | 'summaries' | 'partial'> {
  const { filters } = options;
  let cutoff: string | undefined;
  if (filters.range !== 'all') cutoff = localDay(options.now - (Number(filters.range) - 1) * 86_400_000, options.timeZone);
  const projectFor = new Map(options.sessions.map(session => [session.id, projectId(session)]));
  const rows = options.totals.filter(row =>
    (!filters.adapter || row.provider === filters.adapter) &&
    (!filters.project || projectFor.get(row.sessionId) === filters.project) &&
    (cutoff === undefined || (row.day !== undefined && row.day >= cutoff)));
  const days = new Map<string, DayBar>();
  const models = new Map<string, ModelRow>();
  const perProvider = new Map<Provider, number>();
  let partial = false;
  for (const row of rows) {
    partial ||= row.partial;
    const tokens = dayTokens(row);
    const day = days.get(row.day ?? 'unknown') ?? { day: row.day ?? 'unknown', claude: 0, codex: 0, total: 0 };
    days.set(day.day, day);
    if (row.provider === 'claude-code') day.claude += tokens;
    else day.codex += tokens;
    day.total += tokens;
    perProvider.set(row.provider, (perProvider.get(row.provider) ?? 0) + tokens);
    const key = row.provider + '\n' + (row.model ?? '');
    const model = models.get(key) ?? { provider: providerLabels[row.provider], model: safeText(row.model, 80) ?? 'Unknown model' };
    models.set(key, model);
    for (const field of ['input', 'cacheRead', 'cacheWrite', 'output', 'total'] as const) {
      const value = row.counts[field];
      if (value !== undefined) model[field] = (model[field] ?? 0) + value;
    }
  }
  const latest = (provider: Provider) => options.sessions.find(session => session.provider === provider && session.context?.percent !== undefined);
  return {
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    models: [...models.values()].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
    summaries: (['claude-code', 'codex'] as const).filter(provider => !filters.adapter || filters.adapter === provider)
      .map(provider => ({ provider: providerLabels[provider], tokens: perProvider.get(provider) ?? 0,
        context: latest(provider)?.context?.percent })),
    partial,
  };
}
