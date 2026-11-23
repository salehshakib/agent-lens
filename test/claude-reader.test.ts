import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyClaudeRecord, parseClaudeRecords } from "../src/host/adapters/claude-code/records";
import { extractCodexStartupEvidence } from "../src/host/adapters/claude-code/tools";
import type { Source } from "../src/host/adapters/types";

const sessionId = "10000000-0000-4000-8000-000000000001";
const source: Source = {
  key: "synthetic-claude-transcript",
  provider: "claude-code",
  home: "X:/fixtures/synthetic-claude",
  root: "X:/fixtures/synthetic-claude/projects",
  path: `X:/fixtures/synthetic-claude/projects/example/${sessionId}.jsonl`,
  sessionId,
  laneId: sessionId,
  kind: "transcript",
  updatedAt: Date.parse("2030-01-02T10:00:04Z"),
};
const fixture = readFileSync("test/fixtures/claude-code/transcript.jsonl", "utf8");
const records = fixture.trimEnd().split(/\r?\n/).map(line => JSON.parse(line) as unknown);
const events = records.flatMap((value, offset) => parseClaudeRecords(value, source, offset));

test("Claude reader extracts exact launcher evidence and rejects conflicting or partial markers", () => {
  const codexId = "10000000-0000-4000-8000-000000000020";
  const marker = "AGENT_LENS_CODEX_SESSION=" + codexId;
  const start = JSON.stringify({ type: "thread.started", thread_id: codexId });
  assert.deepEqual(extractCodexStartupEvidence(start), { evidence: "thread-started", threadId: codexId });
  assert.deepEqual(extractCodexStartupEvidence(start + "\r\n" + marker), { evidence: "marker", threadId: codexId });
  assert.deepEqual(extractCodexStartupEvidence(start + "\nAGENT_LENS_CODEX_SESSION=" + sessionId), { evidence: "conflicting" });
  assert.equal(extractCodexStartupEvidence("UUID: " + codexId + "\n> " + marker), undefined);
  assert.equal(extractCodexStartupEvidence("x".repeat(65_515) + "\n" + marker), undefined);
  const events = parseClaudeRecords({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-launch", content: "Scheduled" }] },
    toolUseResult: { stdout: marker, backgroundTaskId: "synthetic-task" },
  }, source, 0);
  const result = events.find(event => event.kind === "result");
  assert.deepEqual(result?.launcher, { evidence: "marker", threadId: codexId });
});

test("Claude reader projects legacy and current blocks, with response and ancestry evidence", () => {
  const messages = events.filter(event => event.kind === "message");
  const prompts = messages.filter(message => message.role === "user");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.text, "Review the synthetic export.");
  assert.equal(prompts[0]?.at, Date.parse("2030-01-02T10:00:00Z"));
  const response = events.filter(event => event.responseId === "synthetic-response");
  const responseUsage = response.filter(event => event.kind === "usage");
  assert.equal(responseUsage.length, 2);
  assert.notEqual(responseUsage[0]?.id, responseUsage[1]?.id);
  assert.equal(responseUsage[0]?.parentId, "synthetic-prompt");
  assert.equal(responseUsage[0]?.recordId, "synthetic-tools");
  assert.deepEqual(responseUsage[0]?.tokens, { input: 12, output: 7, cacheRead: 22, cacheWrite: 6, reasoning: 2 });
  assert.equal(messages.find(message => message.role === "reasoning")?.durationMs, 45);
  assert.ok(events.some(event => event.kind === "usage" && event.responseId === "synthetic-request-fallback"));
  assert.ok(events.some(event => event.kind === "metadata" && event.stopReason === "tool_use" && !event.outcome));
  assert.ok(events.some(event => event.kind === "metadata" && event.stopReason === "end_turn"));
  assert.ok(events.some(event => event.kind === "metadata" && event.version === "2.1.310"));
  assert.ok(events.some(event => event.kind === "metadata" && event.version === "2.1.330" && event.effort === "low"));
  assert.ok(events.some(event => event.kind === "metadata" && event.effort === "medium"));
});

test("Claude reader keeps tool identity, out-of-order results, polling and applied patch evidence", () => {
  const calls = events.filter(event => event.kind === "call");
  const results = events.filter(event => event.kind === "result");
  const read = calls.find(call => call.callId === "synthetic-read");
  const readResult = results.find(result => result.callId === "synthetic-read");
  assert.ok(read);
  assert.ok(readResult);
  assert.deepEqual(read.files?.[0]?.range, { offset: 2, limit: 8 });
  assert.match(read.argumentKey ?? "", /^[0-9a-f]{64}$/);
  assert.ok(events.indexOf(readResult) < events.indexOf(read));
  assert.equal(readResult.sourceAssistantId, "synthetic-tools");
  assert.equal(readResult.text, "synthetic file contents\n[Image]");
  assert.equal(calls.find(call => call.callId === "synthetic-malformed")?.argumentKey, undefined);
  assert.equal(calls.find(call => call.callId === "synthetic-spawn")?.spawn, true);
  assert.equal(calls.find(call => call.callId === "synthetic-poll")?.polling, true);
  assert.equal(calls.find(call => call.callId === "synthetic-private")?.restricted, true);
  assert.equal(calls.find(call => call.callId === "synthetic-private")?.command, undefined);
  assert.equal(results.find(result => result.callId === "synthetic-spawn")?.backgroundTaskId, undefined);
  const bashResult = results.find(result => result.callId === "synthetic-bash");
  assert.equal(bashResult?.status, "scheduled");
  assert.equal(bashResult?.backgroundTaskId, "synthetic-task");
  assert.equal(bashResult?.text, "synthetic command output");
  assert.match(results.find(result => result.callId === "synthetic-write")?.files?.[0]?.patch ?? "", /^@@ -1,1 \+1,1 @@/);
  assert.ok(events.some(event => event.kind === "task" && event.taskId === "synthetic-task" && event.state === "completed"));
  assert.equal(events.filter(event => event.kind === "file" && event.files[0]?.kind === "checkpoint").length, 2);
});

test("Claude reader allowlists companion metadata and treats process markers as hints", () => {
  const child = JSON.parse(readFileSync("test/fixtures/claude-code/child.meta.json", "utf8"));
  const childEvent = parseClaudeRecords(child, { ...source, kind: "agent-metadata", laneId: "a001" }, 0)[0];
  assert.ok(childEvent?.kind === "metadata");
  assert.equal(childEvent.spawnCallId, "synthetic-spawn");
  assert.equal(childEvent.spawnDepth, 2);
  assert.equal(childEvent.outcome, "interrupted");

  const marker = JSON.parse(readFileSync("test/fixtures/claude-code/presence.json", "utf8"));
  const presenceSource: Source = { ...source, kind: "presence", sessionId: "2468", laneId: "2468" };
  const presence = parseClaudeRecords(marker, presenceSource, 0)[0];
  assert.ok(presence?.kind === "metadata");
  assert.equal(presence.threadId, sessionId);
  assert.equal(presence.presence?.status, "idle");
  assert.equal(presence.outcome, undefined);
  assert.equal(classifyClaudeRecord(marker, { ...presenceSource, sessionId: "9876" }), "malformed");
  assert.deepEqual(parseClaudeRecords(marker, { ...presenceSource, sessionId: "9876" }, 0), []);
  assert.doesNotMatch(JSON.stringify([childEvent, presence]), /IGNORE-/);
});

test("Claude reader excludes private, injected and unknown records and marks compaction quietly", () => {
  assert.doesNotMatch(JSON.stringify(events), /IGNORE-|auth\.json/);
  const compaction = events.find(event => event.kind === "compaction");
  assert.equal(compaction?.parentId, "synthetic-finished");
  assert.equal(classifyClaudeRecord({ type: "api-request", params: {} }, source), "known");
  assert.equal(classifyClaudeRecord({ type: "future-type" }, source), "unknown");
  assert.equal(classifyClaudeRecord({ type: "user", message: { role: "assistant" } }, source), "malformed");
});
