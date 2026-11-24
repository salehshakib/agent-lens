const minimum = [2, 1, 330] as const;

export const minimumClaudeCodeVersion = minimum.join('.');

/** Compare the numeric version components, allowing the CLI's optional build suffix. */
export function supportsClaudeCodeVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]*)?$/.exec(version);
  if (!match || match[0] !== version) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  for (const [index, floor] of minimum.entries()) {
    const part = parts[index]!;
    if (part !== floor) return part > floor;
  }
  return true;
}
