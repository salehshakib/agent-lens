import { deepEqual, equal, ok } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readSnapshots } from '../src/host/limits/claude-relay';
import { findMembers, installRelay, relayDirectories, relayState, scanObject, uninstallRelay } from '../src/host/limits/settings';
import { minimalLine, priorCommand, publishSnapshot, snapshotFromInput } from '../src/relay/core';

/** Every case runs against temporary directories only. The real Claude profile is never touched. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'agent-lens-relay-'));
  const home = join(root, 'profile');
  const storage = join(root, 'storage');
  const script = join(root, 'relay-built.js');
  mkdirSync(home);
  mkdirSync(storage);
  writeFileSync(script, '// fixture relay script\n');
  return { root, home, storage, script, settings: join(home, 'settings.json'), none: [] as string[],
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const read = (path: string) => readFileSync(path, 'utf8');

test('install adds only statusLine, keeps other members byte for byte and uninstall restores the file', async () => {
  const box = sandbox();
  try {
    const original = '{\n  // user comment is not valid strict JSON, so use plain JSON\n}';
    equal(scanObject(original), undefined);
    const text = '{\n  "theme": "dark",\n  "env": { "A": "1" }\n}\n';
    writeFileSync(box.settings, text);
    const options = { home: box.home, storage: box.storage, relayScript: box.script, precedencePaths: box.none };
    const installed = await installRelay(options);
    equal(installed.ok, true);
    const after = read(box.settings);
    const parsed = JSON.parse(after);
    equal(parsed.theme, 'dark');
    deepEqual(parsed.env, { A: '1' });
    equal(parsed.statusLine.type, 'command');
    ok(parsed.statusLine.command.includes('relay.js'));
    equal(await relayState(options), 'installed');
    const removed = await uninstallRelay(options);
    equal(removed.ok, true);
    equal(read(box.settings), text);
    equal(await relayState(options), 'not-installed');
    equal(existsSync(relayDirectories(box.storage, box.home).script), false);
  } finally {
    box.cleanup();
  }
});

test('install is idempotent and a prior command is stored for chaining then restored', async () => {
  const box = sandbox();
  try {
    const prior = '{"statusLine": {"type": "command", "command": "echo fixture-line"}, "theme": "dark"}';
    writeFileSync(box.settings, prior);
    const options = { home: box.home, storage: box.storage, relayScript: box.script, precedencePaths: box.none };
    equal((await installRelay(options)).ok, true);
    const again = await installRelay(options);
    equal(again.ok && again.status, 'already-installed');
    const dirs = relayDirectories(box.storage, box.home);
    equal(priorCommand(dirs.profile), 'echo fixture-line');
    equal((await uninstallRelay(options)).ok, true);
    equal(read(box.settings), prior);
  } finally {
    box.cleanup();
  }
});

test('uninstall removes a settings file that Agent Lens created', async () => {
  const box = sandbox();
  try {
    const options = { home: box.home, storage: box.storage, relayScript: box.script, precedencePaths: box.none };
    equal((await installRelay(options)).ok, true);
    ok(existsSync(box.settings));
    equal((await uninstallRelay(options)).ok, true);
    equal(existsSync(box.settings), false);
  } finally {
    box.cleanup();
  }
});

test('a statusLine the user edited after install is left in place', async () => {
  const box = sandbox();
  try {
    const options = { home: box.home, storage: box.storage, relayScript: box.script, precedencePaths: box.none };
    equal((await installRelay(options)).ok, true);
    const edited = '{"statusLine": {"type": "command", "command": "echo user-own"}}';
    writeFileSync(box.settings, edited);
    const removed = await uninstallRelay(options);
    equal(removed.ok && removed.status, 'edited');
    equal(read(box.settings), edited);
    equal(existsSync(relayDirectories(box.storage, box.home).profile), false);
  } finally {
    box.cleanup();
  }
});

test('install refuses an unreadable file, duplicate keys, a non-command value and higher precedence', async () => {
  const box = sandbox();
  try {
    const options = { home: box.home, storage: box.storage, relayScript: box.script, precedencePaths: box.none };
    writeFileSync(box.settings, '{ "theme": ');
    const broken = await installRelay(options);
    equal(!broken.ok && broken.code, 'unreadable');
    equal(read(box.settings), '{ "theme": ');

    writeFileSync(box.settings, '{"statusLine": {"type":"command","command":"a"}, "statusLine": {"type":"command","command":"b"}}');
    const duplicate = await installRelay(options);
    equal(!duplicate.ok && duplicate.code, 'unrecognized');

    writeFileSync(box.settings, '{"statusLine": "just text"}');
    const unknown = await installRelay(options);
    equal(!unknown.ok && unknown.code, 'unrecognized');
    equal(read(box.settings), '{"statusLine": "just text"}');

    writeFileSync(box.settings, '{}');
    const managed = join(box.root, 'managed-settings.json');
    writeFileSync(managed, '{"statusLine": {"type": "command", "command": "managed"}}');
    const higher = await installRelay({ ...options, precedencePaths: [managed] });
    equal(!higher.ok && higher.code, 'precedence');
    equal(read(box.settings), '{}');
    equal(existsSync(relayDirectories(box.storage, box.home).profile), false);
  } finally {
    box.cleanup();
  }
});

test('install rejects paths with characters that cannot be quoted safely', async () => {
  const box = sandbox();
  try {
    const result = await installRelay({ home: box.home, storage: join(box.storage, 'a$b'), relayScript: box.script, precedencePaths: box.none });
    equal(!result.ok && result.code, 'path');
    equal(existsSync(box.settings), false);
  } finally {
    box.cleanup();
  }
});

test('member scanning ignores nested keys and finds the top-level member only', () => {
  const scan = scanObject('{"a": {"statusLine": 1}, "statusLine": {"x": [1, 2]}}')!;
  equal(findMembers(scan, 'statusLine').length, 1);
});

test('snapshots are projected, published atomically and read back per profile', () => {
  const box = sandbox();
  try {
    const now = Date.now();
    const snapshot = snapshotFromInput(JSON.stringify({
      session_id: 'fixture-session-1', prompt: 'never stored', cwd: 'C:/never',
      context_window: { used_percentage: 20, context_window_size: 200000 },
      rate_limits: { five_hour: { used_percentage: 8, resets_at: Math.floor(now / 1000) + 3600 } },
    }), now)!;
    ok(snapshot);
    const directory = join(box.storage, 'snap');
    publishSnapshot(directory, snapshot);
    const files = readdirSync(directory);
    deepEqual(files.filter(name => name.endsWith('.tmp')), []);
    equal(files.length, 1);
    const stored = read(join(directory, files[0]!));
    ok(!stored.includes('never'));
    equal(snapshotFromInput('not json', now), undefined);
    equal(minimalLine(snapshot), 'Context 20%');
    equal(minimalLine(undefined), 'Agent Lens');
  } finally {
    box.cleanup();
  }
});

test('readSnapshots skips malformed and oversized files', async () => {
  const box = sandbox();
  try {
    const directory = join(box.storage, 'snap');
    mkdirSync(directory);
    writeFileSync(join(directory, 'bad.json'), 'nope');
    writeFileSync(join(directory, 'big.json'), ' '.repeat(300_000));
    const now = Date.now();
    publishSnapshot(directory, { v: 1, capturedAt: now, sessionId: 'fixture-session-2', context: { usedPercent: 5, windowSize: 1000 } });
    const snapshots = await readSnapshots(directory);
    equal(snapshots.length, 1);
    equal(snapshots[0]?.sessionId, 'fixture-session-2');
    deepEqual(await readSnapshots(join(box.storage, 'missing')), []);
  } finally {
    box.cleanup();
  }
});

test('the built relay stores a snapshot and passes the prior command output through', async () => {
  const box = sandbox();
  try {
    const script = resolve('dist', 'test', 'src', 'relay', 'relay.js');
    ok(existsSync(script), 'the compiled relay must exist after tsc');
    const profile = join(box.storage, 'profile');
    mkdirSync(profile);
    const chain = 'node -e "process.stdin.pipe(process.stdout)"';
    writeFileSync(join(profile, 'chain.json'), JSON.stringify({ command: chain }));
    const payload = JSON.stringify({ session_id: 'fixture-session-3', context_window: { used_percentage: 33, context_window_size: 1000 } });
    const output = await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, [script, profile], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: '' } });
      let text = '';
      child.stdout.on('data', chunk => { text += String(chunk); });
      child.on('error', fail);
      child.on('close', () => done(text));
      child.stdin.end(payload);
    });
    equal(output, payload);
    const snapshots = await readSnapshots(join(profile, 'snap'));
    equal(snapshots.length, 1);
    equal(snapshots[0]?.context?.usedPercent, 33);
  } finally {
    box.cleanup();
  }
});

test('the built relay prints a minimal line when nothing is chained', async () => {
  const box = sandbox();
  try {
    const script = resolve('dist', 'test', 'src', 'relay', 'relay.js');
    const profile = join(box.storage, 'profile');
    mkdirSync(profile);
    const output = await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, [script, profile], { stdio: ['pipe', 'pipe', 'inherit'] });
      let text = '';
      child.stdout.on('data', chunk => { text += String(chunk); });
      child.on('error', fail);
      child.on('close', () => done(text));
      child.stdin.end(JSON.stringify({ session_id: 'fixture-session-4', context_window: { used_percentage: 12, context_window_size: 1000 } }));
    });
    equal(output, 'Context 12%');
  } finally {
    box.cleanup();
  }
});
