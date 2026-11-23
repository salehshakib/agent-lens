import type { Event, EventBase, FileEvidence, LauncherEvidence, Outcome, ResultStatus } from "../types";
import {
  containsSensitivePath, count, identifier, record, safePath, safeText,
  toolArgumentKey,
} from "../../privacy/projection";

type JsonObject = Record<string, unknown>;

const fileTools = new Set(["Read", "Edit", "Write"]);
const searchTools = new Set(["Glob", "Grep"]);
const agentFields = ["description", "subagent_type", "model", "effort", "prompt", "run_in_background"];
const observedArguments: Record<string, readonly string[]> = {
  Bash: ["command", "description", "run_in_background", "timeout"],
  Read: ["file_path", "offset", "limit"],
  Edit: ["file_path", "old_string", "new_string", "replace_all"],
  Write: ["file_path", "content"],
  Glob: ["path", "pattern"],
  Grep: ["path", "pattern", "glob", "output_mode"],
  Agent: agentFields,
  Task: agentFields,
  TaskOutput: ["task_id", "block", "timeout"],
  TaskStop: ["task_id"],
  SendMessage: ["to", "recipient", "summary", "message", "content"],
};

function boolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function unchangedText(value: unknown): string | undefined {
  if (value === "") return value;
  const text = safeText(value);
  return text === value ? text : undefined;
}

export function taskOutcome(value: unknown): Outcome | undefined {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "interrupted":
    case "aborted":
      return value;
    case "stopped":
      return "interrupted";
    default:
      return undefined;
  }
}

export function claudeToolCall(block: JsonObject, base: EventBase, unsafeCwd: boolean): Event | undefined {
  const callId = identifier(block.id);
  if (!callId) return undefined;

  const nativeName = identifier(block.name);
  const name = nativeName && !nativeName.startsWith("mcp__") ? nativeName : "Tool";
  const input = record(block.input);
  const call: Extract<Event, { kind: "call" }> = { ...base, kind: "call", name, callId };
  if (unsafeCwd) return { ...call, restricted: true };
  if (!input) return call;

  const rawPath = fileTools.has(name) ? input.file_path : searchTools.has(name) ? input.path : undefined;
  // Keep only the call identity when a tool is tied to a sensitive location.
  if (typeof rawPath === "string" && containsSensitivePath(rawPath)) return { ...call, restricted: true };

  let args: Record<string, unknown> | undefined;
  if (name === "Bash") {
    if (typeof input.command === "string" && containsSensitivePath(input.command)) {
      return { ...call, restricted: true };
    }
    call.command = safeText(input.command);
    call.text = safeText(input.description, 512);
    // If sanitization changed the command, equality of the visible text is insufficient evidence.
    if (call.command && call.command === input.command) {
      args = {
        command: call.command,
        runInBackground: boolean(input.run_in_background) ?? false,
        timeout: count(input.timeout),
      };
    }
  } else if (fileTools.has(name)) {
    const path = safePath(input.file_path);
    if (!path) return call;

    const offset = count(input.offset);
    const limit = count(input.limit);
    const range = name === "Read" && (offset !== undefined || limit !== undefined) ? { offset, limit } : undefined;
    call.files = [{ path, kind: name === "Read" ? "read" : "edit", range, status: "pending" }];

    if (name === "Read" && (offset !== undefined || input.offset === undefined) &&
        (limit !== undefined || input.limit === undefined)) {
      args = { path, offset, limit };
    } else if (name === "Edit") {
      const oldText = unchangedText(input.old_string);
      const newText = unchangedText(input.new_string);
      if (oldText !== undefined && newText !== undefined) {
        args = { path, oldText, newText, replaceAll: boolean(input.replace_all) ?? false };
      }
    } else if (name === "Write") {
      const content = unchangedText(input.content);
      if (content !== undefined) args = { path, content };
    }
  } else if (searchTools.has(name)) {
    const path = safePath(input.path);
    const pattern = safeText(input.pattern);
    call.text = pattern;
    if (path) call.files = [{ path, kind: "mention", status: "unknown" }];

    const glob = safeText(input.glob);
    if (pattern && pattern === input.pattern && glob === input.glob && (input.path === undefined || path)) {
      args = { path, pattern, glob, outputMode: identifier(input.output_mode) };
    }
  } else if (name === "Agent" || (name === "Task" && identifier(input.subagent_type) && typeof input.prompt === "string")) {
    // A legacy Task is only a spawn candidate. The host still needs child identity evidence.
    call.spawn = true;
    call.text = safeText(input.description, 512);
    const prompt = safeText(input.prompt);
    if (prompt && prompt === input.prompt) {
      args = {
        prompt,
        agentType: identifier(input.subagent_type),
        model: identifier(input.model),
        effort: identifier(input.effort),
        runInBackground: boolean(input.run_in_background) ?? false,
      };
    }
  } else if (name === "TaskOutput" || name === "TaskStop") {
    call.polling = name === "TaskOutput";
    const taskId = identifier(input.task_id);
    if (taskId) args = { taskId, block: boolean(input.block), timeout: count(input.timeout) };
  } else if (name === "SendMessage") {
    call.text = safeText(input.summary, 512);
    const recipient = identifier(input.to ?? input.recipient);
    const nativeMessage = input.message ?? input.content;
    const message = safeText(nativeMessage);
    if (recipient && message && message === nativeMessage) args = { recipient, message };
  }

  // Unknown arguments may change a call's behavior, so a projected subset cannot establish repetition.
  if (args && Object.keys(input).every(field => observedArguments[name]?.includes(field))) {
    call.argumentKey = toolArgumentKey(name, args, call.cwd);
  }
  return call;
}

function renderResultContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return typeof value === "string" && !containsSensitivePath(value) ? safeText(value) : undefined;
  }

  const parts: string[] = [];
  for (const valuePart of value) {
    const part = record(valuePart);
    if (part?.type === "text" && typeof part.text === "string") {
      if (containsSensitivePath(part.text)) return undefined;
      const text = safeText(part.text);
      if (text) parts.push(text);
    } else if (part?.type === "image") {
      parts.push("[Image]");
    } else if (part?.type === "document") {
      parts.push("[Document]");
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

function patchFromResult(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const parts: string[] = [];
  for (const entry of value) {
    const hunk = record(entry);
    const oldStart = count(hunk?.oldStart);
    const oldLines = count(hunk?.oldLines);
    const newStart = count(hunk?.newStart);
    const newLines = count(hunk?.newLines);
    if (oldStart === undefined || oldLines === undefined || newStart === undefined || newLines === undefined ||
      !Array.isArray(hunk?.lines)) {
      return undefined;
    }

    parts.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    let oldSeen = 0;
    let newSeen = 0;
    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") {
        parts.push(line);
        continue;
      }
      if (typeof line !== "string" || !/^[ +\-]/.test(line) || /[\r\n]/.test(line) || containsSensitivePath(line)) {
        return undefined;
      }
      const sanitized = line === " " ? line : safeText(line);
      if (!sanitized) return undefined;
      if (line[0] !== "+") oldSeen++;
      if (line[0] !== "-") newSeen++;
      parts.push(sanitized);
    }
    if (oldSeen !== oldLines || newSeen !== newLines) return undefined;
  }
  return parts.join("\n");
}

function statedResultStatus(block: JsonObject, failed: boolean, scheduled: boolean): ResultStatus {
  if (block.is_error === true || failed) return "failed";
  if (block.is_error !== false && block.is_error !== undefined) return "unknown";
  if (scheduled) return "scheduled";
  if (block.is_error === false || (block.is_error === undefined &&
    (typeof block.content === "string" || Array.isArray(block.content)))) {
    return "success";
  }
  return "unknown";
}

const launcherUuid = "[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}";
const markerLine = new RegExp("^AGENT_LENS_CODEX_SESSION=(" + launcherUuid + ")$");
const threadIdPattern = new RegExp("^" + launcherUuid + "$");
const launcherPrefix = 64 * 1024;

export function extractCodexStartupEvidence(value: unknown): LauncherEvidence | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.slice(0, launcherPrefix).split(/\r?\n/);
  if (value.length > launcherPrefix) lines.pop();
  let evidence: Extract<LauncherEvidence, { threadId: string }> | undefined;
  for (const line of lines) {
    let threadId = markerLine.exec(line)?.[1];
    const kind = threadId ? "marker" : "thread-started";
    if (!threadId && line.startsWith("{") && line.length <= 2048) {
      try {
        const entry = record(JSON.parse(line));
        if (entry?.type === "thread.started" && typeof entry.thread_id === "string" && threadIdPattern.test(entry.thread_id)) {
          threadId = entry.thread_id;
        }
      } catch {
        continue;
      }
    }
    if (!threadId) continue;
    threadId = threadId.toLowerCase();
    if (evidence && evidence.threadId !== threadId) return { evidence: "conflicting" };
    if (!evidence || kind === "marker") evidence = { evidence: kind, threadId };
  }
  return evidence;
}

export function claudeToolResult(
  block: JsonObject,
  base: EventBase,
  owner: JsonObject,
  singleResult: boolean,
  unsafeCwd: boolean,
): Event | undefined {
  const callId = identifier(block.tool_use_id);
  if (!callId) return undefined;

  const sourceCallId = identifier(owner.sourceToolUseID);
  const attributed = sourceCallId === callId || (singleResult && owner.sourceToolUseID === undefined);
  const meta = attributed ? record(owner.toolUseResult) : undefined;
  const agentId = identifier(meta?.agentId);
  const backgroundTaskId = identifier(meta?.backgroundTaskId);
  const interrupted = meta?.interrupted === true;
  const scheduled = backgroundTaskId !== undefined || (agentId !== undefined && boolean(meta?.isAsync) === true);
  const status = statedResultStatus(block, interrupted || (attributed && !!identifier(owner.toolDenialKind)), scheduled);
  const rawPath = meta?.filePath;
  const restricted = unsafeCwd || [rawPath, meta?.backgroundCwdHint, meta?.stdout, meta?.stderr]
    .some(value => typeof value === "string" && containsSensitivePath(value));
  const files: FileEvidence[] = [];
  const path = !restricted ? safePath(rawPath) : undefined;
  const patch = path ? patchFromResult(meta?.structuredPatch) : undefined;
  if (path && patch) files.push({ path, kind: "edit", patch, status: status === "success" ? "applied" : "unknown" });

  let text: string | undefined;
  if (!restricted) {
    const stdout = safeText(meta?.stdout);
    const stderr = safeText(meta?.stderr);
    text = stderr
      ? (stdout ? `${stdout}\n\nStderr\n${stderr}` : `Stderr\n${stderr}`)
      : stdout ?? renderResultContent(block.content);
  }
  return {
    ...base, kind: "result", callId, status, text, files: files.length ? files : undefined,
    agentId, backgroundTaskId, launcher: restricted ? undefined : extractCodexStartupEvidence(meta?.stdout),
    childOutcome: agentId ? taskOutcome(meta?.status) : undefined,
    sourceAssistantId: identifier(owner.sourceToolAssistantUUID),
    interrupted: interrupted || undefined,
    toolEndsTurn: (attributed && owner.toolEndsTurn === true) || undefined,
  };
}
