import type { FileEvidence } from "../adapters/types";
import { safePath } from "../privacy/projection";

const shellNames = new Set(["Bash", "Command", "exec_command", "shell", "shell_command"]);
const plainTokens = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/g;
const fileShape = /[\\/]|\.[a-z][\w-]{0,15}$/i;
const shellSyntax = /[\r\n`$<>|;&*?()[\]{}!]/;

function target(value: string | undefined): string | undefined {
  if (!value || value.startsWith("-") || value.startsWith("~") || shellSyntax.test(value)) return undefined;
  return safePath(value);
}

export function commandFileEvidence(
  name: string, command: string | undefined, succeeded: boolean, argv?: readonly string[],
): FileEvidence[] {
  if (!shellNames.has(name) || !command || command.length > 16_384) return [];
  const tokens = argv ?? [...command.matchAll(plainTokens)].map(match => match[1] ?? match[2] ?? match[3]!);
  const [tool, first, second] = tokens;
  if (!shellSyntax.test(command) && succeeded) {
    if ((tool === "cat" || tool === "touch") && tokens.length === 2 && (argv || !command.includes("\\"))) {
      const path = target(first);
      if (path) return [{ path, kind: tool === "cat" ? "read" : "edit", status: "inferred" }];
    }
    if (tool?.toLowerCase() === "get-content" && first?.toLowerCase() === "-literalpath" && tokens.length === 3) {
      const path = target(second);
      if (path) return [{ path, kind: "read", status: "inferred" }];
    }
  }
  return tokens.slice(1).flatMap(token => {
    const path = target(token);
    return path && fileShape.test(path) && !path.includes("://") ? [{ path, kind: "mention" }] : [];
  });
}
