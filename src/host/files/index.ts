import { createHash } from "node:crypto";
import type { Event, FileEvidence, Provider } from "../adapters/types";
import type { FileAction } from "../sessions/types";
import { commandFileEvidence } from "./command-evidence";
import { completeFileSides, recordedHunks, recordedSidesPatch, safeFileText } from "./diff";
import { indexPath } from "./paths";
import type { IndexedPath } from "./paths";

type Call = Extract<Event, { kind: "call" }>;
type Result = Extract<Event, { kind: "result" }>;

interface Observation {
  rowId: string;
  laneId: string;
  turnId?: string;
  cwd?: string;
  projectRoot?: string;
  project?: string;
  provider?: Provider;
  at?: number;
  call?: Call;
  result?: Result;
  event?: Extract<Event, { kind: "file" }>;
}

const claudeFiles = new Set(["Read", "Edit", "Write"]);
const changes = new Set<FileEvidence["kind"]>(["edit", "add", "delete", "move"]);

function preview(file: FileEvidence, call: Call | undefined): Pick<FileAction, "diff" | "diffKind" | "diffUnavailable"> {
  const diff = safeFileText(file.patch);
  const before = safeFileText(file.before);
  const after = safeFileText(file.after);
  const knownSides = before !== undefined && after !== undefined;
  const complete = knownSides && (file.kind === "add" && before === "" || file.kind === "delete" && after === "");
  if (diff && recordedHunks(diff)) {
    const reconstructed = completeFileSides({ diff, diffKind: "complete", kind: file.kind });
    return { diff, diffKind: complete && reconstructed?.before === before && reconstructed?.after === after ? "complete" : "hunks" };
  }
  if (knownSides) {
    const excerpts = recordedSidesPatch(before, after);
    if (complete && !excerpts) return { diff: "", diffKind: "complete" };
    if (excerpts && recordedHunks(excerpts)) return { diff: excerpts, diffKind: complete ? "complete" : "partial" };
  }
  if (diff && call?.name === "apply_patch" && /^\s*(?:@@(?: |\n)|[ +\-])/m.test(diff)) {
    return { diff, diffKind: "partial" };
  }
  if (changes.has(file.kind)) return { diffUnavailable: call?.name === "Write" && file.kind === "edit"
    ? "Preimage not recorded" : "Historical patch not recorded" };
  return {};
}

function stateFor(file: FileEvidence, call: Call | undefined, result: Result | undefined): FileAction["status"] {
  if (file.kind === "mention" || file.kind === "checkpoint") return "recorded";
  if (file.status === "inferred") return "inferred";
  if (!call) return "recorded";
  if (result?.status === "failed" || file.status === "failed") return "failed";
  if (file.status === "applied") return "applied";
  if (result?.status === "success" && claudeFiles.has(call.name)) return file.kind === "read" ? "read" : "applied";
  if (file.status === "pending" || !result || result.status === "scheduled") return "requested";
  return "recorded";
}

interface ResolvedFile {
  evidence: FileEvidence;
  path: IndexedPath;
  destination?: IndexedPath;
}

function resolveFiles(files: readonly FileEvidence[], cwd?: string): ResolvedFile[] {
  return files.flatMap(evidence => {
    const path = indexPath(evidence.path, cwd);
    const destination = indexPath(evidence.destination, cwd);
    return path && (evidence.destination === undefined || destination)
      ? [{ evidence, path, destination }] : [];
  });
}

function relatedFiles(observation: Observation, cwd: string | undefined): ResolvedFile[] {
  const { call, result, event } = observation;
  if (event) return resolveFiles(event.files, cwd);
  const recorded = resolveFiles(result?.files ?? [], cwd);
  if (result?.variant === "structured" && result.files) return recorded;
  if (call?.restricted) return [];
  if (!call) return recorded;
  const requested = resolveFiles(call.files ?? [], cwd);
  if (claudeFiles.has(call.name)) {
    return requested.map(file => {
      const matching = recorded.find(candidate => candidate.path.key === file.path.key);
      if (call.name === "Read") return file;
      return matching ?? file;
    });
  }
  const references = resolveFiles(commandFileEvidence(call.name, call.command, result?.status === "success", call.argv), cwd);
  return [...requested, ...references];
}

export class FileIndex {
  private readonly entries = new Map<string, FileAction>();
  private readonly rows = new Map<string, Set<string>>();

  add(observation: Observation): void {
    const { call, result, event, rowId, laneId, turnId, project, projectRoot, provider } = observation;
    const cwd = call?.cwd ?? event?.cwd ?? observation.cwd ?? result?.cwd;
    const resolved = relatedFiles(observation, cwd);
    const files = new Map<string, ResolvedFile>();
    const rowKey = JSON.stringify([laneId, rowId]);
    const prior = this.rows.get(rowKey);
    const currentIds = new Set<string>();
    for (const file of resolved) {
      const current = files.get(file.path.key);
      if (!current || current.evidence.kind === "mention" && file.evidence.kind !== "mention") files.set(file.path.key, file);
    }
    for (const { evidence, path, destination } of files.values()) {
      const resultMismatch = call && claudeFiles.has(call.name) && result?.files?.length &&
        !result.files.some(file => indexPath(file.path, cwd)?.key === path.key);
      const paired = resultMismatch ? undefined : result;
      const key = evidence.kind === "checkpoint" && event?.parentId ? [laneId, event.parentId, path.key, "checkpoint"]
        : [laneId, rowId, path.key];
      const id = createHash("sha256").update(JSON.stringify(key)).digest("hex");
      const at = paired?.at ?? result?.at ?? event?.at ?? observation.at ?? call?.at;
      const offset = evidence.range?.offset;
      const limit = evidence.range?.limit;
      const status = resultMismatch ? "recorded" : stateFor(evidence, call, paired);
      if (evidence.kind === "checkpoint" && this.entries.has(id)) continue;
      currentIds.add(id);
      this.entries.set(id, {
        id, rowId, laneId, turnId, at, kind: evidence.kind, status, cwd, projectRoot, project, provider,
        path: path.path, label: path.label, movePath: destination?.path,
        range: offset !== undefined || limit !== undefined ? { start: offset ?? 1, count: limit } : undefined,
        ...preview(evidence, call),
      });
    }
    if (!event) {
      for (const id of prior ?? []) {
        if (!currentIds.has(id)) this.entries.delete(id);
      }
      if (currentIds.size) this.rows.set(rowKey, currentIds);
      else this.rows.delete(rowKey);
    }
  }

  actions(): FileAction[] {
    return [...this.entries.values()];
  }
}

export interface FileGroup {
  path: string;
  actions: FileAction[];
  laneIds: string[];
  firstSeen?: number;
  lastSeen?: number;
  reads: number;
  proposed: number;
  applied: number;
  mentioned: number;
  inferred: number;
}

export function groupFileActions(actions: readonly FileAction[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const action of actions) {
    const path = indexPath(action.path);
    if (!path) continue;
    const key = path.key.startsWith("unresolved:") ? JSON.stringify([action.project ?? action.laneId, path.key]) : path.key;
    const group = groups.get(key) ?? { path: path.path, actions: [], laneIds: [], reads: 0, proposed: 0, applied: 0, mentioned: 0, inferred: 0 };
    group.actions.push(action);
    if (!group.laneIds.includes(action.laneId)) group.laneIds.push(action.laneId);
    if (action.status === "read") group.reads++;
    if (action.status === "requested" && changes.has(action.kind)) group.proposed++;
    if (action.status === "applied") group.applied++;
    if (action.kind === "mention") group.mentioned++;
    if (action.status === "inferred") group.inferred++;
    if (action.at !== undefined) {
      group.firstSeen = Math.min(group.firstSeen ?? action.at, action.at);
      group.lastSeen = Math.max(group.lastSeen ?? action.at, action.at);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}
