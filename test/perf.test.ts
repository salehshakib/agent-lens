import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { shapes, writeHistory } from './fixtures/synthetic-history';
import { formatReport, makeWorkspace, removeWorkspace, runProfile, smokeBudgets } from './fixtures/synthetic-history-profile';

/**
 * Smoke-scale performance checks. They use loose budgets so they only catch order-of-magnitude regressions on a
 * busy CI machine. The plan budgets (1 s first rows, 42 MiB transcript, 1,800+ child files) run through
 * `npm run profile`, which uses the same harness at full scale.
 */

async function workspace(t: TestContext): Promise<string> {
  const directory = await makeWorkspace();
  t.after(() => removeWorkspace(directory));
  return directory;
}

async function digest(root: string): Promise<{ files: number; hash: string }> {
  const hash = createHash('sha256');
  let files = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        files++;
        hash.update(relative(root, path).replace(/\\/g, '/')).update(await readFile(path));
      }
    }
  }
  await visit(root);
  return { files, hash: hash.digest('hex') };
}

test('synthetic histories are deterministic, local and never use a real project path', async t => {
  const base = await workspace(t);
  const now = Date.parse('2031-04-05T06:00:00Z');
  const first = await writeHistory(join(base, 'one'), shapes.smoke, { now, live: 2, locks: true });
  const second = await writeHistory(join(base, 'two'), shapes.smoke, { now, live: 2, locks: true });
  assert.deepEqual(await digest(join(base, 'one')), await digest(join(base, 'two')));
  assert.equal(first.files, second.files);
  assert.equal(first.bytes, second.bytes);
  assert.ok(first.claudeChildren > 0 && first.codexThreads.length > 0);
  const cwds = (await readFile(first.claudeSessions[0]!, 'utf8')).match(/"cwd":"([^"]+)"/g) ?? [];
  assert.ok(cwds.length > 0 && cwds.every(entry => entry.startsWith('"cwd":"X:\\\\perf-fixtures\\\\project-')), 'cwds must not point at real folders');
  assert.ok((await stat(first.recentClaude[0]!)).mtimeMs >= now - 1000, 'the newest sessions look live');
});

test('smoke-scale profile stays inside the loose budgets', { timeout: 120_000 }, async t => {
  const base = await workspace(t);
  const results = await runProfile({
    directory: base, shape: shapes.smoke, budgets: smokeBudgets, liveLanes: 4, transcriptMiB: 2, recordMiB: 1, sessionMiB: 0.3,
  });
  const failures = results.flatMap(result => result.checks.filter(check => !check.ok).map(check => `${result.name}: ${check.label}`));
  assert.deepEqual(failures, [], formatReport(results, 'smoke'));
  assert.deepEqual(results.map(result => result.name), [
    'catalog discovery', 'first sidebar rows', 'live lanes and append', '0.3 MiB session view model',
    '2 MiB Claude transcript', '1 MiB records',
  ]);
});
