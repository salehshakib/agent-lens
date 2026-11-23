import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { minimalLine, priorCommand, publishSnapshot, snapshotFromInput } from './core';

/**
 * Agent Lens status-line relay. Usage: node relay.js <profile directory>
 * It stores only the allowlisted snapshot, then passes the original stdin to the prior command
 * and prints that command's output unchanged. It makes no network calls.
 */
const maxInput = 1024 * 1024;
const directory = process.argv[2];

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= maxInput) chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const input = await readInput();
  const snapshot = snapshotFromInput(input, Date.now());
  if (directory && snapshot) {
    try {
      publishSnapshot(join(directory, 'snap'), snapshot);
    } catch {
      // The status line must keep working when the snapshot cannot be written.
    }
  }
  const command = directory ? priorCommand(directory) : undefined;
  if (!command) {
    process.stdout.write(minimalLine(snapshot));
    return;
  }
  const shell = process.env.CLAUDE_CODE_GIT_BASH_PATH || true;
  const child = spawn(command, { shell, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', () => process.exit(1));
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
  child.on('close', code => process.exit(code ?? 0));
}

void main();
