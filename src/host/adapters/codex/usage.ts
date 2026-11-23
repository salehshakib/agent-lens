import { count, identifier, record, safeText, timestamp } from "../../privacy/projection";
import type { Event, EventBase, LimitWindow, Tokens } from "../types";

type UsageScope = Extract<Event, { kind: "usage" }>["scope"];

function tokens(value: unknown): Tokens | undefined {
  const input = record(value);
  if (!input) return undefined;
  const counts = {
    input: count(input.input_tokens),
    output: count(input.output_tokens),
    cacheRead: count(input.cached_input_tokens),
    cacheWrite: count(input.cache_write_input_tokens),
    reasoning: count(input.reasoning_output_tokens),
    total: count(input.total_tokens),
  };
  return Object.values(counts).some((value) => value !== undefined) ? counts : undefined;
}

function observation(base: EventBase, scope: UsageScope, value: unknown, responseId?: string): Event[] {
  const observed = tokens(value);
  return observed ? [{ ...base, id: `${base.id}:${scope}`, kind: "usage", scope, tokens: observed, responseId }] : [];
}

export function exactUsage(base: EventBase, payload: Record<string, unknown>): Event[] {
  const responseId = identifier(payload.response_id);
  return [
    ...(responseId ? observation(base, "response", payload.usage, responseId) : []),
    ...observation(base, "turn", payload.turn_token_usage),
    ...observation(base, "thread", payload.thread_token_usage),
  ];
}

function limitWindow(value: unknown): LimitWindow | undefined {
  const row = record(value);
  if (!row) return undefined;
  const minutes = count(row.window_minutes);
  const usedPercent = row.used_percent;
  const resetsAt = timestamp(row.resets_at);
  if ((minutes !== 300 && minutes !== 10_080) || typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 || resetsAt === undefined) {
    return undefined;
  }
  return { minutes, usedPercent, resetsAt };
}

export function observedUsage(base: EventBase, payload: Record<string, unknown>): Event[] {
  const info = record(payload.info);
  const limits = record(payload.rate_limits);
  const last = tokens(info?.last_token_usage);
  const capacity = count(info?.model_context_window);
  const events = [
    ...observation(base, "reported", info?.total_token_usage),
    ...observation(base, "last-response", info?.last_token_usage),
  ];
  if (last?.input !== undefined) {
    const knownCapacity = capacity && capacity > 0 ? capacity : undefined;
    events.push({
      ...base, id: `${base.id}:context`, kind: "context", input: last.input, capacity: knownCapacity,
      percent: knownCapacity ? (100 * last.input) / knownCapacity : undefined, approximate: true,
    });
  }
  const windows = [limitWindow(limits?.primary), limitWindow(limits?.secondary)]
    .filter((window): window is LimitWindow => window !== undefined);
  if (windows.length) {
    const bucket = identifier(limits?.limit_id);
    events.push({
      ...base, id: `${base.id}:limits`, kind: "limits",
      bucket: bucket === safeText(bucket) ? bucket : undefined, windows,
    });
  }
  return events;
}
