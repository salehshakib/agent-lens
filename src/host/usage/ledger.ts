import type { Provider, ResultStatus } from "../adapters/types";
import { count, identifier, safeText } from "../privacy/projection";
import type { Session, TokenCounts, UsageObservation } from "../sessions/types";
import { addCounts, tokenFields } from "./reduce";

export { reduceUsage, resolveContext } from "./reduce";
export type { ReducedUsage, ScopedUsage } from "./reduce";

type LedgerSession = Pick<Session, "id" | "provider" | "profile" | "project" | "usageObservations" |
  "coverage" | "lanes" | "parents" | "parentReason"> & { usagePartial?: boolean };

interface Dimensions {
  sessionId: string;
  provider: Provider;
  project?: string;
  profile?: string;
  laneId: string;
  day?: string;
  model?: string;
}

type Filter = Partial<Dimensions>;

export interface UsageTotal extends Dimensions {
  counts: TokenCounts;
  partial: boolean;
}

export interface LedgerTool {
  id: string;
  laneId: string;
  turnId?: string;
  at?: number;
  model?: string;
  name: string;
  status: ResultStatus;
  isCommand: boolean;
  exitCode?: number;
}

export interface LedgerSignal {
  id: string;
  laneId: string;
  turnId?: string;
  at?: number;
  model?: string;
  kind: "loop" | "no-checks" | "check-failed" | "check-unknown" | "context-high" |
    "context-critical" | "compaction-after-crossing";
  length?: number;
}

interface RunCounts {
  pairedTools: number;
  knownToolResults: number;
  toolFailures: number;
  knownCommandExits: number;
  commandFailures: number;
  loopStreaks: number;
  longestLoop: number;
  noChecks: number;
  failedChecks: number;
  unknownChecks: number;
  highCrossings: number;
  criticalCrossings: number;
  compactionsAfterCrossing: number;
  stopped: number;
  interrupted: number;
  failed: number;
}

export interface RunTotal extends Dimensions {
  tool?: string;
  counts: RunCounts;
  evidenceIds: string[];
  evidenceTruncated: boolean;
}

interface SessionTotals {
  usage: UsageTotal[];
  runs: RunTotal[];
  partial: boolean;
}

const maxEvidenceIds = 32;
const emptyRunCounts: RunCounts = {
  pairedTools: 0,
  knownToolResults: 0,
  toolFailures: 0,
  knownCommandExits: 0,
  commandFailures: 0,
  loopStreaks: 0,
  longestLoop: 0,
  noChecks: 0,
  failedChecks: 0,
  unknownChecks: 0,
  highCrossings: 0,
  criticalCrossings: 0,
  compactionsAfterCrossing: 0,
  stopped: 0,
  interrupted: 0,
  failed: 0,
};

function dimensionKey({ laneId, day, model }: Dimensions, tool?: string): string {
  return JSON.stringify([laneId, day ?? null, model ?? null, tool ?? null]);
}

function matches(dimensions: Dimensions & { tool?: string }, filter: Filter & { tool?: string }): boolean {
  const keys = Object.keys(filter) as (keyof (Filter & { tool?: string }))[];
  return keys.every(key => filter[key] === dimensions[key]);
}

function reportedDelta(previous: UsageObservation, latest: UsageObservation): TokenCounts | undefined {
  if (previous.at === undefined || latest.at === undefined || previous.at > latest.at) return undefined;
  const delta: TokenCounts = {};
  for (const field of tokenFields) {
    const before = previous.counts[field];
    const after = latest.counts[field];
    if (before === undefined && after === undefined) continue;
    if (before === undefined || after === undefined || after < before) return undefined;
    delta[field] = after - before;
  }
  return Object.keys(delta).length ? delta : undefined;
}

/** Keep recent exact response times sorted for overlap checks against cumulative samples. */
function exactResponseTimes(observations: readonly UsageObservation[]): Map<string, number[] | undefined> {
  const times = new Map<string, number[] | undefined>();
  for (const sample of observations) {
    if (sample.scope !== "response") continue;
    if (sample.at === undefined) {
      times.set(sample.laneId, undefined);
    } else if (!times.has(sample.laneId)) {
      times.set(sample.laneId, [sample.at]);
    } else {
      times.get(sample.laneId)?.push(sample.at);
    }
  }
  for (const laneTimes of times.values()) laneTimes?.sort((a, b) => a - b);
  return times;
}

function overlapsExact(from: number, to: number, times: number[] | undefined): boolean {
  if (!times) return true;
  let left = 0;
  let right = times.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const time = times[mid];
    if (time !== undefined && time < from) left = mid + 1;
    else right = mid;
  }
  const first = times[left];
  return first !== undefined && first <= to;
}

function collectUsage(
  session: LedgerSession,
  dimensions: (row: { laneId: string; at?: number; model?: string }) => Dimensions,
): { totals: UsageTotal[]; partial: boolean } {
  let partial = session.coverage === "partial" || session.usagePartial === true ||
    (session.provider === "codex" &&
      (session.parents.some(parent => parent.relation === "child") || session.parentReason !== undefined));
  const totals = new Map<string, UsageTotal>();
  function add(sample: UsageObservation, counts: TokenCounts, approximate: boolean) {
    const scope = dimensions(sample);
    const key = dimensionKey(scope);
    const row = totals.get(key) ?? { ...scope, counts: {}, partial: false };
    const overflow = addCounts(row.counts, counts);
    row.partial ||= approximate || !scope.model || !scope.day || counts.total === undefined || overflow;
    totals.set(key, row);
    partial ||= row.partial;
  }

  const exactTimes = session.provider === "codex" ? exactResponseTimes(session.usageObservations) : undefined;
  const reported = new Map<string, UsageObservation>();
  for (const sample of session.usageObservations) {
    if (sample.scope === "response") {
      add(sample, sample.counts, false);
      continue;
    }
    if (!exactTimes || sample.scope !== "reported") continue;
    const previous = reported.get(sample.laneId);
    reported.set(sample.laneId, sample);
    if (!previous) {
      if (!exactTimes.has(sample.laneId)) partial = true;
      continue;
    }
    if (previous.at === undefined || sample.at === undefined) {
      partial = true;
      continue;
    }
    if (exactTimes.has(sample.laneId) && overlapsExact(previous.at, sample.at, exactTimes.get(sample.laneId))) {
      // An overlapping cumulative delta could count known responses again.
      partial = true;
      continue;
    }
    const delta = reportedDelta(previous, sample);
    const from = dimensions(previous);
    const to = dimensions(sample);
    if (!delta || !from.day || from.day !== to.day || previous.turnId !== sample.turnId) {
      partial = true;
      continue;
    }
    if (!tokenFields.some(field => (delta[field] ?? 0) > 0)) continue;
    add({ ...sample, model: previous.model === sample.model ? sample.model : undefined }, delta, true);
  }
  return { totals: [...totals.values()], partial: partial || !totals.size };
}

type RunSubject = { id: string; laneId: string; at?: number; model?: string };

function collectRuns(
  session: LedgerSession,
  dimensions: (row: RunSubject) => Dimensions,
  tools: readonly LedgerTool[],
  signals: readonly LedgerSignal[],
): RunTotal[] {
  const totals = new Map<string, RunTotal>();
  const seen = new Set<string>();
  function row(subject: RunSubject, kind: "tool" | "signal" | "turn", tool?: string): RunCounts | undefined {
    const sourceKey = JSON.stringify([kind, subject.laneId, subject.id]);
    if (seen.has(sourceKey)) return undefined;
    seen.add(sourceKey);
    const scope = dimensions(subject);
    const key = dimensionKey(scope, tool);
    const total = totals.get(key) ?? {
      ...scope, tool, counts: { ...emptyRunCounts }, evidenceIds: [], evidenceTruncated: false,
    };
    if (total.evidenceIds.length < maxEvidenceIds) total.evidenceIds.push(subject.id);
    else total.evidenceTruncated = true;
    totals.set(key, total);
    return total.counts;
  }

  for (const tool of tools) {
    const counts = row(tool, "tool", identifier(tool.name) ?? safeText(tool.name, 128) ?? "Tool");
    if (!counts) continue;
    counts.pairedTools++;
    if (tool.status === "success" || tool.status === "failed") counts.knownToolResults++;
    if (tool.status === "failed") counts.toolFailures++;
    if (tool.isCommand && Number.isSafeInteger(tool.exitCode)) {
      counts.knownCommandExits++;
      if (tool.exitCode !== 0) counts.commandFailures++;
    }
  }
  for (const signal of signals) {
    const counts = row(signal, "signal");
    if (!counts) continue;
    switch (signal.kind) {
      case "loop":
        counts.loopStreaks++;
        counts.longestLoop = Math.max(counts.longestLoop, count(signal.length) ?? 0);
        break;
      case "no-checks":
        counts.noChecks++;
        break;
      case "check-failed":
        counts.failedChecks++;
        break;
      case "check-unknown":
        counts.unknownChecks++;
        break;
      case "context-high":
        counts.highCrossings++;
        break;
      case "context-critical":
        counts.criticalCrossings++;
        break;
      case "compaction-after-crossing":
        counts.compactionsAfterCrossing++;
        break;
    }
  }
  for (const lane of session.lanes) {
    for (const turn of lane.turns) {
      if (turn.state !== "Stopped" && turn.state !== "Interrupted" && turn.state !== "Failed") continue;
      const counts = row({ ...turn, laneId: lane.id, at: turn.endedAt ?? turn.startedAt }, "turn");
      if (!counts) continue;
      if (turn.state === "Stopped") counts.stopped++;
      if (turn.state === "Interrupted") counts.interrupted++;
      if (turn.state === "Failed") counts.failed++;
    }
  }
  return [...totals.values()];
}

/** Keep compact summaries scoped by canonical session. A rewritten session replaces its prior totals. */
export class UsageLedger {
  private readonly sessions = new Map<string, SessionTotals>();
  private readonly dates: Intl.DateTimeFormat;

  constructor(timeZone?: string) {
    this.dates = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    });
  }

  replace(session: LedgerSession, tools: readonly LedgerTool[] = [], signals: readonly LedgerSignal[] = []): void {
    const dimensions = (sample: { laneId: string; at?: number; model?: string }): Dimensions => ({
      sessionId: session.id, provider: session.provider, project: session.project, profile: session.profile,
      laneId: sample.laneId, day: this.day(sample.at), model: sample.model,
    });
    const { totals, partial } = collectUsage(session, dimensions);
    this.sessions.set(session.id, { usage: totals, runs: collectRuns(session, dimensions, tools, signals), partial });
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  totals(filter: Filter = {}): UsageTotal[] {
    return [...this.sessions.values()].flatMap(session => session.usage
      .filter(row => matches(row, filter))
      .map(row => ({ ...row, counts: { ...row.counts }, partial: row.partial || session.partial })));
  }

  isPartial(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.partial ?? true;
  }

  runTotals(filter: Filter & { tool?: string } = {}): RunTotal[] {
    return [...this.sessions.values()].flatMap(session => session.runs
      .filter(row => matches(row, filter))
      .map(row => ({ ...row, counts: { ...row.counts }, evidenceIds: [...row.evidenceIds] })));
  }

  private day(at: number | undefined): string | undefined {
    if (at === undefined || !Number.isFinite(new Date(at).valueOf())) return undefined;
    const parts = this.dates.formatToParts(at);
    const year = parts.find(part => part.type === "year")?.value;
    const month = parts.find(part => part.type === "month")?.value;
    const day = parts.find(part => part.type === "day")?.value;
    return year && month && day ? `${year.padStart(4, "0")}-${month}-${day}` : undefined;
  }
}
