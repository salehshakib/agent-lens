import type { Source } from '../adapters/types';
import { fresh, isKind, key, latestTime, stateByOutcome } from './evidence';
import type { Kind, Positioned } from './evidence';
import type { Lane, State, Turn } from './types';

export interface WorkingTurn extends Turn {
  capacity?: number;
  activity?: number;
  terminal?: State;
  started?: boolean;
  modelFromContext?: boolean;
  effortFromContext?: boolean;
  parentTurnConflict?: boolean;
}

export interface LaneWork {
  lane: Lane;
  source: Source;
  items: Positioned[];
  turns: Map<string, WorkingTurn>;
  metadata?: Kind<'metadata'>;
  transcript?: Source;
  currentTurn?: string;
}

function recordTurn(work: LaneWork, id: string, nativeId?: string): WorkingTurn {
  let turn = work.turns.get(id);
  if (!turn) {
    turn = { id, nativeId, state: 'Recorded' };
    work.turns.set(id, turn);
  }
  return turn;
}

function touch(turn: WorkingTurn, at: number | undefined): void {
  turn.activity = latestTime(turn.activity, at);
}

const terminalReasons = new Set(['end_turn', 'stop_sequence']);

/** A stop on one Claude response does not make another response in the same turn final. */
function markClaudeFinals(work: LaneWork): void {
  const responses = new Map<string, { terminal: boolean; conflicted: boolean }>();
  const responseKey = (item: Positioned): string => key(item.turnId, item.event.responseId ?? item.event.recordId ??
    item.event.id.replace(/:(?:metadata|block:\d+)$/, ''));
  for (const item of work.items) {
    if (!isKind(item, 'metadata') || item.source.kind !== 'transcript') continue;
    const { stopReason, outcome } = item.event;
    if (!stopReason && outcome !== 'aborted') continue;
    const id = responseKey(item);
    const state = responses.get(id) ?? { terminal: false, conflicted: false };
    state.terminal ||= terminalReasons.has(stopReason ?? '');
    state.conflicted ||= outcome === 'aborted' || (stopReason !== undefined && !terminalReasons.has(stopReason));
    responses.set(id, state);
  }
  for (const item of work.items) {
    if (!isKind(item, 'message') || item.event.role !== 'assistant') continue;
    const state = responses.get(responseKey(item));
    if (state?.terminal && !state.conflicted) item.event = { ...item.event, terminal: 'response' };
  }
}

function assignClaude(work: LaneWork, initialCwd?: string): void {
  const { lane, items } = work;
  const parents = new Map<string, string>();
  const prompts = new Map<string, string>();
  for (const { event } of items) {
    if (event.recordId && event.parentId && !parents.has(event.recordId)) parents.set(event.recordId, event.parentId);
    if (event.recordId && event.kind === 'message' && event.role === 'user') {
      prompts.set(event.recordId, key(lane.id, 'turn', event.recordId));
    }
    if (event.kind === 'metadata' && event.leafId) lane.branchLeaf = event.leafId;
  }
  const branch = new Set<string>();
  for (let id = lane.branchLeaf; id && !branch.has(id); id = parents.get(id)) branch.add(id);
  const ancestry = new Map<string, string | undefined>();
  function resolve(recordId?: string): string | undefined {
    const visited = new Set<string>();
    let id = recordId;
    while (id && !visited.has(id) && !ancestry.has(id) && !prompts.has(id)) {
      visited.add(id);
      id = parents.get(id);
    }
    const found = id ? prompts.get(id) ?? ancestry.get(id) : undefined;
    for (const seen of visited) ancestry.set(seen, found);
    return found;
  }
  let current: string | undefined;
  let cwd = initialCwd;
  for (const item of items) {
    const event = item.event;
    if (item.source.kind !== 'transcript') continue;
    cwd = event.cwd ?? cwd;
    item.cwd = cwd;
    item.currentBranch = lane.branchLeaf && event.recordId ? branch.has(event.recordId) : undefined;
    if (event.kind === 'message' && event.role === 'user') {
      current = event.recordId ? prompts.get(event.recordId) : undefined;
      current ??= key(lane.id, 'turn', event.id);
      const turn = recordTurn(work, current);
      turn.startedAt ??= event.at;
      turn.cwd ??= cwd;
      turn.started = true;
    }
    item.turnId = resolve(event.recordId) ?? resolve(event.parentId) ?? (!event.parentId ? current : undefined);
    if (!item.turnId) continue;
    const turn = recordTurn(work, item.turnId);
    turn.cwd ??= cwd;
    if (event.kind === 'message' || event.kind === 'call' || event.kind === 'result' || event.kind === 'compaction') {
      if (event.kind !== 'message' || event.role !== 'error') touch(turn, event.at);
    }
    if (event.kind === 'metadata') {
      turn.model = event.model ?? turn.model;
      turn.effort = event.effort ?? turn.effort;
      if (event.model || event.effort) turn.modelSource = 'transcript';
      if (event.outcome === 'aborted' || terminalReasons.has(event.stopReason ?? '')) {
        if (turn.terminal !== 'Aborted') turn.terminal = event.outcome === 'aborted' ? 'Aborted' : 'Completed';
        turn.endedAt = latestTime(turn.endedAt, event.at);
      }
    }
  }
  work.currentTurn = resolve(lane.branchLeaf) ?? current;
  markClaudeFinals(work);
}

function assignCodex(work: LaneWork, initialCwd?: string): void {
  const open = new Set<string>();
  let settings: Kind<'metadata'> | undefined;
  let anonymous = 0;
  let latestStarted: string | undefined;
  for (const item of work.items) {
    const event = item.event;
    if (event.kind === 'metadata' && event.modelSource === 'thread-settings' && !event.turnId) settings = event;

    let id = event.turnId ? key(work.lane.id, 'turn', event.turnId) : open.size === 1 ? open.values().next().value : undefined;
    if (!event.turnId && event.kind === 'turn' && event.state === 'running') id = key(work.lane.id, 'legacy-turn', String(++anonymous));
    item.turnId = id;
    const turn = id ? recordTurn(work, id, event.turnId) : undefined;
    item.cwd = event.cwd ?? turn?.cwd ?? settings?.cwd ?? initialCwd;
    if (!turn || !id) continue;
    turn.rootId ??= event.rootTurnId;
    if (event.kind === 'metadata' && event.modelSource === 'turn-context') {
      if (event.model) { turn.model = event.model; turn.modelFromContext = true; }
      if (event.effort) { turn.effort = event.effort; turn.effortFromContext = true; }
      if (event.model || event.effort) turn.modelSource = 'turn-context';
      turn.cwd = event.cwd ?? turn.cwd;
    } else if (event.kind === 'metadata' && event.modelSource === 'thread-settings') {
      if (!turn.modelFromContext) turn.model = event.model ?? turn.model;
      if (!turn.effortFromContext) turn.effort = event.effort ?? turn.effort;
      if (!turn.modelSource && (event.model || event.effort)) turn.modelSource = 'thread-settings';
      turn.cwd ??= event.cwd;
    }
    if (event.kind === 'turn') {
      if (event.state === 'running') {
        if (event.turnId && event.parentId && !turn.parentTurnConflict) {
          if (turn.parentNativeId && turn.parentNativeId !== event.parentId) {
            turn.parentTurnConflict = true;
            turn.parentNativeId = undefined;
          } else turn.parentNativeId = event.parentId;
        }
        if (!turn.terminal) open.add(id);
        turn.started = true;
        turn.startedAt ??= event.at;
        turn.capacity = event.capacity ?? turn.capacity;
        if (!turn.modelSource && (settings?.model || settings?.effort)) turn.modelSource = 'thread-settings';
        turn.model ??= settings?.model;
        turn.effort ??= settings?.effort;
        turn.cwd ??= item.cwd;
        latestStarted = id;
      } else {
        if (turn.terminal !== 'Failed') turn.terminal = stateByOutcome[event.state];
        turn.startedAt ??= event.startedAt;
        turn.endedAt = latestTime(turn.endedAt, event.at);
        turn.durationMs = event.durationMs ?? turn.durationMs;
        open.delete(id);
        const current = latestStarted ? work.turns.get(latestStarted) : undefined;
        if (!current || (current.terminal && id !== current.id &&
          (turn.startedAt ?? turn.endedAt ?? -1) >= (current.startedAt ?? current.endedAt ?? -1))) latestStarted = id;
      }
    }
    if (event.kind === 'turn' || event.kind === 'call' || event.kind === 'result' ||
        event.kind === 'message' || event.kind === 'spawn' || event.kind === 'compaction') touch(turn, event.at);
  }
  work.currentTurn = latestStarted ?? Array.from(work.turns.keys()).at(-1);
}

export function assignTurns(work: LaneWork, cwd?: string): void {
  if (work.source.provider === 'claude-code') assignClaude(work, cwd);
  else assignCodex(work, cwd);
}

export function finishTurns(work: LaneWork, unresolvedSynchronous: ReadonlySet<string>, now: number): void {
  const claude = work.source.provider === 'claude-code';
  for (const turn of work.turns.values()) {
    const terminal = turn.terminal;
    if (terminal && (terminal !== 'Completed' || !unresolvedSynchronous.has(turn.id))) turn.state = terminal;
    else if (turn.id === work.currentTurn && (claude || turn.started) && fresh(turn.activity, now)) turn.state = 'Live';
    else if (!claude && turn.id === work.currentTurn && turn.started && work.transcript?.writerPresent) turn.state = 'Writer present';
    else turn.state = 'Outcome unknown';
    if (turn.durationMs === undefined && turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt >= turn.startedAt) {
      turn.durationMs = turn.endedAt - turn.startedAt;
    }
  }
  work.lane.turns = [...work.turns.values()];
  work.lane.status = work.currentTurn ? work.turns.get(work.currentTurn)?.state ?? 'Recorded' : 'Recorded';
}
