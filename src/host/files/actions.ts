import { randomUUID } from "node:crypto";
import { commands, Uri, window, workspace } from "vscode";
import type { ExtensionContext } from "vscode";
import type { FileAction } from "../sessions/types";
import { completeFileSides, safeFileText } from "./diff";
import { currentFilePath, indexPath } from "./paths";

const documentScheme = "agent-lens-recorded-diff";
const actionId = /^[a-f0-9]{64}$/;
const maxSnapshots = 12;
type DocumentPart = "before" | "after" | "patch";

export function registerFileActions(
  context: ExtensionContext,
  resolve: (id: string) => FileAction | undefined,
  excludedRoots: () => readonly string[] = () => [],
): void {
  const snapshots = new Map<string, Partial<Record<DocumentPart, string>>>();
  function find(value: unknown): FileAction | undefined {
    if (typeof value !== "string" || !actionId.test(value)) return undefined;
    const action = resolve(value);
    if (!action || action.id !== value || !indexPath(action.path) || (action.movePath && !indexPath(action.movePath))) {
      return undefined;
    }
    return action;
  }

  function document(id: string, kind: DocumentPart): Uri {
    return Uri.from({ scheme: documentScheme, path: `/${id}/${kind}.diff` });
  }

  context.subscriptions.push(workspace.registerTextDocumentContentProvider(documentScheme, {
    provideTextDocumentContent(uri) {
      const match = /^\/([a-f0-9-]{36})\/(before|after|patch)\.diff$/.exec(uri.path);
      if (!match || uri.authority || uri.query || uri.fragment) return "Recorded file evidence is unavailable.";
      return snapshots.get(match[1]!)?.[match[2] as DocumentPart] ?? "Recorded file evidence is unavailable.";
    },
  }), commands.registerCommand("agentLens.files.open", async (...args: unknown[]) => {
    const action = args.length === 1 ? find(args[0]) : undefined;
    const path = action && await currentFilePath(action, excludedRoots());
    if (!path || !action) return false;
    const latest = find(action.id);
    if (!latest || latest.path !== action.path || latest.movePath !== action.movePath || latest.cwd !== action.cwd ||
      latest.projectRoot !== action.projectRoot || latest.status !== action.status) return false;
    try {
      await commands.executeCommand("vscode.open", Uri.file(path));
      return true;
    } catch {
      return false;
    }
  }), commands.registerCommand("agentLens.files.diff", async (...args: unknown[]) => {
    const action = args.length === 1 ? find(args[0]) : undefined;
    const patch = safeFileText(action?.diff);
    if (!action || patch === undefined) return false;
    const id = randomUUID();
    const sides = completeFileSides(action);
    snapshots.set(id, sides ?? { patch });
    if (snapshots.size > maxSnapshots) snapshots.delete(snapshots.keys().next().value!);
    try {
      if (sides) {
        await commands.executeCommand("vscode.diff", document(id, "before"), document(id, "after"),
          `${action.label} · Recorded diff`);
      } else {
        await window.showTextDocument(document(id, "patch"), { preview: true });
      }
      return true;
    } catch {
      snapshots.delete(id);
      return false;
    }
  }), { dispose: () => snapshots.clear() });
}
