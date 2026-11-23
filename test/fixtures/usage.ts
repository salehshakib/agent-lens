import type { Event } from "../../src/host/adapters/types";
import type { ScopedUsage } from "../../src/host/usage/ledger";

type UsageEvent = Extract<Event, { kind: "usage" }>;

function sample(
  id: string,
  laneId: string,
  turnId: string,
  scope: UsageEvent["scope"],
  tokens: UsageEvent["tokens"],
  metadata: { time?: string; model?: string; responseId?: string; recordId?: string } = {},
): ScopedUsage {
  const { time, ...identity } = metadata;
  return {
    laneId, turnId, event: { kind: "usage", id, scope, tokens, ...identity, at: time ? Date.parse(time) : undefined },
  };
}

const mainResponse = {
  time: "2031-01-02T07:30:00Z", model: "fixture-main", responseId: "fixture-response-a", recordId: "fixture-block-a",
};
const mainCounts = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 };

export const claudeUsage = [
  sample("main-a", "main", "main-turn-a", "response", { ...mainCounts, reasoning: 2 }, mainResponse),
  sample("main-b", "main", "main-turn-a", "response", mainCounts, mainResponse),
  sample("child-copy", "child", "child-turn-a", "response", { ...mainCounts, reasoning: 2 }, mainResponse),
  sample("child-unrelated", "child", "child-turn-a", "response", { input: 4, output: 2, cacheRead: 8, cacheWrite: 1 },
    { ...mainResponse, time: "2031-01-02T08:25:00Z", model: "fixture-child", recordId: "fixture-child-block" }),
  sample("main-late", "main", "main-turn-b", "response", { input: 7 },
    { time: "2031-01-02T08:30:00Z", model: "fixture-main", responseId: "fixture-response-b" }),
] satisfies ScopedUsage[];

const exact = {
  model: "fixture-model", time: "2031-01-02T07:10:00Z", responseId: "fixture-codex-response",
};
const breakdown = { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 15, total: 150 };

export const codexUsage = [
  sample("first-block", "thread", "turn-a", "response", breakdown, exact),
  sample("second-block", "thread", "turn-a", "response", { total: 150 }, exact),
  sample("turn-snapshot", "thread", "turn-a", "turn", { total: 200 }),
  sample("thread-snapshot", "thread", "turn-a", "thread", { total: 450 }),
  sample("reported-snapshot", "thread", "turn-a", "reported", { total: 1050 }),
  sample("last-request", "thread", "turn-a", "last-response", { input: 140 }),
  sample("other-turn", "thread", "turn-b", "response", { total: 25 }, { ...exact, time: "2031-01-02T08:10:00Z" }),
  sample("latest-thread-snapshot", "thread", "turn-b", "thread", { total: 475 }),
] satisfies ScopedUsage[];

export const legacyUsage = [
  sample("baseline", "thread", "turn-a", "reported", { total: 100 }, { ...exact, time: "2031-01-02T07:00:00Z" }),
  sample("advance", "thread", "turn-a", "reported", { total: 120 }, { ...exact, time: "2031-01-02T07:05:00Z" }),
  sample("exact", "thread", "turn-a", "response", { total: 8 }, exact),
  sample("overlap", "thread", "turn-a", "reported", { total: 150 }, { ...exact, time: "2031-01-02T07:15:00Z" }),
  sample("reset", "thread", "turn-a", "reported", { total: 20 }, { ...exact, time: "2031-01-02T07:20:00Z" }),
  sample("after-reset", "thread", "turn-a", "reported", { total: 35 }, { ...exact, time: "2031-01-02T07:25:00Z" }),
  sample("next-day", "thread", "turn-a", "reported", { total: 45 }, { ...exact, time: "2031-01-02T08:10:00Z" }),
] satisfies ScopedUsage[];
