import {
  containsSensitivePath, count, identifier, record, safePath, safeText, toolArgumentKey,
} from "../../privacy/projection";
import type { Event, EventBase, FileEvidence, ResultStatus } from "../types";
import { proposedFiles, recordedFiles } from "./file-evidence";

const shellTools = new Set(["exec_command", "shell", "shell_command"]);
const pollingTools = new Set(["wait", "wait_agent", "wait_for_agent"]);

function isRestricted(value: unknown): value is string {
  return typeof value === "string" && containsSensitivePath(value);
}

function redacted(value: unknown): string | undefined {
  return isRestricted(value) ? undefined : safeText(value);
}

function textResult(value: unknown, types: readonly string[]): string | undefined {
  if (!Array.isArray(value)) return redacted(value);
  const parts: string[] = [];
  for (const entry of value) {
    const part = record(entry);
    if (typeof part?.type !== "string" || !types.includes(part.type)) continue;
    if (isRestricted(part.text)) return undefined;
    const text = safeText(part.text);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function toolName(value: unknown): string | undefined {
  const native = identifier(value);
  return native === safeText(native) ? native : undefined;
}

function resultStatus(value: unknown, exitCode?: number): ResultStatus {
  if (value === "failed" || value === "declined" || (exitCode !== undefined && exitCode !== 0)) return "failed";
  if (value === "completed" || value === "applied" || exitCode === 0) return "success";
  return "unknown";
}

function recordedDuration(value: unknown): number | undefined {
  const duration = record(value);
  const secs = count(duration?.secs);
  const nanos = count(duration?.nanos);
  return secs !== undefined && (nanos === undefined || nanos < 1_000_000_000)
    ? count(secs * 1_000 + Math.floor((nanos ?? 0) / 1_000_000))
    : undefined;
}

function toolPair(
  base: EventBase,
  callId: string,
  call: Omit<Extract<Event, { kind: "call" }>, keyof EventBase | "kind" | "callId">,
  result: Omit<Extract<Event, { kind: "result" }>, keyof EventBase | "kind" | "callId" | "callRowId">,
): Event[] {
  return [
    { ...base, ...call, kind: "call", callId },
    { ...base, ...result, id: `${base.id}:result`, kind: "result", callId, callRowId: base.id },
  ];
}

function commandArguments(raw: string | undefined, cwd: string | undefined, argv?: string[], reader = true) {
  const command = redacted(raw);
  return {
    command,
    input: reader ? command : undefined,
    argv: command === raw ? argv : undefined,
    argumentKey: command && command === raw
      ? toolArgumentKey("shell", argv ? { argv, cwd } : { command, cwd }, cwd)
      : undefined,
  };
}

function commandOutput(item: Record<string, unknown>): { text?: string; stdout?: string; stderr?: string } {
  const fields = [item.stdout, item.stderr, item.aggregated_output, item.formatted_output];
  if (fields.some(isRestricted)) return {};
  const stdout = safeText(item.stdout);
  const stderr = safeText(item.stderr);
  const text = stdout && stderr ? `${stdout}\nStderr\n${stderr}`
    : stdout ?? stderr ?? safeText(item.aggregated_output) ?? safeText(item.formatted_output);
  return { text, stdout, stderr };
}

function commandFiles(value: unknown, succeeded: boolean): FileEvidence[] {
  if (!Array.isArray(value)) return [];
  const files: FileEvidence[] = [];
  for (const command of value) {
    const entry = record(command);
    const path = safePath(entry?.path);
    if (!path) continue;
    if (entry?.type === "read" || entry?.type === "search" || entry?.type === "list_files") {
      files.push(entry.type === "read" && succeeded ? { kind: "read", path, status: "inferred" } : { kind: "mention", path });
    }
  }
  return files;
}

export function completedTool(base: EventBase, callId: string, item: Record<string, unknown>): Event[] {
  const startedAt = count(item.started_at_ms);
  const completedAt = count(item.completed_at_ms);
  const elapsed = startedAt !== undefined && completedAt !== undefined ? count(completedAt - startedAt) : undefined;
  const durationMs = recordedDuration(item.duration) ?? elapsed;
  if (item.type === "CommandExecution") {
    const argv = Array.isArray(item.command) && item.command.every((part) => typeof part === "string")
      ? item.command as string[] : undefined;
    const raw = argv?.join(" ");
    const restricted = isRestricted(raw) || isRestricted(item.cwd) ||
      (Array.isArray(item.parsed_cmd) && item.parsed_cmd.some((entry) => isRestricted(record(entry)?.path)));
    const cwd = safePath(item.cwd);
    const exitCode = Number.isSafeInteger(item.exit_code) ? item.exit_code as number : undefined;
    const status = resultStatus(item.status, exitCode);
    return toolPair({ ...base, cwd }, callId, {
      name: "Command", readerOutput: Boolean(raw) || undefined,
      ...(restricted ? { restricted } : { ...commandArguments(raw, cwd, argv), files: commandFiles(item.parsed_cmd, status === "success") }),
    }, {
      ...(restricted ? {} : commandOutput(item)), exitCode, durationMs, status,
    });
  }
  if (item.type === "FileChange") {
    const status = resultStatus(item.status);
    const fileStatus = status === "success" ? "applied" : status === "failed" ? "failed" : "unknown";
    const files = recordedFiles(item.changes, fileStatus);
    const restricted = Object.entries(record(item.changes) ?? {}).some(([path, value]) =>
      isRestricted(path) || isRestricted(record(value)?.move_path));
    return toolPair(base, callId, { name: "File change", restricted, readerOutput: true }, { status, files });
  }
  const result = record(item.result);
  return toolPair(base, callId, { name: toolName(item.tool) ?? "MCP tool" }, {
    status: result?.isError === true ? "failed" : resultStatus(item.status), durationMs,
    text: Array.isArray(result?.content) ? textResult(result.content, ["text"]) : undefined,
  });
}

function toolArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length > 256 * 1024) return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function responseTool(base: EventBase, payload: Record<string, unknown>): Event[] {
  const callId = identifier(payload.call_id);
  if (!callId) return [];
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    return [{
      ...base, kind: "result", callId, status: "unknown",
      text: textResult(payload.output, ["input_text"]),
    }];
  }
  const name = toolName(payload.name) ?? "Tool";
  const reader = payload.namespace === undefined;
  if (name === "apply_patch" && payload.type === "custom_tool_call" && typeof payload.input === "string") {
    const files = proposedFiles(payload.input);
    return [{
      ...base, kind: "call", callId, name, files, restricted: isRestricted(payload.input), readerOutput: reader || undefined,
      argumentKey: files.length && safeText(payload.input) === payload.input
        ? toolArgumentKey(name, { patch: payload.input }) : undefined,
    }];
  }
  const args = toolArguments(payload.arguments);
  if (shellTools.has(name) && args) {
    const raw = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : undefined;
    const restricted = isRestricted(raw) || isRestricted(args.workdir);
    const cwd = safePath(args.workdir);
    return [{
      ...base, kind: "call", callId, name, cwd, restricted, readerOutput: reader && Boolean(raw) || undefined,
      ...(restricted ? {} : commandArguments(raw, cwd, undefined, reader)),
    }];
  }
  if (name === "write_stdin" && args) {
    const sessionId = typeof args.session_id === "number" ? count(args.session_id) : identifier(args.session_id);
    const polling = args.chars === "";
    return [{
      ...base, kind: "call", callId, name, polling, readerOutput: reader && sessionId !== undefined || undefined,
      argumentKey: sessionId !== undefined && polling ? toolArgumentKey(name, { sessionId }) : undefined,
    }];
  }
  if (pollingTools.has(name) && args) {
    const ids = Array.isArray(args.ids) ? args.ids.map(identifier) : [];
    return [{
      ...base, kind: "call", callId, name, polling: true,
      argumentKey: ids.length && ids.every((id) => id !== undefined) ? toolArgumentKey(name, { ids }) : undefined,
    }];
  }
  return [{ ...base, kind: "call", callId, name, spawn: name === "spawn_agent" }];
}

export function searchTool(base: EventBase, callId: string, item: Record<string, unknown>): Event[] {
  const action = record(item.action);
  const queries = Array.isArray(action?.queries) ? action.queries.filter((value) => typeof value === "string") : [];
  const query = typeof action?.query === "string" ? action.query : item.query ?? (queries.length ? queries.join("\n") : undefined);
  const target = query ?? action?.url;
  const restricted = [target, action?.pattern, ...queries].some(isRestricted);
  const subject = restricted ? undefined : redacted(target);
  const pattern = restricted ? undefined : redacted(action?.pattern);
  const text = pattern && subject ? `${pattern}\n${subject}` : subject;
  const name = item.type === "Extension" ? "Extension" : "Web search";
  const argumentKey = subject && subject === target && pattern === action?.pattern
    ? toolArgumentKey(name, { action: toolName(action?.type), target: subject, pattern })
    : undefined;
  const call = { name, text, input: item.type === "Extension" ? undefined : text, argumentKey, restricted,
    readerOutput: item.type !== "Extension" || undefined };
  if (base.variant === "provisional") return [{ ...base, ...call, kind: "call", callId }];
  const resultCount = Array.isArray(item.results) ? item.results.length : undefined;
  return toolPair(base, callId, call, {
    status: resultStatus(item.status),
    text: resultCount === undefined || restricted ? undefined : `${resultCount} results`,
    durationMs: count(item.durationMs),
  });
}
