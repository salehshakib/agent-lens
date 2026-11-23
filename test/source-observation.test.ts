import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { appendFile, copyFile, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { adapters } from '../src/host/adapters/registry';
import type { Adapter } from '../src/host/adapters/types';
import { ByteTail, JsonSnapshot, parseJson } from '../src/host/discovery/byte-tail';
import { discoverSources, probeSource } from '../src/host/discovery/catalog';
import { RootObservation } from '../src/host/discovery/observation';
import { SourceReader } from '../src/host/discovery/reader';
import { configureRoots } from '../src/host/discovery/roots';
import type { ApprovedRoot } from '../src/host/discovery/roots';

const fixtures = resolve('test/fixtures');
const nativeId = '10000000-0000-4000-8000-000000000001';
const elsewhereId = '10000000-0000-4000-8000-000000000050';

async function fixtureWorkspace(t: TestContext) {
  const directory = await mkdtemp(join(fixtures, '.phase-a-'));
  t.after(async () => {
    assert.match(relative(fixtures, directory), /^\.phase-a-[a-zA-Z0-9]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function rootFor(directory: string, adapter: Adapter['id']): ApprovedRoot {
  const root = configureRoots(adapters, {}, directory, {}).get(adapter)?.roots[0];
  assert.ok(root);
  return root;
}

async function put(path: string, text: string | Buffer): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, text);
}

test('approved roots isolate provider profiles and discovery-only overrides', async t => {
  const directory = await fixtureWorkspace(t);
  const custom = join(directory, 'claude-fixture');
  const secondary = join(directory, 'another-fixture');
  const unowned = join(directory, 'unowned-fixture');
  const result = configureRoots(adapters, {
    'claude-code': { logRoot: unowned, profiles: [
      { id: 'secondary', label: 'Fixture profile', home: secondary },
      { id: 'alias', label: 'Alias', home: join(custom, 'nested') },
      { id: 'nested-id', label: 'Remote', home: '\\\\fixture-host\\share' },
      { id: 'secondary', label: 'Duplicate ID', home: join(directory, 'duplicate') },
    ] },
    codex: { enabled: false },
  }, directory, { CLAUDE_CONFIG_DIR: custom });
  const claude = result.get('claude-code');
  assert.equal(claude?.rejected, 3);
  assert.deepEqual(claude?.roots.map(root => [root.boundary, root.history, root.profile?.id]), [
    [custom, join(custom, 'projects'), 'default'],
    [secondary, join(secondary, 'projects'), 'secondary'],
    [unowned, unowned, undefined],
  ]);
  assert.deepEqual(result.get('codex'), { disabled: true, roots: [], rejected: 0 });
});

test('catalog accepts only provider layouts, rejects aliases and observes locks without reading them', async t => {
  const directory = await fixtureWorkspace(t);
  const claude = rootFor(directory, 'claude-code');
  const codex = rootFor(directory, 'codex');
  const main = join(claude.history, 'fixture-project', nativeId + '.jsonl');
  const child = join(claude.history, 'fixture-project', nativeId, 'subagents', 'agent-local');
  const presence = join(claude.boundary, 'sessions', '420.json');
  const validRollout = join(codex.history, '2026', '01', '03', 'rollout-2026-01-03T10-00-00-' + nativeId + '.jsonl');
  await put(main, '');
  await put(child + '.jsonl', '');
  await put(child + '.meta.json', '{}');
  await put(presence, '{}');
  await put(validRollout, '');
  await put(join(codex.boundary, 'session_index.jsonl'), '');
  await put(join(codex.boundary, 'thread-writer-locks', nativeId + '.lock'), '');
  await put(join(codex.boundary, 'history.jsonl'), 'fixture historical input');
  await put(join(codex.boundary, 'auth.json'), 'fixture private material');
  await put(join(claude.history, 'fixture-project', nativeId, 'tool-results', 'fixture.txt'), 'fixture spill');
  await put(join(codex.history, '2026', '99', '03', 'rollout-2026-01-03T10-00-00-' + elsewhereId + '.jsonl'), '');
  const excluded = join(directory, 'outside', elsewhereId + '.jsonl');
  await put(excluded, 'fixture outside observed homes');
  await symlink(resolve(excluded, '..'), join(claude.history, 'junction-project'), 'junction');
  const alias = join(claude.history, 'fixture-project', elsewhereId + '.jsonl');
  await link(excluded, alias);

  const signal = new AbortController().signal;
  const [cl, cx] = await Promise.all([discoverSources(claude, signal), discoverSources(codex, signal)]);
  assert.equal(cl.state, 'available');
  assert.equal(cx.state, 'available');
  assert.deepEqual([...cl.sources.values()].map(source => source.path).sort(), [main, child + '.jsonl', child + '.meta.json', presence].sort());
  assert.deepEqual([...cx.sources.values()].map(source => [source.kind, source.writerPresent]), [
    ['transcript', true], ['index', undefined],
  ]);
  await assert.rejects(probeSource(claude, alias), { state: 'rejected' });
  await assert.rejects(probeSource(claude, join(claude.history, 'junction-project', elsewhereId + '.jsonl')), { state: 'rejected' });
  assert.equal(await probeSource(codex, join(codex.boundary, 'auth.json')), undefined);
});

test('byte tail commits complete UTF-8 and CRLF lines across appends and discards oversized records', async t => {
  const directory = await fixtureWorkspace(t);
  const file = join(directory, 'bytes.jsonl');
  const first = Buffer.from('\ufeff{"text":"é"}\r\n', 'utf8');
  const split = first.indexOf(0xc3) + 1;
  const tail = new ByteTail(32);
  await put(file, first.subarray(0, split));
  assert.deepEqual(await tail.read(file), { generation: 1, reset: true, committed: 0, more: false, lines: [] });
  await appendFile(file, first.subarray(split, first.length - 1));
  assert.equal((await tail.read(file)).committed, 0);
  await appendFile(file, '\n' + 'a'.repeat(40));
  const appended = await tail.read(file);
  assert.equal(appended.generation, 1);
  assert.equal(appended.committed, first.length);
  const line = appended.lines[0];
  assert.ok(line?.bytes);
  assert.deepEqual(parseJson(line.bytes, line.offset), { text: 'é' });
  await appendFile(file, 'a'.repeat(40) + '\n{}\n{"partial":');
  const final = await tail.read(file);
  assert.deepEqual(final.lines.map(line => line.bytes?.toString()), [undefined, '{}']);
  assert.equal(final.lines[0]?.offset, first.length);
  assert.equal(final.lines[1]?.offset, first.length + 81);
  assert.equal((await tail.read(file)).lines.length, 0);
});

test('byte tail invalidates replacements, truncations and append-after-rewrite', async t => {
  const directory = await fixtureWorkspace(t);
  const file = join(directory, 'rotation.jsonl');
  const tail = new ByteTail();
  await put(file, '{"old":"history"}\n{"pending":');
  assert.equal((await tail.read(file)).generation, 1);
  await put(file, '{"new":"history"}\n{}\n{"tail":"longer"}\n');
  const rewritten = await tail.read(file);
  assert.equal(rewritten.reset, true);
  assert.equal(rewritten.generation, 2);
  assert.equal(rewritten.lines[0]?.bytes?.toString(), '{"new":"history"}');
  await put(file, '{}\n');
  assert.equal((await tail.read(file)).generation, 3);
  await rename(file, join(directory, 'old.jsonl'));
  await assert.rejects(tail.read(file), { code: 'ENOENT' });
  await put(file, '{}\n');
  const replaced = await tail.read(file);
  assert.equal(replaced.reset, true);
  assert.equal(replaced.generation, 4);
});

test('JSON companions resnapshot multiline metadata and bound oversized replacements', async t => {
  const directory = await fixtureWorkspace(t);
  const path = join(directory, 'agent.meta.json');
  const tail = new JsonSnapshot();
  await put(path, '{\n  "finished": false\n}');
  const first = await tail.read(path);
  assert.equal(first.generation, 1);
  assert.ok(first.lines[0]?.bytes);
  assert.deepEqual(parseJson(first.lines[0].bytes, 0), { finished: false });
  await put(path, '{\n  "finished": true\n}');
  assert.equal((await tail.read(path)).generation, 2);
  await put(path, Buffer.alloc(256 * 1024 + 1, 32));
  assert.deepEqual((await tail.read(path)).lines, [{ offset: 0, bytes: undefined }]);
  assert.equal((await tail.read(path)).reset, false);
});

test('source reader skips malformed and unknown lines and never replays embedded compaction history', async t => {
  const directory = await fixtureWorkspace(t);
  const root = rootFor(directory, 'codex');
  const path = join(root.history, '2026', '01', '03', 'rollout-2026-01-03T10-00-00-' + nativeId + '.jsonl');
  await put(path, '{malformed}\n{"type":"future_event","payload":{"private":"ignored"}}\n');
  await appendFile(path, Buffer.from([0xff, 0x0a]));
  await appendFile(path, JSON.stringify({ type: 'compacted', payload: { replacement_history: 'a'.repeat(8 * 1024 * 1024) } }) + '\n');
  const source = await probeSource(root, path);
  assert.ok(source);
  const reader = new SourceReader(root.adapter, source);
  const first = await reader.read(source);
  assert.deepEqual(first.diagnostics, { malformed: 2, unknown: 1, oversized: 0 });
  let batch = first;
  for (let i = 0; i < 20 && batch.more; i++) batch = await reader.read(source);
  assert.equal(batch.more, false);
  assert.deepEqual(batch.events.map(event => event.kind), ['compaction']);
  assert.equal((await reader.read(source)).events.length, 0);
});

test('polling reconciles missing sources, errors and missed watch events in old folders across restart', async t => {
  const directory = await fixtureWorkspace(t);
  const root = rootFor(directory, 'codex');
  let now = Date.now();
  const watches: FakeWatch[] = [];
  let resets = 0;
  let appended = 0;
  class FakeWatch extends EventEmitter {
    close() { return this; }
  }
  const observer = new RootObservation(root, {
    watch: () => {
      const watcher = new FakeWatch();
      watches.push(watcher);
      return watcher as unknown as FSWatcher;
    },
    now: () => now,
    onBatch: batch => {
      if (batch.reset) resets++;
      else appended += batch.events.filter(event => event.kind === 'compaction').length;
    },
  });
  t.after(() => observer.dispose());
  await observer.pollDiscovery();
  assert.equal(observer.status.state, 'missing');
  const path = join(root.history, '2026', '01', '03', 'rollout-2026-01-03T10-00-00-' + nativeId + '.jsonl');
  await put(path, '');
  await copyFile(join(fixtures, 'codex', 'current-rollout.jsonl'), path);
  now += 65_000;
  await observer.pollDiscovery();
  assert.equal(observer.status.transcripts, 1);
  observer.select([...observer.catalog.keys()][0]);
  await observer.pollReaders();
  assert.deepEqual(observer.status.versions, ['0.170.0']);
  assert.equal(resets, 1);
  await appendFile(path, '{"type":"compacted","payload":{}}\n');
  now += 65_000;
  await observer.pollDiscovery();
  await observer.pollReaders();
  assert.equal(resets, 1);
  assert.equal(appended, 1);

  const originalCount = watches.length;
  watches[0]?.emit('error', Object.assign(new Error('synthetic watch failure'), { code: 'EPERM' }));
  now += 65_000;
  const oldUpdatedAt = [...observer.catalog.values()][0]?.updatedAt ?? 0;
  await writeFile(path, '{"type":"compacted","payload":{}}\n');
  await observer.pollDiscovery();
  await observer.pollReaders();
  assert.ok(watches.length > originalCount);
  assert.ok(([...observer.catalog.values()][0]?.updatedAt ?? 0) >= oldUpdatedAt);
  assert.equal(resets, 2);

  observer.dispose();
  const restarted = new RootObservation(root, { now: () => now, watch: () => { throw new Error('watch unavailable'); } });
  t.after(() => restarted.dispose());
  await restarted.pollDiscovery();
  assert.equal(restarted.status.transcripts, 1);
  await rm(path);
  now += 65_000;
  await restarted.pollDiscovery();
  assert.equal(restarted.status.transcripts, 0);
});
