import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { adapters } from '../src/host/adapters/registry';
import { discoverSources } from '../src/host/discovery/catalog';
import { RootObservation } from '../src/host/discovery/observation';
import { configureRoots } from '../src/host/discovery/roots';
import type { ApprovedRoot } from '../src/host/discovery/roots';
import { SessionStore } from '../src/host/sessions/store';
import {
  claudeSessionId, claudeTranscript, codexRollout, codexThreadId, projectDirectory, shapes, writeHistory,
} from './fixtures/synthetic-history';
import { makeWorkspace, removeWorkspace } from './fixtures/synthetic-history-profile';

/**
 * External discovery: provider homes that live outside the user home, selected by the provider environment
 * variables, saved profiles or an observation-only log root. Everything is generated in the OS temp directory.
 */

class QuietWatch extends EventEmitter {
  close() { return this; }
}
const quietWatch = () => new QuietWatch() as unknown as FSWatcher;

async function workspace(t: TestContext): Promise<string> {
  const directory = await makeWorkspace();
  t.after(() => removeWorkspace(directory));
  return directory;
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

const anchor = Date.parse('2031-04-05T06:00:00Z');
const rolloutName = (threadId: string) => `rollout-2031-04-05T06-00-00-${threadId}.jsonl`;
const claudeFile = (home: string, slug: string, id: string) => join(home, 'projects', slug, id + '.jsonl');
const codexFile = (home: string, id: string) => join(home, 'sessions', '2031', '04', '05', rolloutName(id));
const claudeBody = (id: string) => claudeTranscript(id, 2, anchor, projectDirectory(1));
const codexBody = (id: string) => codexRollout(id, 2, anchor, projectDirectory(2));

function rootsOf(config: ReturnType<typeof configureRoots>) {
  return {
    claude: config.get('claude-code')?.roots ?? [],
    codex: config.get('codex')?.roots ?? [],
  };
}

/** Observe roots the way the extension does, with a controllable clock and no OS watchers. */
function observe(roots: readonly ApprovedRoot[], clock: { now: number }) {
  const store = new SessionStore(undefined, () => clock.now);
  const observers = roots.map(root => {
    const observer: RootObservation = new RootObservation(root, {
      watch: quietWatch, now: () => clock.now,
      onChange: () => store.setCatalog(root.key, root.adapter, observer.catalog),
      onBatch: batch => store.ingest(batch),
    });
    return observer;
  });
  return {
    store,
    observers,
    async settle() {
      for (const observer of observers) await observer.pollDiscovery();
      for (const observer of observers) await observer.pollReaders();
    },
    dispose: () => observers.forEach(observer => observer.dispose()),
  };
}

const names = (root: { catalog: ReadonlyMap<string, { path: string }> }) => [...root.catalog.values()].map(source => basename(source.path)).sort();

test('provider environment variables select external default homes and the user home is not read', async t => {
  const base = await workspace(t);
  const userHome = join(base, 'user home');
  const external = join(base, 'external drive', 'claude config');
  const externalCodex = join(base, 'external drive', 'codex data');
  const decoy = claudeSessionId(9);
  const claudeId = claudeSessionId(1);
  const codexId = codexThreadId(1);
  await put(claudeFile(join(userHome, '.claude'), 'decoy', decoy), claudeBody(decoy));
  await put(codexFile(join(userHome, '.codex'), codexThreadId(9)), codexBody(codexThreadId(9)));
  await put(claudeFile(external, 'external', claudeId), claudeBody(claudeId));
  await put(codexFile(externalCodex, codexId), codexBody(codexId));

  const { claude, codex } = rootsOf(configureRoots(adapters, {}, userHome, { CLAUDE_CONFIG_DIR: external, CODEX_HOME: externalCodex }));
  assert.deepEqual(claude.map(root => [root.boundary, root.profile?.id]), [[external, 'default']]);
  assert.deepEqual(codex.map(root => [root.boundary, root.profile?.id]), [[externalCodex, 'default']]);

  const clock = { now: Date.now() };
  const model = observe([...claude, ...codex], clock);
  t.after(model.dispose);
  await model.settle();
  const sessions = await model.store.sessions();
  assert.deepEqual(sessions.map(session => session.nativeId).sort(), [claudeId, codexId].sort());
  assert.ok(sessions.every(session => session.profile === 'default'));

  // Without the variables the same settings fall back to the user home, and the external homes are never seen.
  const fallback = rootsOf(configureRoots(adapters, {}, userHome, {}));
  assert.deepEqual([...fallback.claude, ...fallback.codex].map(root => root.boundary), [join(userHome, '.claude'), join(userHome, '.codex')]);
});

test('a missing or unreadable external home is reported as missing without throwing', async t => {
  const base = await workspace(t);
  const { claude } = rootsOf(configureRoots(adapters, {}, join(base, 'home'), { CLAUDE_CONFIG_DIR: join(base, 'unmounted', 'claude') }));
  const model = observe(claude, { now: Date.now() });
  t.after(model.dispose);
  await model.settle();
  assert.equal(model.observers[0]?.status.state, 'missing');
  assert.equal(model.observers[0]?.catalog.size, 0);
  assert.deepEqual(await model.store.sessions(), []);
});

test('saved external profiles stay isolated, including a native session id used in two profiles', async t => {
  const base = await workspace(t);
  const homes = { a: join(base, 'profile a'), b: join(base, 'profile b'), c: join(base, 'profile c'), def: join(base, 'default home') };
  const shared = claudeSessionId(5);
  const sharedCodex = codexThreadId(5);
  await put(claudeFile(homes.def, 'one', claudeSessionId(1)), claudeBody(claudeSessionId(1)));
  await put(claudeFile(homes.a, 'one', shared), claudeBody(shared));
  await put(claudeFile(homes.b, 'one', shared), claudeBody(shared));
  await put(codexFile(homes.c, sharedCodex), codexBody(sharedCodex));
  await put(codexFile(join(base, 'codex default'), codexThreadId(1)), codexBody(codexThreadId(1)));

  const config = configureRoots(adapters, {
    'claude-code': { profiles: [{ id: 'a', label: 'Work', home: homes.a }, { id: 'b', label: 'Personal', home: homes.b }] },
    codex: { profiles: [{ id: 'c', label: 'Lab', home: homes.c }] },
  }, join(base, 'home'), { CLAUDE_CONFIG_DIR: homes.def, CODEX_HOME: join(base, 'codex default') });
  const { claude, codex } = rootsOf(config);
  assert.deepEqual(claude.map(root => root.profile?.id), ['default', 'a', 'b']);
  assert.deepEqual(codex.map(root => root.profile?.id), ['default', 'c']);
  assert.equal(config.get('claude-code')?.rejected, 0);

  const model = observe([...claude, ...codex], { now: Date.now() });
  t.after(model.dispose);
  await model.settle();

  // Each observer catalogs only files inside its own boundary.
  for (const observer of model.observers) {
    const root = [...claude, ...codex][model.observers.indexOf(observer)]!;
    for (const source of observer.catalog.values()) {
      assert.ok(!relative(root.boundary, source.path).startsWith('..'), `${source.path} escaped ${root.boundary}`);
      assert.equal(source.profileId, root.profile?.id);
    }
  }
  const sessions = await model.store.sessions();
  const sharedClaude = sessions.filter(session => session.nativeId === shared);
  assert.deepEqual(sharedClaude.map(session => session.profile).sort(), ['a', 'b']);
  assert.equal(new Set(sharedClaude.map(session => session.id)).size, 2);
  assert.deepEqual(sessions.filter(session => session.nativeId === sharedCodex).map(session => session.profile), ['c']);
  assert.equal(sessions.length, 5);
});

test('a log root is observation-only: transcripts are read, but companions, presence and locks are not', async t => {
  const base = await workspace(t);
  const claudeLogs = join(base, 'copied claude logs');
  const codexLogs = join(base, 'copied codex logs');
  const claudeId = claudeSessionId(3);
  const codexId = codexThreadId(3);
  await put(join(claudeLogs, 'slug', claudeId + '.jsonl'), claudeBody(claudeId));
  await put(join(claudeLogs, 'sessions', '4242.json'), '{"pid":4242}');
  await put(join(codexLogs, '2031', '04', '05', rolloutName(codexId)), codexBody(codexId));
  await put(join(codexLogs, 'session_index.jsonl'), '{"id":"x","thread_name":"Index only in a profile"}\n');
  await put(join(codexLogs, 'thread-writer-locks', codexId + '.lock'), '');

  const config = configureRoots(adapters, {
    'claude-code': { logRoot: claudeLogs },
    codex: { logRoot: codexLogs },
  }, join(base, 'no home'), {});
  const { claude, codex } = rootsOf(config);
  const logs = [claude, codex].map(list => list.find(root => !root.profile));
  assert.ok(logs[0] && logs[1]);
  assert.equal(logs[0].history, claudeLogs);
  assert.equal(logs[1].history, codexLogs);

  const model = observe([logs[0], logs[1]], { now: Date.now() });
  t.after(model.dispose);
  await model.settle();
  assert.deepEqual(names(model.observers[0]!), [claudeId + '.jsonl']);
  assert.deepEqual(names(model.observers[1]!), [rolloutName(codexId)]);
  for (const observer of model.observers) {
    assert.ok([...observer.catalog.values()].every(source => source.kind === 'transcript' && source.profileId === undefined && !source.writerPresent));
  }
  const sessions = await model.store.sessions();
  assert.deepEqual(sessions.map(session => session.nativeId).sort(), [claudeId, codexId].sort());
  assert.ok(sessions.every(session => session.profile === undefined));
});

test('overlapping, relative, remote and duplicate roots are rejected before anything is read', async t => {
  const base = await workspace(t);
  const home = join(base, 'claude home');
  const codexHome = join(base, 'codex home');
  const result = configureRoots(adapters, {
    'claude-code': { profiles: [
      { id: 'inside', label: 'Inside', home: join(home, 'nested') },
      { id: 'parent', label: 'Parent', home: base },
      { id: 'dotdot', label: 'Dot dot', home: join(base, 'other', '..', 'claude home') },
      { id: 'relative', label: 'Relative', home: join('relative', 'home') },
      { id: 'remote', label: 'Remote', home: '\\\\remote-host\\share\\claude' },
      { id: 'posix-remote', label: 'Remote', home: '//remote-host/share/claude' },
      { id: 'ok', label: 'Fine', home: join(base, 'fine') },
      { id: 'ok', label: 'Duplicate', home: join(base, 'fine two') },
    ], logRoot: join(home, 'projects') },
    codex: { profiles: 'not-a-list' },
  }, join(base, 'user'), { CLAUDE_CONFIG_DIR: home, CODEX_HOME: codexHome });
  const { claude, codex } = rootsOf(result);
  assert.deepEqual(claude.map(root => root.profile?.id), ['default', 'ok']);
  assert.equal(result.get('claude-code')?.rejected, 8); // seven profiles plus the log root inside the default home
  assert.deepEqual(codex.map(root => root.profile?.id), ['default']);
  assert.equal(result.get('codex')?.rejected, 1);
  // The accepted roots never overlap each other.
  const boundaries = [...claude, ...codex].map(root => root.boundary);
  for (const [i, a] of boundaries.entries()) for (const [j, b] of boundaries.entries()) {
    if (i !== j) assert.ok(relative(a, b).startsWith('..') || relative(a, b) === '', `${a} overlaps ${b}`);
  }
});

test('a home claimed by one provider cannot be claimed by another, and the earlier provider wins', async t => {
  const base = await workspace(t);
  const shared = join(base, 'shared home');
  const result = configureRoots(adapters, {
    'claude-code': { profiles: [{ id: 'oops', label: 'Wrong home', home: shared }] },
  }, join(base, 'user'), { CODEX_HOME: shared });
  assert.deepEqual(rootsOf(result).claude.map(root => root.profile?.id), ['default', 'oops']);
  // Plan gap: the later provider's default home is dropped, not the mistaken profile. See the report.
  assert.deepEqual(rootsOf(result).codex, []);
  assert.equal(result.get('codex')?.rejected, 1);
});

test('junctions, hard links, credential files and foreign layouts never reach the catalog', async t => {
  const base = await workspace(t);
  const outside = join(base, 'outside');
  const claudeHome = join(base, 'claude');
  const codexHome = join(base, 'codex');
  const good = claudeSessionId(1);
  const foreign = claudeSessionId(2);
  const codexGood = codexThreadId(1);
  const text = (id: string) => claudeBody(id);

  await put(claudeFile(claudeHome, 'real', good), text(good));
  // Foreign content that must stay out: a project reached through a junction, a hard link, a junctioned subagents folder.
  await put(claudeFile(outside, 'shared', foreign), text(foreign));
  await put(join(outside, 'secret', claudeSessionId(7) + '.jsonl'), text(claudeSessionId(7)));
  await mkdir(join(claudeHome, 'projects'), { recursive: true });
  await symlink(join(outside, 'projects', 'shared'), join(claudeHome, 'projects', 'junction-project'), 'junction');
  await put(join(outside, 'agents', 'agent-evil.jsonl'), text(foreign));
  await mkdir(join(claudeHome, 'projects', 'real', good), { recursive: true });
  await symlink(join(outside, 'agents'), join(claudeHome, 'projects', 'real', good, 'subagents'), 'junction');
  await link(claudeFile(outside, 'shared', foreign), claudeFile(claudeHome, 'real', claudeSessionId(3)));
  // Credential and settings layouts at every level.
  for (const path of [
    join(claudeHome, '.credentials.json'), join(claudeHome, 'settings.json'), join(claudeHome, 'history.jsonl'),
    join(claudeHome, 'projects', '.credentials.json'), join(claudeHome, 'projects', 'real', 'auth.json'),
    join(claudeHome, 'projects', 'real', good + '.jsonl.bak'), join(claudeHome, 'projects', 'real', 'notes.txt'),
    join(claudeHome, 'projects', 'real', good, 'credentials.json'), join(claudeHome, 'projects', 'real', good, 'agent-x.jsonl'),
    join(claudeHome, 'projects', 'real', good, 'subagents', 'auth.json'), join(claudeHome, 'sessions', 'token.json'),
    join(claudeHome, 'sessions', '0.json'), join(claudeHome, 'sessions', '12.json.tmp'),
  ]) await put(path, '{"token":"sk-never-read"}');

  await put(codexFile(codexHome, codexGood), codexBody(codexGood));
  for (const path of [
    join(codexHome, 'auth.json'), join(codexHome, 'config.toml'), join(codexHome, 'history.jsonl'),
    join(codexHome, 'sessions', 'auth.json'), join(codexHome, 'sessions', '2031', 'auth.json'),
    join(codexHome, 'sessions', '2031', '04', '05', 'auth.json'), join(codexHome, 'sessions', '2031', '13', '05', rolloutName(codexThreadId(2))),
    join(codexHome, 'sessions', '2031', '04', '05', 'rollout-2031-04-05T06-00-00-not-a-uuid.jsonl'),
    join(codexHome, 'sessions', '2031', '04', '05', rolloutName(codexThreadId(3)) + '.bak'),
    join(codexHome, 'sessions', '2031', '04', 'extra', '05', rolloutName(codexThreadId(4))),
    join(codexHome, 'thread-writer-locks', 'auth.json'),
  ]) await put(path, '{"token":"sk-never-read"}');
  await put(codexFile(outside, codexThreadId(6)), codexBody(codexThreadId(6)));
  await link(codexFile(outside, codexThreadId(6)), join(codexHome, 'sessions', '2031', '04', '05', rolloutName(codexThreadId(5))));

  const { claude, codex } = rootsOf(configureRoots(adapters, {}, join(base, 'home'), { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }));
  const signal = new AbortController().signal;
  const found = await discoverSources(claude[0]!, signal);
  assert.deepEqual([...found.sources.values()].map(source => basename(source.path)), [good + '.jsonl']);
  const codexFound = await discoverSources(codex[0]!, signal);
  assert.deepEqual([...codexFound.sources.values()].map(source => basename(source.path)), [rolloutName(codexGood)]);

  // A profile whose home is itself a junction to a real home is rejected as a whole.
  const real = join(base, 'real profile');
  await put(claudeFile(real, 'p', claudeSessionId(8)), text(claudeSessionId(8)));
  const aliased = join(base, 'aliased profile');
  await symlink(real, aliased, 'junction');
  const aliasConfig = rootsOf(configureRoots(adapters, { 'claude-code': { profiles: [{ id: 'alias', label: 'Alias', home: aliased }] } }, join(base, 'home'), {}));
  const aliasRoot = aliasConfig.claude.find(root => root.profile?.id === 'alias');
  assert.ok(aliasRoot);
  const model = observe([aliasRoot], { now: Date.now() });
  t.after(model.dispose);
  await model.settle();
  assert.equal(model.observers[0]?.status.state, 'rejected');
  assert.equal(model.observers[0]?.catalog.size, 0);
  assert.deepEqual(await model.store.sessions(), []);
});

test('a root that disappears is reconciled away and returns when the files do', async t => {
  const base = await workspace(t);
  const home = join(base, 'claude');
  const first = claudeSessionId(1);
  const second = claudeSessionId(2);
  await put(claudeFile(home, 'one', first), claudeBody(first));
  await put(claudeFile(home, 'one', second), claudeBody(second));
  const { claude } = rootsOf(configureRoots(adapters, {}, join(base, 'user'), { CLAUDE_CONFIG_DIR: home }));
  const clock = { now: Date.now() };
  const model = observe(claude, clock);
  t.after(model.dispose);
  const observer = model.observers[0]!;
  const advance = async (ms: number) => { clock.now += ms; await model.settle(); };

  await model.settle();
  assert.equal(observer.status.state, 'available');
  assert.equal((await model.store.sessions()).length, 2);

  // One transcript goes away, then returns with new content.
  await rm(claudeFile(home, 'one', second));
  await advance(20_000);
  assert.deepEqual(names(observer), [first + '.jsonl']);
  assert.deepEqual((await model.store.sessions()).map(session => session.nativeId), [first]);
  await put(claudeFile(home, 'one', second), claudeBody(second));
  await advance(20_000);
  assert.equal((await model.store.sessions()).length, 2);

  // The whole history disappears (unmounted drive), then the drive comes back.
  await rm(join(home, 'projects'), { recursive: true });
  await advance(60_000);
  assert.equal(observer.status.state, 'missing');
  assert.equal(observer.catalog.size, 0);
  assert.deepEqual(await model.store.sessions(), []);
  await put(claudeFile(home, 'one', first), claudeBody(first));
  await advance(120_000);
  await advance(120_000);
  assert.equal(observer.status.state, 'available');
  assert.deepEqual((await model.store.sessions()).map(session => session.nativeId), [first]);
});

test('observed roots flow into the session store with child lanes, usage and appended turns', async t => {
  const base = await workspace(t);
  const now = Date.now();
  const manifest = await writeHistory(join(base, 'history'), shapes.smoke, { now, live: 2, locks: true });
  const { claude, codex } = rootsOf(configureRoots(adapters, {}, join(base, 'user'), { CLAUDE_CONFIG_DIR: manifest.claudeHome, CODEX_HOME: manifest.codexHome }));
  const model = observe([...claude, ...codex], { now });
  t.after(model.dispose);
  await model.settle();

  const sessions = await model.store.sessions();
  assert.equal(sessions.length, manifest.claudeSessions.length + manifest.codexThreads.length);
  assert.ok(sessions.every(session => session.title !== undefined));
  // Locks mark the matching Codex transcripts as having a writer (the turns here are complete, so the state stays Completed).
  const writers = model.observers.flatMap(observer => [...observer.catalog.values()]).filter(source => source.writerPresent);
  assert.equal(writers.length, 2);
  assert.ok(writers.every(source => source.provider === 'codex' && source.kind === 'transcript'));

  // A session that spawns child lanes shows them after it is opened. Opening is one request at a time:
  // a newer request supersedes an older one, so the sessions are opened in sequence.
  let lanes = 0;
  for (const session of sessions.filter(item => item.provider === 'claude-code')) {
    lanes = Math.max(lanes, (await model.store.materialize(session.id))?.lanes.length ?? 0);
  }
  assert.ok(lanes > 1, 'a Claude session with subagent lanes should expose them');
});
