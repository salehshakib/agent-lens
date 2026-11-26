import { formatDuration } from '../../shared/format';
import type {
  AgentActivity, AgentActivityRow, AgentDelegation, AgentIdentity, AgentNode, AgentToolActivity, CardLink, ChatCard,
  ChatCardEntry, ChatRow, RowView, SessionDetail,
} from '../../shared/protocol';
import { recordedHunks } from '../files/diff';
import { agentActivityText, safeText } from '../privacy/projection';
import { key } from '../sessions/evidence';
import { parseCodexInvocation } from '../sessions/launch-command';
import type { FileAction, Lane, ParentTarget, Session, State, TimelineRow } from '../sessions/types';
import { previewHunks } from './chat-cards';
import { providerLabels, rowView, toneFor } from './models';

export type TranscriptRow = ChatRow & {
  keys?: readonly string[];
  /** Canonical timeline position of this rendered row or the start of its folded activity. */
  sourceRowId?: string;
  /** Exact call identities used only to place a newly verified delegation beside its live spawning row. */
  delegationCallKeys?: readonly string[];
  /** A scoped notice used when the observed lane cannot be placed at an exact launch row. */
  unresolvedDelegation?: boolean;
};

const maxEntries = 40;
const maxOutput = 240;
const maxFoldedDiffs = 3;
const changeKinds = new Set<FileAction['kind']>(['edit', 'add', 'delete', 'move']);
const folded = new Set(['reasoning', 'tool', 'result']);
const readerToolLabels = new Set([
  'Agent', 'Task', 'TaskOutput', 'TaskStop', 'SendMessage', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite',
  'Command', 'File change', 'Web search', 'MCP tool', 'Extension', 'exec_command', 'shell', 'shell_command', 'apply_patch',
  'write_stdin', 'spawn_agent', 'wait', 'wait_agent', 'wait_for_agent',
]);

export const agentRootPageSize = 1500;
export const agentPageSize = 100;
export const agentOutputPageSize = 4_000;

export interface AgentScope {
  sessionId: string;
  laneId: string;
  turnId?: string;
}

export interface AgentEdge {
  id: string;
  parent: AgentScope;
  rowId: string;
  target: AgentScope;
  relation: ParentTarget['relation'];
  /** The exact Claude launch is known, but the underlying lane identity has not been reported. */
  pending?: boolean;
}

interface RootTranscriptOptions {
  sessions: readonly Session[];
  now: number;
  limit?: number;
  snapshotStartRow?: string;
  issueEdge?: (edge: AgentEdge) => string | undefined;
}

interface AgentActivityOptions {
  now: number;
  privateMode: boolean;
  loading?: boolean;
  limit?: number;
  startRow?: string;
  earlierRows?: number;
  outputLimits?: ReadonlyMap<string, number>;
  issueEdge?: (edge: AgentEdge) => string | undefined;
  issueOutput?: (rowId: string) => string;
}

function edgeId(parent: AgentScope, rowId: string, relation: AgentEdge['relation']): string {
  return key('delegation', parent.sessionId, parent.laneId, rowId, relation);
}

function scopedLane(sessions: readonly Session[], scope: AgentScope): { session: Session; lane: Lane } | undefined {
  const session = sessions.find(item => item.id === scope.sessionId);
  const lane = session?.lanes.find(item => item.id === scope.laneId && item.pendingSessionId === undefined);
  return session && lane ? { session, lane } : undefined;
}

/** Resolve only the edges supported by this lane and its exact spawning rows. */
export function directAgentEdges(sessions: readonly Session[], scope: AgentScope): AgentEdge[] {
  const owner = scopedLane(sessions, scope);
  if (!owner) return [];
  const childRollout = owner.session.provider === 'codex'
    && (owner.lane.parentSessionId !== undefined || owner.lane.parent?.relation === 'child');
  const rows = new Map(owner.lane.rows.map(row => [row.id, row]));
  const edges = new Map<string, AgentEdge | undefined>();
  function offer(origin: ParentTarget | undefined, target: AgentScope, pending?: boolean): void {
    if (!origin || origin.sessionId !== scope.sessionId || origin.laneId !== scope.laneId
      || (scope.turnId !== undefined && origin.turnId !== scope.turnId)) return;
    const row = rows.get(origin.rowId);
    if (!row || row.ambiguous || row.turnId !== origin.turnId || (childRollout && row.agentHistory !== 'owned')) return;
    const parent = { sessionId: origin.sessionId, laneId: origin.laneId, turnId: origin.turnId };
    const id = edgeId(parent, origin.rowId, origin.relation);
    edges.set(id, edges.has(id) ? undefined : { id, parent, rowId: origin.rowId, target, relation: origin.relation, pending });
  }
  for (const lane of owner.session.lanes.slice(1)) {
    if (lane.parent?.relation === 'agent' || (lane.parent?.relation === 'child' && lane.pendingSessionId)) {
      offer(lane.parent, { sessionId: lane.pendingSessionId ?? owner.session.id, laneId: lane.id }, lane.pendingIdentity);
    }
  }
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const childId of new Set(owner.session.children.map(edge => edge.sessionId))) {
    const child = byId.get(childId);
    const lane = child?.lanes[0];
    if (!child || !lane) continue;
    if (child.provider === 'codex' && lane.parent?.relation === 'child') {
      offer(lane.parent, { sessionId: child.id, laneId: lane.id });
    }
    for (const link of child.launches ?? []) {
      if (link.sessionId !== child.id || link.laneId !== lane.id || !lane.turns.some(turn => turn.id === link.turnId)) continue;
      offer(link.parent, { sessionId: link.sessionId, laneId: link.laneId, turnId: link.turnId });
    }
  }
  return [...edges.values()].filter((edge): edge is AgentEdge => edge !== undefined);
}

function edgeTarget(sessions: readonly Session[], edge: AgentEdge): { session: Session; lane: Lane } | undefined {
  const target = scopedLane(sessions, edge.target);
  if (target) return target;
  const session = sessions.find(item => item.id === edge.parent.sessionId);
  const lane = session?.lanes.find(item => item.pendingSessionId === edge.target.sessionId && item.id === edge.target.laneId
    && item.parent?.laneId === edge.parent.laneId && item.parent.rowId === edge.rowId);
  return session && lane ? { session, lane } : undefined;
}

function agentStatus(state: State | undefined): AgentIdentity['status'] {
  switch (state) {
    case 'Live': return 'Running';
    case 'Completed': case 'Failed': return state;
    case 'Stopped': case 'Interrupted': case 'Aborted': return 'Stopped';
    default: return 'Outcome unknown';
  }
}

function targetRows(lane: Lane, edge: AgentEdge): TimelineRow[] {
  return lane.rows.filter(row => (edge.target.turnId === undefined || row.turnId === edge.target.turnId)
    && (edge.relation !== 'child' || row.agentHistory === 'owned'));
}

export function agentIdentity(sessions: readonly Session[], edge: AgentEdge, now: number, privateMode: boolean): AgentIdentity {
  const target = edgeTarget(sessions, edge);
  const lane = target?.lane;
  const scoped = lane ? targetRows(lane, edge) : [];
  const turn = edge.target.turnId === undefined ? undefined : lane?.turns.find(item => item.id === edge.target.turnId);
  const ownedTurns = new Set(edge.relation === 'child' ? scoped.map(row => row.turnId) : []);
  const childTurn = lane?.turns.findLast(item => ownedTurns.has(item.id));
  const parentCompleted = lane?.parentStatus === 'Completed'
    && (lane.parentEndedAt === undefined || (childTurn?.startedAt ?? 0) <= lane.parentEndedAt);
  const childState = parentCompleted ? lane?.parentStatus : childTurn?.state ?? lane?.parentStatus;
  const state = edge.relation === 'child' ? childState : edge.target.turnId === undefined ? lane?.status : turn?.state;
  const start = edge.relation === 'child' ? lane?.parent?.at ?? childTurn?.startedAt
    : turn?.startedAt ?? (edge.target.turnId === undefined ? lane?.startedAt ?? lane?.parent?.at : undefined);
  const observedEnd = edge.relation === 'child' ? (parentCompleted ? lane?.parentEndedAt : childTurn?.endedAt)
    : turn?.endedAt ?? (edge.target.turnId === undefined && (!lane?.pending || lane.updatedAt !== start) ? lane?.updatedAt : undefined);
  const end = state === 'Live' ? now : observedEnd;
  const elapsedMs = turn?.durationMs ?? (start === undefined || end === undefined ? undefined : Math.max(0, end - start));
  const neutral = edge.relation === 'launch' ? 'Linked run' : 'Agent';
  const titleSource = edge.relation === 'agent' ? lane?.title
    : scoped.find(row => row.kind === 'user' && !row.ambiguous)?.text;
  const label = privateMode ? neutral : agentActivityText(titleSource, 100)?.replace(/\s+/g, ' ').trim() || neutral;
  const provider = providerLabels[edge.relation === 'agent' ? 'claude-code' : 'codex'];
  return { label, provider, status: agentStatus(state), tone: state === undefined ? 'neutral' : toneFor(state), elapsedMs };
}

function isCodexLaunch(session: Session, row: TimelineRow): boolean {
  return session.provider === 'claude-code' && row.kind === 'tool' && row.label === 'Bash'
    && row.command !== undefined && parseCodexInvocation(row.command) !== undefined;
}

function delegationLinks(sessions: readonly Session[], edge: AgentEdge, privateMode: boolean): CardLink[] {
  const target = scopedLane(sessions, edge.target);
  const links: CardLink[] = [];
  if (privateMode) links.push({ label: 'Transcript', reason: 'hidden in private display' });
  else if (target?.lane.transcriptAvailable) {
    links.push({ label: edge.relation === 'launch' ? 'Open transcript · full rollout' : 'Open transcript',
      request: { type: 'openTranscript', session: edge.target.sessionId, lane: edge.target.laneId } });
  } else links.push({ label: 'Transcript', reason: 'no transcript is recorded for this agent' });
  if (target) {
    links.push(
      { label: 'Files · destination session', request: { type: 'openSessionView', session: target.session.id, tab: 'files' } },
      { label: 'Agent map · destination session', request: { type: 'openSessionView', session: target.session.id, tab: 'map' } },
    );
  } else {
    links.push(
      { label: 'Files · destination session', reason: 'destination session unavailable' },
      { label: 'Agent map · destination session', reason: 'destination session unavailable' },
    );
  }
  links.push({ label: 'Launch evidence', request: { type: 'goto', session: edge.parent.sessionId, lane: edge.parent.laneId, row: edge.rowId } });
  return links;
}

function transcriptWaiting(lane: Lane | undefined, agent: AgentIdentity): boolean {
  return Boolean(lane && !lane.historyUnavailable && (lane.historyPending || (!lane.transcriptAvailable && agent.status === 'Running')));
}

function activityLabel(row: TimelineRow): string | undefined {
  switch (row.kind) {
    case 'user': return 'Prompt';
    case 'assistant': return row.terminal ? 'Final result' : 'Message';
    case 'final': return 'Final result';
    case 'agent': return row.text ? 'Agent message' : 'Subagent activity';
    case 'tool': return toolLabel(row);
    case 'result': return 'Tool result';
    default: return undefined;
  }
}

function toolLabel(row: TimelineRow): string {
  return readerToolLabels.has(row.label) ? row.label : 'Tool';
}

function delegation(sessions: readonly Session[], edge: AgentEdge, options: Pick<AgentActivityOptions, 'now' | 'privateMode' | 'issueEdge'>): AgentDelegation {
  const { now, privateMode, issueEdge } = options;
  const agent = agentIdentity(sessions, edge, now, privateMode);
  const lane = edgeTarget(sessions, edge)?.lane;
  const recentRow = !privateMode && lane ? targetRows(lane, edge).findLast(row => !row.ambiguous && activityLabel(row)) : undefined;
  const recent = recentRow ? activityLabel(recentRow) : undefined;
  const reason = !lane?.transcriptAvailable || lane.historyPending || lane.historyUnavailable
    ? (transcriptWaiting(lane, agent) ? 'Waiting for transcript' : 'Transcript unavailable') : undefined;
  return { ...agent, id: edge.id, ref: issueEdge?.(edge), recent, reason, links: delegationLinks(sessions, edge, privateMode) };
}

function unresolved(scope: AgentScope, row: TimelineRow, session: Session): AgentDelegation | undefined {
  const launch = isCodexLaunch(session, row);
  if (!row.spawnAttempt && !launch) return undefined;
  const relation = launch ? 'launch' : session.provider === 'codex' ? 'child' : 'agent';
  return {
    id: edgeId(scope, row.id, relation), label: launch ? 'Linked run' : 'Agent',
    provider: providerLabels[launch ? 'codex' : session.provider], status: 'Outcome unknown', tone: 'neutral',
    reason: 'Launch unresolved. Exact spawning identity is unavailable or conflicting.',
  };
}

function bySpawningRow(edges: readonly AgentEdge[]): Map<string, AgentEdge[]> {
  const result = new Map<string, AgentEdge[]>();
  for (const edge of edges) result.set(edge.rowId, [...result.get(edge.rowId) ?? [], edge]);
  return result;
}

function changesByRow(files: readonly FileAction[], scope?: AgentScope): Map<string, FileAction[]> {
  const byRow = new Map<string, FileAction[]>();
  for (const file of files) {
    if (!changeKinds.has(file.kind) || (scope && (file.laneId !== scope.laneId
      || (scope.turnId !== undefined && file.turnId !== scope.turnId)))) continue;
    const actions = byRow.get(file.rowId);
    if (actions) actions.push(file);
    else byRow.set(file.rowId, [file]);
  }
  return byRow;
}

function pageStart(rows: readonly TimelineRow[], limit: number, startRow?: string, earlierRows = 0): number {
  const start = Math.max(0, rows.length - limit);
  if (!startRow) return start;
  const anchored = rows.findIndex(row => row.id === startRow);
  return anchored < 0 ? start : Math.min(start, Math.max(0, anchored - earlierRows));
}

function rootPageStart(rows: readonly TimelineRow[], limit = agentRootPageSize, snapshotStartRow?: string): number {
  const snapshot = snapshotStartRow === undefined ? -1 : rows.findIndex(row => row.id === snapshotStartRow);
  if (snapshot < 0) return Math.max(0, rows.length - limit);
  return Math.max(0, snapshot - Math.max(0, limit - agentRootPageSize));
}

export function rootAgentEarlier(sessions: readonly Session[], scope: AgentScope, limit?: number, snapshotStartRow?: string): boolean {
  const lane = scopedLane(sessions, scope)?.lane;
  if (snapshotStartRow !== undefined && !lane?.rows.some(row => row.id === snapshotStartRow)) return false;
  return lane !== undefined && rootPageStart(lane.rows, limit, snapshotStartRow) > 0;
}

function toolActivity(
  row: TimelineRow, files: readonly FileAction[], options: AgentActivityOptions, edge: AgentEdge, launch: boolean,
): AgentToolActivity {
  const input = launch ? undefined : agentActivityText(row.input, 12_000);
  const resultInScope = edge.relation === 'child' ? row.readerOutputAttributed === true
    : edge.relation !== 'launch' || row.readerOutputTurnMatched === true;
  const showOutput = !launch && row.readerOutput && resultInScope;
  const stdout = showOutput ? agentActivityText(row.stdout) : undefined;
  const stderr = showOutput ? agentActivityText(row.stderr) : undefined;
  const output = showOutput && row.stdout === undefined && row.stderr === undefined ? agentActivityText(row.output) : undefined;
  const limit = options.outputLimits?.get(row.id) ?? agentOutputPageSize;
  const more = [stdout, stderr, output].some(value => value !== undefined && value.length > limit);
  const diff: NonNullable<AgentToolActivity['diff']>[number][] = [];
  for (const action of files.slice(0, maxFoldedDiffs)) {
    const path = agentActivityText(action.path, 240);
    const hunks = path && showOutput && recordedHunks(agentActivityText(action.diff));
    if (hunks) diff.push(...previewHunks(hunks).diff.map(hunk => ({ ...hunk, heading: path + ' ' + hunk.heading })));
  }
  return {
    input, stdout: stdout?.slice(0, limit), stderr: stderr?.slice(0, limit), output: output?.slice(0, limit),
    outputRef: more ? options.issueOutput?.(row.id) : undefined,
    outputTruncated: showOutput ? row.outputTruncated : undefined,
    durationMs: resultInScope ? row.durationMs : undefined, exitCode: resultInScope ? row.exitCode : undefined,
    status: resultInScope || row.kind === 'result' ? outcome(row) : 'Outcome not recorded', diff: diff.length ? diff : undefined,
  };
}

function activityRow(
  row: TimelineRow, text: string | undefined, session: Session, files: readonly FileAction[], terminal: boolean,
  children: readonly AgentDelegation[], edge: AgentEdge, options: AgentActivityOptions,
): AgentActivityRow | undefined {
  const base = { id: row.id, children: children.length ? children : undefined };
  if (options.privateMode) return children.length ? { ...base, kind: 'notice', label: 'Delegation' } : undefined;
  switch (row.kind) {
    case 'user': return text ? { ...base, kind: 'prompt', label: 'Prompt', text } : undefined;
    case 'final': case 'assistant': {
      if (row.terminal && !terminal) return undefined;
      if (terminal) return text ? { ...base, kind: 'final', label: 'Final result', text } : undefined;
      const commentary = row.commentary || (session.provider === 'claude-code' && row.kind === 'assistant');
      return text ? { ...base, kind: commentary ? 'commentary' : 'message', label: commentary ? 'Commentary' : 'Message', text } : undefined;
    }
    case 'tool': {
      const launch = isCodexLaunch(session, row);
      const label = launch ? 'Bash · Launch' : toolLabel(row);
      return { ...base, kind: 'tool', label, tool: toolActivity(row, files, options, edge, launch) };
    }
    case 'result':
      return { ...base, kind: 'result', label: row.unmatched ? 'Unmatched tool result' : 'Tool result',
        tool: toolActivity(row, [], options, edge, false) };
    case 'agent':
      if (text) return { ...base, kind: 'message', label: 'Agent message', text };
      if (row.spawnAttempt || children.length) return { ...base, kind: 'notice', label: 'Subagent started' };
      return { ...base, kind: 'notice', label: 'Subagent activity' };
    case 'compact': return { ...base, kind: 'notice', label: 'Context compacted' };
    default: return undefined;
  }
}

function eligibleActivity(row: TimelineRow, privateMode: boolean, hasChildren: boolean, text?: string): boolean {
  if (privateMode) return hasChildren || !!row.spawnAttempt;
  switch (row.kind) {
    case 'user': case 'assistant': case 'final': return text !== undefined;
    case 'agent': case 'tool': case 'result': case 'compact': return true;
    default: return hasChildren;
  }
}

function unresolvedScope(sessions: readonly Session[], session: Session, lane: Lane): boolean {
  // A metadata-only Codex relationship establishes a parent thread, but no spawning row or turn.
  return session.provider === 'codex' && lane === session.lanes[0] && sessions.some(child => {
    const candidate = child.lanes[0];
    return candidate?.parentSessionId === session.id && !candidate.parent;
  });
}

/** Project a single verified occurrence. Off-lane and unattributed rows never enter the reader page. */
export function projectAgentActivity(
  sessions: readonly Session[], edge: AgentEdge, options: AgentActivityOptions,
): AgentActivity & { agent: AgentIdentity } {
  const { now, privateMode, loading } = options;
  const target = edgeTarget(sessions, edge);
  const launch = scopedLane(sessions, edge.parent)?.lane.rows.find(row => row.id === edge.rowId);
  const current = directAgentEdges(sessions, edge.parent).some(candidate => candidate.id === edge.id
    && candidate.target.sessionId === edge.target.sessionId && candidate.target.laneId === edge.target.laneId
    && candidate.target.turnId === edge.target.turnId);
  if (!target || !launch || !current) return { state: 'sourceUnavailable', rows: [], agent: agentIdentity([], edge, now, true) };
  const agent = agentIdentity(sessions, edge, now, privateMode);
  const { session, lane } = target;
  const links = delegationLinks(sessions, edge, privateMode);
  const edges = bySpawningRow(directAgentEdges(sessions, edge.target));
  const all = targetRows(lane, edge);
  const text = new Map<string, string>();
  if (!privateMode) for (const row of all) {
    if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'final' && row.kind !== 'agent') continue;
    const safe = agentActivityText(row.text, 20_000);
    if (safe !== undefined) text.set(row.id, safe);
  }
  const ownsFinal = new Set(all.filter(row => !row.ambiguous && row.terminal === 'response' && text.has(row.id)).map(row => row.turnId));
  const terminalRow = (row: TimelineRow): boolean => !row.ambiguous && !!row.terminal
    && (row.terminal !== 'fallback' || !ownsFinal.has(row.turnId));
  const hasFinal = !privateMode && all.some(row => terminalRow(row) && text.has(row.id));
  const parentResult = !privateMode && !hasFinal ? agentActivityText(lane.parentResult, 20_000) : undefined;
  const recordedPrompt = all.find(row => row.kind === 'user' && !row.ambiguous);
  const delegatedPrompt = !privateMode && edge.relation === 'agent' ? agentActivityText(lane.delegatedPrompt) : undefined;
  const eligible = all.filter(row => (!row.terminal || terminalRow(row))
    && (eligibleActivity(row, privateMode, edges.has(row.id), text.get(row.id)) || (privateMode && isCodexLaunch(session, row))));
  const start = pageStart(eligible, options.limit ?? agentPageSize, options.startRow, options.earlierRows);
  const byRow = changesByRow(privateMode ? [] : session.files, edge.target);
  const rows: AgentActivityRow[] = eligible.slice(start).flatMap(row => {
    const children = (edges.get(row.id) ?? []).map(child => delegation(sessions, child, options));
    if (!children.length) {
      const notice = unresolved(edge.target, row, session);
      if (notice) children.push(notice);
    }
    const projected = activityRow(row, text.get(row.id), session, byRow.get(row.id) ?? [], terminalRow(row), children, edge, options);
    return projected ? [projected] : [];
  });
  if (start === 0 && delegatedPrompt && delegatedPrompt.trim() !== agentActivityText(recordedPrompt?.text)?.trim()) {
    rows.unshift({ id: key(edge.id, 'delegatedPrompt'), kind: 'delegatedPrompt', label: 'Delegated prompt', synthetic: true,
      text: agentActivityText(delegatedPrompt, 20_000) });
  }
  if (parentResult) rows.push({ id: key(edge.id, 'parentResult'), kind: 'parentResult', label: 'Result reported to parent',
    synthetic: true, text: parentResult });
  if (edge.target.turnId === undefined && unresolvedScope(sessions, session, lane)) {
    rows.push({ id: key(edge.id, 'unresolvedScope'), kind: 'notice', label: 'Launch unresolved', synthetic: true,
      text: 'A child thread names this parent, but the exact spawning row is unavailable.' });
  }
  const ended = agent.status === 'Completed' || agent.status === 'Failed' || agent.status === 'Stopped';
  const finalMissing = !privateMode && ended && !hasFinal && !parentResult;
  const historyPartial = lane.historyPartial || (lane.historyPartial === undefined && session.coverage === 'partial')
    || (edge.relation === 'child' && all.length < lane.rows.length);
  let state: AgentActivity['state'] = 'ready';
  if (privateMode) state = 'private';
  else if (loading && (!lane.transcriptAvailable || lane.historyPending)) state = 'loading';
  else if (transcriptWaiting(lane, agent)) state = 'waiting';
  else if (!lane.transcriptAvailable || lane.historyUnavailable) state = 'transcriptUnavailable';
  else if (!rows.length) state = agent.status === 'Running' ? 'emptyActive' : 'empty';
  return { agent, state, rows, earlier: start > 0, finalMissing, historyPartial, links };
}

/** How the recorded evidence describes one file change. */
export function changeState(action: FileAction): string {
  if (action.status === 'applied') return 'Applied';
  if (action.status === 'failed') return 'Failed';
  if (action.status === 'requested') return 'Proposed';
  return 'Unknown';
}

function diffNote(action: FileAction): string {
  if (action.diff === undefined) return action.diffUnavailable ?? 'No patch recorded.';
  if (action.diffKind === 'partial') return 'Partial recorded patch. One side is missing.';
  return '';
}

function outcome(row: Pick<RowView, 'kind' | 'status' | 'exitCode'>): string {
  if (row.kind === 'reasoning') return 'Reasoning';
  if (row.status === 'failed' || (row.exitCode !== undefined && row.exitCode !== 0)) return 'Failed';
  if (row.status === 'success' || row.status === 'completed') return 'Completed';
  if (row.status === 'requested') return 'Requested';
  return row.status ? row.status[0]!.toUpperCase() + row.status.slice(1) : 'Outcome not recorded';
}

/** Full diff through the existing `openDiff` route, only when the recorded patch is eligible. */
export function diffLink(action: FileAction, privateMode: boolean): CardLink {
  if (privateMode) return { label: 'Full diff', reason: 'diffs are hidden in private display mode' };
  if (action.diff === undefined) return { label: 'Full diff', reason: diffNote(action).replace(/\.$/, '') || 'no patch recorded' };
  if (!recordedHunks(action.diff)) return { label: 'Full diff', reason: 'the recorded patch has no eligible hunks' };
  return { label: 'Open full diff', request: { type: 'openDiff', id: action.id } };
}

function activityEntry(row: RowView, actions: readonly FileAction[], privateMode: boolean): ChatCardEntry {
  const parts = [outcome(row), row.durationMs === undefined ? undefined : formatDuration(row.durationMs)];
  for (const action of actions) parts.push(changeState(action) + ' change', diffNote(action) || undefined);
  const output = privateMode || row.kind === 'reasoning' ? undefined
    : safeText(row.output, maxOutput)?.split('\n').slice(0, 4).join('\n');
  const links: CardLink[] = actions.map(action => diffLink(action, privateMode));
  return {
    links: links.length ? links : undefined,
    title: row.kind === 'reasoning' ? 'Reasoning' : row.label + (row.file ? ' · ' + row.file : ''),
    detail: parts.filter(Boolean).join(' · ') + (output ? '\n' + output + (row.outputTruncated ? '…' : '') : ''),
  };
}

function foldCard(rows: readonly RowView[], actions: ReadonlyMap<string, readonly FileAction[]>, privateMode: boolean): ChatCard {
  const diff: NonNullable<ChatCard['diff']>[number][] = [];
  if (!privateMode) {
    let shown = 0;
    for (const row of rows) {
      const edit = actions.get(row.id)?.find(action => action.diff !== undefined);
      const hunks = edit && recordedHunks(edit.diff);
      if (edit && hunks && shown < maxFoldedDiffs) {
        shown++;
        diff.push(...previewHunks(hunks).diff.map(hunk => ({ ...hunk, heading: edit.path + ' ' + hunk.heading })));
      }
    }
  }
  return {
    title: 'Activity · ' + summary(rows), folded: true, scope: '', state: 'ready',
    entries: rows.slice(0, maxEntries).map(row => activityEntry(row, actions.get(row.id) ?? [], privateMode)),
    message: rows.length > maxEntries ? rows.length - maxEntries + ' more events are in the Timeline.' : undefined,
    diff: diff.length ? diff : undefined,
  };
}

function summary(rows: readonly RowView[]): string {
  const tools = rows.filter(row => row.kind === 'tool');
  const failed = tools.filter(row => outcome(row) === 'Failed').length;
  const thinking = rows.some(row => row.kind === 'reasoning');
  return [tools.length ? tools.length + (tools.length === 1 ? ' tool call' : ' tool calls') : undefined,
    failed ? failed + ' failed' : undefined, thinking ? 'reasoning' : undefined].filter(Boolean).join(' · ') || 'Activity';
}

function agentLinks(node: AgentNode, spawnRow: string | undefined, privateMode: boolean): CardLink[] {
  const launch = node.parentInfo.targets[0];
  return [
    !privateMode && node.transcript ? { label: 'Open transcript', request: { type: 'openTranscript', session: node.sessionId, lane: node.laneId } }
      : { label: 'Transcript', reason: privateMode ? 'hidden in private display' : 'no transcript is recorded for this agent' },
    { label: 'Files', tab: 'files' },
    { label: 'Agent map', tab: 'map' },
    launch && spawnRow !== undefined
      ? { label: 'Launch evidence', request: { type: 'goto', session: launch.sessionId, lane: launch.laneId, row: launch.rowId } }
      : { label: 'Launch evidence', reason: node.parentInfo.reason ?? 'launch not resolved yet' },
  ];
}

function agentCard(node: AgentNode, resolved: boolean, privateMode: boolean): ChatCard {
  const entries: ChatCardEntry[] = [
    { title: 'Owner', detail: node.title + (node.kind === 'codex-run' ? ' (linked Codex run)' : '') },
    { title: 'Status', detail: node.status, links: agentLinks(node, resolved ? node.parentInfo.targets[0]?.rowId : undefined, privateMode) },
  ];
  if (!resolved) entries.push({ title: 'Launch', detail: node.parentInfo.reason ?? 'Launch not resolved yet. Shown at its observed position.' });
  return { title: 'Agent · ' + node.title, folded: true, scope: '', state: 'ready', entries };
}

/**
 * Chat-first transcript rows from the recorded session. Prompts and replies stay as rows. Thinking and tool
 * activity fold into one block per run of activity. Each delegated agent groups at its spawning row, and an
 * unresolved launch keeps its observed position. Source order and exact identity keys are preserved.
 */
export function projectTranscript(
  detail: SessionDetail, actions: readonly FileAction[], privateMode: boolean, options?: RootTranscriptOptions,
): TranscriptRow[] {
  const main = detail.agents.find(agent => agent.kind === 'main')?.laneId;
  if (!main) return [];
  const scope = { sessionId: detail.id, laneId: main };
  const owner = options && scopedLane(options.sessions, scope);
  const raw = new Map<string, TimelineRow>();
  let visible = detail.rows.filter(row => row.laneId === main);
  if (owner) {
    const { lane } = owner;
    const lanes = new Map([[lane.id, lane]]);
    const projected = lane.rows.slice(rootPageStart(lane.rows, options?.limit, options?.snapshotStartRow));
    visible = projected.map(row => {
      raw.set(row.id, row);
      return rowView(row, lanes, privateMode);
    });
  }
  const links = options && owner ? bySpawningRow(directAgentEdges(options.sessions, scope)) : new Map<string, AgentEdge[]>();
  const legacy = new Map<string, AgentNode[]>();
  const pending: AgentNode[] = [];
  if (!options) for (const node of detail.agents.filter(agent => agent.laneId !== main && agent.kind !== 'main')) {
    const spawn = node.parentInfo.state === 'resolved' ? node.parentInfo.targets.find(target => target.laneId === main) : undefined;
    if (spawn) legacy.set(spawn.rowId, [...legacy.get(spawn.rowId) ?? [], node]);
    else if (node.parentInfo.state === 'unresolved') pending.push(node);
  }
  const out: TranscriptRow[] = [];
  const changes = changesByRow(actions, scope);
  let run: RowView[] = [];
  const flush = (): void => {
    if (!run.length) return;
    out.push({ id: 'fold:' + run[0]!.id, role: 'tool', text: summary(run), card: foldCard(run, changes, privateMode),
      sourceRowId: run[0]!.id, keys: run.flatMap(row => row.nativeKeys ?? []) });
    run = [];
  };
  const place = (node: AgentNode, resolved: boolean): void => {
    out.push({ id: 'agent:' + node.id, role: 'tool', text: node.title + ' · ' + node.status, card: agentCard(node, resolved, privateMode) });
  };
  const firstAt = (node: AgentNode): number => detail.rows.find(row => row.laneId === node.laneId)?.at ?? Infinity;
  pending.sort((a, b) => firstAt(a) - firstAt(b));
  for (const row of visible) {
    while (pending.length && row.at !== undefined && firstAt(pending[0]!) <= row.at) {
      flush();
      place(pending.shift()!, false);
    }
    const spawn = raw.get(row.id);
    const edges = links.get(row.id) ?? [];
    const children = edges.length && options ? edges.map(edge => delegation(options.sessions, edge, { ...options, privateMode })) : [];
    if (!children.length && owner && spawn) {
      const notice = unresolved(scope, spawn, owner.session);
      if (notice) children.push(notice);
    }
    if (row.id === options?.snapshotStartRow || children.length) flush();
    if (row.kind === 'user' || row.kind === 'assistant' || row.kind === 'final') {
      flush();
      const text = row.text ?? (privateMode ? 'Hidden in private display mode' : undefined);
      if (text) out.push({ id: row.id, role: row.kind === 'user' ? 'user' : 'assistant', text, sourceRowId: row.id, keys: row.nativeKeys });
    } else if (folded.has(row.kind) || (row.kind === 'agent' && children.length)) run.push(row);
    if (children.length) {
      flush();
      for (const child of children) out.push({
        id: 'agent:' + child.id, role: 'tool', text: '', delegation: child, sourceRowId: row.id,
        delegationCallKeys: edges.length && row.kind === 'tool' ? row.nativeKeys : undefined,
      });
    }
    const previous = legacy.get(row.id);
    if (previous) {
      flush();
      for (const node of previous) place(node, true);
    }
  }
  flush();
  for (const node of pending) place(node, false);
  if (options && owner && (owner.session.lanes.slice(1).some(lane => !lane.parent)
      || unresolvedScope(options.sessions, owner.session, owner.lane))) {
    out.push({ id: key(scope.sessionId, 'unresolvedAgentScope'), role: 'notice', unresolvedDelegation: true,
      text: 'Launch unresolved. An agent has no verified spawning row in this conversation.' });
  }
  return out;
}
