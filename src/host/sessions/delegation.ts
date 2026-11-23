import type { BigIntStats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  claudeTaskOutputReference, extractCodexStartupEvidence, launcherPrefix, reconcileStartupEvidence,
} from '../adapters/claude-code/launcher';
import type { Event, LauncherEvidence, Source } from '../adapters/types';
import { inspectLocal, localPath, openLocalFile, pathKey, sameFile, within } from '../discovery/local-path';
import type { CodexInvocation } from './launch-command';
import { parseCodexInvocation } from './launch-command';
import type { ParentTarget, Turn } from './types';

type CallEvent = Extract<Event, { kind: 'call' }>;
type ResultEvent = Extract<Event, { kind: 'result' }>;
type TaskEvent = Extract<Event, { kind: 'task' }>;
type ConfirmedEvidence = Extract<LauncherEvidence, { threadId: string }>;

export interface ClaudeLaunchCandidate {
  source: Source;
  parent: ParentTarget;
  call: CallEvent;
  result?: ResultEvent;
  cwd?: string;
  tasks?: readonly TaskEvent[];
}

export interface CodexLaunchCandidate {
  source: Source;
  sessionId: string;
  laneId: string;
  cwd?: string;
  origin?: string;
  at?: number;
  turns: readonly Turn[];
  parentThreadId?: string;
}

export interface DelegationLink {
  parent: ParentTarget;
  sessionId: string;
  laneId: string;
  turnId: string;
  taskId?: string;
  role: CodexInvocation['role'];
  evidence: ConfirmedEvidence['evidence'] | 'resume-argument';
}

const cliSource = new Set(['cli', 'exec', 'codex_exec']);
const maxTaskProbes = 8;
const maxCachedTasks = 256;

export function claudeTaskRoot(localAppData: string | undefined): string | undefined {
  const local = localPath(localAppData);
  return local ? join(local, 'Temp', 'claude') : undefined;
}

function resolveRecordedPath(value: string | undefined, base?: string): string | undefined {
  if (!value) return undefined;
  const drive = process.platform === 'win32' ? /^\/([a-z])(?=\/|$)/i.exec(value)?.[1] : undefined;
  if (drive) return localPath(`${drive}:${value.slice(2) || '/'}`);
  if (isAbsolute(value)) return localPath(value);
  if (!base || /^[a-z]:/i.test(value) || /^[\\/]/.test(value)) return undefined;
  return localPath(resolve(base, value));
}

function matchesCwd(expected: string, recorded: string | undefined): boolean {
  const local = resolveRecordedPath(recorded);
  return local !== undefined && pathKey(local) === pathKey(expected);
}

function invocationFor(call: CallEvent, result?: ResultEvent): CodexInvocation | undefined {
  if (call.name !== 'Bash' || call.restricted || (result && call.callId !== result.callId) || !call.command) return undefined;
  return parseCodexInvocation(call.command);
}

/** Use the inline ID for targeted rollout discovery. The join still validates all provenance. */
export function delegationThreadId(call: CallEvent, result?: ResultEvent): string | undefined {
  const invocation = invocationFor(call, result);
  const evidence = result?.launcher;
  if (!invocation || evidence?.evidence === 'conflicting') return undefined;
  if (evidence && invocation.threadId && evidence.threadId !== invocation.threadId) return undefined;
  return evidence?.threadId ?? invocation.threadId;
}

function commandDirectory(candidate: ClaudeLaunchCandidate, invocation: CodexInvocation): string | undefined {
  const { call, result, cwd } = candidate;
  const recorded = resolveRecordedPath(result?.backgroundCwd ?? call.cwd ?? cwd);
  return invocation.changedDirectory === undefined ? recorded
    : resolveRecordedPath(invocation.changedDirectory, recorded);
}

function scopedTaskPath(root: string | undefined, sessionId: string, taskId: string | undefined, value: unknown) {
  const reference = claudeTaskOutputReference(value);
  if (!root || !reference || reference.sessionId !== sessionId.toLowerCase() ||
    (taskId !== undefined && reference.taskId !== taskId)) return undefined;
  const path = localPath(reference.path);
  if (!path || !within(root, path)) return undefined;
  const expected = join(root, reference.bucket, reference.sessionId, 'tasks', `${reference.taskId}.output`);
  return pathKey(path) === pathKey(expected) ? { path, taskId: reference.taskId } : undefined;
}

type TaskStartup = { evidence: LauncherEvidence; at: number };
type TaskSnapshot = { file?: BigIntStats; startup?: TaskStartup };

async function taskStartup(path: string, previous?: TaskSnapshot): Promise<TaskSnapshot> {
  try {
    const current = await inspectLocal(path, 'file');
    const before = previous?.file;
    if (before && sameFile(before, current) && before.size === current.size && before.mtimeNs === current.mtimeNs) {
      return previous;
    }
    const { handle, file } = await openLocalFile(path);
    try {
      const length = Math.min(Number(file.size), launcherPrefix);
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(bytes, read, length - read, read);
        if (!bytesRead) return {};
        read += bytesRead;
      }
      const after = await inspectLocal(path, 'file');
      if (!sameFile(file, after) || after.size < file.size ||
        (after.size === file.size && after.mtimeNs !== file.mtimeNs)) return {};
      const end = bytes.lastIndexOf(10);
      const evidence = end < 0 ? undefined : extractCodexStartupEvidence(bytes.toString('utf8', 0, end + 1));
      return { file, startup: evidence ? { evidence, at: Number(file.mtimeMs) } : undefined };
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
}

export class TaskStartupReader {
  private readonly cache = new Map<string, { after: number; snapshot: TaskSnapshot }>();

  forReconciliation(now: number) {
    let probes = 0;
    return async (path: string, ended: boolean): Promise<TaskSnapshot | undefined> => {
      const key = pathKey(path);
      const entry = this.cache.get(key);
      if (entry && entry.after > now) return entry.snapshot;
      if (probes >= maxTaskProbes) return entry?.snapshot;
      probes++;
      const snapshot = await taskStartup(path, entry?.snapshot);
      this.cache.delete(key);
      this.cache.set(key, { after: now + (ended ? 30_000 : 3_000), snapshot });
      if (this.cache.size > maxCachedTasks) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      return snapshot;
    };
  }
}

type BoundLaunch = ClaudeLaunchCandidate & {
  invocation: CodexInvocation;
  start: number;
  taskId?: string;
  taskKey?: string;
  outputPath?: string;
  finishedAt?: number;
};

function bindLaunch(candidate: ClaudeLaunchCandidate, taskRoot?: string): BoundLaunch | undefined {
  const { call, result, source } = candidate;
  const start = call.at;
  if (source.provider !== 'claude-code' || source.kind !== 'transcript' || start === undefined) return undefined;
  const invocation = invocationFor(call, result);
  if (!invocation) return undefined;
  const fromResult = scopedTaskPath(taskRoot, source.sessionId, result?.backgroundTaskId, result?.taskOutputPath);
  const currentTasks = (candidate.tasks ?? []).filter(event => event.at === undefined || event.at >= start);
  const taskIds = new Set(currentTasks.filter(event => event.sourceCallId === call.callId).map(event => event.taskId));
  const resultId = result?.backgroundTaskId ?? fromResult?.taskId;
  if (resultId) taskIds.add(resultId);
  if (taskIds.size > 1) return undefined;
  const taskId = taskIds.values().next().value;
  const related = taskId ? currentTasks.filter(event => event.taskId === taskId) : [];
  if (related.some(event => event.sourceCallId && event.sourceCallId !== call.callId)) return undefined;
  const paths = new Map<string, string>();
  if (fromResult) paths.set(pathKey(fromResult.path), fromResult.path);
  const endTimes: number[] = [];
  if (taskId === undefined && result?.status !== 'scheduled' && result?.at !== undefined) endTimes.push(result.at);
  for (const event of related) {
    const reference = scopedTaskPath(taskRoot, source.sessionId, taskId, event.taskOutputPath);
    if (reference) paths.set(pathKey(reference.path), reference.path);
    if (event.state !== 'running' && event.at !== undefined) endTimes.push(event.at);
  }
  if (paths.size > 1 || endTimes.some(at => at < start)) return undefined;
  const finishedAt = endTimes.length ? Math.min(...endTimes) : undefined;
  const taskKey = taskId ? JSON.stringify([pathKey(source.home), source.sessionId, taskId]) : undefined;
  return { ...candidate, invocation, start, taskId, taskKey, finishedAt, outputPath: paths.values().next().value };
}

function possibleMatch(launch: BoundLaunch, rollouts: readonly CodexLaunchCandidate[],
  evidence: ConfirmedEvidence | undefined, upper: number): { rollout: CodexLaunchCandidate; turn: Turn } | undefined {
  const { invocation, start } = launch;
  const threadId = evidence?.threadId ?? invocation.threadId;
  const commandCwd = commandDirectory(launch, invocation);
  const cwd = invocation.workdir === undefined ? commandCwd : resolveRecordedPath(invocation.workdir, commandCwd);
  if (!threadId || !cwd || (evidence?.cwd !== undefined && !matchesCwd(cwd, evidence.cwd))) return undefined;
  const hintedHome = resolveRecordedPath(invocation.home, commandCwd);
  if (invocation.home !== undefined && !hintedHome) return undefined;
  const candidates = rollouts.filter(({ source }) => hintedHome === undefined || matchesCwd(hintedHome, source.home));
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0]!;
  if (candidate.parentThreadId) return undefined;

  // Provider start times can use whole epoch seconds. The enclosing session metadata retains its own precision.
  const turnLower = Math.floor(Math.max(start, candidate.at ?? 0) / 1_000) * 1_000;
  if (invocation.role === 'fresh') {
    if (!candidate.origin || !cliSource.has(candidate.origin.toLowerCase()) || candidate.at === undefined ||
      candidate.at < start || candidate.at > upper || !matchesCwd(cwd, candidate.cwd)) return undefined;
  } else if (candidate.at === undefined || candidate.at > start) {
    return undefined;
  }
  const turns = candidate.turns.filter(turn => turn.startedAt !== undefined && turn.startedAt >= turnLower &&
    turn.startedAt <= upper && matchesCwd(cwd, turn.cwd ?? candidate.cwd));
  return turns.length === 1 ? { rollout: candidate, turn: turns[0]! } : undefined;
}

function indexClaims<T>(rows: readonly T[], keyFor: (row: T) => string | undefined,
  ownerFor: (row: T) => string): Map<string, Set<string>> {
  const claims = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const owners = claims.get(key) ?? new Set<string>();
    owners.add(ownerFor(row));
    claims.set(key, owners);
  }
  return claims;
}

/** Reconcile only recorded, locally attributed launches with one approved rollout and one turn. */
export async function resolveDelegations(launches: readonly ClaudeLaunchCandidate[],
  rollouts: readonly CodexLaunchCandidate[], taskRoot?: string, now = Date.now(),
  taskReader = new TaskStartupReader()): Promise<DelegationLink[]> {
  const bound = launches.flatMap(candidate => bindLaunch(candidate, taskRoot) ?? [])
    .sort((left, right) => right.start - left.start);
  const claimedTasks = indexClaims(bound, launch => launch.taskKey, launch => launch.parent.rowId);
  const byThread = new Map<string, CodexLaunchCandidate[]>();
  for (const candidate of rollouts) {
    const { source } = candidate;
    if (source.provider !== 'codex' || source.kind !== 'transcript' || !source.profileId ||
      !within(source.root, source.path) || !within(source.home, source.root)) continue;
    const key = source.sessionId.toLowerCase();
    const group = byThread.get(key) ?? [];
    group.push(candidate);
    byThread.set(key, group);
  }
  const readTask = taskReader.forReconciliation(now);
  const links: DelegationLink[] = [];
  for (const launch of bound) {
    if (launch.taskKey && claimedTasks.get(launch.taskKey)?.size !== 1) continue;
    const inline = launch.result?.launcher;
    if (inline?.evidence === 'conflicting') continue;
    const snapshot = launch.outputPath ? await readTask(launch.outputPath, launch.finishedAt !== undefined) : undefined;
    if (launch.outputPath && !snapshot) continue;
    const file = snapshot?.startup;
    const merged = reconcileStartupEvidence(inline, file?.evidence);
    if (merged?.evidence === 'conflicting') continue;
    const evidence = merged?.evidence === 'thread-started' && !launch.invocation.json ? undefined : merged;
    if (launch.invocation.threadId && merged && launch.invocation.threadId !== merged.threadId) continue;
    const threadId = evidence?.threadId ?? launch.invocation.threadId;
    if (!threadId) continue;
    const observedAt = evidence === undefined ? undefined : Math.max(
      inline ? launch.result?.at ?? 0 : 0, file?.at ?? 0);
    const upper = Math.min(now, launch.finishedAt ?? (observedAt || 0));
    if (upper < launch.start) continue;
    const match = possibleMatch(launch, byThread.get(threadId) ?? [], evidence, upper);
    if (!match) continue;
    links.push({
      parent: { ...launch.parent, relation: 'launch', at: launch.start },
      sessionId: match.rollout.sessionId, laneId: match.rollout.laneId, turnId: match.turn.id,
      taskId: launch.taskId, role: launch.invocation.role, evidence: evidence?.evidence ?? 'resume-argument',
    });
  }
  const linkTurn = (link: DelegationLink) => JSON.stringify([link.sessionId, link.turnId]);
  const claimedTurns = indexClaims(links, linkTurn, link => link.parent.rowId);
  const distinct = new Map<string, DelegationLink>();
  for (const link of links) {
    const turn = linkTurn(link);
    if (claimedTurns.get(turn)?.size === 1) distinct.set(JSON.stringify([turn, link.parent.rowId]), link);
  }
  return [...distinct.values()].sort((left, right) => (right.parent.at ?? 0) - (left.parent.at ?? 0) ||
    left.parent.rowId.localeCompare(right.parent.rowId));
}
