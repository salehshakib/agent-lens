import { relative, sep } from 'node:path';
import { delegatedPromptCandidate } from '../adapters/types';
import { fresh, key, sourceSessionId, stateByOutcome } from './evidence';
import type { Kind, Positioned } from './evidence';
import type { PairedCall } from './items';
import { rowFor } from './items';
import type { LaneWork } from './turns';
import type { BackgroundTask, Lane, ParentTarget, Session, State } from './types';

function target(session: Session, call: Positioned, relation: ParentTarget['relation']): ParentTarget {
  return { sessionId: session.id, laneId: call.laneId, rowId: key(call.laneId, call.event.id),
    turnId: call.turnId, at: call.event.at, relation };
}

function bucket(item: LaneWork['source']): string {
  return relative(item.root, item.path).split(sep)[0] ?? '';
}

function childState(call: PairedCall, now: number): State {
  const result = call.result?.event;
  if (result?.childOutcome && result.childOutcome !== 'running') return stateByOutcome[result.childOutcome];
  if (result?.status === 'failed') return result.interrupted ? 'Interrupted' : 'Failed';
  return fresh(result?.at ?? call.event.at, now) ? 'Live' : 'Outcome unknown';
}

function terminalParentResult(call: PairedCall, childId: string | undefined): string | undefined {
  const result = call.result?.event;
  return childId && result?.agentId === childId && result.childOutcome && result.childOutcome !== 'running' &&
    result.status !== 'scheduled' && !result.launcher && !result.taskOutputPath && !result.readerBodyRestricted ? result.text : undefined;
}

export function claudeChildren(session: Session, lanes: LaneWork[], calls: PairedCall[], now: number): void {
  const root = lanes.find(work => work.lane.nativeId === session.nativeId);
  const spawns = calls.filter(call => call.event.spawn && !call.event.restricted && !call.ambiguous);
  const children = lanes.filter(work => work !== root);
  const resultClaims = new Map<string, number>();
  for (const call of spawns) {
    const childId = call.result?.event.agentId;
    if (!childId) continue;
    const claim = key(bucket(call.source), childId);
    resultClaims.set(claim, (resultClaims.get(claim) ?? 0) + 1);
  }
  const edges = new Map<LaneWork, PairedCall>();
  const parents = new Map(lanes.map(work => [work.lane.id, work]));
  const claimed = new Map<PairedCall, number>();
  for (const child of children) {
    const metadataId = child.metadata?.spawnCallId;
    const matches = spawns.filter(call => call.laneId !== child.lane.id && bucket(call.source) === bucket(child.source) &&
      (metadataId ? call.event.callId === metadataId : call.result?.event.agentId === child.lane.nativeId));
    const call = matches.length === 1 ? matches[0] : undefined;
    const reportedChild = call?.result?.event.agentId;
    if (!call || (reportedChild && reportedChild !== child.lane.nativeId)) {
      child.lane.parentReason = matches.length ? 'Conflicting spawn evidence' : 'Spawning Agent call unavailable';
      continue;
    }
    edges.set(child, call);
    claimed.set(call, (claimed.get(call) ?? 0) + 1);
  }
  for (const [child, spawn] of edges) {
    if (claimed.get(spawn) !== 1) {
      child.lane.parentReason = 'Spawn identifies several children';
      continue;
    }
    const visited = new Set([child]);
    let parent = parents.get(spawn.laneId);
    let depth = 1;
    while (parent && parent !== root && !visited.has(parent)) {
      visited.add(parent);
      const edge = edges.get(parent);
      parent = edge && claimed.get(edge) === 1 ? parents.get(edge.laneId) : undefined;
      depth++;
    }
    if (parent && visited.has(parent)) {
      child.lane.parentReason = 'Cyclic spawn evidence';
      continue;
    }
    if (parent === root && child.metadata?.spawnDepth !== undefined && child.metadata.spawnDepth !== depth) {
      child.lane.parentReason = 'Recorded spawn depth conflicts';
      continue;
    }
    child.lane.parent = target(session, spawn, 'agent');
    child.lane.delegatedPrompt = spawn.event[delegatedPromptCandidate];
    child.lane.parentResult = terminalParentResult(spawn, child.lane.nativeId);
    if (!child.metadata?.outcome) {
      const observed = childState(spawn, now);
      if (child.lane.status === 'Recorded' || ['Completed', 'Failed', 'Interrupted', 'Aborted'].includes(observed)) {
        child.lane.status = observed;
      }
    }
  }
  for (const spawn of spawns) {
    if (claimed.has(spawn) || spawn.event.name === 'Task') continue;
    const nativeId = spawn.result?.event.agentId;
    if (nativeId && (resultClaims.get(key(bucket(spawn.source), nativeId)) !== 1 ||
        children.some(work => work.lane.nativeId === nativeId))) continue;
    const pending: Lane = {
      id: nativeId ? key(session.id, 'lane', nativeId) : key(session.id, 'pending', spawn.event.id),
      nativeId: nativeId ?? spawn.event.callId,
      title: spawn.event.text ?? 'Claude agent',
      rows: [], turns: [], signals: [], pending: true, pendingIdentity: !nativeId || undefined, transcriptAvailable: false,
      status: childState(spawn, now), parent: target(session, spawn, 'agent'),
      delegatedPrompt: spawn.event[delegatedPromptCandidate],
      parentResult: terminalParentResult(spawn, nativeId),
      updatedAt: spawn.result?.event.at ?? spawn.event.at,
    };
    session.lanes.push(pending);
  }
}

export function backgroundTasks(session: Session, calls: PairedCall[], tasks: Positioned<Kind<'task'>>[], now: number): BackgroundTask[] {
  const output: BackgroundTask[] = [];
  const byId = new Map<string, PairedCall[]>();
  for (const call of calls) {
    const taskId = call.result?.event.backgroundTaskId;
    if (!taskId || call.ambiguous || call.event.restricted || call.result?.event.status === 'failed') continue;
    const list = byId.get(taskId) ?? [];
    list.push(call);
    byId.set(taskId, list);
  }
  for (const [taskId, launches] of byId) {
    if (launches.length !== 1) continue;
    const launch = launches[0]!;
    const observed = tasks.filter(task => task.event.taskId === taskId &&
      (!task.event.sourceCallId || task.event.sourceCallId === launch.event.callId)).at(-1);
    const at = observed?.event.at ?? launch.result?.event.at ?? launch.event.at;
    const state = observed?.event.state;
    const status = state && state !== 'running' ? stateByOutcome[state]
      : fresh(at, now) ? 'Live' : 'Outcome unknown';
    output.push({ id: key(session.id, launch.laneId, taskId), laneId: launch.laneId,
      rowId: rowFor(launch)!.id, turnId: launch.turnId, at, status, title: launch.event.text ?? 'Background task' });
  }
  for (const task of tasks) {
    if (byId.has(task.event.taskId) || !task.event.sourceCallId) continue;
    const call = calls.find(candidate => candidate.laneId === task.laneId && candidate.event.callId === task.event.sourceCallId &&
      !candidate.ambiguous && !candidate.event.restricted);
    if (!call) continue;
    const id = key(session.id, call.laneId, task.event.taskId);
    const phase = task.event.state;
    const work = { id, laneId: call.laneId, rowId: rowFor(call)!.id, turnId: call.turnId, at: task.event.at,
      status: phase === 'running' && !fresh(task.event.at, now) ? 'Outcome unknown' as const : stateByOutcome[phase],
      title: task.event.description ?? call.event.text ?? 'Background task' };
    const previous = output.findIndex(item => item.id === id);
    if (previous < 0) output.push(work);
    else output[previous] = work;
  }
  return output;
}

export interface CodexAncestry {
  source: LaneWork['source'];
  session: Session;
  metadata?: Kind<'metadata'>;
  spawns: Positioned<Kind<'spawn'>>[];
}

function completedChild(parent: CodexAncestry, childId: string): boolean {
  return parent.spawns.findLast(spawn => spawn.event.childThreadId === childId && spawn.event.state)
    ?.event.state === 'completed';
}

function observeChildStatus(lane: Lane, parent: CodexAncestry, spawn: Positioned<Kind<'spawn'>>, now: number): void {
  const complete = parent.spawns.findLast(item => item.event.childThreadId === spawn.event.childThreadId &&
    item.event.state && item.order >= spawn.order);
  lane.parentStatus = complete?.event.state === 'completed' ? 'Completed'
    : fresh(spawn.event.at, now) ? 'Live' : 'Outcome unknown';
  lane.parentEndedAt = complete?.event.state === 'completed' ? complete.event.at : undefined;
}

function attributeChildActivity(lane: Lane, parent: CodexAncestry, spawn: Positioned<Kind<'spawn'>>): void {
  const parentTurn = parent.session.lanes.find(item => item.id === spawn.laneId)?.turns.find(turn => turn.id === spawn.turnId)?.nativeId;
  if (!parentTurn) return;
  const localTurns = new Set(lane.turns.filter(turn => turn.parentNativeId === parentTurn).map(turn => turn.id));
  if (!localTurns.size) return;
  lane.rows = lane.rows.map(row => row.agentHistory !== 'owned' && row.explicitTurn && row.turnId && localTurns.has(row.turnId)
    ? { ...row, agentHistory: 'owned' } : row);
}

export function codexChildren(models: readonly CodexAncestry[], now: number): void {
  const catalog = new Map(models.map(model => [model.session.id, model]));
  const inbound = new Map<string, { parent: CodexAncestry; spawn: Positioned<Kind<'spawn'>> }[]>();
  for (const model of models) {
    for (const spawn of model.spawns) {
      if (spawn.event.state !== 'running') continue;
      const id = sourceSessionId(model.source, spawn.event.childThreadId);
      const items = inbound.get(id) ?? [];
      items.push({ parent: model, spawn });
      inbound.set(id, items);
    }
  }
  const edge = new Map<string, string>();
  const conflict = new Set<string>();
  for (const { session, source, metadata } of models) {
    const candidates = inbound.get(session.id) ?? [];
    const explicit = metadata?.parentThreadId ? sourceSessionId(source, metadata.parentThreadId) : undefined;
    const ids = new Set(candidates.map(candidate => candidate.parent.session.id));
    if (explicit) ids.add(explicit);
    if (metadata?.parentConflict || ids.size > 1 || ids.has(session.id)) conflict.add(session.id);
    else if (ids.size === 1) edge.set(session.id, ids.values().next().value!);
  }
  for (const model of models) {
    const { session } = model;
    const lane = session.lanes[0];
    if (!lane) continue;
    if (conflict.has(session.id)) {
      session.parentReason = lane.parentReason = 'Conflicting child-thread evidence';
      continue;
    }
    const id = edge.get(session.id);
    if (!id) continue;
    const visited = new Set([session.id]);
    let ancestor: string | undefined = id;
    while (ancestor && !visited.has(ancestor)) {
      visited.add(ancestor);
      ancestor = edge.get(ancestor);
    }
    if (ancestor) {
      session.parentReason = lane.parentReason = 'Cyclic child-thread evidence';
      continue;
    }
    const parent = catalog.get(id);
    if (!parent) {
      session.parentReason = lane.parentReason = 'Parent thread unavailable';
      continue;
    }
    lane.parentSessionId = parent.session.id;
    if (['Recorded', 'Outcome unknown', 'Writer present'].includes(lane.status) && completedChild(parent, session.nativeId)) {
      lane.status = 'Completed';
    }
    const spawns = inbound.get(session.id) ?? [];
    const record = spawns.length === 1 ? spawns[0]?.spawn : undefined;
    if (!record) {
      session.parentReason = lane.parentReason = 'Exact spawn record unavailable';
      continue;
    }
    lane.parent = target(parent.session, record, 'child');
    attributeChildActivity(lane, parent, record);
    observeChildStatus(lane, parent, record, now);
    session.parents.push(lane.parent);
    parent.session.children.push({ ...lane.parent, sessionId: session.id, laneId: lane.id });
  }

  for (const [id, candidates] of inbound) {
    if (catalog.has(id) || candidates.length !== 1) continue;
    const { parent, spawn } = candidates[0]!;
    const at = spawn.event.at;
    const pending: Lane = { id: key(id, 'lane', spawn.event.childThreadId), nativeId: spawn.event.childThreadId, title: 'Codex child',
      pending: true, pendingSessionId: id, transcriptAvailable: false, rows: [], turns: [], signals: [],
      model: spawn.event.model, effort: spawn.event.effort, updatedAt: at, status: 'Outcome unknown',
      parent: target(parent.session, spawn, 'child') };
    observeChildStatus(pending, parent, spawn, now);
    pending.status = pending.parentStatus ?? pending.status;
    parent.session.lanes.push(pending);
  }
}
