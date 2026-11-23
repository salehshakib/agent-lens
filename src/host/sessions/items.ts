import type { Event } from '../adapters/types';
import { isKind, key } from './evidence';
import type { Kind, Positioned } from './evidence';
import type { TimelineRow } from './types';

export interface PairedCall extends Positioned<Kind<'call'>> {
  result?: Positioned<Kind<'result'>>;
}

function add<T>(map: Map<string, T[]>, id: string, item: T): void {
  const list = map.get(id);
  if (list) list.push(item);
  else map.set(id, [item]);
}

const resultRank = { failed: 3, success: 2, scheduled: 1, unknown: 0 };

export function pairCalls(items: Positioned[]): { calls: PairedCall[]; unmatched: Positioned<Kind<'result'>>[] } {
  const calls: PairedCall[] = [];
  const byId = new Map<string, PairedCall[]>();
  const byRow = new Map<string, PairedCall>();
  for (const item of items) {
    if (!isKind(item, 'call')) continue;
    const call: PairedCall = { ...item };
    calls.push(call);
    add(byId, item.event.callId, call);
    byRow.set(item.event.id, call);
  }
  const unmatched: Positioned<Kind<'result'>>[] = [];
  for (const item of items) {
    if (!isKind(item, 'result')) continue;
    const { event } = item;
    const exact = event.callRowId && byRow.get(event.callRowId);
    const all = byId.get(event.callId) ?? [];
    let candidates = exact ? [exact] : all.filter(call => {
      if (item.source.provider === 'claude-code') {
        return event.sourceAssistantId ? call.event.recordId === event.sourceAssistantId : call.laneId === item.laneId;
      }
      return call.laneId === item.laneId && call.event.variant !== 'structured'
        && (!item.turnId || !call.turnId || item.turnId === call.turnId);
    });
    if (!exact && item.source.provider === 'claude-code' && event.sourceAssistantId) {
      const local = candidates.filter(call => call.laneId === item.laneId);
      candidates = local.length ? local : candidates;
    }
    const call = candidates.length === 1 ? candidates[0] : undefined;
    if (call) {
      const previous = call.result;
      if (previous && resultRank[event.status] === resultRank[previous.event.status] &&
          event.text !== previous.event.text) call.ambiguous = true;
      if (!previous || resultRank[event.status] >= resultRank[previous.event.status]) call.result = item;
    } else {
      for (const candidate of candidates) candidate.ambiguous = true;
      unmatched.push({ ...item, ambiguous: candidates.length > 1 || undefined });
    }
  }
  return { calls, unmatched };
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function equivalence(item: Positioned): string | undefined {
  if (isKind(item, 'call')) {
    const call = item.event;
    if (call.restricted) return undefined;
    if (call.command && !call.command.includes('[redacted')) return 'command:' + normalizeCommand(call.command);
    const files = call.files ?? (item as PairedCall).result?.event.files;
    if ((call.name === 'apply_patch' || call.name === 'File change') && files?.length) {
      return 'patch:' + files.map(file => JSON.stringify([file.path, file.destination])).sort().join();
    }
    if (call.text && !call.text.includes('[redacted')) return call.name + ':' + call.text;
  } else if (isKind(item, 'message')) {
    return item.event.text.includes('[redacted') ? undefined
      : (item.event.role === 'final' ? 'assistant' : item.event.role) + ':' + item.event.text.trim();
  } else if (isKind(item, 'compaction')) {
    // A single top-level marker and a single completed item in the same turn can be joined.
    return 'compaction';
  }
  return undefined;
}

/** Reconcile a single equivalent within an attributed turn. Ambiguous copies stay inspectable. */
export function reconcileCodex<T extends Positioned>(items: T[]): T[] {
  const byNative = new Map<string, T[]>();
  const byContent = new Map<string, T[]>();
  for (const item of items) {
    if (!item.turnId) continue;
    const role = isKind(item, 'message')
      ? item.event.role === 'final' ? 'assistant' : item.event.role
      : item.event.kind;
    const nativeId = item.event.nativeId;
    if (nativeId) add(byNative, key(item.laneId, item.turnId, role, nativeId), item);
    const content = equivalence(item);
    if (content) add(byContent, key(item.laneId, item.turnId, content), item);
  }
  const removed = new Set<T>();
  const consumed = new Set<T>();
  function merge(candidates: T[], exact: boolean): void {
    const available = candidates.filter(item => !removed.has(item) && (exact || !consumed.has(item)));
    const structured = available.filter(item => item.event.variant === 'structured');
    const provisional = available.filter(item => item.event.variant === 'provisional' || item.event.variant === undefined);
    const fallback = available.filter(item => item.event.variant === 'fallback');
    const winner = structured[0] ?? provisional[0];
    if (!winner || available.length < 2 || (!structured.length && !fallback.length)) return;
    if (structured.length > 1 || provisional.length > 1 || fallback.length > 1) {
      for (const item of [...provisional, ...fallback]) item.ambiguous = true;
      return;
    }
    if (!structured.length && !(isKind(winner, 'message') && fallback.some(item => isKind(item, 'message')))) return;
    for (const item of available) {
      if (item === winner) continue;
      removed.add(item);
      if (item.order < winner.order) {
        winner.order = item.order;
        winner.rowKey = item.rowKey ?? item.event.id;
      }
      if (isKind(item, 'call') && isKind(winner, 'call')) {
        const current = winner as PairedCall;
        const previous = item as PairedCall;
        if (!current.result) current.result = previous.result;
        else if (previous.result?.event.text && !current.result.event.text && !current.event.restricted) {
          current.result = { ...current.result, event: { ...current.result.event, text: previous.result.event.text } };
        }
        if (previous.event.argumentKey && !current.event.restricted) {
          current.event = { ...current.event, argumentKey: previous.event.argumentKey, polling: previous.event.polling };
        }
      }
      if (isKind(winner, 'message') && winner.event.role === 'assistant' &&
          isKind(item, 'message') && item.event.role === 'final' && winner.event.variant !== 'structured') {
        (winner as Positioned<Kind<'message'>>).event = { ...winner.event, role: 'final' };
      }
    }
    if (exact) consumed.add(winner);
  }
  for (const matches of byNative.values()) merge(matches, true);
  for (const matches of byContent.values()) merge(matches, false);
  return items.filter(item => !removed.has(item));
}

const messageKind: Record<Kind<'message'>['role'], TimelineRow['kind']> = {
  user: 'user', assistant: 'assistant', final: 'final', reasoning: 'reasoning', agent: 'agent',
  attachment: 'system', error: 'system', plan: 'assistant',
};

export function rowFor(item: Positioned): TimelineRow | undefined {
  const { event, laneId, turnId, currentBranch, ambiguous } = item;
  const base = {
    id: key(laneId, item.rowKey ?? event.id), laneId, turnId, at: event.at, currentBranch, ambiguous,
    parentRecordId: event.parentId,
    responseId: event.responseId ? key(laneId, event.responseId) : undefined,
  };
  switch (event.kind) {
    case 'message':
      return { ...base, kind: messageKind[event.role], label: event.role === 'user' ? 'Prompt' : event.role,
        text: event.text, durationMs: event.durationMs };
    case 'call': {
      const result = (item as PairedCall).result?.event;
      return { ...base, kind: 'tool', label: event.name,
        text: event.restricted ? undefined : event.text, command: event.restricted ? undefined : event.command,
        output: event.restricted ? undefined : result?.text, status: result?.status ?? 'requested',
        exitCode: result?.exitCode, durationMs: result?.durationMs };
    }
    case 'result':
      return { ...base, kind: 'result', label: 'Tool result', status: event.status };
    case 'compaction':
      return { ...base, kind: 'compact', label: 'Context compacted' };
    case 'spawn':
      return { ...base, kind: 'agent', label: 'Subagent activity', status: event.state };
    case 'task':
      return { ...base, kind: 'task', label: event.description ?? 'Background task', status: event.state };
    case 'file':
      return { ...base, kind: 'system', label: event.files.every(file => file.kind === 'checkpoint') ? 'File checkpoint' : 'File reference' };
    default:
      return undefined;
  }
}

export function isTimelineEvent(item: Positioned): boolean {
  const kind: Event['kind'] = item.event.kind;
  return kind === 'message' || kind === 'compaction' || kind === 'spawn' || kind === 'task' || kind === 'file';
}

/** Merge lane heads by time without reordering records inside any lane. */
export function mergeTimeline(lanes: readonly { rows: readonly TimelineRow[] }[]): TimelineRow[] {
  const positions = lanes.map(() => 0);
  const rows: TimelineRow[] = [];
  while (true) {
    let selected = -1;
    let earliest: TimelineRow | undefined;
    for (const [index, lane] of lanes.entries()) {
      const row = lane.rows[positions[index] ?? 0];
      if (row && (!earliest || (row.at ?? Infinity) < (earliest.at ?? Infinity) ||
          (row.at === earliest.at && row.laneId < earliest.laneId))) {
        earliest = row;
        selected = index;
      }
    }
    if (!earliest) return rows;
    rows.push(earliest);
    positions[selected] = (positions[selected] ?? 0) + 1;
  }
}
