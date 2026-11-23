import { containsSensitivePath, record, safePath, safeText } from "../../privacy/projection";
import type { FileEvidence } from "../types";

type FileStatus = FileEvidence["status"];

function safePatch(value: unknown): string | undefined {
  return typeof value === "string" && !containsSensitivePath(value) ? safeText(value) : undefined;
}

function wholeFilePatch(content: unknown, kind: "add" | "delete"): string | undefined {
  // The shared text projection discards blank prose, but a blank file can still contain changed lines.
  const text = safePatch(content) ??
    (typeof content === "string" && /^[ \r\n\t]+$/.test(content) ? content.replace(/\r\n?/g, "\n") : undefined);
  if (!text) return undefined;
  const eofNewline = text.endsWith("\n");
  const body = eofNewline ? text.slice(0, -1) : text;
  const adding = kind === "add";
  let lines = 0;
  const prefixed = body.replace(/(^|\n)/g, (lineStart) => {
    lines += 1;
    return lineStart + (adding ? "+" : "-");
  });
  const range = adding ? "0,0 +1," + lines : "1," + lines + " +0,0";
  return "@@ -" + range + " @@\n" + prefixed + (eofNewline ? "" : "\n\\ No newline at end of file");
}

export function recordedFiles(value: unknown, status: FileStatus): FileEvidence[] {
  const changes = record(value);
  if (!changes) return [];
  const files: FileEvidence[] = [];
  for (const [name, change] of Object.entries(changes)) {
    const path = safePath(name);
    const item = record(change);
    if (!path || !item) continue;
    if (item.type === "add" || item.type === "delete") {
      files.push({ path, kind: item.type, status, patch: wholeFilePatch(item.content, item.type) });
    } else if (item.type === "update") {
      const destination = safePath(item.move_path);
      if (item.move_path != null && !destination) continue;
      const patch = safePatch(item.unified_diff);
      files.push({
        path, kind: destination ? "move" : "edit", destination, status,
        patch: patch && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: |$)/m.test(patch) ? patch : undefined,
      });
    }
  }
  return files;
}

const patchBoundary = /^\*\*\* Begin Patch\r?\n([\s\S]*?)\r?\n\*\*\* End Patch(?:\r?\n)?$/;
const pathHeader = /^\*\*\* (Add|Delete|Update) File: ([^\r\n]+)\r?$/gm;
const moveHeader = /^\r?\n\*\*\* Move to: ([^\r\n]+)\r?(?=\n|$)/;

export function proposedFiles(value: string): FileEvidence[] {
  const body = patchBoundary.exec(value)?.[1];
  if (!body) return [];
  const headers = body.matchAll(pathHeader);
  const files: FileEvidence[] = [];
  let current = headers.next();
  while (!current.done) {
    const header = current.value;
    current = headers.next();
    const path = safePath(header[2]);
    if (!path) continue;
    const following = body.slice(header.index + header[0].length, current.done ? undefined : current.value.index);
    const move = header[1] === "Update" ? moveHeader.exec(following) : null;
    const destination = safePath(move?.[1]);
    if (move && !destination) continue;
    const kind = header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : destination ? "move" : "edit";
    files.push({ path, kind, destination, status: "pending", patch: safePatch(following.slice(move?.[0].length ?? 0)) });
  }
  return files;
}
