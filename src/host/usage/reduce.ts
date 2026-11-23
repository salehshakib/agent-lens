import type { Event, Provider } from "../adapters/types";
import { count } from "../privacy/projection";
import type { ContextSample, TokenCounts, UsageObservation } from "../sessions/types";

type UsageEvent = Extract<Event, { kind: "usage" }>;
type ContextEvent = Extract<Event, { kind: "context" }>;
type LaneScope = "response" | "thread" | "reported";

export interface ScopedUsage {
  event: UsageEvent;
  laneId: string;
  turnId?: string;
  model?: string;
}

export interface ReducedUsage {
  observations: UsageObservation[];
  byLane: Map<string, TokenCounts>;
  byLaneScope: Map<string, LaneScope>;
  byTurn: Map<string, TokenCounts>;
  byTurnScope: Map<string, "response" | "turn">;
  byLaneContext: Map<string, ContextSample>;
  session?: TokenCounts;
  partial: boolean;
}

export const tokenFields = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "total"] as const;
const claudeTotalFields = ["input", "cacheRead", "cacheWrite", "output"] as const;
const comparableTotals = ["input", "output", "total"] as const;

/** Adds only recorded fields and reports when a sum exceeds the exact integer range. */
export function addCounts(counts: TokenCounts, incoming: TokenCounts): boolean {
  let partial = false;
  for (const field of tokenFields) {
    const value = incoming[field];
    if (value === undefined) continue;
    const sum = (counts[field] ?? 0) + value;
    partial ||= !Number.isSafeInteger(sum);
    counts[field] = Math.min(sum, Number.MAX_SAFE_INTEGER);
  }
  return partial;
}

function normalizeCounts(tokens: TokenCounts, provider: Provider, scope: UsageObservation["scope"]): TokenCounts {
  const counts: TokenCounts = {};
  for (const field of tokenFields) {
    const value = count(tokens[field]);
    if (value !== undefined) counts[field] = value;
  }
  if (provider === "claude-code" && scope === "response" && counts.total === undefined &&
    claudeTotalFields.every(field => counts[field] !== undefined)) {
    const total = count(claudeTotalFields.reduce((sum, field) => sum + (counts[field] ?? 0), 0));
    if (total !== undefined) counts.total = total;
  }
  return counts;
}

function completeness(counts: TokenCounts, provider: Provider): number {
  const core = Number(counts.input !== undefined) + Number(counts.output !== undefined);
  return provider === "claude-code" ? 3 * core + Number(counts.cacheRead !== undefined) +
    Number(counts.cacheWrite !== undefined) : core + Number(counts.total !== undefined);
}

function selectResponse(previous: UsageObservation, current: UsageObservation, provider: Provider): UsageObservation {
  const [better, other] = completeness(current.counts, provider) >= completeness(previous.counts, provider)
    ? [current, previous] : [previous, current];
  const counts = { ...better.counts };
  // Split records can repeat the same totals while including only one optional breakdown.
  if (comparableTotals.every(field => counts[field] === other.counts[field])) {
    const breakdowns = provider === "claude-code" ? ["reasoning"] as const : ["cacheRead", "cacheWrite", "reasoning"] as const;
    for (const field of breakdowns) {
      const value = other.counts[field];
      if (counts[field] === undefined && value !== undefined) counts[field] = value;
    }
  }
  return {
    ...better,
    counts,
    at: better.at ?? other.at,
    turnId: better.turnId ?? other.turnId,
    model: better.model ?? other.model,
  };
}

function usageObservation(input: ScopedUsage, provider: Provider): UsageObservation | undefined {
  const { event, laneId, turnId } = input;
  const scope = event.scope === "last-response" ? "last" : event.scope;
  const counts = normalizeCounts(event.tokens, provider, scope);
  if (!Object.keys(counts).length) return undefined;
  return {
    id: scope === "response"
      ? JSON.stringify([laneId, provider === "codex" ? turnId ?? null : null, event.responseId ?? event.id])
      : event.id,
    laneId,
    turnId,
    at: event.at,
    model: event.model ?? input.model,
    scope,
    counts,
  };
}

type ResponseEvidence = { responseId?: string; recordId?: string };

function copiedClaudeResponse(
  sample: UsageObservation,
  evidence: ResponseEvidence,
  seen: Map<string, string>,
): boolean {
  if (!evidence.responseId) return false;
  const keys: string[] = [];
  const counts = tokenFields.map(field => sample.counts[field] ?? null);
  if (evidence.recordId) {
    keys.push(JSON.stringify([evidence.responseId, evidence.recordId, sample.model ?? null, sample.at ?? null, counts]));
  }
  if (sample.at !== undefined && sample.model) {
    keys.push(JSON.stringify([evidence.responseId, sample.at, sample.model, counts]));
  }
  if (keys.some(key => seen.has(key) && seen.get(key) !== sample.laneId)) return true;
  for (const key of keys) seen.set(key, sample.laneId);
  return false;
}

function accumulate<K>(map: Map<K, TokenCounts>, key: K, incoming: TokenCounts): boolean {
  const total = map.get(key) ?? {};
  const partial = addCounts(total, incoming);
  map.set(key, total);
  return partial;
}

function lastClaudeInput(sample: UsageObservation): ContextSample | undefined {
  const { input: fresh, cacheRead, cacheWrite } = sample.counts;
  if (fresh === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  const input = count((fresh ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0));
  return {
    input, inputComponents: { input: fresh, cacheRead, cacheWrite },
    at: sample.at, approximate: false,
  };
}

export function resolveContext(event: ContextEvent, turnCapacity?: number): ContextSample | undefined {
  const input = count(event.input);
  const approximate = event.approximate === true;
  const capacity = count(event.capacity) || (approximate ? count(turnCapacity) || undefined : undefined);
  const percent = approximate
    ? input !== undefined && capacity !== undefined ? 100 * input / capacity : undefined
    : event.percent !== undefined && Number.isFinite(event.percent) && event.percent >= 0 && event.percent <= 100
      ? event.percent : undefined;
  if (input === undefined && percent === undefined) return undefined;
  return { input, capacity, percent, approximate, at: event.at };
}

/** Consume observations in source order within each lane. */
export function reduceUsage(provider: Provider, input: readonly ScopedUsage[]): ReducedUsage {
  const byId = new Map<string, { sample: UsageObservation; evidence?: ResponseEvidence }>();
  let partial = input.length === 0;
  for (const entry of input) {
    const sample = usageObservation(entry, provider);
    if (!sample) continue;
    const previous = byId.get(sample.id);
    if (sample.scope === "response") {
      const winner = previous ? selectResponse(previous.sample, sample, provider) : sample;
      byId.set(sample.id, {
        sample: winner,
        evidence: {
          responseId: entry.event.responseId,
          recordId: entry.event.recordId ?? previous?.evidence?.recordId,
        },
      });
    } else if (!previous) {
      byId.set(sample.id, { sample });
    }
  }

  const totalsByLane = new Map<string, TokenCounts>();
  const byTurn = new Map<string, TokenCounts>();
  const byLaneContext = new Map<string, ContextSample>();
  const seenCopies = new Map<string, string>();
  const observations: UsageObservation[] = [];
  const exactSession: TokenCounts = {};
  const latestClaudeLaneSample = new Map<string, UsageObservation>();
  const snapshotsByTurn = new Map<string, TokenCounts>();
  const snapshotsByLane = new Map<string, Partial<Record<"thread" | "reported", TokenCounts>>>();
  for (const { sample, evidence } of byId.values()) {
    if (sample.scope === "response") {
      if (provider === "claude-code" && evidence && copiedClaudeResponse(sample, evidence, seenCopies)) continue;
      const incomplete = sample.counts.total === undefined || sample.at === undefined || sample.model === undefined ||
        evidence?.responseId === undefined || (provider === "codex" && sample.turnId === undefined);
      partial = accumulate(totalsByLane, sample.laneId, sample.counts) || incomplete || partial;
      if (sample.turnId) partial = accumulate(byTurn, sample.turnId, sample.counts) || partial;
      if (provider === "claude-code") {
        partial = addCounts(exactSession, sample.counts) || partial;
        latestClaudeLaneSample.set(sample.laneId, sample);
      }
    } else if (sample.scope === "turn" && sample.turnId) {
      snapshotsByTurn.set(sample.turnId, sample.counts);
    } else if (sample.scope === "thread" || sample.scope === "reported") {
      const snapshots = snapshotsByLane.get(sample.laneId) ?? {};
      snapshots[sample.scope] = sample.counts;
      snapshotsByLane.set(sample.laneId, snapshots);
    }
    observations.push(sample);
  }

  const byLaneScope = new Map<string, LaneScope>();
  for (const laneId of totalsByLane.keys()) byLaneScope.set(laneId, "response");
  for (const [laneId, snapshots] of snapshotsByLane) {
    const scope = snapshots.thread ? "thread" : "reported";
    const counts = snapshots[scope];
    if (counts) {
      const responseTotal = totalsByLane.get(laneId)?.total;
      partial ||= counts.total !== undefined && (responseTotal === undefined || responseTotal < counts.total);
      totalsByLane.set(laneId, counts);
      byLaneScope.set(laneId, scope);
    }
  }
  const byTurnScope = new Map<string, "response" | "turn">();
  for (const turnId of byTurn.keys()) byTurnScope.set(turnId, "response");
  for (const [turnId, counts] of snapshotsByTurn) {
    const responseTotal = byTurn.get(turnId)?.total;
    partial ||= counts.total !== undefined && (responseTotal === undefined || responseTotal < counts.total);
    byTurn.set(turnId, counts);
    byTurnScope.set(turnId, "turn");
  }
  for (const [laneId, sample] of latestClaudeLaneSample) {
    const context = lastClaudeInput(sample);
    if (context) byLaneContext.set(laneId, context);
  }
  const session = provider === "claude-code"
    ? Object.keys(exactSession).length ? exactSession : undefined
    : totalsByLane.size === 1 ? totalsByLane.values().next().value : undefined;
  partial ||= session === undefined || [...byLaneScope.values()].includes("reported");
  return { observations, byLane: totalsByLane, byLaneScope, byTurn, byTurnScope, byLaneContext, session, partial };
}
