/** View models and messages shared by the host and the webviews. Everything here is plain, sanitized data. */

export type StatusTone = 'live' | 'ok' | 'warn' | 'fail' | 'neutral';

export interface GaugeView {
  /** Provider display label, for example Claude Code. */
  provider: string;
  profile: string;
  label: string;
  /** Display state shown as text next to the bar. */
  state: 'Fresh' | 'Stale' | 'Reset' | 'No data';
  percent?: number;
  resetsAt?: number;
  observedAt?: number;
  reason: string;
  bucket?: string;
}

export interface RelayView {
  state: 'not-installed' | 'installed' | 'declined' | 'unavailable';
  /** Profile id the action applies to. */
  profileId: string;
  profile: string;
  detail: string;
}

/** One signal shown as a label. The text label always accompanies the tone, never the color alone. */
export interface SignalView {
  kind: 'loop' | 'check' | 'context';
  state: 'live' | 'historical';
  label: string;
  detail?: string;
  tone: StatusTone;
}

/** A timeline row, possibly in another session of the same delegation tree. */
export interface RowTarget {
  sessionId: string;
  laneId: string;
  rowId: string;
}

export interface ParentChoice extends RowTarget {
  /** Session, lane and time text for the choice menu. */
  label: string;
  at?: number;
}

export interface ParentInfo {
  state: 'root' | 'unresolved' | 'resolved';
  /** Why the parent is unresolved. */
  reason?: string;
  /** Launch targets, newest first. Several appear when a Codex thread was resumed by more than one launch. */
  targets: ParentChoice[];
}

export interface Crumb {
  label: string;
  /** Present on every ancestor segment. The current segment has none. */
  target?: RowTarget;
}

export interface SessionRow {
  id: string;
  provider: string;
  title: string;
  status: string;
  tone: StatusTone;
  updatedAt?: number;
  /** Project label when the row sits outside its parent's project. */
  project?: string;
  agents: AgentRow[];
  children: SessionRow[];
  /** Short warning labels such as Possible loop, No checks after edits, Context High. */
  warnings: SignalView[];
  parent: { state: ParentInfo['state']; reason?: string };
}

export interface AgentRow {
  title: string;
  status: string;
  tone: StatusTone;
}

export interface GroupNode {
  key: 'live' | 'today' | 'earlier';
  label: string;
  rows: SessionRow[];
  /** Earlier rows not yet loaded. */
  more: number;
}

export interface ProjectNode {
  id: string;
  label: string;
  groups: GroupNode[];
}

export interface FilterOption {
  id: string;
  label: string;
}

export interface SourceView {
  label: string;
  state: string;
  transcripts: number;
  versions: string[];
}

export interface Filters {
  search: string;
  adapter: string;
  project: string;
  /** Show only sessions with a live loop, an unresolved done-without-checks outcome or a high context level. */
  warnings: boolean;
}

export interface SidebarModel {
  gauges: GaugeView[];
  liveCount: number;
  backgroundCount: number;
  adapters: FilterOption[];
  projects: FilterOption[];
  tree: ProjectNode[];
  sources: SourceView[];
  relays: RelayView[];
  refresh: { enabled: boolean; reason: string };
  filters: Filters;
  privateMode: boolean;
  total: number;
}

export interface RowView {
  id: string;
  laneId: string;
  lane: string;
  at?: number;
  kind: string;
  label: string;
  text?: string;
  textTruncated?: boolean;
  output?: string;
  outputTruncated?: boolean;
  status?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  file?: string;
  turnId?: string;
  /** Membership of a repeated-call streak. The first row of a streak carries the group head. */
  loop?: { id: string; tool: string; count: number; live: boolean };
  signals?: SignalView[];
  /** End-of-turn marker links to the last confirmed edit and the last check. */
  links?: { edit?: RowTarget; check?: RowTarget };
}

export interface ToolView {
  name: string;
  target?: string;
  line?: string;
}

export interface AgentNode {
  id: string;
  laneId: string;
  parent?: string;
  title: string;
  kind: 'main' | 'agent' | 'codex-run';
  status: string;
  tone: StatusTone;
  model?: string;
  elapsedMs?: number;
  tokens?: number;
  tokenLabel: string;
  contextPercent?: number;
  contextApproximate?: boolean;
  /** High or Critical only. Normal and unknown capacity have no level. */
  contextLevel?: 'High' | 'Critical';
  signals: SignalView[];
  parentInfo: ParentInfo;
  parentTitle?: string;
  transcript: boolean;
  /** Session that owns the transcript, which differs from the open session for a linked Codex run. */
  sessionId: string;
  tools: ToolView[];
  note?: string;
}

export interface FileItem {
  actionId: string;
  kind: string;
  status: string;
  laneTitle: string;
  hasDiff: boolean;
  note?: string;
}

export interface FileGroup {
  path: string;
  read: number;
  changed: number;
  mentioned: number;
  agents: string[];
  openId?: string;
  diffId?: string;
  diffNote?: string;
  items: FileItem[];
}

export interface TokenRow {
  label: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  total?: number;
}

export interface UsageView {
  tokens: TokenRow[];
  scope: string;
  partial: boolean;
}

export interface TaskView {
  id: string;
  sessionId: string;
  title: string;
  status: string;
  tone: StatusTone;
  provider: string;
  project: string;
  lane: string;
  at?: number;
}

export interface SessionDetail {
  id: string;
  title: string;
  provider: string;
  profile?: string;
  project: string;
  branch?: string;
  status: string;
  tone: StatusTone;
  model?: string;
  effort?: string;
  elapsedMs?: number;
  agentCount: number;
  contextPercent?: number;
  contextApproximate?: boolean;
  contextLevel?: 'High' | 'Critical';
  contextText: string;
  usageText: string;
  /** Header summary: live streak count, latest turn outcome and context level. */
  signals: { liveLoops: number; outcome?: SignalView; context?: SignalView };
  parent: ParentInfo;
  breadcrumb: Crumb[];
  rows: RowView[];
  rowsOmitted: number;
  agents: AgentNode[];
  files: FileGroup[];
  usage: UsageView;
  tasks: TaskView[];
  lanes: FilterOption[];
  privateMode: boolean;
  partial: boolean;
  /** The recorded evidence stopped growing before the session was fully read. */
  note?: string;
}

export interface DayBar {
  day: string;
  claude: number;
  codex: number;
  total: number;
}

export interface ModelRow {
  provider: string;
  model: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  total?: number;
}

export interface UsageFilters {
  range: '7' | '30' | 'all';
  project: string;
  adapter: string;
}

export interface UsageModel {
  gauges: GaugeView[];
  otherGauges: GaugeView[];
  filters: UsageFilters;
  projects: FilterOption[];
  adapters: FilterOption[];
  days: DayBar[];
  models: ModelRow[];
  summaries: { provider: string; tokens: number; context?: number }[];
  partial: boolean;
  relays: RelayView[];
  refresh: { enabled: boolean; reason: string };
}

export type PanelModel =
  | { mode: 'session'; session: SessionDetail }
  | { mode: 'usage'; usage: UsageModel }
  | { mode: 'tasks'; tasks: TaskView[]; privateMode: boolean }
  | { mode: 'empty'; message: string };

export type RelayCommand = 'enable' | 'decline' | 'uninstall' | 'refresh';
export type PanelTab = 'timeline' | 'map' | 'files' | 'usage' | 'tasks';

export type HostMessage =
  | { type: 'sidebar'; model: SidebarModel }
  /** `tab` is set only when the host opens the panel on a specific tab. `focus` is set when Open parent targets a row. */
  | { type: 'panel'; model: PanelModel; tab?: PanelTab; focus?: { lane: string; row: string } };

export type SidebarRequest =
  | { type: 'ready' }
  | { type: 'filter'; filters: Filters }
  | { type: 'loadOlder'; project: string }
  | { type: 'openSession'; id: string }
  | { type: 'openMap'; id: string }
  | { type: 'openParent'; id: string }
  | { type: 'openUsage' }
  | { type: 'openTasks' }
  | { type: 'relay'; command: RelayCommand; profile: string };

export type PanelRequest =
  | { type: 'ready' }
  | { type: 'openFile'; id: string }
  | { type: 'openDiff'; id: string }
  | { type: 'openTranscript'; session: string; lane: string }
  | { type: 'openSession'; id: string }
  /** Open a session at a row. `lane` and `row` are empty to open the session without a target. */
  | { type: 'goto'; session: string; lane: string; row: string }
  /** Open the parent of the current session or lane. `lane` is empty for the main lane. */
  | { type: 'openParent'; session: string; lane: string }
  | { type: 'openSettings' }
  | { type: 'usageFilters'; filters: UsageFilters }
  | { type: 'relay'; command: RelayCommand; profile: string };

const sessionId = /^[a-f0-9]{32}$/;
const actionId = /^[a-f0-9]{64}$/;

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => present.includes(key));
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

export const maxSearch = 200;

export function isFilters(value: unknown): value is Filters {
  return shape(value, ['search', 'adapter', 'project', 'warnings']) && text(value.search, maxSearch)
    && text(value.adapter, 40) && text(value.project, 64) && typeof value.warnings === 'boolean';
}

export function isUsageFilters(value: unknown): value is UsageFilters {
  return shape(value, ['range', 'project', 'adapter']) && (value.range === '7' || value.range === '30' || value.range === 'all')
    && text(value.project, 64) && text(value.adapter, 40);
}

function isRelayCommand(value: unknown): value is RelayCommand {
  return value === 'enable' || value === 'decline' || value === 'uninstall' || value === 'refresh';
}

/** Validate a message from the sidebar webview. Anything unknown is rejected. */
export function parseSidebarRequest(message: unknown): SidebarRequest | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  if (type === 'ready' && shape(message, ['type'])) return { type };
  if (type === 'openUsage' && shape(message, ['type'])) return { type };
  if (type === 'openTasks' && shape(message, ['type'])) return { type };
  if (type === 'filter' && shape(message, ['type', 'filters']) && isFilters(message.filters)) return { type, filters: message.filters };
  if (type === 'loadOlder' && shape(message, ['type', 'project']) && text(message.project, 64)) return { type, project: message.project };
  if ((type === 'openSession' || type === 'openMap' || type === 'openParent') && shape(message, ['type', 'id'])
    && typeof message.id === 'string' && sessionId.test(message.id)) return { type, id: message.id };
  if (type === 'relay' && shape(message, ['type', 'command', 'profile']) && isRelayCommand(message.command)
    && text(message.profile, 64)) {
    return { type, command: message.command, profile: message.profile };
  }
  return undefined;
}

function optionalId(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || sessionId.test(value));
}

/** Validate a message from the session panel webview. */
export function parsePanelRequest(message: unknown): PanelRequest | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  if (type === 'ready' && shape(message, ['type'])) return { type };
  if ((type === 'openFile' || type === 'openDiff') && shape(message, ['type', 'id']) && typeof message.id === 'string'
    && actionId.test(message.id)) return { type, id: message.id };
  if (type === 'openTranscript' && shape(message, ['type', 'session', 'lane']) && typeof message.session === 'string'
    && typeof message.lane === 'string' && sessionId.test(message.session) && sessionId.test(message.lane)) {
    return { type, session: message.session, lane: message.lane };
  }
  if (type === 'openSession' && shape(message, ['type', 'id']) && typeof message.id === 'string'
    && sessionId.test(message.id)) return { type, id: message.id };
  if (type === 'openSettings' && shape(message, ['type'])) return { type };
  if (type === 'goto' && shape(message, ['type', 'session', 'lane', 'row']) && typeof message.session === 'string'
    && sessionId.test(message.session) && optionalId(message.lane) && optionalId(message.row)) {
    return { type, session: message.session, lane: message.lane, row: message.row };
  }
  if (type === 'openParent' && shape(message, ['type', 'session', 'lane']) && typeof message.session === 'string'
    && sessionId.test(message.session) && optionalId(message.lane)) {
    return { type, session: message.session, lane: message.lane };
  }
  if (type === 'usageFilters' && shape(message, ['type', 'filters']) && isUsageFilters(message.filters)) {
    return { type, filters: message.filters };
  }
  if (type === 'relay' && shape(message, ['type', 'command', 'profile']) && isRelayCommand(message.command)
    && text(message.profile, 64)) {
    return { type, command: message.command, profile: message.profile };
  }
  return undefined;
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (type === 'sidebar' || type === 'panel') && typeof (value as { model?: unknown }).model === 'object'
    && (value as { model?: unknown }).model !== null;
}
