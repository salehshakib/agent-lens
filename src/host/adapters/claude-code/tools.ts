import { delegatedPromptCandidate } from "../types";
import type { Event, EventBase, FileEvidence, Outcome, ResultStatus } from "../types";
import {
  containsSensitivePath, count, identifier, record, safePath, safeText,
  toolArgumentKey,
} from "../../privacy/projection";
import { safeFileText } from "../../files/diff";
import { claudeTaskOutputReference, extractCodexStartupEvidence, reconcileStartupEvidence, scheduledTaskReference } from "./launcher";

export { extractCodexStartupEvidence } from "./launcher";

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
    call.input = call.command;
    call.readerOutput = Boolean(call.command) || undefined;
    call.background = boolean(input.run_in_background);
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
    call.readerOutput = true;
    call.input = [path, range?.offset === undefined ? undefined : `Offset ${range.offset}`,
      range?.limit === undefined ? undefined : `Limit ${range.limit}`].filter(value => value !== undefined).join("\n");

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
    call.input = [safeText(input.pattern, 2_000), path, safeText(input.glob, 2_000)].filter(Boolean).join("\n") || undefined;
    call.readerOutput = Boolean(pattern) || undefined;
    if (pattern && pattern === input.pattern && glob === input.glob && (input.path === undefined || path)) {
      args = { path, pattern, glob, outputMode: identifier(input.output_mode) };
    }
  } else if (name === "Agent" || (name === "Task" && identifier(input.subagent_type) && typeof input.prompt === "string")) {
    // A legacy Task is only a spawn candidate. The host still needs child identity evidence.
    call.spawn = true;
    call.readerOutput = typeof input.prompt === "string" || undefined;
    call.background = boolean(input.run_in_background);
    call.text = safeText(input.description, 512);
    call.input = [call.text, identifier(input.subagent_type)].filter(Boolean).join("\n") || undefined;
    call[delegatedPromptCandidate] = safeText(input.prompt, 12_000);
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
      if (line[0] !== "+") oldSeen++;
      if (line[0] !== "-") newSeen++;
      parts.push(line);
    }
    if (oldSeen !== oldLines || newSeen !== newLines) return undefined;
  }
  return safeFileText(parts.join("\n"));
}

function statedResultStatus(block: JsonObject, failed: boolean, scheduled: boolean, exitCode?: number): ResultStatus {
  if (block.is_error === true || failed || (exitCode !== undefined && exitCode !== 0)) return "failed";
  if (block.is_error !== false && block.is_error !== undefined) return "unknown";
  if (scheduled) return "scheduled";
  if (exitCode === 0 || block.is_error === false || (block.is_error === undefined &&
    (typeof block.content === "string" || Array.isArray(block.content)))) {
    return "success";
  }
  return "unknown";
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
  const exitCode = Number.isSafeInteger(meta?.exitCode) ? meta?.exitCode as number : undefined;
  const scheduledRef = attributed ? scheduledTaskReference(block.content) : undefined;
  const backgroundTaskId = identifier(meta?.backgroundTaskId) ?? scheduledRef?.taskId;
  const interrupted = meta?.interrupted === true;
  const scheduled = backgroundTaskId !== undefined || (agentId !== undefined && boolean(meta?.isAsync) === true);
  const status = statedResultStatus(block, interrupted || (attributed && !!identifier(owner.toolDenialKind)), scheduled, exitCode);
  const rawPath = meta?.filePath;
  const restricted = unsafeCwd || [rawPath, meta?.backgroundCwdHint, meta?.stdout, meta?.stderr]
    .some(value => typeof value === "string" && containsSensitivePath(value));
  const files: FileEvidence[] = [];
  const path = !restricted ? safePath(rawPath) : undefined;
  if (path && meta) {
    const patch = patchFromResult(meta.structuredPatch);
    const created = meta.type === "create";
    const before = created ? "" : safeFileText(meta.oldString);
    const after = safeFileText(created ? meta.content : meta.newString);
    files.push({ path, kind: created ? "add" : "edit", patch, before, after,
      status: status === "success" ? "applied" : status === "failed" ? "failed" : "unknown" });
  }

  const stdout = restricted ? undefined : safeText(meta?.stdout);
  const stderr = restricted ? undefined : safeText(meta?.stderr);
  const text = !restricted
    ? stderr
      ? (stdout ? `${stdout}\n\nStderr\n${stderr}` : `Stderr\n${stderr}`)
      : stdout ?? renderResultContent(block.content)
    : undefined;
  const readerBodyRestricted = typeof text === "string" && /<persisted-output\b|\btool-results[\\/]/i.test(text);
  return {
    ...base, kind: "result", callId, status, text, stdout, stderr, exitCode, files: files.length ? files : undefined,
    readerBodyRestricted: readerBodyRestricted || undefined,
    agentId, backgroundTaskId,
    backgroundCwd: restricted ? undefined : safePath(meta?.backgroundCwdHint),
    taskOutputPath: restricted ? undefined : claudeTaskOutputReference(meta?.outputFilePath ?? meta?.outputFile)?.path ?? scheduledRef?.path,
    launcher: restricted ? undefined : reconcileStartupEvidence(
      extractCodexStartupEvidence(meta?.stdout), extractCodexStartupEvidence(meta?.stderr)),
    childOutcome: agentId ? taskOutcome(meta?.status) : undefined,
    sourceAssistantId: identifier(owner.sourceToolAssistantUUID),
    interrupted: interrupted || undefined,
    toolEndsTurn: (attributed && owner.toolEndsTurn === true) || undefined,
  };
}
