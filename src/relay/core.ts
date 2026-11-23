import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectStatusLine, snapshotFileName } from '../host/limits/claude-relay';
import type { RelaySnapshot } from '../host/limits/claude-relay';

const retentionMs = 8 * 24 * 60 * 60_000;
const maxFiles = 200;

/** Parse the status-line payload. Only the allowlisted projection survives, the raw payload is never kept. */
export function snapshotFromInput(input: string, now: number): RelaySnapshot | undefined {
  try {
    return projectStatusLine(JSON.parse(input), now);
  } catch {
    return undefined;
  }
}

/** Replace the per-session snapshot atomically and prune old Agent Lens snapshots. */
export function publishSnapshot(directory: string, snapshot: RelaySnapshot): void {
  mkdirSync(directory, { recursive: true });
  const name = snapshotFileName(snapshot.sessionId);
  const temporary = join(directory, name + '.' + process.pid + '.tmp');
  writeFileSync(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, join(directory, name));
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  prune(directory, snapshot.capturedAt);
}

function prune(directory: string, now: number): void {
  try {
    const entries = readdirSync(directory)
      .filter(name => name.endsWith('.json') || name.endsWith('.tmp'))
      .map(name => ({ name, at: statSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    entries.forEach((entry, index) => {
      if (index >= maxFiles || now - entry.at > retentionMs) {
        try { unlinkSync(join(directory, entry.name)); } catch { /* best effort */ }
      }
    });
  } catch {
    // Pruning never blocks the status line.
  }
}

/** The prior status-line command saved at install time, if any. */
export function priorCommand(directory: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, 'chain.json'), 'utf8'));
    const command = typeof value === 'object' && value !== null && 'command' in value ? value.command : undefined;
    return typeof command === 'string' && command.trim() ? command : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal local status line used when the user had no status line before. */
export function minimalLine(snapshot: RelaySnapshot | undefined): string {
  const used = snapshot?.context?.usedPercent;
  return used === undefined ? 'Agent Lens' : 'Context ' + Math.round(used) + '%';
}
