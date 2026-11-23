import { count, identifier, record, safePath, safeText, timestamp } from "../../privacy/projection";
import type { Event, EventBase, Source } from "../types";
import { completedTool, responseTool, searchTool } from "./tools";
import { exactUsage, observedUsage } from "./usage";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const outerTypes = new Set([
  "session_meta", "turn_context", "world_state", "event_msg", "response_item",
  "token_usage_record", "inter_agent_communication_metadata", "compacted",
]);
const eventTypes = new Set([
  "task_started", "task_complete", "turn_aborted", "thread_settings_applied",
  "token_count", "user_message", "item_completed",
]);
const responseTypes = new Set([
  "message", "agent_message", "reasoning", "function_call", "function_call_output",
  "custom_tool_call", "custom_tool_call_output", "web_search_call", "additional_tools",
]);
const itemTypes = new Set([
  "UserMessage", "AgentMessage", "CommandExecution", "FileChange", "Reasoning",
  "SubAgentActivity", "McpToolCall", "WebSearch", "Extension", "Plan", "ContextCompaction",
]);

export function classifyCodexRecord(value: unknown, source: Source): "known" | "unknown" | "malformed" {
  const row = record(value);
  if (!row) return "malformed";
  if (source.kind === "index") return uuid(row.id) ? "known" : "malformed";
  if (typeof row.type !== "string") return "malformed";
  if (!outerTypes.has(row.type)) return "unknown";
  const payload = record(row.payload);
  if (!payload) return "malformed";
  if (row.type !== "event_msg" && row.type !== "response_item") return "known";
  if (typeof payload.type !== "string") return "malformed";
  if (row.type === "response_item") return responseTypes.has(payload.type) ? "known" : "unknown";
  if (payload.type !== "item_completed") return eventTypes.has(payload.type) ? "known" : "unknown";
  const item = record(payload.item);
  if (typeof item?.type !== "string") return "malformed";
  return itemTypes.has(item.type) ? "known" : "unknown";
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && uuidPattern.test(value) ? value.toLowerCase() : undefined;
}

function matchesThread(value: unknown, source: Source): boolean {
  return value === undefined || uuid(value) === source.sessionId.toLowerCase();
}

function label(value: unknown): string | undefined {
  return safeText(value, 256)?.trim() || undefined;
}

function message(base: EventBase, role: Extract<Event, { kind: "message" }>["role"], text?: string): Event[] {
  return text ? [{ ...base, kind: "message", role, text }] : [];
}

function contentText(value: unknown, types: readonly string[], include?: (index: number) => boolean): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const [index, entry] of value.entries()) {
    const part = record(entry);
    if (typeof part?.type !== "string" || !types.includes(part.type) || (include && !include(index))) continue;
    const text = safeText(part.text);
    if (text?.trim()) parts.push(text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function attachmentSummary(base: EventBase, total: number): Event[] {
  return total ? message({ ...base, id: `${base.id}:attachments` }, "attachment",
    total === 1 ? "1 image attachment" : `${total} image attachments`) : [];
}

function sessionMeta(base: EventBase, payload: Record<string, unknown>, source: Source): Event[] {
  if (!matchesThread(payload.id, source)) return [];
  const child = record(record(record(payload.source)?.subagent)?.thread_spawn);
  const directParent = uuid(payload.parent_thread_id);
  const nestedParent = uuid(child?.parent_thread_id);
  const agrees = !directParent || !nestedParent || directParent === nestedParent;
  const parent = agrees ? directParent ?? nestedParent : undefined;
  const parentThreadId = parent === source.sessionId.toLowerCase() ? undefined : parent;
  return [{
    ...base,
    at: timestamp(payload.timestamp) ?? base.at,
    kind: "metadata",
    threadId: source.sessionId.toLowerCase(),
    version: identifier(payload.cli_version),
    cwd: safePath(payload.cwd),
    branch: label(record(payload.git)?.branch),
    origin: label(payload.source) ?? label(payload.originator),
    title: label(payload.agent_nickname) ?? label(child?.agent_nickname),
    agentType: label(payload.agent_role) ?? label(child?.agent_role),
    parentThreadId,
    historyStartOrdinal: count(payload.subagent_history_start_ordinal),
  }];
}

function modelSettings(base: EventBase, settings: Record<string, unknown>, effort: unknown): Event[] {
  const collaboration = base.turnId ? record(record(settings.collaboration_mode)?.settings) : undefined;
  return [{
    ...base,
    kind: "metadata",
    model: label(settings.model) ?? label(collaboration?.model),
    effort: label(effort) ?? label(collaboration?.reasoning_effort),
    cwd: safePath(settings.cwd),
  }];
}

function completedItem(base: EventBase, item: Record<string, unknown>, source: Source): Event[] {
  const nativeId = identifier(item.id);
  if (!nativeId) return [];
  const itemBase: EventBase = {
    ...base,
    id: JSON.stringify([source.key, "item", base.turnId ?? null, nativeId]),
    at: count(item.completed_at_ms) ?? base.at,
    nativeId,
    variant: "structured",
  };
  switch (item.type) {
    case "UserMessage": {
      const total = Array.isArray(item.content) ? item.content.filter((entry) => {
        const type = record(entry)?.type;
        return type === "image" || type === "local_image";
      }).length : 0;
      return [...message(itemBase, "user", contentText(item.content, ["text", "input_text"])),
        ...attachmentSummary(itemBase, total)];
    }
    case "AgentMessage":
      return message(itemBase, item.phase === "final_answer" ? "final" : "assistant",
        contentText(item.content, ["text", "output_text"]));
    case "Reasoning": {
      const parts = Array.isArray(item.summary_text)
        ? item.summary_text.map((entry) => safeText(entry)).filter((entry) => entry?.trim())
        : [];
      return message(itemBase, "reasoning", parts.length ? parts.join("\n") : undefined);
    }
    case "SubAgentActivity": {
      const childThreadId = uuid(item.agent_thread_id);
      if (!childThreadId || childThreadId === source.sessionId.toLowerCase()) return [];
      if (item.kind !== "started" && item.kind !== "interacted" && item.kind !== "completed") return [];
      const state = item.kind === "started" ? "running" : item.kind === "completed" ? "completed" : undefined;
      return [{
        ...itemBase, kind: "spawn", childThreadId, state,
        model: label(item.model), effort: label(item.reasoning_effort),
      }];
    }
    case "ContextCompaction":
      return [{ ...itemBase, kind: "compaction" }];
    case "Plan":
      return message(itemBase, "plan", safeText(item.text));
    case "CommandExecution":
    case "FileChange":
    case "McpToolCall":
      return completedTool(itemBase, nativeId, item);
    case "WebSearch":
    case "Extension":
      return searchTool(itemBase, nativeId, item);
    default:
      return [];
  }
}

function eventMessage(base: EventBase, payload: Record<string, unknown>, source: Source): Event[] {
  const attribution = record(payload.turn_attribution);
  const eventBase = {
    ...base,
    turnId: base.turnId ?? identifier(attribution?.turn_id),
    rootTurnId: base.rootTurnId ?? identifier(attribution?.root_turn_id),
    parentId: identifier(attribution?.parent_turn_id),
  };
  switch (payload.type) {
    case "task_started":
      return [{
        ...eventBase, kind: "turn", state: "running", capacity: count(payload.model_context_window) || undefined,
        at: timestamp(payload.started_at) ?? base.at,
      }];
    case "task_complete": {
      const failed = payload.error !== undefined && payload.error !== null;
      const at = timestamp(payload.completed_at) ?? base.at;
      const turn: Event = {
        ...eventBase, at, kind: "turn", state: failed ? "failed" : "completed", durationMs: count(payload.duration_ms),
      };
      return [
        turn,
        ...message({ ...eventBase, at, id: `${base.id}:error` }, "error", safeText(record(payload.error)?.message)),
        ...message({ ...eventBase, at, id: `${base.id}:final`, variant: "fallback" }, "final",
          safeText(payload.last_agent_message)),
      ];
    }
    case "turn_aborted":
      return [{
        ...eventBase, kind: "turn", state: payload.reason === "interrupted" ? "interrupted" : "aborted",
        at: timestamp(payload.completed_at) ?? base.at, durationMs: count(payload.duration_ms),
      }];
    case "thread_settings_applied": {
      const settings = record(payload.thread_settings);
      return settings ? modelSettings(base, settings, settings.reasoning_effort) : [];
    }
    case "token_count":
      return observedUsage(base, payload);
    case "user_message": {
      const legacy: EventBase = { ...base, variant: "fallback" };
      const images = Array.isArray(payload.images) ? payload.images.length : 0;
      const localImages = Array.isArray(payload.local_images) ? payload.local_images.length : 0;
      const count = images && localImages ? 0 : images + localImages;
      return [...message(legacy, "user", safeText(payload.message)), ...attachmentSummary(legacy, count)];
    }
    case "item_completed": {
      const item = record(payload.item);
      return item ? completedItem(base, item, source) : [];
    }
    default:
      return [];
  }
}

function responseItem(base: EventBase, payload: Record<string, unknown>): Event[] {
  const metadata = record(payload.internal_chat_message_metadata_passthrough);
  const responseBase: EventBase = {
    ...base,
    turnId: base.turnId ?? identifier(metadata?.turn_id),
    at: timestamp(metadata?.create_time) ?? base.at,
    nativeId: identifier(payload.id),
    variant: "provisional",
  };
  switch (payload.type) {
    case "message": {
      if (payload.role === "assistant") {
        return message(responseBase, payload.phase === "final_answer" ? "final" : "assistant",
          contentText(payload.content, ["output_text"]));
      }
      if (payload.role !== "user") return [];
      const kinds = metadata?.content_item_kinds ?? record(payload.metadata)?.content_item_kinds ??
        payload.content_item_kinds;
      if (kinds !== undefined && !Array.isArray(kinds)) return [];
      return message(responseBase, "user", contentText(payload.content, ["input_text"],
        Array.isArray(kinds) ? (index) => kinds[index] === "user.text" : undefined));
    }
    case "agent_message":
      return message(responseBase, "agent", contentText(payload.content, ["input_text"]));
    case "reasoning":
      return message(responseBase, "reasoning", contentText(payload.summary, ["summary_text"]));
    case "function_call":
    case "function_call_output":
    case "custom_tool_call":
    case "custom_tool_call_output":
      return responseTool(responseBase, payload);
    case "web_search_call":
      return searchTool(responseBase, responseBase.nativeId ?? responseBase.id, payload);
    default:
      return [];
  }
}

/** Project the on-disk rollout shapes without starting a CLI or interpreting command text. */
export function parseCodexRecords(value: unknown, source: Source, offset: number): Event[] {
  if (source.provider !== "codex") return [];
  const row = record(value);
  if (!row) return [];
  const base = { id: JSON.stringify([source.key, offset]), at: timestamp(row.timestamp) };
  if (source.kind === "index") {
    const threadId = uuid(row.id);
    const title = label(row.thread_name);
    return threadId && title
      ? [{ ...base, at: timestamp(row.updated_at), kind: "metadata", threadId, title, titleSource: "index" }]
      : [];
  }
  if (source.kind !== "transcript" || !uuid(source.sessionId)) return [];
  const payload = record(row.payload);
  if (!payload || !matchesThread(payload.thread_id, source)) return [];
  const attributed = { ...base, turnId: identifier(payload.turn_id), rootTurnId: identifier(payload.root_turn_id) };
  switch (row.type) {
    case "session_meta":
      return sessionMeta(base, payload, source);
    case "turn_context":
      return modelSettings(attributed, payload, payload.effort);
    case "event_msg":
      return eventMessage(attributed, payload, source);
    case "response_item":
      return responseItem(attributed, payload);
    case "token_usage_record":
      return exactUsage(attributed, payload);
    case "compacted":
      return [{ ...attributed, kind: "compaction", nativeId: identifier(payload.compaction_response_id) }];
    default:
      return [];
  }
}
