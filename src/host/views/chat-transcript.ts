import { formatDuration } from '../../shared/format';
import type { AgentNode, CardLink, ChatCard, ChatCardEntry, ChatRow, RowTarget, RowView, SessionDetail } from '../../shared/protocol';
import { recordedHunks, safeFileText } from '../files/diff';
import { safePath, safeText } from '../privacy/projection';
import { parseCodexInvocation } from '../sessions/launch-command';
import type { FileAction, Session } from '../sessions/types';
import { previewHunks } from './chat-cards';
import { buildDetail, buildLaneRows, providerLabels } from './models';

export type TranscriptRow = ChatRow & { keys?: readonly string[] };

export interface TranscriptSources {
  session: Session;
  sessions: readonly Session[];
  profileLabel?(session: Session): string | undefined;
}

const maxChildRows = 40;
const maxChildDepth = 4;
const maxNestedRows = 300;
const maxOutput = 1600;
const maxOutputLines = 20;
const maxFileEntries = 8;
const maxFoldedDiffs = 2;
const inlineDiffBudget = { hunks: 2, lines: 12, lineText: 200 };
const changeKinds = new Set<FileAction['kind']>(['edit', 'add', 'delete', 'move']);

export function changeState(action: FileAction): string {
  if (action.status === 'applied') return 'Applied';
  if (action.status === 'failed') return 'Failed';
  if (action.status === 'requested') return 'Proposed';
  return 'Unknown';
}

function diffNote(action: FileAction): string | undefined {
  if (action.diff === undefined) {
    return action.diffUnavailable === 'Preimage not recorded'
      ? 'Previous content unavailable. No preimage was recorded.'
      : safeText(action.diffUnavailable, 120) ?? 'No patch recorded.';
  }
  if (action.diffKind === 'partial') return 'Partial recorded patch. Complete file sides are unavailable.';
  return undefined;
}

function outcome(row: RowView): string {
  if (row.status === 'failed' || (row.exitCode !== undefined && row.exitCode !== 0)) return 'Failed';
  if (row.status === 'success' || row.status === 'completed') return 'Completed';
  if (row.status === 'requested') return 'Requested';
  if (row.status === 'unknown' || !row.status) return 'Outcome not recorded';
  return (safeText(row.status, 60) ?? 'Unknown').replace(/^./, first => first.toUpperCase());
}

/** Use the same recorded file evidence route as Files. */
export function diffLink(action: FileAction, privateMode: boolean): CardLink {
  if (privateMode) return { label: 'Full diff', reason: 'Diffs are hidden in private display mode.' };
  if (!safePath(action.path) || (action.movePath !== undefined && !safePath(action.movePath))) {
    return { label: 'Full diff', reason: 'The recorded path is unavailable.' };
  }
  if (action.diff === undefined) return { label: 'Full diff', reason: diffNote(action) };
  if (!recordedHunks(action.diff) && safeFileText(action.diff) !== '') {
    return { label: 'Full diff', reason: 'The recorded patch has no eligible hunks.' };
  }
  return { label: 'Open full diff', request: { type: 'openDiff', id: action.id } };
}

function rowLink(label: string, target: RowTarget): CardLink {
  return { label, request: { type: 'goto', session: target.sessionId, lane: target.laneId, row: target.rowId } };
}

function boundedText(value: string | undefined, truncated = false): string | undefined {
  const text = safeText(value, maxOutput);
  if (!text) return undefined;
  const lines = text.split('\n', maxOutputLines + 1);
  if (lines.length > maxOutputLines) return lines.slice(0, maxOutputLines).join('\n') + '\nOutput shortened for display.';
  return text + (truncated || text.length > maxOutput ? '\nOutput shortened for display.' : '');
}

function fileEntry(action: FileAction, privateMode: boolean): ChatCardEntry | undefined {
  const path = safePath(action.path);
  if (!path || (action.movePath !== undefined && !safePath(action.movePath))) return undefined;
  const changed = changeKinds.has(action.kind);
  const links: CardLink[] = [{ label: 'Open file', request: { type: 'openFile', id: action.id } }];
  if (changed && !privateMode && action.diff !== undefined) links.push(diffLink(action, false));
  return {
    title: path,
    detail: changed ? [changeState(action) + ' change', privateMode ? undefined : diffNote(action)].filter(Boolean).join(' · ') : undefined,
    links,
  };
}

function activityCard(row: RowView, actions: readonly FileAction[], session: string, privateMode: boolean, launchUnresolved: boolean): ChatCard {
  const thinking = row.kind === 'reasoning';
  const label = thinking ? 'Thinking' : privateMode && row.kind === 'task' ? 'Background task' : row.label;
  const status = thinking ? undefined : outcome(row);
  const target = row.file ?? actions[0]?.label;
  const summary = [label, safeText(target, 100), ...(row.signals?.map(signal => signal.label) ?? [])].filter(Boolean).join(' · ');
  const rawSummary = !privateMode && thinking && row.text !== 'Thinking' ? row.text : undefined;
  const command = privateMode || thinking ? undefined : boundedText(row.command);
  const output = privateMode || thinking ? undefined : boundedText(row.output, row.outputTruncated);
  const body = privateMode || command || output || thinking ? undefined : boundedText(row.text, row.textTruncated);
  const duration = row.durationMs === undefined ? undefined : formatDuration(row.durationMs);
  const exit = row.exitCode === undefined ? undefined : 'Exit ' + row.exitCode;
  const metadata = [duration, exit].filter(Boolean).join(' · ');
  const entries: ChatCardEntry[] = [];
  if (metadata) entries.push({ title: 'Recorded timing and exit', detail: metadata });
  if (rawSummary) entries.push({ title: 'Summary', output: boundedText(rawSummary, row.textTruncated) });
  if (command) entries.push({ title: 'Command', output: command });
  if (body) entries.push({ title: 'Details', output: body });
  if (output || row.kind === 'tool') entries.push({
    title: output ? 'Output' : privateMode ? 'Output hidden' : status === 'Requested' ? 'Awaiting result' : 'Output unavailable',
    output, evidence: row.nativeKeys?.[0],
  });
  for (const action of actions.slice(0, maxFileEntries)) {
    const entry = fileEntry(action, privateMode);
    if (entry) entries.push(entry);
  }

  const diff: NonNullable<ChatCard['diff']>[number][] = [];
  let clipped = false;
  let shown = 0;
  if (!privateMode) for (const action of actions) {
    if (!changeKinds.has(action.kind) || !safePath(action.path) || (action.movePath !== undefined && !safePath(action.movePath))) continue;
    const hunks = recordedHunks(action.diff);
    if (!hunks) continue;
    if (shown >= maxFoldedDiffs) {
      clipped = true;
      break;
    }
    shown++;
    const preview = previewHunks(hunks, inlineDiffBudget);
    clipped ||= preview.clipped;
    diff.push(...preview.diff.map(hunk => ({ ...hunk, heading: action.path + ' ' + hunk.heading })));
  }
  const message = [
    launchUnresolved ? 'No verified Codex run is linked to this call.' : undefined,
    row.kind === 'result' ? 'No unique matching tool call was recorded.' : undefined,
    actions.length > maxFileEntries ? 'More file evidence is available in Files.' : undefined,
    clipped ? 'Preview shortened. Open the recorded diff for the remaining evidence.' : undefined,
  ].filter(Boolean).join(' ');
  return {
    title: summary, outcome: status, folded: true, scope: '', state: 'ready', entries, message: message || undefined,
    diff: diff.length ? diff : undefined,
    links: [rowLink('Open Timeline evidence', { sessionId: session, laneId: row.laneId, rowId: row.id })],
  };
}

function signalCard(row: RowView, session: string): ChatCard {
  const links = [
    row.links?.edit && rowLink('Go to last edit', row.links.edit),
    row.links?.check && rowLink('Go to last check', row.links.check),
  ].filter((link): link is CardLink => Boolean(link));
  return {
    title: row.label, scope: '', state: 'ready', folded: true,
    message: row.signals?.[0]?.detail,
    links: links.length ? links : [rowLink('Open Timeline evidence', { sessionId: session, laneId: row.laneId, rowId: row.id })],
  };
}

function projectRow(row: RowView, actions: readonly FileAction[], session: string, privateMode: boolean, launchUnresolved: boolean): TranscriptRow | undefined {
  const base = { id: row.id, keys: row.nativeKeys };
  if (row.kind === 'user' || row.kind === 'assistant' || row.kind === 'final') {
    const text = privateMode ? 'Hidden in private display mode.' : row.text;
    return text ? { ...base, role: row.kind === 'user' ? 'user' : 'assistant', text } : undefined;
  }
  if (row.kind === 'tool' || row.kind === 'reasoning' || row.kind === 'result' || row.kind === 'task'
    || (row.kind === 'system' && actions.length)) {
    return { ...base, role: 'tool', text: '', identityUnresolved: row.kind === 'result' || undefined,
      card: activityCard(row, actions, session, privateMode, launchUnresolved) };
  }
  if (row.kind === 'signal') return { ...base, role: 'notice', text: '', card: signalCard(row, session) };
  if (row.kind === 'compact') return { ...base, role: 'notice', text: row.label };
  return undefined;
}

interface Group {
  id: string;
  node: AgentNode;
  spawn?: RowTarget;
  turn?: string;
  at?: number;
}

interface Scope {
  detail: SessionDetail;
  session?: Session;
  files: Map<string, FileAction[]>;
  rows: Map<string, RowView[]>;
  launchRows: Set<string>;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function makeScope(detail: SessionDetail, actions: readonly FileAction[], session?: Session): Scope {
  const files = new Map<string, FileAction[]>();
  for (const action of actions) append(files, action.rowId, action);
  const rows = new Map<string, RowView[]>();
  for (const row of detail.rows) append(rows, row.laneId, row);
  const launchRows = new Set<string>();
  if (session?.provider === 'claude-code') for (const lane of session.lanes) {
    for (const row of lane.rows) {
      if (row.kind === 'tool' && row.label === 'Bash' && row.command && parseCodexInvocation(row.command)) launchRows.add(row.id);
    }
  }
  return { detail, session, files, rows, launchRows };
}

function groupsFor(scope: Scope, laneId: string, sources: ReadonlyMap<string, Session>): Group[] {
  const { detail, session } = scope;
  const main = detail.agents.find(node => node.kind === 'main');
  const groups: Group[] = [];
  for (const node of detail.agents) {
    if (node.kind === 'main') continue;
    const targets = node.parentInfo.targets.filter(target => target.sessionId === detail.id && target.laneId === laneId);
    if (!targets.length) {
      if (main?.laneId === laneId && node.parentInfo.state !== 'resolved') {
        const child = sources.get(node.sessionId)?.lanes.find(item => item.id === node.laneId);
        const first = child?.rows[0]?.at ?? scope.rows.get(node.laneId)?.[0]?.at ?? child?.startedAt;
        groups.push({ id: 'agent:' + node.id, node, at: first });
      }
      continue;
    }
    for (const spawn of targets) {
      const edge = session?.children.find(item => item.sessionId === node.sessionId && item.laneId === node.laneId && item.rowId === spawn.rowId);
      const id = 'agent:' + node.id + (node.sessionId === detail.id ? '' : ':' + spawn.rowId);
      groups.push({ id, node, spawn, turn: edge?.relation === 'launch' ? edge.turnId : undefined, at: spawn.at });
    }
  }
  return groups;
}

function agentLinks(node: AgentNode, session: string, spawn: RowTarget | undefined, latestRow = ''): CardLink[] {
  const view = (tab: 'files' | 'map', label: string): CardLink => node.sessionId === session
    ? { label, tab }
    : { label, request: { type: 'goto', session: node.sessionId, lane: '', row: '', tab } };
  return [
    node.transcript ? rowLink('Open transcript', { sessionId: node.sessionId, laneId: node.laneId, rowId: latestRow })
      : { label: 'Transcript', reason: 'No transcript is recorded for this agent.' },
    view('files', 'Files'),
    view('map', 'Agent map'),
    spawn ? rowLink('Launch evidence', spawn)
      : { label: 'Launch evidence', reason: node.parentInfo.reason ?? 'Launch not resolved yet.' },
    node.parentInfo.state !== 'root' ? node.parentInfo.state === 'resolved'
      ? { label: 'Open parent', request: { type: 'openParent', session: node.sessionId, lane: node.laneId } }
      : { label: 'Open parent', reason: node.parentInfo.reason ?? 'Parent not resolved yet.' } : undefined,
  ].filter((link): link is CardLink => link !== undefined);
}

/** Project the M1 source order, with child evidence nested at its verified launch row. */
export function projectTranscript(
  detail: SessionDetail, actions: readonly FileAction[], privateMode: boolean, input?: TranscriptSources,
): TranscriptRow[] {
  const main = detail.agents.find(agent => agent.kind === 'main')?.laneId;
  if (!main) return [];

  const sources = new Map(input?.sessions.map(session => [session.id, session]));
  if (input) sources.set(input.session.id, input.session);
  const scopes = new Map([[detail.id, makeScope(detail, actions, input?.session)]]);
  const owners = new Set<string>();
  let remaining = maxNestedRows;

  function findScope(id: string): Scope | undefined {
    const existing = scopes.get(id);
    if (existing) return existing;
    const session = sources.get(id);
    if (!session || !input) return undefined;
    const childDetail = buildDetail(session, input.sessions, {
      now: session.updatedAt ?? 0, privateMode, profileLabel: input.profileLabel?.(session),
    });
    const scope = makeScope(childDetail, session.files, session);
    scopes.set(id, scope);
    return scope;
  }

  function laneRows(scope: Scope, lane: string, depth: number, turn?: string): RowView[] {
    const sourceLane = scope.session?.lanes.find(item => item.id === lane);
    const limit = Math.min(maxChildRows, remaining);
    if (sourceLane && scope.session) {
      return buildLaneRows(scope.session, sourceLane, privateMode, depth ? limit : undefined, turn);
    }
    const rows = scope.rows.get(lane) ?? [];
    const selected = turn ? rows.filter(row => row.turnId === turn) : rows;
    return depth ? selected.slice(-limit) : selected;
  }

  function projectLane(scope: Scope, lane: string, depth: number, turn?: string): TranscriptRow[] {
    const id = scope.detail.id + '/' + lane;
    if (owners.has(id) || depth > maxChildDepth || (depth > 0 && remaining <= 0)) return [];
    owners.add(id);
    const rows = laneRows(scope, lane, depth, turn);
    if (depth > 0) remaining -= rows.length;
    const present = new Set(rows.map(row => row.id));
    const atSpawn = new Map<string, Group[]>();
    const pending: Group[] = [];
    for (const group of groupsFor(scope, lane, sources)) {
      const spawnId = group.spawn?.rowId;
      if (spawnId && present.has(spawnId)) append(atSpawn, spawnId, group);
      else if (!turn) pending.push(group);
    }
    pending.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

    const out: TranscriptRow[] = [];
    let next = 0;
    for (const row of rows) {
      while (row.at !== undefined && next < pending.length && (pending[next]!.at ?? Infinity) <= row.at) {
        out.push(projectGroup(pending[next++]!, scope, depth));
      }
      const children = atSpawn.get(row.id) ?? [];
      const launchUnresolved = scope.launchRows.has(row.id) && !children.some(child => child.node.kind === 'codex-run');
      const item = projectRow(row, scope.files.get(row.id) ?? [], scope.detail.id, privateMode, launchUnresolved);
      if (item) out.push(item);
      for (const child of children) out.push(projectGroup(child, scope, depth));
    }
    for (const group of pending.slice(next)) out.push(projectGroup(group, scope, depth));
    owners.delete(id);
    return out;
  }

  function projectGroup(group: Group, parent: Scope, depth: number): TranscriptRow {
    const { node, spawn, turn } = group;
    const child = findScope(node.sessionId);
    const title = privateMode ? (node.kind === 'codex-run' ? 'Codex run' : 'Agent') : node.title;
    const owner = child?.session ? providerLabels[child.session.provider] : parent.detail.provider;
    const profile = child?.session && input?.profileLabel?.(child.session);
    const lane = child?.session?.lanes.find(lane => lane.id === node.laneId);
    const turnStatus = turn && lane?.turns.find(item => item.id === turn)?.state;
    const status = turnStatus || node.status;
    const entries: ChatCardEntry[] = [
      { title: 'Owner', detail: [owner, safeText(profile, 100)].filter(Boolean).join(' · ') },
      { title: 'Status', detail: status },
    ];
    if (!spawn) entries.push({ title: 'Launch', detail: node.parentInfo.reason ?? 'Launch not resolved yet.' });
    const childRows = child ? projectLane(child, node.laneId, depth + 1, turn) : [];
    const nested = childRows.map(({ keys: _keys, ...item }) => item);
    const latestRow = turn ? lane?.rows.findLast(row => row.turnId === turn) : lane?.rows.at(-1);
    const links = agentLinks(node, detail.id, spawn, latestRow?.id);
    const recorded = lane?.rows;
    const rowCount = turn ? recorded?.filter(row => row.turnId === turn).length : recorded?.length;
    const message = rowCount && rowCount > maxChildRows ? 'Open the transcript for the rest of the recorded activity.'
      : node.transcript && !nested.length ? 'Open the transcript to inspect recorded activity.' : undefined;
    return {
      id: group.id, role: 'tool', text: '', card: {
        title, outcome: status, folded: true, scope: '', state: 'ready', entries, links,
        children: nested.length ? nested : undefined, message,
      },
    };
  }

  return projectLane(scopes.get(detail.id)!, main, 0);
}
