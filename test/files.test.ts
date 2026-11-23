import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { claudeToolResult } from "../src/host/adapters/claude-code/tools";
import { recordedFiles } from "../src/host/adapters/codex/file-evidence";
import type { Event, FileEvidence, Provider } from "../src/host/adapters/types";
import { completeFileSides, recordedHunks } from "../src/host/files/diff";
import { FileIndex, groupFileActions } from "../src/host/files/index";
import { currentFilePath } from "../src/host/files/paths";
import type { FileAction } from "../src/host/sessions/types";

const cwd = "X:\\Synthetic Repo";
const laneId = "fixture-lane";

function call(id: string, name: string, files?: FileEvidence[]): Extract<Event, { kind: "call" }> {
  return { id, kind: "call", callId: id, name, files };
}

function result(id: string, status: Extract<Event, { kind: "result" }>["status"], files?: FileEvidence[]):
  Extract<Event, { kind: "result" }> {
  return { id: `${id}-result`, kind: "result", callId: id, status, files };
}

function attributed(rowId: string, provider: Provider = "claude-code") {
  return { rowId, laneId, turnId: "fixture-turn", cwd, project: "fixture-project", provider };
}

test("Files group canonical paths by drive and case with read, change and checkpoint provenance", () => {
  const index = new FileIndex();
  const read = call("read", "Read", [{ path: "src/example.ts", kind: "read", range: { offset: 2, limit: 8 } }]);
  index.add({ ...attributed("read"), call: read, at: 10 });
  const pending = index.actions()[0];
  assert.ok(pending);
  assert.equal(pending.status, "requested");
  index.add({ ...attributed("read"), call: read, result: result("read", "success"), at: 10 });
  const edit = call("edit", "Edit", [{ path: "x:/synthetic repo/src/./EXAMPLE.ts", kind: "edit", status: "pending" }]);
  const edited = claudeToolResult({ tool_use_id: "edit", is_error: false, content: "Synthetic result" }, { id: "result", at: 30 }, {
    toolUseResult: {
      filePath: "src/example.ts", oldString: "synthetic old", newString: "synthetic new",
      structuredPatch: [{ oldStart: 8, oldLines: 1, newStart: 8, newLines: 1, lines: ["-old", "+new"] }],
    },
  }, true, false);
  assert.equal(edited?.kind, "result");
  index.add({ ...attributed("edit"), call: edit, result: edited, at: 20 });
  const file = { kind: "checkpoint" as const, path: "src/example.ts" };
  index.add({ ...attributed("checkpoint"), at: 15,
    event: { kind: "file", id: "fixture-checkpoint", parentId: "fixture-snapshot", files: [file] } });
  index.add({ ...attributed("checkpoint-replay"), at: 16,
    event: { kind: "file", id: "fixture-checkpoint-delta", parentId: "fixture-snapshot", files: [file] } });
  index.add({ ...attributed("separate-drive"), event: { kind: "file", id: "other", files: [{ ...file, path: "Y:/Synthetic Repo/src/example.ts" }] } });

  const [group, other] = groupFileActions(index.actions());
  assert.ok(group && other);
  assert.deepEqual({ first: group.firstSeen, last: group.lastSeen, reads: group.reads, applied: group.applied },
    { first: 10, last: 30, reads: 1, applied: 1 });
  assert.deepEqual(group.actions.map(item => [item.kind, item.status]), [["read", "read"], ["edit", "applied"], ["checkpoint", "recorded"]]);
  const [readAction, editAction] = group.actions;
  assert.equal(readAction?.id, pending.id);
  assert.deepEqual(readAction?.range, { start: 2, count: 8 });
  assert.equal(editAction?.rowId, "edit");
  assert.equal(editAction.provider, "claude-code");
  assert.equal(editAction.project, "fixture-project");
  assert.equal(editAction.diffKind, "hunks");
  assert.deepEqual(recordedHunks(editAction.diff)?.[0]?.lines,
    [{ kind: "removed", text: "old", oldLine: 8 }, { kind: "added", text: "new", newLine: 8 }]);
});

test("Files keep Claude failures, partial excerpts and missing preimages distinct", () => {
  const index = new FileIndex();
  index.add({ ...attributed("read"), call: call("read", "Read", [{ path: "version.txt", kind: "read" }]), result: result("read", "failed") });
  index.add({ ...attributed("write"), call: call("write", "Write", [{ path: "version.txt", kind: "edit" }]), result: result("write", "success") });
  const edited = claudeToolResult({ tool_use_id: "edit", is_error: false, content: "Synthetic result" }, { id: "result" }, {
    toolUseResult: { filePath: "version.txt", oldString: "old version", newString: "new version", structuredPatch: [
      { oldStart: 10, oldLines: 2, newStart: 10, newLines: 1, lines: ["-old", "+new"] },
    ] },
  }, true, false);
  assert.equal(edited?.kind, "result");
  index.add({ ...attributed("edit"), call: call("edit", "Edit", [{ path: "version.txt", kind: "edit" }]), result: edited });
  index.add({ ...attributed("mismatched"), call: call("mismatched", "Edit", [{ path: "version.txt", kind: "edit" }]),
    result: result("mismatched", "success", [{ path: "elsewhere.txt", kind: "edit", status: "applied" }]) });
  const [failedRead, overwrite, partial, mismatched] = index.actions();
  assert.equal(failedRead?.status, "failed");
  assert.equal(overwrite?.status, "applied");
  assert.equal(overwrite.diffUnavailable, "Preimage not recorded");
  assert.equal(partial?.diffKind, "partial");
  assert.match(partial.diff ?? "", /-old version\n.*\n\+new version/);
  assert.equal(completeFileSides(partial), undefined);
  assert.equal(mismatched?.status, "recorded");
});

test("Recorded Codex file changes supersede proposals and retain full add and delete sides", () => {
  const index = new FileIndex();
  const patch = call("patch", "apply_patch", [
    { path: "src/old.ts", destination: "src/proposed.ts", kind: "move", status: "pending", patch: "\n@@\n-before\n+after" },
    { path: "src/discard.ts", kind: "add", status: "pending" },
  ]);
  index.add({ ...attributed("patch", "codex"), call: patch, result: result("patch", "unknown") });
  assert.deepEqual(index.actions().map(action => action.status), ["requested", "requested"]);
  const pending = index.actions()[0];
  const files = recordedFiles({
    "src/old.ts": { type: "update", move_path: "src/new.ts", unified_diff: "@@ -4 +4 @@\n-before\n+after" },
    "src/new-empty.ts": { type: "add", content: "" },
    "src/deleted.ts": { type: "delete", content: "fixture contents\r\n  " },
    ".env.local": { type: "add", content: "synthetic ignored fixture" },
  }, "applied");
  index.add({ ...attributed("patch", "codex"), call: patch, result: { ...result("patch", "success", files), variant: "structured" } });
  const [move, add, deleted] = index.actions();
  assert.deepEqual(index.actions().map(action => action.kind), ["move", "add", "delete"]);
  assert.equal(move?.id, pending?.id);
  assert.equal(move?.movePath, "X:\\Synthetic Repo\\src\\new.ts");
  assert.equal(move?.status, "applied");
  assert.ok(add && deleted);
  assert.deepEqual(completeFileSides(add), { before: "", after: "" });
  assert.deepEqual(completeFileSides(deleted), { before: "fixture contents\n  ", after: "" });
  assert.equal(index.actions().some(action => action.label.includes(".env")), false);
});

test("Files keep shell references and inferred reads outside confirmed edit counts", () => {
  const index = new FileIndex();
  index.add({ ...attributed("cat"), call: { ...call("cat", "Bash"), command: "cat 'src/with spaces.ts'" }, result: result("cat", "success") });
  index.add({ ...attributed("prose"), call: { ...call("prose", "Bash"), command: "echo editing src/mention.ts" }, result: result("prose", "success") });
  index.add({ ...attributed("dynamic"), call: { ...call("dynamic", "Bash"), command: "cat $VAR/src/ignored.ts" }, result: result("dynamic", "success") });
  index.add({ ...attributed("touch"), call: { ...call("touch", "Command"), command: "touch src/inferred change.ts", argv: ["touch", "src/inferred change.ts"] },
    result: result("touch", "success") });
  assert.deepEqual(index.actions().map(action => [action.kind, action.status]),
    [["read", "inferred"], ["mention", "recorded"], ["edit", "inferred"]]);
  assert.ok(groupFileActions(index.actions()).every(group => group.applied === 0));
});

test("Current file action rechecks roots, resolved aliases, and sensitive paths", async t => {
  const fixtures = resolve("test/fixtures");
  const root = await mkdtemp(join(fixtures, ".phase-b-files-"));
  assert.equal(dirname(root), fixtures);
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await Promise.all([mkdir(project), mkdir(outside)]);
  const insideFile = join(project, "fixture.ts");
  const outsideFile = join(outside, "fixture.ts");
  await Promise.all([writeFile(insideFile, "synthetic current contents\n"), writeFile(outsideFile, "synthetic outside contents\n")]);
  await symlink(outside, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
  const base: FileAction = {
    id: "fixture", rowId: "row", laneId, path: insideFile, label: "fixture.ts", cwd: project, projectRoot: project,
    status: "read", kind: "read",
  };
  assert.equal(await currentFilePath(base), insideFile);
  for (const path of [outsideFile, join(project, "absent.ts"), join(project, "linked", "fixture.ts"),
    join(project, ".env"), "vscode-remote://ssh-remote+example/project/fixture.ts", "\\\\example\\share\\fixture.ts"]) {
    assert.equal(await currentFilePath({ ...base, path }), undefined);
  }
  assert.equal(await currentFilePath(base, [project]), undefined);
  assert.equal(await currentFilePath({ ...base, kind: "move", status: "applied", movePath: outsideFile }), undefined);
});

test("Recorded hunks reject malformed ranges and suppress multiline secret-shaped fixtures", () => {
  assert.equal(recordedHunks("@@ -3,2 +3 @@\n-before\n+after"), undefined);
  assert.equal(recordedHunks("@@ -3 +3 @@\n-reads .env\n+after"), undefined);
  assert.equal(recordedHunks("@@ -3,3 +0,0 @@\n-----BEGIN PRIVATE KEY-----\n-synthetic fixture\n------END PRIVATE KEY-----"), undefined);
});
