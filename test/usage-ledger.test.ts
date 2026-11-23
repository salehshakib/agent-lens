import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "../src/host/adapters/types";
import { reduceUsage, resolveContext, UsageLedger } from "../src/host/usage/ledger";
import type { LedgerSignal, LedgerTool, ReducedUsage } from "../src/host/usage/ledger";
import { claudeUsage, codexUsage, legacyUsage } from "./fixtures/usage";

function session(id: string, provider: Provider, reduced: ReducedUsage) {
  return {
    id, provider, profile: "fixture-profile", project: "fixture-project", usageObservations: reduced.observations,
    coverage: "recorded" as const, usagePartial: reduced.partial,
    lanes: [], parents: [],
  };
}

test("Claude usage deduplicates split blocks and corroborated child copies", () => {
  const usage = reduceUsage("claude-code", claudeUsage);
  assert.equal(usage.observations.length, 3);
  assert.deepEqual(usage.session, { total: 35, input: 21, output: 7, cacheRead: 11, cacheWrite: 3, reasoning: 2 });
  assert.equal(usage.byLane.get("main")?.total, 20);
  assert.equal(usage.byLane.get("child")?.total, 15);
  assert.equal(usage.byTurn.get("main-turn-a")?.reasoning, 2);
  assert.equal(usage.byTurn.get("main-turn-b")?.total, undefined);
  assert.equal(usage.partial, true);
  assert.deepEqual(usage.byLaneContext.get("main")?.inputComponents, {
    input: 7, cacheRead: undefined, cacheWrite: undefined,
  });
  assert.deepEqual(usage.byLaneContext.get("child")?.inputComponents, { input: 4, cacheRead: 8, cacheWrite: 1 });
  assert.equal(usage.byLaneContext.get("child")?.input, 13);
  assert.equal(usage.byLaneContext.get("child")?.percent, undefined);
});

test("Codex usage keeps exact response, turn, thread, reported and last-request counts separate", () => {
  const usage = reduceUsage("codex", codexUsage);
  assert.equal(usage.observations.filter(sample => sample.scope === "response").length, 2);
  assert.deepEqual(usage.observations.find(sample => sample.scope === "response")?.counts, {
    input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 15, total: 150,
  });
  assert.deepEqual(usage.session, { total: 475 });
  assert.equal(usage.byLaneScope.get("thread"), "thread");
  assert.deepEqual(usage.byTurn.get("turn-a"), { total: 200 });
  assert.deepEqual(usage.byTurn.get("turn-b"), { total: 25 });
  assert.equal(usage.byTurnScope.get("turn-a"), "turn");
  assert.equal(usage.byTurnScope.get("turn-b"), "response");
  assert.deepEqual(usage.observations.find(sample => sample.scope === "reported")?.counts, { total: 1050 });
  assert.deepEqual(usage.observations.find(sample => sample.scope === "last")?.counts, { input: 140 });

  const ledger = new UsageLedger("America/Los_Angeles");
  ledger.replace(session("fixture-thread", "codex", usage));
  assert.deepEqual(ledger.totals().map(row => [row.day, row.counts.total]), [
    ["2031-01-01", 150], ["2031-01-02", 25],
  ]);
});

test("Codex context uses last-request input and applicable capacity and preserves unavailable values", () => {
  const context = { kind: "context", id: "fixture-context", approximate: true } as const;
  assert.deepEqual(resolveContext({ ...context, input: 140 }, 200), {
    input: 140, capacity: 200, percent: 70, approximate: true, at: undefined,
  });
  assert.equal(resolveContext({ ...context, input: 0, capacity: 200 })?.percent, 0);
  assert.equal(resolveContext({ ...context, input: 220, capacity: 200 }, 300)?.percent, 110);
  assert.equal(resolveContext({ ...context, input: 140, capacity: 0 })?.percent, undefined);
  assert.equal(resolveContext({ ...context, capacity: 200 }), undefined);
});

test("Usage ledger attributes resume responses to local days and replaces rewritten session totals", () => {
  const ledger = new UsageLedger("America/Los_Angeles");
  const original = reduceUsage("claude-code", claudeUsage);
  const first = session("fixture-session", "claude-code", original);
  ledger.replace(first);
  assert.deepEqual(ledger.totals({ day: "2031-01-01", profile: "fixture-profile" })
    .map(row => [row.sessionId, row.project, row.laneId, row.model, row.counts.total]), [
    ["fixture-session", "fixture-project", "main", "fixture-main", 20],
  ]);
  assert.equal(ledger.totals({ laneId: "child", day: "2031-01-02" })[0]?.counts.total, 15);
  ledger.replace(first);
  assert.equal(ledger.totals().length, 3);

  const updated = reduceUsage("claude-code", claudeUsage.slice(-1));
  ledger.replace(session("fixture-session", "claude-code", updated));
  assert.equal(ledger.totals().length, 1);
  assert.deepEqual(ledger.totals()[0]?.counts, { input: 7 });
  assert.equal(ledger.totals({ day: "2031-01-01" }).length, 0);
  ledger.remove("fixture-session");
  assert.deepEqual(ledger.totals(), []);
});

test("Usage ledger counts only comparable nonoverlapping Codex fallback deltas", () => {
  const ledger = new UsageLedger("America/Los_Angeles");
  const usage = reduceUsage("codex", legacyUsage);
  assert.equal(usage.session?.total, 45);
  assert.equal(usage.byLaneScope.get("thread"), "reported");
  ledger.replace(session("legacy-thread", "codex", usage));
  assert.deepEqual(ledger.totals().map(row => [row.day, row.model, row.counts.total, row.partial]), [
    ["2031-01-01", "fixture-model", 43, true],
  ]);
  assert.equal(ledger.isPartial("legacy-thread"), true);
});

test("Run ledger keeps known outcomes separate, bounds evidence and clears rewritten signals", () => {
  const ledger = new UsageLedger("UTC");
  const reduced = reduceUsage("codex", codexUsage);
  const observed = session("fixture-thread", "codex", reduced);
  const tools = Array.from({ length: 40 }, (_, index): LedgerTool => ({
    id: `fixture-call-${index}`, name: "Command", laneId: "thread", model: "fixture-model", isCommand: true,
    status: index === 0 ? "failed" : index === 1 ? "success" : "unknown",
    exitCode: index === 0 ? 3 : index === 1 ? 0 : undefined,
  }));
  const failed = tools[0];
  assert.ok(failed);
  const signal: LedgerSignal = { id: "fixture-loop", laneId: "thread", kind: "loop", length: 4 };
  ledger.replace(observed, [...tools, failed], [signal, signal]);
  const command = ledger.runTotals({ tool: "Command" })[0];
  assert.equal(command?.counts.pairedTools, 40);
  assert.equal(command.counts.toolFailures, 1);
  assert.equal(command.counts.knownToolResults, 2);
  assert.equal(command.counts.commandFailures, 1);
  assert.equal(command.counts.knownCommandExits, 2);
  assert.equal(command.evidenceIds.length, 32);
  assert.equal(command.evidenceTruncated, true);
  const signals = ledger.runTotals({ tool: undefined })[0];
  assert.equal(signals?.counts.loopStreaks, 1);
  assert.equal(signals.counts.longestLoop, 4);
  ledger.replace(observed, [failed]);
  assert.equal(ledger.runTotals().length, 1);
  assert.equal(ledger.runTotals()[0]?.counts.pairedTools, 1);
  ledger.remove(observed.id);
  assert.deepEqual(ledger.runTotals(), []);
});
