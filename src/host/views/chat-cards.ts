import { formatAge, formatPercent, formatTokens } from '../../shared/format';
import { maxSearch } from '../../shared/protocol';
import type {
  ChatCard, ChatCardAction, ChatCardEntry, FileGroup, GaugeView, SessionDetail,
} from '../../shared/protocol';
import type { CompactMeasurement } from '../chat/types';
import { recordedHunks, safeFileText } from '../files/diff';
import type { RelayContext } from '../limits/claude-relay';
import { safePath, safeText } from '../privacy/projection';
import type { FileAction, Lane, Session } from '../sessions/types';
import { laneContext } from './signal-models';
import type { Thresholds } from './signal-models';

export type InspectionCommand = 'usage' | 'context' | 'agents' | 'files' | 'diff' | 'tasks' | 'status';
export type ChatFileKind = 'all' | 'changed' | 'read' | 'mentioned';

export type ChatCardTarget =
  | { kind: 'view'; view: 'usage' | 'map' | 'files' | 'tasks' | 'allTasks' }
  | { kind: 'file' | 'diff' | 'previewDiff'; id: string }
  | { kind: 'transcript' | 'parent'; session: string; lane: string }
  | { kind: 'session'; session: string }
  | { kind: 'filterFiles'; fileKind?: ChatFileKind }
  | { kind: 'contextLane'; lane: string }
  | { kind: 'backgroundTasks' | 'interrupt' | 'refreshLimits' };

export interface ChatContextEvidence {
  lane: string;
  input?: number;
  inputAt?: number;
  capacity?: number;
  percent?: number;
  approximate?: boolean;
  compactTokens?: number;
  level?: string;
  source: string;
  at?: number;
}

export interface ChatCardInput {
  scope: string;
  argument?: string;
  detail?: SessionDetail;
  loading?: boolean;
  privateMode: boolean;
  now: number;
  /** Selected by provider and owning profile before display labels are applied. */
  gauges?: readonly GaugeView[];
  context?: ChatContextEvidence;
  contextLanes?: readonly { id: string; label: string }[];
  selectedContextLane?: string;
  status?: {
    channel: string;
    reason?: string;
    owner?: string;
    model?: string;
    effort?: string;
    queued?: number;
    canInterrupt?: boolean;
  };
  fileKind?: ChatFileKind;
  /** The current action resolved from this session's index after selection. */
  selectedDiff?: { action: FileAction; title: string };
  refreshLimits?: boolean;
  action(target: ChatCardTarget, label: string, input?: ChatCardAction['input']): ChatCardAction;
}

const maxEntries = 40;
const maxDiffHunks = 8;
const maxDiffLines = 80;
const maxLineText = 500;
const fileKinds: readonly [ChatFileKind, string][] = [
  ['all', 'All files'], ['changed', 'Changed'], ['read', 'Read'], ['mentioned', 'Mentioned'],
];
const titles: Record<InspectionCommand, string> = {
  usage: 'Usage', context: 'Context', agents: 'Agents', files: 'Files', diff: 'Recorded changes',
  tasks: 'Tasks', status: 'Status',
};

export type CompactCardResult =
  | { state: 'pending' }
  | { state: 'completed'; measurement: CompactMeasurement }
  | { state: 'failed'; reason?: string };

const wholeTokens = new Intl.NumberFormat('en');

export function compactChatCard(scope: string, result: CompactCardResult): ChatCard {
  const title = 'Compact context';
  if (result.state === 'pending') return { title, scope, state: 'loading', message: 'Compacting context…' };
  if (result.state === 'failed') {
    const message = safeText(result.reason, 240) ?? 'Compaction did not return a confirmed context measurement.';
    return { title, scope, state: 'unavailable', message, announcement: message };
  }
  const { preTokens, postTokens } = result.measurement;
  const detail = wholeTokens.format(preTokens) + ' → ' + wholeTokens.format(postTokens) + ' tokens';
  return {
    title, scope, state: 'ready', entries: [{ title: 'Context before and after', detail }],
    announcement: 'Context compacted. ' + wholeTokens.format(postTokens) + ' tokens remain.',
  };
}

export function compactContextEvidence(label: string, measurement: CompactMeasurement): ChatContextEvidence {
  return { lane: label, compactTokens: measurement.postTokens, source: 'Live compaction boundary', at: measurement.at };
}

/** Reuse M1 lane thresholds. Relay fill and recorded input can come from different measurements. */
export function chatContextEvidence(
  session: Session, lane: Lane, label: string, relay?: RelayContext, thresholds?: Thresholds, compact?: CompactMeasurement,
): ChatContextEvidence | undefined {
  const main = lane === session.lanes[0];
  const sample = lane.context ?? (main ? session.context : undefined);
  const mainMeasurement = main && session.provider === 'claude-code' ? compact : undefined;
  const activeRelay = main && session.provider === 'claude-code' && relay && (!mainMeasurement || relay.at > mainMeasurement.at)
    ? relay : undefined;
  if (mainMeasurement && !activeRelay && (sample?.at ?? 0) <= mainMeasurement.at) {
    return compactContextEvidence(label, mainMeasurement);
  }
  if (!sample && !activeRelay) return undefined;
  const level = laneContext(session, lane, activeRelay?.percent, thresholds);
  return {
    lane: label, input: sample?.input, inputAt: sample?.at,
    capacity: activeRelay ? activeRelay.windowSize : sample?.capacity,
    percent: activeRelay?.percent ?? sample?.percent,
    approximate: activeRelay ? false : sample?.approximate,
    level: level.level ?? (activeRelay ? undefined : sample?.level),
    source: activeRelay ? 'Status-line relay' : sample?.approximate ? 'Recorded last-request estimate' : 'Recorded request',
    at: activeRelay?.at ?? sample?.at,
  };
}

function joined(parts: readonly (string | undefined)[]): string {
  return parts.filter(Boolean).join(' · ');
}

function view(input: ChatCardInput, kind: Extract<ChatCardTarget, { kind: 'view' }>['view'], label: string): ChatCardAction {
  return input.action({ kind: 'view', view: kind }, label);
}

function bounded(entries: ChatCardEntry[], message?: string): Pick<ChatCard, 'entries' | 'message'> {
  return {
    entries: entries.slice(0, maxEntries),
    message: joined([message, entries.length > maxEntries ? 'More entries are available in the secondary view.' : undefined]) || undefined,
  };
}

function usageCard(input: ChatCardInput, card: ChatCard): ChatCard {
  const actions = [view(input, 'usage', 'Open Usage')];
  if (input.refreshLimits) actions.push(input.action({ kind: 'refreshLimits' }, 'Refresh limits'));
  const usage = input.detail?.usage;
  const gauges = input.gauges;
  return {
    ...card, actions, gauges, usage: usage && { ...usage, tokens: usage.tokens.slice(0, maxEntries) },
    state: gauges?.length || usage?.tokens.length ? 'ready' : input.loading ? 'loading' : 'unavailable',
    message: joined([
      gauges?.length ? undefined : 'Limits are unavailable for this profile.',
      usage?.tokens.length ? undefined : input.loading ? 'Loading session usage.' : 'No session tokens recorded yet.',
    ]) || undefined,
  };
}

function contextCard(input: ChatCardInput, card: ChatCard): ChatCard {
  const actions = [view(input, 'usage', 'Open Usage')];
  const lanes = input.contextLanes ?? [];
  const selected = lanes.find(lane => lane.id === input.selectedContextLane) ?? lanes[0];
  const label = (lane: { label: string }, index: number): string => input.privateMode ? 'Lane ' + (index + 1)
    : safeText(lane.label, 100) ?? 'Lane ' + (index + 1);
  const choices = lanes.slice(0, maxEntries).flatMap((lane, index) => lane.id === selected?.id ? []
    : [input.action({ kind: 'contextLane', lane: lane.id }, 'Show context for ' + label(lane, index))]);
  const evidence = input.context;
  if (!evidence) {
    return {
      ...card, actions: [...actions, ...choices], state: input.loading ? 'loading' : 'empty',
      entries: selected ? [{ title: label(selected, lanes.indexOf(selected)) }] : undefined,
      message: input.loading ? 'Loading context evidence.' : 'Waiting for context data.',
    };
  }
  const age = formatAge(evidence.at, input.now) || 'Time unavailable';
  const fill = evidence.percent === undefined ? 'Context fill unavailable'
    : formatPercent(evidence.percent) + (evidence.approximate ? ' estimated fill' : ' used');
  const capacity = evidence.capacity === undefined ? 'Capacity unknown' : formatTokens(evidence.capacity) + ' tokens capacity';
  const entries: ChatCardEntry[] = [{
    title: selected ? label(selected, lanes.indexOf(selected))
      : input.privateMode ? 'Selected lane' : safeText(evidence.lane, 100) ?? 'Selected lane',
    detail: joined([
      evidence.compactTokens === undefined ? undefined : wholeTokens.format(evidence.compactTokens) + ' tokens after compaction',
      fill, capacity, evidence.level, evidence.source, age,
    ]),
  }];
  if (evidence.input !== undefined) {
    entries.push({
      title: 'Last recorded request input',
      detail: joined([formatTokens(evidence.input) + ' tokens', formatAge(evidence.inputAt, input.now) || 'Time unavailable']),
    });
  }
  return { ...card, entries, actions: [...actions, ...choices] };
}

function agentsCard(input: ChatCardInput, card: ChatCard): ChatCard {
  const agents = input.detail?.agents ?? [];
  const entries = agents.slice(0, maxEntries + 1).map(agent => {
    const actions: ChatCardAction[] = [];
    if (agent.transcript) actions.push(input.action({ kind: 'transcript', session: agent.sessionId, lane: agent.laneId }, 'Open transcript'));
    if (agent.parentInfo.state === 'resolved') {
      actions.push(input.action({ kind: 'parent', session: agent.sessionId, lane: agent.laneId }, 'Open parent'));
    }
    if (agent.kind === 'main' && input.status?.canInterrupt) actions.push(input.action({ kind: 'interrupt' }, 'Interrupt turn'));
    const liveChild = agent.kind !== 'main' && (agent.status === 'Live' || agent.status === 'Waiting');
    const detail = joined([
      agent.status, agent.note ?? agent.parentInfo.reason,
      agent.transcript ? undefined : 'Transcript unavailable.',
      liveChild ? 'Targeted Stop is planned for a later update.' : undefined,
    ]);
    const tools = agent.tools.slice(-8).map(tool => joined([tool.name, input.privateMode ? undefined : tool.target, tool.line]));
    return { title: agent.title, detail: [detail, ...tools].join('\n'), actions };
  });
  return {
    ...card, actions: input.detail ? [view(input, 'map', 'Open Agent map')] : [],
    state: entries.length ? 'ready' : input.loading ? 'loading' : 'empty',
    ...bounded(entries, entries.length ? input.detail?.note : input.loading ? 'Loading Agent map.' : 'No agents recorded.'),
  };
}

function matches(group: FileGroup, search: string, kind: ChatFileKind): boolean {
  return safePath(group.path) !== undefined && group.path.toLowerCase().includes(search) && (kind === 'all' || group[kind] > 0);
}

function fileEntry(group: FileGroup, input: ChatCardInput): ChatCardEntry {
  const actions: ChatCardAction[] = [];
  if (group.openId) actions.push(input.action({ kind: 'file', id: group.openId }, 'Open file'));
  if (group.diffId && !input.privateMode) actions.push(input.action({ kind: 'diff', id: group.diffId }, 'Open recorded diff'));
  return {
    title: group.path, actions,
    detail: joined([
      group.changed ? group.changed + ' changed' : undefined,
      group.read ? group.read + ' read' : undefined,
      group.mentioned ? group.mentioned + ' mentioned' : undefined,
      group.agents.length ? 'By ' + group.agents.join(', ') : undefined,
      group.diffId ? undefined : group.diffNote,
    ]),
  };
}

function changeEntries(group: FileGroup, input: ChatCardInput): ChatCardEntry[] {
  const changes = group.items.filter(item => item.kind !== 'read' && item.kind !== 'mention' && item.kind !== 'checkpoint');
  const evidenceActions = (id: string): ChatCardAction[] => [
    input.action({ kind: 'previewDiff', id }, 'Preview recorded diff'),
    input.action({ kind: 'diff', id }, 'Open recorded diff'),
  ];
  const entries = changes.map(item => {
    const actions = !input.privateMode && item.hasDiff ? evidenceActions(item.actionId) : [];
    return {
      title: group.path, actions,
      detail: joined([
        item.kind, item.status, item.laneTitle,
        actions.length ? undefined : input.privateMode ? 'Diffs are hidden in private display mode.'
          : item.note ?? group.diffNote ?? 'No patch was recorded for this action.',
      ]),
    };
  });
  if (!input.privateMode && group.diffId && !changes.some(item => item.actionId === group.diffId)) {
    entries.unshift({ title: group.path, detail: 'Latest recorded diff', actions: evidenceActions(group.diffId) });
  }
  return entries.length ? entries : [fileEntry(group, input)];
}

/** Bounded hunks for an inline or card preview. `clipped` tells the reader to open the full diff. */
export function previewHunks(hunks: NonNullable<ReturnType<typeof recordedHunks>>): { diff: NonNullable<ChatCard['diff']>[number][]; clipped: boolean } {
  let remaining = maxDiffLines;
  const diff: NonNullable<ChatCard['diff']>[number][] = [];
  for (const hunk of hunks.slice(0, maxDiffHunks)) {
    if (!remaining) break;
    const lines = hunk.lines.slice(0, remaining);
    remaining -= lines.length;
    diff.push({
      heading: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      lines: lines.map(line => ({
        text: (line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ') + line.text.slice(0, maxLineText)
          + (line.text.length > maxLineText ? '…' : ''),
        before: line.oldLine, after: line.newLine,
      })),
    });
  }
  const clipped = diff.length < hunks.length || hunks.some((hunk, index) => hunk.lines.length !== diff[index]?.lines.length
    || hunk.lines.some(line => line.text.length > maxLineText));
  return { diff, clipped };
}

function diffPreview(card: ChatCard, groups: FileGroup[], input: ChatCardInput): ChatCard {
  const action = input.selectedDiff?.action;
  if (!action) return card;
  const group = groups.find(candidate => candidate.diffId === action.id
    || candidate.items.some(item => item.actionId === action.id && item.hasDiff));
  if (input.privateMode) return { ...card, state: 'denied', message: 'Diffs are hidden in private display mode.' };
  if (!group) return { ...card, state: 'changed', message: 'The selected change is no longer available in this scope.' };
  const hunks = recordedHunks(action.diff);
  if (!hunks) {
    const empty = safeFileText(action.diff) === '';
    return {
      ...card, state: empty ? 'empty' : 'unavailable',
      message: empty ? 'The recorded change has no text lines.' : 'No eligible recorded hunks are available for this action.',
    };
  }
  const { diff, clipped } = previewHunks(hunks);
  return {
    ...card, title: 'Recorded diff · ' + group.path, diff,
    message: clipped ? 'Preview limited. Open the recorded diff for the full evidence.' : card.message,
    actions: [...(card.actions ?? []), input.action({ kind: 'diff', id: action.id }, 'Open recorded diff')],
  };
}

function filesCard(input: ChatCardInput, card: ChatCard, changes: boolean): ChatCard {
  const filter = input.argument?.trim() ?? '';
  const kind = changes ? 'changed' : input.fileKind ?? 'all';
  const all = input.detail?.files ?? [];
  const groups = all.filter(group => matches(group, filter.toLowerCase(), kind));
  const actions = input.detail ? [view(input, 'files', 'Open Files')] : [];
  if (!changes && input.detail) {
    actions.push(input.action({ kind: 'filterFiles' }, 'Filter paths', {
      label: 'Path filter', value: input.privateMode ? undefined : safeText(filter, maxSearch), maxLength: maxSearch,
    }));
    for (const [fileKind, label] of fileKinds) {
      if (fileKind !== kind) actions.push(input.action({ kind: 'filterFiles', fileKind }, label));
    }
  }
  const empty = input.loading ? 'Loading indexed file activity.'
    : all.length === 0 ? 'No file activity recorded.'
      : changes && !filter && !all.some(group => group.changed > 0) ? 'No recorded changes.'
        : 'No files match these filters.';
  const entries: ChatCardEntry[] = [];
  for (const group of groups) {
    entries.push(...(changes ? changeEntries(group, input) : [fileEntry(group, input)]));
    if (entries.length > maxEntries) break;
  }
  const result: ChatCard = {
    ...card, actions, state: entries.length ? 'ready' : input.loading ? 'loading' : 'empty',
    ...bounded(entries, entries.length ? input.detail?.note : empty),
  };
  return changes ? diffPreview(result, groups, input) : result;
}

function tasksCard(input: ChatCardInput, card: ChatCard): ChatCard {
  if (input.argument !== 'background') {
    return {
      ...card, state: 'unavailable', message: 'Structured to-do evidence is unavailable in this chat.',
      actions: [input.action({ kind: 'backgroundTasks' }, 'Background tasks')],
    };
  }
  const entries = (input.detail?.tasks ?? []).slice(0, maxEntries + 1).map(task => ({
    title: task.title, detail: joined([task.status, task.provider, task.project, task.lane, 'Indexed session evidence', formatAge(task.at, input.now)]),
    actions: [input.action({ kind: 'session', session: task.sessionId }, 'Open session')],
  }));
  return {
    ...card, actions: [view(input, 'allTasks', 'Open all background tasks')],
    state: entries.length ? 'ready' : input.loading ? 'loading' : 'empty',
    ...bounded(entries, entries.length ? input.detail?.note : input.loading ? 'Loading background tasks.' : 'No background tasks observed in this chat.'),
  };
}

function statusCard(input: ChatCardInput, card: ChatCard): ChatCard {
  const { detail, status } = input;
  const owner = status?.owner ?? (detail?.status === 'Writer present' ? 'External writer observed' : 'No owned channel');
  const entries = [
    { title: 'Channel', detail: joined([status?.channel ?? 'Unknown', owner, status?.reason]) },
    { title: 'Recorded session', detail: detail?.status ?? 'No session confirmed' },
    { title: 'Effective model', detail: safeText(status?.model ?? detail?.model, 100) ?? 'Unknown' },
    { title: 'Effective effort', detail: safeText(status?.effort ?? detail?.effort, 100) ?? 'Unknown' },
    { title: 'Queued drafts', detail: status?.queued === undefined ? 'Unknown' : String(status.queued) },
  ];
  return {
    ...card, entries, gauges: input.gauges,
    actions: [view(input, 'usage', 'Open Usage'), view(input, 'allTasks', 'Open background tasks')],
  };
}

/** Build a local-only snapshot from the same M1 evidence used by the secondary views. */
export function projectChatCard(name: InspectionCommand, input: ChatCardInput): ChatCard {
  const card: ChatCard = { title: titles[name], scope: input.scope, state: 'ready' };
  switch (name) {
    case 'usage': return usageCard(input, card);
    case 'context': return contextCard(input, card);
    case 'agents': return agentsCard(input, card);
    case 'files': return filesCard(input, card, false);
    case 'diff': return filesCard(input, card, true);
    case 'tasks': return tasksCard(input, card);
    case 'status': return statusCard(input, card);
  }
}
