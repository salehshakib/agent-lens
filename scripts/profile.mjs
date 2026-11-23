#!/usr/bin/env node
// Profiles the history reader and session model against generated synthetic histories.
//
//   node --expose-gc scripts/profile.mjs [smoke|default|reference] [--plan] [--no-transcript] [--keep]
//
// The harness lives in test/fixtures/synthetic-history-profile.ts so tsc checks it. It is bundled with esbuild
// into a temporary file and run here. Exits non-zero when a budget check fails. All generated data lives under
// the OS temp directory and is removed at the end unless --keep is given.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const shapeName = args.find(arg => !arg.startsWith('--')) ?? 'default';
const flags = new Set(args.filter(arg => arg.startsWith('--')));

const bundleDirectory = await mkdtemp(join(tmpdir(), 'agent-lens-profile-bundle-'));
let workspace;
let harness;
try {
  const outfile = join(bundleDirectory, 'profile.cjs');
  await build({
    entryPoints: [resolve('test/fixtures/synthetic-history-profile.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile, logLevel: 'error', external: ['vscode'],
  });
  harness = await import(pathToFileURL(outfile).href);
  const shape = harness.shapes?.[shapeName];
  if (!shape) throw new Error(`Unknown shape "${shapeName}". Use one of: ${harness.shapeNames.join(', ')}.`);

  workspace = await harness.makeWorkspace();
  const full = shapeName !== 'smoke';
  const results = await harness.runProfile({
    directory: workspace,
    shape,
    budgets: flags.has('--plan') || full ? harness.planBudgets : harness.smokeBudgets,
    liveLanes: full ? 48 : 6,
    transcriptMiB: flags.has('--no-transcript') ? 0 : full ? 42 : 4,
    recordMiB: full ? 8 : 2,
    sessionMiB: full ? 1.2 : 0.3,
    log: line => console.error(line),
  });
  console.log(harness.formatReport(results, shapeName));
  if (results.some(result => result.checks.some(check => !check.ok))) process.exitCode = 1;
} finally {
  await rm(bundleDirectory, { recursive: true, force: true });
  if (workspace && harness && !flags.has('--keep')) await harness.removeWorkspace(workspace);
  else if (workspace) console.error(`Kept ${workspace}`);
}
