import type { Event, EventBase, Source, Tokens } from "../types";
import { containsSensitivePath, count, identifier, record, safePath, safeText, timestamp } from "../../privacy/projection";
import { claudeToolCall, claudeToolResult, taskOutcome } from "./tools";

type JsonObject = Record<string, unknown>;
type Metadata = Extract<Event, { kind: "metadata" }>;

const supportedTypes = new Set([
  "user", "assistant", "attachment", "ai-title", "last-prompt", "system",
  "file-history-snapshot", "file-history-delta",
]);
const ignoredTypes = new Set([
  "queue-operation", "tools-used", "session-owner", "atis-latch", "api-request",
  "api-request-blob", "api-request-shape", "mode", "pr-link",
]);
const sessionIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function classifyClaudeRecord(value: unknown, source: Source): "known" | "unknown" | "malformed" {
  const row = record(value);
  if (!row || source.provider !== "claude-code") return "malformed";
  if (source.kind === "agent-metadata") {
    return ["agentType", "description", "toolUseId", "finished", "stoppedByUser", "model", "effort"]
      .some(field => Object.hasOwn(row, field)) ? "known" : "unknown";
  }
  if (source.kind === "presence") {
    return count(row.pid) && typeof row.sessionId === "string" && sessionIdPattern.test(row.sessionId)
      && String(row.pid) === source.sessionId ? "known" : "malformed";
  }
  if (source.kind !== "transcript" || typeof row.type !== "string") return "malformed";
  if (!supportedTypes.has(row.type) && !ignoredTypes.has(row.type)) return "unknown";
  if (!ownsRecord(row, source)) return "malformed";
  if ((row.type === "assistant" || row.type === "user") && record(row.message)?.role !== row.type) {
    return "malformed";
  }
  return "known";
}

function ownsRecord(row: JsonObject, source: Source): boolean {
  if (row.sessionId !== undefined &&
      (typeof row.sessionId !== "string" || row.sessionId.toLowerCase() !== source.sessionId.toLowerCase())) {
    return false;
  }
  // Main files can hold branches and explicit cross-lane evidence. A child descriptor names one lane.
  return source.laneId === source.sessionId || row.agentId === undefined || row.agentId === source.laneId;
}

function responseUsage(value: unknown): Tokens | undefined {
  const usage = record(value);
  if (!usage) return undefined;

  const tokens: Tokens = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    reasoning: count(record(usage.output_tokens_details)?.thinking_tokens),
  };
  return Object.values(tokens).some(value => value !== undefined) ? tokens : undefined;
}

function emitterVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,5}(?:[-+][\w.-]{1,40})?$/.test(value)
    ? value : undefined;
}

function metadataFor(row: JsonObject, base: EventBase): Metadata | undefined {
  const message = row.type === "assistant" ? record(row.message) : undefined;
  const metadata: Metadata = {
    ...base,
    kind: "metadata",
    model: identifier(message?.model),
    effort: identifier(row.perTurnEffort) ?? identifier(row.effort),
    version: emitterVersion(row.version),
    branch: safeText(row.gitBranch, 160),
    stopReason: identifier(message?.stop_reason),
    outcome: message && row.isAbortedMidStream === true ? "aborted" : undefined,
  };
  return base.cwd || metadata.model || metadata.effort || metadata.version ||
    metadata.branch || metadata.stopReason || metadata.outcome ? metadata : undefined;
}

function parsePresence(row: JsonObject, source: Source): Event[] {
  if (classifyClaudeRecord(row, source) !== "known") return [];
  const status = identifier(row.status);
  const statusUpdatedAt = timestamp(row.statusUpdatedAt);
  return [{
    id: `${source.key}:presence`,
    kind: "metadata",
    at: timestamp(row.updatedAt) ?? statusUpdatedAt ?? timestamp(row.startedAt),
    threadId: identifier(row.sessionId)?.toLowerCase(),
    cwd: safePath(row.cwd),
    version: emitterVersion(row.version),
    origin: identifier(row.entrypoint),
    presence: {
      pid: count(row.pid),
      procStart: count(row.procStart),
      pidDomain: identifier(row.pidDomain),
      status,
      statusUpdatedAt,
    },
  }];
}

function parseAgentMetadata(row: JsonObject, source: Source, offset: number): Event[] {
  if (classifyClaudeRecord(row, source) !== "known" || !ownsRecord(row, source)) return [];
  return [{
    id: `${source.key}:${offset}:agent`,
    kind: "metadata",
    at: source.updatedAt,
    spawnCallId: identifier(row.toolUseId),
    spawnDepth: count(row.spawnDepth),
    agentType: identifier(row.agentType),
    description: safeText(row.description, 512),
    model: identifier(row.model),
    effort: identifier(row.effort),
    outcome: row.stoppedByUser === true ? "interrupted" : row.finished === true ? "completed" : undefined,
  }];
}

function parseMessage(row: JsonObject, base: EventBase, unsafeCwd: boolean): Event[] {
  const message = record(row.message);
  if (!message || message.role !== row.type) return [];

  const assistant = row.type === "assistant";
  const responseId = assistant ? identifier(message.id) ?? identifier(row.requestId) : undefined;
  const messageBase = { ...base, responseId };
  const events: Event[] = [];
  const metadata = metadataFor(row, { ...messageBase, id: `${base.id}:metadata` });
  if (metadata) events.push(metadata);

  const blocks = Array.isArray(message.content)
    ? message.content.map(record)
    : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
  const results = blocks.filter(block => block?.type === "tool_result");
  const userPrompt = !assistant && results.length === 0 && row.isMeta !== true &&
    row.isCompactSummary !== true && !row.sourceToolAssistantUUID && !row.sourceToolUseID;

  if (assistant && row.isApiErrorMessage === true) {
    return [...events, { ...messageBase, id: `${base.id}:error`, kind: "message", role: "error", text: "API error" }];
  }

  for (const [index, block] of blocks.entries()) {
    if (!block) continue;
    const blockBase = { ...messageBase, id: `${base.id}:block:${index}` };
    if (assistant && block.type === "tool_use") {
      const call = claudeToolCall(block, blockBase, unsafeCwd);
      if (call) events.push(call);
    } else if (!assistant && block.type === "tool_result") {
      const result = claudeToolResult(block, blockBase, row, results.length === 1, unsafeCwd);
      if (result) events.push(result);
    } else if ((assistant || userPrompt) && block.type === "text") {
      const text = safeText(block.text);
      if (text?.trim()) events.push({ ...blockBase, kind: "message", role: assistant ? "assistant" : "user", text });
    } else if (assistant && block.type === "thinking") {
      events.push({ ...blockBase, kind: "message", role: "reasoning", text: "Thinking", durationMs: count(row.thinkingDurationMs) });
    } else if ((assistant || userPrompt) && (block.type === "image" || block.type === "document")) {
      const label = block.type === "image" ? "Image" : "Document";
      const title = safeText(block.title, 160);
      events.push({ ...blockBase, kind: "message", role: "attachment", text: title ? `${label} · ${title}` : label });
    }
  }

  const tokens = assistant ? responseUsage(message.usage) : undefined;
  if (tokens) events.push({
    ...messageBase, id: `${base.id}:usage`, kind: "usage", scope: "response",
    tokens, model: identifier(message.model),
  });
  return events;
}

function parseAttachment(row: JsonObject, base: EventBase): Event[] {
  const attachment = record(row.attachment);
  if (attachment?.type === "task_status") {
    const taskId = identifier(attachment.taskId);
    const state = taskOutcome(attachment.status);
    return taskId && state ? [{
      ...base, kind: "task", taskId, state, description: safeText(attachment.description, 512),
    }] : [];
  }
  if (attachment?.type !== "file") return [];
  const path = safePath(attachment.displayPath) ?? safePath(attachment.filename);
  return path ? [{ ...base, kind: "message", role: "attachment", text: path }] : [];
}

function parseCheckpoints(row: JsonObject, base: EventBase): Event[] {
  if (row.type === "file-history-delta") {
    const path = safePath(row.trackingPath);
    return path ? [{
      ...base, kind: "file", parentId: identifier(row.snapshotMessageId) ?? identifier(row.messageId),
      files: [{ path, kind: "checkpoint" }],
    }] : [];
  }

  const snapshot = record(row.snapshot);
  const backups = record(snapshot?.trackedFileBackups);
  if (!backups) return [];
  const files = Object.keys(backups).flatMap(key => {
    const path = safePath(key);
    return path ? [{ path, kind: "checkpoint" as const }] : [];
  });
  return files.length ? [{
    ...base, at: base.at ?? timestamp(snapshot?.timestamp),
    parentId: identifier(snapshot?.messageId) ?? identifier(row.messageId), kind: "file", files,
  }] : [];
}

export function parseClaudeRecords(value: unknown, source: Source, offset: number): Event[] {
  const row = record(value);
  if (!row || source.provider !== "claude-code") return [];
  if (source.kind === "agent-metadata") return parseAgentMetadata(row, source, offset);
  if (source.kind === "presence") return parsePresence(row, source);
  if (source.kind !== "transcript" || typeof row.type !== "string" || !supportedTypes.has(row.type) ||
    !ownsRecord(row, source)) return [];

  const recordId = identifier(row.uuid);
  const apiBlockIndex = count(row.apiBlockIndex);
  const base: EventBase = {
    id: `${source.key}:${recordId ? `record:${recordId}:${apiBlockIndex ?? ""}` : `byte:${offset}`}`,
    recordId,
    at: timestamp(row.timestamp),
    parentId: identifier(row.parentUuid),
    cwd: safePath(row.cwd),
  };
  const unsafeCwd = typeof row.cwd === "string" && containsSensitivePath(row.cwd);
  switch (row.type) {
    case "user":
    case "assistant":
      return parseMessage(row, base, unsafeCwd);
    case "ai-title": {
      const title = safeText(row.aiTitle, 256)?.trim();
      return title ? [{ ...base, kind: "metadata", title }] : [];
    }
    case "last-prompt": {
      const title = safeText(row.lastPrompt, 256)?.trim() || undefined;
      const leafId = identifier(row.leafUuid);
      return title || leafId ? [{ ...base, kind: "metadata", title, titleSource: "fallback", leafId }] : [];
    }
    case "system":
      return row.subtype === "compact_boundary" ? [{
        ...base, kind: "compaction", parentId: identifier(row.logicalParentUuid) ?? base.parentId,
      }] : [];
    case "attachment":
      return parseAttachment(row, base);
    case "file-history-delta":
    case "file-history-snapshot":
      return parseCheckpoints(row, base);
    default:
      return [];
  }
}
