import type { Source } from '../adapters/types';
import { FileIndex } from '../files/index';
import { reduceUsage, resolveContext } from '../usage/ledger';
import type { LedgerTool } from '../usage/ledger';
import { backgroundTasks, claudeChildren } from './ancestry';
import type { CodexAncestry } from './ancestry';
import { firstTitle, fresh, isKind, key, latestTime, sourceSessionId, stateByOutcome } from './evidence';
import type { Kind, Positioned, SourceEvidence } from './evidence';
import { isTimelineEvent, pairCalls, reconcileCodex, rowFor } from './items';
import type { PairedCall } from './items';
import { recordedPath } from './project';
import type { ProjectIdentity } from './project';
import { assignTurns, finishTurns } from './turns';
import type { LaneWork } from './turns';
import type { Session } from './types';

export interface ReducedSession {
  session: Session;
  tools: LedgerTool[];
  calls: PairedCall[];
  tasks: Positioned<Kind<'task'>>[];
  codex?: CodexAncestry;
}

function preferredSource(a: SourceEvidence, b: SourceEvidence): number {
  return b.source.updatedAt - a.source.updatedAt || a.source.key.localeCompare(b.source.key);
}

function createLanes(input: SourceEvidence[], session: Session): LaneWork[] {
  const byLane = new Map<string, SourceEvidence[]>([[session.nativeId, []]]);
  for (const evidence of input) {
    const list = byLane.get(evidence.source.laneId);
    if (list) list.push(evidence);
    else byLane.set(evidence.source.laneId, [evidence]);
  }
  const lanes: LaneWork[] = [];
  for (const [nativeId, entries] of byLane) {
    const ordered = entries.sort(preferredSource);
    const transcript = ordered.find(entry => entry.source.kind === 'transcript');
    const companion = ordered.find(entry => entry.source.kind === 'agent-metadata');
    const source = transcript?.source ?? companion?.source ?? input[0]!.source;
    const laneId = key(session.id, 'lane', nativeId);
    let order = 0;
    const items: Positioned[] = [];
    for (const entry of [transcript, companion]) {
      if (!entry) continue;
      for (const event of entry.events) items.push({ source: entry.source, event, order: order++, laneId });
    }
    const metadata = items.find(item => isKind(item, 'metadata') && (item.event.threadId || item.source.kind === 'agent-metadata'));
    const details = metadata && isKind(metadata, 'metadata') ? metadata.event : undefined;
    lanes.push({
      source, items, turns: new Map(), metadata: details, transcript: transcript?.source,
      lane: {
        id: laneId, nativeId, rows: [], turns: [], status: 'Recorded', signals: [],
        title: details?.description ?? details?.title ?? details?.agentType ??
          (nativeId === session.nativeId ? 'Main' : 'Claude agent ' + nativeId.slice(0, 8)),
        model: details?.model, effort: details?.effort, transcriptAvailable: !!transcript,
      },
    });
    if (ordered.length > Number(!!transcript) + Number(!!companion)) session.coverage = 'partial';
  }
  return lanes;
}

const synchronousTerminals = new Set(['failed', 'success', 'scheduled']);

export function reduceSession(
  input: SourceEvidence[],
  now: number,
  projectFor: (cwd: string) => ProjectIdentity | undefined = () => undefined,
  title?: string,
  presence: Kind<'metadata'>[] = [],
): ReducedSession | undefined {
  const source = input[0]?.source;
  if (!source) return undefined;
  const claude = source.provider === 'claude-code';
  const id = sourceSessionId(source);
  const nativeId = source.sessionId;
  const session: Session = {
    id, provider: source.provider, profile: source.profileId, nativeId, title: '',
    status: 'Recorded', lanes: [], signals: [], parents: [], children: [], files: [], background: [], usageObservations: [],
    coverage: input.some(entry => entry.partial) ? 'partial' : 'recorded',
  };
  const lanes = createLanes(input, session);
  const main = lanes[0]!;
  const rootMeta = main.items.filter(item => isKind(item, 'metadata')).map(item => item.event as Kind<'metadata'>);
  const rootCwd = main.metadata?.cwd ?? rootMeta.find(event => event.cwd)?.cwd ??
    lanes.flatMap(work => work.items).find(item => item.event.cwd)?.event.cwd ?? presence.at(-1)?.cwd;
  session.cwd = rootCwd;
  const project = rootCwd ? projectFor(rootCwd) : undefined;
  session.project = project?.key ?? (rootCwd ? 'cwd:' + (recordedPath(rootCwd) ?? rootCwd) : 'unresolved:' + id);
  session.projectRoot = project?.root;
  session.branch = rootMeta.findLast(event => event.branch)?.branch;
  session.origin = main.metadata?.origin ?? presence.at(-1)?.origin;
  for (const work of lanes) assignTurns(work, rootCwd);
  const allItems = lanes.flatMap(work => work.items);
  const paired = pairCalls(allItems);
  const byLane = new Map(lanes.map(work => [work.lane.id, work]));
  const timelineItems = [...allItems.filter(isTimelineEvent), ...paired.calls, ...paired.unmatched];
  const visible = claude ? timelineItems : reconcileCodex(timelineItems);
  const calls: PairedCall[] = [];
  const tools: LedgerTool[] = [];
  const files = new FileIndex();
  const unresolved = new Set<string>();

  for (const item of visible.sort((a, b) => a.order - b.order)) {
    const work = byLane.get(item.laneId);
    const row = rowFor(item);
    if (!row || !work) continue;
    work.lane.rows.push(row);
    const cwd = item.cwd;
    const rowProject = cwd ? projectFor(cwd) : undefined;
    const fileScope = { rowId: row.id, laneId: item.laneId, turnId: item.turnId, at: row.at, cwd,
      provider: session.provider, project: rowProject?.key ?? session.project, projectRoot: rowProject?.root ?? session.projectRoot };
    if (isKind(item, 'file')) {
      files.add({ ...fileScope, event: item.event });
    } else if (isKind(item, 'call')) {
      const call = item as PairedCall;
      calls.push(call);
      const result = call.result?.event;
      if (claude && item.turnId && (!result || !synchronousTerminals.has(result.status) || item.ambiguous)) {
        unresolved.add(item.turnId);
      }
      if (item.ambiguous) continue;
      files.add({ ...fileScope, call: call.event, result, at: result?.at ?? row.at });
      if (result) tools.push({
        id: row.id, laneId: item.laneId, turnId: item.turnId, name: call.event.name,
        isCommand: !!call.event.command || ['Bash', 'Command', 'exec_command', 'shell', 'shell_command'].includes(call.event.name),
        model: item.turnId ? work.turns.get(item.turnId)?.model : undefined,
        at: row.at, status: result.status, exitCode: result.exitCode,
      });
    }
  }

  for (const work of lanes) {
    finishTurns(work, unresolved, now);
    const active = work.currentTurn && work.turns.get(work.currentTurn);
    const latestMeta = work.items.filter(item => isKind(item, 'metadata')).map(item => item.event as Kind<'metadata'>);
    work.lane.model = active ? active.model ?? work.lane.model : latestMeta.findLast(event => event.model)?.model ?? work.lane.model;
    work.lane.effort = active ? active.effort ?? work.lane.effort : latestMeta.findLast(event => event.effort)?.effort ?? work.lane.effort;
    work.lane.latestActivity = work.lane.rows.at(-1);
    work.lane.startedAt = work.lane.turns.find(turn => turn.startedAt !== undefined)?.startedAt;
    work.lane.updatedAt = work.lane.rows.reduce<number | undefined>((at, row) => latestTime(at, row.at), undefined)
      ?? work.metadata?.at ?? work.transcript?.updatedAt;
    if (claude && work !== main && work.metadata?.outcome) {
      work.lane.status = work.metadata.stoppedByUser ? 'Stopped' : stateByOutcome[work.metadata.outcome];
    } else if (claude && work !== main && work.lane.status === 'Recorded' && fresh(work.lane.latestActivity?.at, now)) {
      work.lane.status = 'Live';
    }
    session.lanes.push(work.lane);
  }
  // Presence is a secondary hint. Recent matching transcript activity corroborates a waiting marker.
  if (claude && main.lane.status === 'Completed' && fresh(main.lane.latestActivity?.at, now)
      && presence.some(event => fresh(event.presence?.statusUpdatedAt ?? event.at, now)
        && ['idle', 'waiting'].includes(event.presence?.status ?? ''))) main.lane.status = 'Waiting';

  const samples = allItems.filter((item): item is Positioned<Kind<'usage'>> => isKind(item, 'usage')).map(item => ({
    event: item.event, laneId: item.laneId, turnId: item.turnId,
    model: item.turnId ? byLane.get(item.laneId)?.turns.get(item.turnId)?.model : undefined,
  }));
  const usage = reduceUsage(session.provider, samples);
  for (const work of lanes) {
    work.lane.usage = usage.byLane.get(work.lane.id);
    work.lane.usageScope = usage.byLaneScope.get(work.lane.id);
    for (const turn of work.lane.turns) {
      turn.usage = usage.byTurn.get(turn.id);
      turn.usageScope = usage.byTurnScope.get(turn.id);
    }
    work.lane.context = usage.byLaneContext.get(work.lane.id);
    for (const item of work.items) {
      if (!isKind(item, 'context')) continue;
      work.lane.context = resolveContext(item.event, item.turnId ? work.turns.get(item.turnId)?.capacity : undefined);
    }
  }
  session.usageObservations = usage.observations;
  session.usage = usage.session;
  session.usagePartial = usage.partial;
  session.usageScope = main.lane.usageScope;
  session.context = main.lane.context;
  session.model = main.lane.model;
  session.effort = main.lane.effort;
  session.files = files.actions();
  const tasks = allItems.filter((item): item is Positioned<Kind<'task'>> => isKind(item, 'task'));
  if (claude) {
    claudeChildren(session, lanes, calls, now);
    session.background = backgroundTasks(session, calls, tasks, now);
  }
  session.title = title ?? (claude ? rootMeta.findLast(event => event.title && event.titleSource !== 'fallback')?.title : undefined)
    ?? firstTitle(main.lane.rows.find(row => row.kind === 'user')?.text)
    ?? rootMeta.findLast(event => event.titleSource === 'fallback')?.title ??
    (claude ? 'Claude session ' : 'Codex thread ') + nativeId.slice(0, 8);
  session.updatedAt = session.lanes.reduce<number | undefined>((at, lane) => latestTime(at, lane.updatedAt), undefined);
  session.status = session.lanes.some(lane => lane.status === 'Live') || session.background.some(task => task.status === 'Live')
    ? 'Live' : main.lane.status;
  return {
    session, calls, tools, tasks,
    codex: claude ? undefined : {
      source: main.source, session, metadata: main.metadata,
      spawns: allItems.filter((item): item is Positioned<Kind<'spawn'>> => isKind(item, 'spawn')),
    },
  };
}
