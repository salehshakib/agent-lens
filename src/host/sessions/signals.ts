import { createHash } from 'node:crypto';
import type { LedgerSignal } from '../usage/ledger';
import { key } from './evidence';
import type { PairedCall } from './items';
import type { ContextLevel, ContextSample, FileAction, RowRef, Session, Signal } from './types';

/** Validated signal settings. Everything the signal derivation reads from user configuration lives here. */
export interface CheckRule {
  /** A project root path, or `*` for every project. */
  root: string;
  /** Replace the default patterns for this root instead of adding to them. */
  replace: boolean;
  patterns: readonly RegExp[];
}

export interface SignalSettings {
  loopThreshold: number;
  checkIgnore: readonly string[];
  checkCommands: readonly CheckRule[];
  warnPercent: number;
  criticalPercent: number;
}

export const defaultCheckIgnore: readonly string[] = ['**/*.md', '**/*.mdx', '**/*.txt'];
export const defaultWarnPercent = 70;
export const defaultCriticalPercent = 90;
export const defaultLoopThreshold = 3;

/** Default check patterns. Each is tested against one command segment, never run. */
export const defaultCheckPatterns: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)(?::[\w-]+)?(?:\s|$)/i,
  /^(?:npx\s+(?:--?[\w-]+\s+)*)?tsc(?:\s|$)/i,
  /^(?:(?:npx|bunx|yarn|pnpm\s+exec|pnpm\s+dlx)\s+(?:--?[\w-]+\s+)*)?(?:vitest|jest|eslint|pytest)(?:\s|$)/i,
  /^python3?\s+-m\s+pytest(?:\s|$)/i,
  /^cargo\s+(?:test|check|clippy)(?:\s|$)/i,
  /^go\s+(?:test|vet)(?:\s|$)/i,
  /^dotnet\s+(?:test|build)(?:\s|$)/i,
];

export const defaultSignalSettings: SignalSettings = {
  loopThreshold: defaultLoopThreshold, checkIgnore: defaultCheckIgnore, checkCommands: [],
  warnPercent: defaultWarnPercent, criticalPercent: defaultCriticalPercent,
};

const maxPatternLength = 200;
const maxRules = 50;
const maxPatterns = 50;
const maxCommandLength = 2000;

function wholeNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : undefined;
}

function compile(source: unknown): RegExp | undefined {
  if (typeof source !== 'string' || !source.trim() || source.length > maxPatternLength) return undefined;
  try {
    return new RegExp(source, 'i');
  } catch {
    return undefined;
  }
}

function rules(value: unknown): CheckRule[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const output: CheckRule[] = [];
  for (const [root, entry] of Object.entries(value).slice(0, maxRules)) {
    const replace = typeof entry === 'object' && entry !== null && !Array.isArray(entry) && (entry as { replace?: unknown }).replace === true;
    const list = Array.isArray(entry) ? entry : (entry as { patterns?: unknown } | null)?.patterns;
    if (!Array.isArray(list)) continue;
    const patterns = list.slice(0, maxPatterns).map(compile).filter((item): item is RegExp => !!item);
    if (patterns.length || replace) output.push({ root: normalizeRoot(root), replace, patterns });
  }
  return output;
}

/** Turn raw configuration values into safe settings. Invalid values fall back to the documented defaults. */
export function parseSignalSettings(raw: {
  loopThreshold?: unknown; checkIgnore?: unknown; checkCommands?: unknown; warnPercent?: unknown; criticalPercent?: unknown;
}): SignalSettings {
  const warn = wholeNumber(raw.warnPercent, 1, 99) ?? defaultWarnPercent;
  const critical = wholeNumber(raw.criticalPercent, 2, 100) ?? defaultCriticalPercent;
  const ordered = warn < critical;
  const ignore = Array.isArray(raw.checkIgnore)
    ? raw.checkIgnore.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200).slice(0, 50)
    : undefined;
  return {
    loopThreshold: wholeNumber(raw.loopThreshold, 2, 50) ?? defaultLoopThreshold,
    checkIgnore: ignore ?? defaultCheckIgnore,
    checkCommands: rules(raw.checkCommands),
    warnPercent: ordered ? warn : defaultWarnPercent,
    criticalPercent: ordered ? critical : defaultCriticalPercent,
  };
}

function normalizeRoot(value: string): string {
  return value === '*' ? '*' : value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Match a recorded command against the check patterns for one project root. The command is only ever tested as text. */
export function checkMatcher(settings: SignalSettings, projectRoot?: string): (command: string) => boolean {
  const root = projectRoot ? normalizeRoot(projectRoot) : undefined;
  const applicable = settings.checkCommands.filter(rule => rule.root === '*' || rule.root === root);
  const replaced = applicable.some(rule => rule.replace);
  const patterns = [...(replaced ? [] : defaultCheckPatterns), ...applicable.flatMap(rule => rule.patterns)];
  return command => command.slice(0, maxCommandLength).split(/&&|\|\||[;|\n]/)
    .map(part => part.trim()).filter(Boolean).some(part => patterns.some(pattern => pattern.test(part)));
}

export function globToRegExp(glob: string): RegExp {
  const text = glob.replace(/\\/g, '/');
  let out = '';
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith('**/', index)) {
      out += '(?:.*/)?';
      index += 2;
    } else if (text.startsWith('**', index)) {
      out += '.*';
      index += 1;
    } else if (text[index] === '*') out += '[^/]*';
    else if (text[index] === '?') out += '[^/]';
    else out += text[index]!.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 'i');
}

export function ignoreMatcher(globs: readonly string[]): (path: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return path => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    for (let index = 0; index < parts.length; index++) {
      const tail = parts.slice(index).join('/');
      if (patterns.some(pattern => pattern.test(tail))) return true;
    }
    return false;
  };
}

export function contextLevel(percent: number | undefined, settings: Pick<SignalSettings, 'warnPercent' | 'criticalPercent'>): ContextLevel | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  if (percent >= settings.criticalPercent) return 'Critical';
  return percent >= settings.warnPercent ? 'High' : 'Normal';
}

/** A context sample older than this no longer says anything about the lane, so its level is cleared. */
export const contextStaleMs = 10 * 60_000;

export type ContextStep =
  | { kind: 'sample'; sample: ContextSample }
  | { kind: 'compaction' };

const levelRank: Record<ContextLevel, number> = { Normal: 0, High: 1, Critical: 2 };

export interface ContextHistory {
  /** The latest sample with its level. Absent when no percentage exists, the sample is stale or a compaction followed. */
  current?: ContextSample;
  /** Number of compactions seen. A level crossing belongs to the epoch it was observed in. */
  epoch: number;
  ledger: LedgerSignal[];
}

/**
 * Walk one lane's context samples and compactions in source order. Levels exist only where a percentage exists. The
 * level is cleared by a later compaction or a stale sample. The highest level per compaction epoch feeds the ledger.
 */
export function deriveContext(
  laneId: string,
  steps: readonly ContextStep[],
  settings: Pick<SignalSettings, 'warnPercent' | 'criticalPercent'>,
  now: number,
): ContextHistory {
  const ledger: LedgerSignal[] = [];
  let epoch = 0;
  let top: { level: ContextLevel; at?: number } | undefined;
  let current: ContextSample | undefined;
  const flush = (compacted: boolean) => {
    if (!top || top.level === 'Normal') return;
    ledger.push({ id: key('context', laneId, String(epoch), top.level), laneId, at: top.at,
      kind: top.level === 'Critical' ? 'context-critical' : 'context-high' });
    if (compacted) ledger.push({ id: key('compaction', laneId, String(epoch)), laneId, at: top.at, kind: 'compaction-after-crossing' });
  };
  for (const step of steps) {
    if (step.kind === 'compaction') {
      flush(true);
      epoch++;
      top = undefined;
      current = undefined;
      continue;
    }
    const level = contextLevel(step.sample.percent, settings);
    if (!level) {
      current = undefined;
      continue;
    }
    current = { ...step.sample, level };
    if (!top || levelRank[level] > levelRank[top.level]) top = { level, at: step.sample.at };
  }
  flush(false);
  if (current && (current.at === undefined || now - current.at > contextStaleMs)) current = undefined;
  return { current, epoch, ledger };
}

const maxStreakRows = 200;

function hashResult(call: PairedCall): string | undefined {
  const result = call.result?.event;
  if (!result || result.text === undefined) return undefined;
  return createHash('sha256').update(JSON.stringify([result.status, result.exitCode, result.text.slice(0, 8192)])).digest('hex').slice(0, 16);
}

interface Streak {
  signature: string;
  name: string;
  rowIds: string[];
  count: number;
  turnId?: string;
  lastHash?: string;
  at?: number;
}

export interface LoopResult {
  signals: Signal[];
  ledger: LedgerSignal[];
}

/**
 * Find streaks of one repeated call per lane. `calls` must be in source order. Only a paired, unambiguous call that
 * carries an adapter argument key can start or extend a streak. Polling calls extend a streak only when the result
 * hash is unchanged. The hash is compared in memory and never stored.
 */
export function deriveLoops(
  calls: readonly PairedCall[],
  rowId: (call: PairedCall) => string,
  threshold: number,
  isActive: (laneId: string) => boolean,
): LoopResult {
  const finished: { laneId: string; streak: Streak; live: boolean }[] = [];
  const current = new Map<string, Streak | undefined>();
  const done = (laneId: string, streak: Streak | undefined, live: boolean) => {
    if (streak && streak.count >= threshold) finished.push({ laneId, streak, live });
  };
  for (const call of calls) {
    const { laneId } = call;
    const active = current.get(laneId);
    const argument = call.event.argumentKey;
    if (call.ambiguous || call.event.restricted || !argument || !call.result) {
      done(laneId, active, false);
      current.set(laneId, undefined);
      continue;
    }
    const signature = call.event.name + '\u0000' + argument;
    const hash = call.event.polling ? hashResult(call) : undefined;
    const id = rowId(call);
    if (active && active.signature === signature && (!call.event.polling || (hash !== undefined && hash === active.lastHash))) {
      active.count++;
      if (active.rowIds.length < maxStreakRows) active.rowIds.push(id);
      active.at = call.event.at ?? active.at;
      continue;
    }
    done(laneId, active, false);
    current.set(laneId, { signature, name: call.event.name, rowIds: [id], count: 1, turnId: call.turnId, lastHash: hash, at: call.event.at });
  }
  for (const [laneId, streak] of current) done(laneId, streak, isActive(laneId));
  const signals: Signal[] = [];
  const ledger: LedgerSignal[] = [];
  for (const { laneId, streak, live } of finished) {
    const id = key('loop', laneId, streak.rowIds[0]);
    signals.push({ id, laneId, turnId: streak.turnId, kind: 'loop', state: live ? 'live' : 'historical', rowIds: streak.rowIds,
      label: 'Possible loop', detail: streak.name + ' ×' + streak.count, count: streak.count });
    ledger.push({ id, laneId, turnId: streak.turnId, at: streak.at, kind: 'loop', length: streak.count });
  }
  return { signals, ledger };
}

export type CheckResult = 'passed' | 'failed' | 'unknown';

export interface CheckEvidence extends RowRef {
  turnId?: string;
  at?: number;
  command: string;
  exitCode?: number;
  result: CheckResult;
}

export interface EditEvidence extends RowRef {
  turnId?: string;
  at?: number;
  path: string;
}

/** Confirmed edits and recorded checks of one session. The tree evaluation joins them across sessions. */
export interface RunEvidence {
  edits: EditEvidence[];
  checks: CheckEvidence[];
}

const changeKinds = new Set<FileAction['kind']>(['edit', 'add', 'delete', 'move']);

function checkResult(call: PairedCall, claude: boolean): CheckResult {
  const result = call.result?.event;
  if (!result) return 'unknown';
  if (result.status === 'failed' || (result.exitCode !== undefined && result.exitCode !== 0)) return 'failed';
  if (result.exitCode === 0) return 'passed';
  // Claude reports a tool error flag instead of an exit code, so a clean result means the command did not fail.
  return claude && result.status === 'success' ? 'passed' : 'unknown';
}

export function collectEvidence(
  sessionId: string,
  claude: boolean,
  calls: readonly PairedCall[],
  rowId: (call: PairedCall) => string,
  files: readonly FileAction[],
  matches: (command: string) => boolean,
  ignored: (path: string) => boolean,
): RunEvidence {
  const edits: EditEvidence[] = files.filter(action => action.status === 'applied' && changeKinds.has(action.kind) && !ignored(action.path))
    .map(action => ({ sessionId, laneId: action.laneId, rowId: action.rowId, turnId: action.turnId, at: action.at, path: action.path }));
  const checks: CheckEvidence[] = [];
  for (const call of calls) {
    const command = call.event.command;
    if (!command || call.ambiguous || call.event.restricted || !call.result || !matches(command)) continue;
    checks.push({ sessionId, laneId: call.laneId, rowId: rowId(call), turnId: call.turnId, at: call.event.at,
      command: command.slice(0, 200), exitCode: call.result.event.exitCode, result: checkResult(call, claude) });
  }
  return { edits, checks };
}

export interface EvaluationInput {
  session: Session;
  evidence: RunEvidence;
}

export interface Evaluation {
  signals: Map<string, Signal[]>;
  ledger: Map<string, LedgerSignal[]>;
}

const outcomeText = {
  'no-checks': 'No checks after edits',
  'check-failed': 'Last check failed',
  'check-unknown': 'Check result unknown',
} as const;

/**
 * Evaluate Done without checks for every root turn tree. A Claude subagent lane, a Codex child thread and a verified
 * linked Codex run all resolve to the root turn that started them. Only Completed root turns get an outcome.
 */
export function evaluateChecks(inputs: readonly EvaluationInput[]): Evaluation {
  const sessions = new Map(inputs.map(input => [input.session.id, input.session]));
  const separator = '\u0000';

  function rootOf(sessionId: string, laneId: string, turnId: string | undefined, depth: number): [string, string | undefined] | undefined {
    const session = sessions.get(sessionId);
    const lane = session?.lanes.find(item => item.id === laneId);
    if (!session || !lane || depth > 8) return undefined;
    const main = session.lanes[0];
    if (lane === main) {
      const launch = session.launches?.find(link => link.turnId === turnId);
      if (launch) return rootOf(launch.parent.sessionId, launch.parent.laneId, launch.parent.turnId, depth + 1);
      if (lane.parent && lane.parent.relation !== 'launch') {
        return rootOf(lane.parent.sessionId, lane.parent.laneId, lane.parent.turnId, depth + 1);
      }
      return [sessionId, turnId];
    }
    if (lane.parent) return rootOf(lane.parent.sessionId, lane.parent.laneId, lane.parent.turnId, depth + 1);
    return undefined;
  }

  interface Tree { sessionId: string; turnId: string; edits: EditEvidence[]; checks: CheckEvidence[] }
  const trees = new Map<string, Tree>();
  const tree = (root: [string, string | undefined] | undefined): Tree | undefined => {
    if (!root || !root[1]) return undefined;
    const id = root[0] + separator + root[1];
    let entry = trees.get(id);
    if (!entry) trees.set(id, entry = { sessionId: root[0], turnId: root[1], edits: [], checks: [] });
    return entry;
  };
  for (const { session, evidence } of inputs) {
    for (const edit of evidence.edits) tree(rootOf(session.id, edit.laneId, edit.turnId, 0))?.edits.push(edit);
    for (const check of evidence.checks) tree(rootOf(session.id, check.laneId, check.turnId, 0))?.checks.push(check);
  }

  const signals = new Map<string, Signal[]>();
  const ledger = new Map<string, LedgerSignal[]>();
  const bySession = new Map<string, { index: number; passed: boolean; signal?: Signal; ledger?: LedgerSignal }[]>();
  for (const entry of trees.values()) {
    const session = sessions.get(entry.sessionId);
    const lane = session?.lanes[0];
    const turnIndex = lane?.turns.findIndex(turn => turn.id === entry.turnId) ?? -1;
    const turn = lane?.turns[turnIndex];
    if (!session || !lane || !turn) continue;
    const row = { index: turnIndex, passed: entry.checks.some(check => check.result === 'passed') } as
      { index: number; passed: boolean; signal?: Signal; ledger?: LedgerSignal };
    (bySession.get(session.id) ?? bySession.set(session.id, []).get(session.id)!).push(row);
    if (turn.state !== 'Completed' || !entry.edits.length) continue;
    const lastEdit = entry.edits.reduce((best, edit) => (edit.at ?? Infinity) >= (best.at ?? Infinity) ? edit : best);
    const lastAt = lastEdit.at ?? Infinity;
    const after = entry.checks.filter(check => check.at !== undefined && check.at > lastAt);
    const latest = after.reduce<CheckEvidence | undefined>((best, check) => !best || (check.at ?? 0) >= (best.at ?? 0) ? check : best, undefined);
    let outcome: keyof typeof outcomeText | undefined;
    if (!latest) outcome = 'no-checks';
    else if (latest.result === 'failed') outcome = 'check-failed';
    else if (latest.result === 'unknown') outcome = 'check-unknown';
    if (!outcome) continue;
    const files = new Set(entry.edits.map(edit => edit.path)).size;
    const detail = outcome === 'no-checks' ? files + (files === 1 ? ' file changed' : ' files changed')
      : (latest!.command + (outcome === 'check-failed' ? (latest!.exitCode === undefined ? ' · error result' : ' · exit ' + latest!.exitCode) : ''));
    const id = key('check', lane.id, turn.id);
    row.signal = { id, laneId: lane.id, turnId: turn.id, kind: 'check', state: 'live', rowIds: [], label: outcomeText[outcome], detail,
      outcome, count: files, edit: { sessionId: lastEdit.sessionId, laneId: lastEdit.laneId, rowId: lastEdit.rowId },
      check: latest ? { sessionId: latest.sessionId, laneId: latest.laneId, rowId: latest.rowId } : undefined };
    row.ledger = { id, laneId: lane.id, turnId: turn.id, at: turn.endedAt, kind: outcome, model: turn.model };
  }
  for (const [sessionId, rows] of bySession) {
    rows.sort((a, b) => a.index - b.index);
    rows.forEach((row, position) => {
      if (!row.signal) return;
      // A later turn that passed a check supersedes this outcome.
      if (rows.slice(position + 1).some(next => next.passed)) row.signal.state = 'historical';
      (signals.get(sessionId) ?? signals.set(sessionId, []).get(sessionId)!).push(row.signal);
      if (row.ledger) (ledger.get(sessionId) ?? ledger.set(sessionId, []).get(sessionId)!).push(row.ledger);
    });
  }
  return { signals, ledger };
}
