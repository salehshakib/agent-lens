import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { classifyCodexRecord, parseCodexRecords } from "../src/host/adapters/codex/records";
import type { Event, Source } from "../src/host/adapters/types";

const currentId = "10000000-0000-4000-8000-000000000001";
const parentId = "10000000-0000-4000-8000-000000000002";
const legacyId = "10000000-0000-4000-8000-000000000003";

function fixture(name: string, sessionId = currentId, kind: Source["kind"] = "transcript") {
  const root = resolve("test/fixtures/codex");
  const path = resolve(root, name);
  const source: Source = {
    provider: "codex", key: name, home: root, root, path, sessionId, laneId: sessionId, kind, updatedAt: 0,
  };
  let offset = 0;
  const rows = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    const row = { value, offset };
    offset += Buffer.byteLength(line) + 1;
    return row;
  });
  return {
    source,
    events: rows.flatMap((row) => parseCodexRecords(row.value, source, row.offset)),
    diagnostics: rows.map((row) => classifyCodexRecord(row.value, source)),
  };
}

function eventsOf<Kind extends Event["kind"]>(events: Event[], kind: Kind): Extract<Event, { kind: Kind }>[] {
  return events.filter((event): event is Extract<Event, { kind: Kind }> => event.kind === kind);
}

test("Codex reader projects current rollout attribution, lifecycle, structured tools and eligible text", () => {
  const { events, diagnostics } = fixture("current-rollout.jsonl");
  const [meta, settings] = eventsOf(events, "metadata");
  assert.equal(meta?.threadId, currentId);
  assert.equal(meta.parentThreadId, parentId);
  assert.equal(meta.version, "0.170.0");
  assert.equal(meta.historyStartOrdinal, 12);
  assert.equal(meta.cwd, "X:\\Fixture Labs\\engine");
  assert.equal(settings?.model, "fixture-model");
  assert.equal(settings?.effort, "high");
  assert.equal(settings?.turnId, "fixture-turn-1");
  assert.equal(settings?.rootTurnId, "fixture-root-turn");

  const turns = eventsOf(events, "turn");
  assert.deepEqual(turns.map(({ state, turnId }) => [state, turnId]), [
    ["running", "fixture-turn-1"], ["failed", "fixture-turn-1"], ["interrupted", "fixture-turn-2"],
  ]);
  assert.equal(turns[0]?.at, Date.parse("2026-01-03T10:00:00Z"));
  assert.equal(turns[0]?.capacity, 200);
  assert.equal(turns[1]?.durationMs, 11_000);

  const messages = eventsOf(events, "message");
  assert.deepEqual(messages.filter(({ role }) => role === "user").map(({ text, variant }) => [text, variant]), [
    ["Check the fixture renderer.", "provisional"], ["Check the fixture renderer.", "structured"],
  ]);
  assert.deepEqual(messages.filter(({ role }) => role === "final").map(({ variant }) => variant), [
    "structured", "fallback",
  ]);
  assert.equal(messages.find(({ role }) => role === "attachment")?.text, "1 image attachment");

  const command = eventsOf(events, "call").find(({ nativeId }) => nativeId === "fixture-command");
  const result = eventsOf(events, "result").find(({ nativeId }) => nativeId === "fixture-command");
  assert.equal(command?.command, "npm run check");
  assert.equal(command.at, Date.parse("2026-01-03T10:00:02.500Z"));
  assert.deepEqual(command?.files, [{ kind: "mention", path: "src/renderer.ts" }]);
  assert.match(command.argumentKey ?? "", /^[a-f0-9]{64}$/);
  assert.equal(result?.callRowId, command.id);
  assert.equal(result?.status, "failed");
  assert.equal(result?.exitCode, 3);
  assert.equal(result?.durationMs, 1250);
  assert.equal(result?.text, "Ran fixture check.\nStderr\naccess_token=[redacted]");
  assert.equal(eventsOf(events, "result").find(({ nativeId }) => nativeId === "fixture-mcp")?.text,
    "Fixture lookup failed.");
  const fileResult = eventsOf(events, "result").find(({ nativeId }) => nativeId === "fixture-file");
  assert.deepEqual(fileResult?.files?.map(({ path, kind, status, destination }) => [path, kind, status, destination]), [
    ["src/renderer.ts", "edit", "applied", undefined],
    ["src/old.ts", "move", "applied", "src/new.ts"],
    ["src/fixture.ts", "add", "applied", undefined],
  ]);
  assert.equal(fileResult?.files?.[0]?.patch, "@@ -1 +1 @@\n-before\n+after");
  assert.equal(fileResult?.files?.[2]?.patch, "@@ -0,0 +1,1 @@\n+fixture contents");
  assert.equal(eventsOf(events, "compaction").length, 1);
  assert.equal(diagnostics.filter((status) => status === "unknown").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /hidden-|private-|foreign-thread-marker|synthetic-token-text/u);
});

test("Codex reader keeps response, turn, thread, reported, and last-request usage scopes separate", () => {
  const { events } = fixture("current-rollout.jsonl");
  const usage = eventsOf(events, "usage");
  assert.deepEqual(usage.map(({ scope, tokens }) => [scope, tokens.total]), [
    ["response", 150], ["turn", 200], ["thread", 450], ["reported", 1050], ["last-response", undefined],
  ]);
  assert.equal(usage[0]?.responseId, "fixture-response");
  assert.deepEqual(usage[0]?.tokens, { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 15, total: 150 });
  assert.equal(new Set(usage.map(({ id }) => id)).size, usage.length);
  const [context] = eventsOf(events, "context");
  assert.equal(context?.input, 140);
  assert.equal(context?.capacity, 200);
  assert.equal(context?.percent, 70);
  assert.equal(context?.approximate, true);

  const [named, unassigned] = eventsOf(events, "limits");
  assert.equal(named?.bucket, "codex");
  assert.deepEqual(named?.windows.map(({ minutes, usedPercent }) => [minutes, usedPercent]), [[10_080, 11], [300, 22.5]]);
  assert.equal(named?.windows[1]?.resetsAt, 1_767_452_400_000);
  assert.equal(unassigned?.bucket, undefined);
  assert.equal(unassigned?.windows.length, 1);
  assert.equal(unassigned?.windows[0]?.usedPercent, 18);
});

test("Codex reader recognizes legacy records and quarantines malformed tool input", () => {
  const { source, events } = fixture("legacy-rollout.jsonl", legacyId);
  const [meta, settings] = eventsOf(events, "metadata");
  assert.equal(meta?.version, "0.58.0");
  assert.equal(meta.origin, "cli");
  assert.equal(settings?.model, "fixture-legacy-model");
  assert.equal(settings?.effort, "medium");
  const calls = eventsOf(events, "call");
  const results = eventsOf(events, "result");
  const result = results.find(({ callId }) => callId === "fixture-shell");
  const call = calls.find(({ callId }) => callId === "fixture-shell");
  assert.ok(call && result && events.indexOf(result) < events.indexOf(call));
  assert.equal(result.status, "unknown");
  assert.equal(result.text, "Finished fixture command.");
  assert.equal(call.command, "npm  run check");
  const sameCall = parseCodexRecords({
    type: "response_item",
    payload: { type: "function_call", call_id: "fixture-next-call", name: "shell",
      arguments: JSON.stringify({ command: "npm run check", workdir: "x:/fixture labs/engine" }) },
  }, source, 100_000)[0];
  assert.equal(sameCall?.kind, "call");
  assert.equal(sameCall.argumentKey, call.argumentKey);
  assert.match(sameCall.argumentKey ?? "", /^[a-f0-9]{64}$/);
  const malformed = calls.find(({ callId }) => callId === "fixture-malformed");
  assert.equal(malformed?.name, "shell_command");
  assert.equal(malformed.command, undefined);
  assert.equal(malformed.argumentKey, undefined);
  const restricted = calls.find(({ callId }) => callId === "fixture-sensitive-call");
  assert.equal(restricted?.restricted, true);
  assert.equal(restricted.command, undefined);
  assert.equal(restricted.argumentKey, undefined);
  const patch = calls.find(({ callId }) => callId === "fixture-patch");
  assert.deepEqual(patch?.files, [{
    kind: "move", path: "src/old.ts", destination: "src/new.ts", status: "pending", patch: "\n@@\n-before\n+after",
  }]);
  assert.match(patch.argumentKey ?? "", /^[a-f0-9]{64}$/);
  const polling = calls.find(({ callId }) => callId === "fixture-poll");
  assert.equal(polling?.polling, true);
  assert.match(polling.argumentKey ?? "", /^[a-f0-9]{64}$/);
  const text = eventsOf(events, "message");
  assert.equal(text.find(({ role }) => role === "reasoning")?.text, "Fixture reasoning summary.");
  assert.equal(text.find(({ role }) => role === "agent")?.turnId, "fixture-turn-legacy");
  assert.equal(eventsOf(events, "context")[0]?.percent, undefined);
  assert.doesNotMatch(JSON.stringify(events), /hidden-|private-|auth\.json/u);
});

test("Codex reader validates advisory index identities and preserves observation time", () => {
  const { events, diagnostics } = fixture("session-index.jsonl", "", "index");
  const entries = eventsOf(events, "metadata");
  assert.deepEqual(entries.map(({ threadId, title, at, titleSource }) => [threadId, title, at, titleSource]), [
    [currentId, "Fixture renderer", Date.parse("2026-01-05T10:00:00Z"), "index"],
    [currentId, "Renamed fixture renderer", Date.parse("2026-01-05T11:00:00Z"), "index"],
  ]);
  assert.deepEqual(diagnostics, ["known", "known", "malformed", "known"]);
  assert.doesNotMatch(JSON.stringify(entries), /private-index-marker/u);
});
