import { record, safePath } from "../../privacy/projection";
import { recordedSidesPatch, safeFileText } from "../../files/diff";
import type { FileEvidence } from "../types";

type FileStatus = FileEvidence["status"];

export function recordedFiles(value: unknown, status: FileStatus): FileEvidence[] {
  const changes = record(value);
  if (!changes) return [];
  const files: FileEvidence[] = [];
  for (const [name, change] of Object.entries(changes)) {
    const path = safePath(name);
    const item = record(change);
    if (!path || !item) continue;
    if (item.type === "add" || item.type === "delete") {
      const text = safeFileText(item.content);
      const before = text === undefined ? undefined : item.type === "delete" ? text : "";
      const after = text === undefined ? undefined : item.type === "add" ? text : "";
      const patch = before !== undefined && after !== undefined ? recordedSidesPatch(before, after) : undefined;
      files.push({ path, kind: item.type, status, patch, before, after });
    } else if (item.type === "update") {
      const destination = safePath(item.move_path);
      if (item.move_path != null && !destination) continue;
      const patch = safeFileText(item.unified_diff);
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
    files.push({ path, kind, destination, status: "pending", patch: safeFileText(following.slice(move?.[0].length ?? 0)) });
  }
  return files;
}
