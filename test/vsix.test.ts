import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

/**
 * The VSIX inspector (scripts/inspect-vsix.mjs) is the pre-distribution check for credentials, private data,
 * fixture content and bundled provider binaries. These tests prove it catches each class on small archives and
 * that the files `vsce` would ship today pass it. `npm run inspect:vsix` runs it on a freshly packaged VSIX.
 */

interface Problem { file: string; rule: string; detail: string }
interface Inspector {
  inspectVsix(buffer: Buffer, options?: { repoRoot?: string; homes?: string[]; limits?: Record<string, number> }): { entries: { name: string; size: number }[]; problems: Problem[]; totalBytes: number };
  readZip(buffer: Buffer): { name: string; isDirectory: boolean; data(): Buffer }[];
}

const load = async (): Promise<Inspector> => (await import(pathToFileURL(resolve('scripts/inspect-vsix.mjs')).href)) as Inspector;
const repoRoot = resolve('.');

/** A stored (uncompressed) zip. The inspector does not rely on checksums, so they are left at zero. */
function zip(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));
    parts.push(local, nameBytes, data);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const manifest = JSON.stringify({
  name: 'agent-lens', publisher: 'someone', version: '1.0.0', main: './dist/host/extension.js',
  contributes: { viewsContainers: { activitybar: [{ id: 'x', title: 'X', icon: 'media/activity.svg' }] } },
});
const clean: Record<string, string> = {
  '[Content_Types].xml': '<Types/>',
  'extension.vsixmanifest': '<PackageManifest/>',
  'extension/package.json': manifest,
  'extension/readme.md': '# Agent Lens\n',
  'extension/dist/host/extension.js': '"use strict";\nmodule.exports = {};\n',
  'extension/dist/relay/relay.js': '"use strict";\n',
  'extension/dist/webview/sidebar.js': '"use strict";\n',
  'extension/dist/webview/panel.js': '"use strict";\n',
  'extension/media/activity.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'extension/media/lens.css': ':root{}\n',
};

const problemsFor = async (files: Record<string, string | Buffer>) =>
  (await load()).inspectVsix(zip(files), { repoRoot, homes: [homedir()] }).problems;
const rules = (problems: Problem[], file: string) => problems.filter(problem => problem.file === file).map(problem => problem.rule);

test('a clean runtime package passes', async () => {
  const result = (await load()).inspectVsix(zip(clean), { repoRoot, homes: [homedir()] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.entries.length, Object.keys(clean).length);
});

test('the inspector reads deflated archives made by real tools', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const body = Buffer.from('console.log("hi");\n'.repeat(50));
  const packed = deflateRawSync(body);
  const stored = zip({ 'extension/dist/host/extension.js': 'x' });
  // Rewrite the single stored entry as a deflated one.
  const nameLength = 'extension/dist/host/extension.js'.length;
  const local = Buffer.concat([stored.subarray(0, 30 + nameLength), packed]);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(body.length, 22);
  const directoryOffset = local.length;
  const header = Buffer.from(stored.subarray(30 + nameLength + 1, 30 + nameLength + 1 + 46 + nameLength));
  header.writeUInt16LE(8, 10);
  header.writeUInt32LE(packed.length, 20);
  header.writeUInt32LE(body.length, 24);
  const end = Buffer.from(stored.subarray(stored.length - 22));
  end.writeUInt32LE(46 + nameLength, 12);
  end.writeUInt32LE(directoryOffset, 16);
  const archive = Buffer.concat([local, header, end]);
  const entries = (await load()).readZip(archive);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.data(), body);
});

test('every class of unwanted content is reported against its file', async () => {
  const files: Record<string, string | Buffer> = {
    ...clean,
    'extension/dist/host/extension.js.map': '{"version":3}',
    'extension/test/fixtures/claude-code/session.jsonl': '{}',
    'extension/dist/test/test/perf.test.js': '',
    'extension/.npm-cache/_cacache/index': 'x',
    'extension/.claude/settings.json': '{}',
    'extension/.credentials.json': '{}',
    'extension/auth.json': '{}',
    'extension/bin/codex.exe': Buffer.from('MZ\x90\x00'),
    'extension/bin/claude': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]),
    'extension/media/helper.node': Buffer.from('x'),
    'extension/docs/plan/m1-implementation.md': '# plan',
    'extension/m1-phase-E2-claude-order.md': '# order',
    'extension/src/extension.ts': 'export {}',
    'extension/node_modules/left-pad/index.js': '',
    'extension/previous.vsix': Buffer.from('PK\x03\x04'),
    'extension/dist/webview/extra.js': '',
    'extension/dist/webview/leak.js': '',
  };
  files['extension/dist/relay/relay.js'] = `"use strict";\n//# sourceMappingURL=relay.js.map\n`;
  files['extension/dist/webview/sidebar.js'] = `const root = "${repoRoot.replace(/\\/g, '\\\\')}";\n`;
  files['extension/dist/webview/panel.js'] = `const key = "sk-${'a1B2c3D4'.repeat(4)}";\nconst fixture = "10000000-0000-4000-8000-000000000001";\n`;
  files['extension/media/lens.css'] = `/* IGNORE-TOOL-PROMPT private-remote-marker */\n`;
  const problems = await problemsFor(files);

  assert.deepEqual(rules(problems, 'extension/dist/host/extension.js.map'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/test/fixtures/claude-code/session.jsonl'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/dist/test/test/perf.test.js'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/.npm-cache/_cacache/index'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/.claude/settings.json'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/.credentials.json'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/auth.json'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/bin/codex.exe'), ['denied', 'binary']);
  assert.deepEqual(rules(problems, 'extension/bin/claude'), ['denied', 'binary']);
  assert.deepEqual(rules(problems, 'extension/media/helper.node'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/docs/plan/m1-implementation.md'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/m1-phase-E2-claude-order.md'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/src/extension.ts'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/node_modules/left-pad/index.js'), ['denied']);
  assert.deepEqual(rules(problems, 'extension/previous.vsix'), ['denied', 'binary']);
  assert.deepEqual(rules(problems, 'extension/dist/webview/extra.js'), ['allowlist']);
  assert.deepEqual(rules(problems, 'extension/dist/relay/relay.js'), ['source-map']);
  assert.deepEqual(rules(problems, 'extension/dist/webview/sidebar.js'), ['local-path']);
  assert.deepEqual(rules(problems, 'extension/dist/webview/panel.js'), ['secret', 'fixture']);
  assert.deepEqual(rules(problems, 'extension/media/lens.css'), ['fixture', 'fixture']);
});

test('the user home and a generic secret in the manifest are caught too', async () => {
  const withHome = { ...clean, 'extension/readme.md': `Install from ${homedir().replace(/\\/g, '\\\\')}\\Downloads\n` };
  assert.deepEqual(rules(await problemsFor(withHome), 'extension/readme.md'), ['local-path']);
  const withKey = { ...clean, 'extension/readme.md': '-----BEGIN OPENSSH PRIVATE KEY-----\n' };
  assert.deepEqual(rules(await problemsFor(withKey), 'extension/readme.md'), ['secret']);
});

test('manifest consistency: main, icons and dependencies', async () => {
  const withoutMain: Record<string, string> = { ...clean };
  delete withoutMain['extension/dist/host/extension.js'];
  assert.ok((await problemsFor(withoutMain)).some(problem => problem.rule === 'manifest' && /main/.test(problem.detail)));

  const withoutIcon: Record<string, string> = { ...clean };
  delete withoutIcon['extension/media/activity.svg'];
  assert.ok((await problemsFor(withoutIcon)).some(problem => problem.rule === 'manifest' && /activity\.svg/.test(problem.detail)));

  const bundled = { ...clean, 'extension/package.json': JSON.stringify({ ...JSON.parse(manifest), dependencies: { leftpad: '1.0.0' } }) };
  assert.ok((await problemsFor(bundled)).some(problem => problem.rule === 'manifest' && /dependencies/.test(problem.detail)));
});

test('corrupt archives and oversized contents are reported, not thrown', async () => {
  const inspector = await load();
  assert.equal(inspector.inspectVsix(Buffer.from('not a zip')).problems[0]?.rule, 'archive');
  const big = inspector.inspectVsix(zip({ ...clean, 'extension/dist/host/extension.js': 'x'.repeat(2048) }), { limits: { fileBytes: 1024 } });
  assert.ok(big.problems.some(problem => problem.rule === 'size'));
});

test('the files vsce would package today pass the inspector', { timeout: 60_000 }, async t => {
  const dist = ['dist/host/extension.js', 'dist/relay/relay.js', 'dist/webview/sidebar.js', 'dist/webview/panel.js'];
  if (dist.some(file => !existsSync(resolve(file)))) return t.skip('run `npm run build` first');
  const run = spawnSync(process.execPath, [resolve('node_modules/@vscode/vsce/vsce'), 'ls'], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(run.status, 0, run.stderr);
  const listed = run.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.ok(listed.includes('package.json') && listed.includes('dist/host/extension.js'));
  const files: Record<string, Buffer | string> = { '[Content_Types].xml': '<Types/>', 'extension.vsixmanifest': '<PackageManifest/>' };
  for (const file of listed) files['extension/' + file.replace(/\\/g, '/')] = await readFile(resolve(file));
  const result = (await load()).inspectVsix(zip(files), { repoRoot, homes: [homedir()] });
  assert.deepEqual(result.problems, [], 'vsce would ship content the inspector rejects');
});
