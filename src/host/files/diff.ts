import { containsSensitivePath, safeText } from "../privacy/projection";
import type { FileAction } from "../sessions/types";

const maxPreview = 256 * 1024;
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const remoteHeaders = /^(?:diff --git |index |--- |\+\+\+ )/;
const noNewline = "\\ No newline at end of file";

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
  oldLine?: number;
  newLine?: number;
  noNewline?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export function safeFileText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > maxPreview || containsSensitivePath(value)) return undefined;
  const normalized = value.replace(/\r\n?/g, "\n");
  // A blank line or empty file is still recorded content.
  const clean = /^[ \t\n]*$/.test(normalized) ? normalized : safeText(normalized, maxPreview);
  if (clean === undefined ||
    (clean !== normalized && clean.split("\n").length !== normalized.split("\n").length)) return undefined;
  return clean;
}

export function recordedHunks(value: unknown): DiffHunk[] | undefined {
  const patch = safeFileText(value);
  if (patch === undefined) return undefined;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: DiffHunk[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor++]!;
    if (!hunks.length && remoteHeaders.test(line)) continue;
    const header = hunkHeader.exec(line);
    if (!header) return undefined;
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? 1);
    const newStart = Number(header[3]);
    const newCount = Number(header[4] ?? 1);
    if (!Number.isSafeInteger(oldStart + oldCount) || !Number.isSafeInteger(newStart + newCount) ||
      (oldCount && !oldStart) || (newCount && !newStart) || !(oldCount || newCount)) return undefined;
    const previous = hunks.at(-1);
    if (previous && (oldStart < previous.oldStart + previous.oldCount ||
      newStart < previous.newStart + previous.newCount)) return undefined;

    const hunk: DiffHunk = { oldStart, oldCount, newStart, newCount, lines: [] };
    let oldLine = oldStart;
    let newLine = newStart;
    while (cursor < lines.length && !lines[cursor]!.startsWith("@@ ")) {
      const part = lines[cursor++]!;
      const last = hunk.lines.at(-1);
      if (part === noNewline && last && !last.noNewline) {
        last.noNewline = true;
        continue;
      }
      const prefix = part[0];
      const text = part.slice(1);
      if (prefix === " ") hunk.lines.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
      else if (prefix === "-") hunk.lines.push({ kind: "removed", text, oldLine: oldLine++ });
      else if (prefix === "+") hunk.lines.push({ kind: "added", text, newLine: newLine++ });
      else return undefined;
      if (oldLine - oldStart > oldCount || newLine - newStart > newCount) return undefined;
    }
    if (oldLine - oldStart !== oldCount || newLine - newStart !== newCount) return undefined;
    hunks.push(hunk);
  }
  return hunks.length ? hunks : undefined;
}

function sideLines(text: string): { lines: string[]; eofNewline: boolean } {
  const eofNewline = text.endsWith("\n");
  const lines = text ? (eofNewline ? text.slice(0, -1) : text).split("\n") : [];
  return { lines, eofNewline };
}

function renderSide(side: ReturnType<typeof sideLines>, prefix: string): string[] {
  if (!side.lines.length) return [];
  const lines = side.lines.map(line => prefix + line);
  if (!side.eofNewline) lines.push(noNewline);
  return lines;
}

export function recordedSidesPatch(before: string, after: string): string | undefined {
  const oldSide = sideLines(before);
  const newSide = sideLines(after);
  if (!oldSide.lines.length && !newSide.lines.length) return undefined;
  return [
    `@@ -${Number(oldSide.lines.length > 0)},${oldSide.lines.length} +${Number(newSide.lines.length > 0)},${newSide.lines.length} @@`,
    ...renderSide(oldSide, "-"),
    ...renderSide(newSide, "+"),
  ].join("\n");
}

export function completeFileSides(action: Pick<FileAction, "kind" | "diff" | "diffKind">):
  { before: string; after: string } | undefined {
  if (action.diffKind !== "complete" || (action.kind !== "add" && action.kind !== "delete")) return undefined;
  if (action.diff === "") return { before: "", after: "" };
  const hunks = recordedHunks(action.diff);
  const hunk = hunks?.[0];
  if (!hunk || hunks?.length !== 1) return undefined;
  const adding = action.kind === "add";
  const validRange = adding
    ? hunk.oldStart === 0 && hunk.oldCount === 0 && hunk.newStart === 1
    : hunk.newStart === 0 && hunk.newCount === 0 && hunk.oldStart === 1;
  if (!validRange || hunk.lines.slice(0, -1).some(line => line.noNewline)) return undefined;
  const text = hunk.lines.map(line => line.text).join("\n") + (hunk.lines.at(-1)?.noNewline ? "" : "\n");
  return adding ? { before: "", after: text } : { before: text, after: "" };
}
