import { formatDuration } from '../../shared/format';
import type { AgentNode, CardLink, ChatCard, ChatCardEntry, ChatRow, RowView, SessionDetail } from '../../shared/protocol';
import { recordedHunks } from '../files/diff';
import { safeText } from '../privacy/projection';
import type { FileAction } from '../sessions/types';
import { previewHunks } from './chat-cards';

export type TranscriptRow = ChatRow & { keys?: readonly string[] };

const maxEntries = 40;
const maxOutput = 240;
const maxFoldedDiffs = 3;
const changeKinds = new Set<FileAction['kind']>(['edit', 'add', 'delete', 'move']);
const folded = new Set(['reasoning', 'tool', 'result']);

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

function outcome(row: RowView): string {
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
  const own = actions.filter(action => action.rowId === row.id && changeKinds.has(action.kind));
  const parts = [outcome(row), row.durationMs === undefined ? undefined : formatDuration(row.durationMs)];
  for (const action of own) parts.push(changeState(action) + ' change', diffNote(action) || undefined);
  const output = privateMode || row.kind === 'reasoning' ? undefined
    : safeText(row.output, maxOutput)?.split('\n').slice(0, 4).join('\n');
  const links: CardLink[] = own.map(action => diffLink(action, privateMode));
  return {
    links: links.length ? links : undefined,
    title: row.kind === 'reasoning' ? 'Reasoning' : row.label + (row.file ? ' · ' + row.file : ''),
    detail: parts.filter(Boolean).join(' · ') + (output ? '\n' + output + (row.outputTruncated ? '…' : '') : ''),
  };
}

function foldCard(rows: readonly RowView[], actions: readonly FileAction[], privateMode: boolean): ChatCard {
  const diff: NonNullable<ChatCard['diff']>[number][] = [];
  if (!privateMode) {
    let shown = 0;
    for (const row of rows) {
      const edit = actions.find(action => action.rowId === row.id && changeKinds.has(action.kind) && action.diff !== undefined);
      const hunks = edit && recordedHunks(edit.diff);
      if (edit && hunks && shown < maxFoldedDiffs) {
        shown++;
        diff.push(...previewHunks(hunks).diff.map(hunk => ({ ...hunk, heading: edit.path + ' ' + hunk.heading })));
      }
    }
  }
  return {
    title: 'Activity · ' + summary(rows), folded: true, scope: '', state: 'ready',
    entries: rows.slice(0, maxEntries).map(row => activityEntry(row, actions, privateMode)),
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

function agentLinks(node: AgentNode, spawnRow: string | undefined): CardLink[] {
  const launch = node.parentInfo.targets[0];
  return [
    node.transcript ? { label: 'Open transcript', request: { type: 'openTranscript', session: node.sessionId, lane: node.laneId } }
      : { label: 'Transcript', reason: 'no transcript is recorded for this agent' },
    { label: 'Files', tab: 'files' },
    { label: 'Agent map', tab: 'map' },
    launch && spawnRow !== undefined
      ? { label: 'Launch evidence', request: { type: 'goto', session: launch.sessionId, lane: launch.laneId, row: launch.rowId } }
      : { label: 'Launch evidence', reason: node.parentInfo.reason ?? 'launch not resolved yet' },
  ];
}

function agentCard(node: AgentNode, resolved: boolean): ChatCard {
  const entries: ChatCardEntry[] = [
    { title: 'Owner', detail: node.title + (node.kind === 'codex-run' ? ' (linked Codex run)' : '') },
    { title: 'Status', detail: node.status, links: agentLinks(node, resolved ? node.parentInfo.targets[0]?.rowId : undefined) },
  ];
  if (!resolved) entries.push({ title: 'Launch', detail: node.parentInfo.reason ?? 'Launch not resolved yet. Shown at its observed position.' });
  return { title: 'Agent · ' + node.title, folded: true, scope: '', state: 'ready', entries };
}

/**
 * Chat-first transcript rows from the recorded session. Prompts and replies stay as rows. Thinking and tool
 * activity fold into one block per run of activity. Each delegated agent groups at its spawning row, and an
 * unresolved launch keeps its observed position. Source order and exact identity keys are preserved.
 */
export function projectTranscript(detail: SessionDetail, actions: readonly FileAction[], privateMode: boolean): TranscriptRow[] {
  const main = detail.agents.find(agent => agent.kind === 'main')?.laneId;
  if (!main) return [];
  const children = detail.agents.filter(agent => agent.laneId !== main && agent.kind !== 'main');
  const bySpawn = new Map<string, AgentNode[]>();
  const unresolved: AgentNode[] = [];
  for (const node of children) {
    const spawn = node.parentInfo.state === 'resolved' ? node.parentInfo.targets.find(target => target.laneId === main) : undefined;
    if (spawn) bySpawn.set(spawn.rowId, [...bySpawn.get(spawn.rowId) ?? [], node]);
    else unresolved.push(node);
  }
  const out: TranscriptRow[] = [];
  let run: RowView[] = [];
  const flush = (): void => {
    if (!run.length) return;
    out.push({ id: 'fold:' + run[0]!.id, role: 'tool', text: summary(run), card: foldCard(run, actions, privateMode),
      keys: run.flatMap(row => row.nativeKeys ?? []) });
    run = [];
  };
  const place = (node: AgentNode, resolved: boolean): void => {
    out.push({ id: 'agent:' + node.id, role: 'tool', text: node.title + ' · ' + node.status, card: agentCard(node, resolved) });
  };
  const firstAt = (node: AgentNode): number => detail.rows.find(row => row.laneId === node.laneId)?.at ?? Infinity;
  const pending = [...unresolved].sort((a, b) => firstAt(a) - firstAt(b));
  for (const row of detail.rows) {
    if (row.laneId !== main) continue;
    while (pending.length && row.at !== undefined && firstAt(pending[0]!) <= row.at) {
      flush();
      place(pending.shift()!, false);
    }
    if (row.kind === 'user' || row.kind === 'assistant' || row.kind === 'final') {
      flush();
      const text = row.text ?? (privateMode ? 'Hidden in private display mode' : undefined);
      if (text) out.push({ id: row.id, role: row.kind === 'user' ? 'user' : 'assistant', text, keys: row.nativeKeys });
    } else if (folded.has(row.kind)) run.push(row);
    const spawned = bySpawn.get(row.id);
    if (spawned) {
      flush();
      for (const node of spawned) place(node, true);
    }
  }
  flush();
  for (const node of pending) place(node, false);
  return out;
}
