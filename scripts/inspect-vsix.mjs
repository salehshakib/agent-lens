#!/usr/bin/env node
// Inspects a packaged VSIX before distribution (plan section 15 pre-distribution checklist).
//
//   node scripts/inspect-vsix.mjs [file.vsix] [--keep]
//
// With no file it packages the extension into a temporary folder with the local vsce, inspects the result and
// deletes the folder (use --keep to leave the .vsix in place and print its path). The checks are:
//   - every file is on the runtime allowlist, and nothing matches the denylist (tests, fixtures, source maps,
//     sources, docs, scripts, caches, credentials, provider binaries, work orders, other archives);
//   - text files carry no source-map reference, local absolute paths, secret-shaped strings or fixture markers;
//   - the manifest is consistent: main, icon and contributed media files are present, and nothing is bundled
//     as a runtime dependency.
// The zip reader is deliberately small and dependency-free, so the check does not trust the packager it inspects.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const sizeLimits = { fileBytes: 8 * 1024 * 1024, totalBytes: 12 * 1024 * 1024, vsixBytes: 4 * 1024 * 1024 };

/** Minimal zip central-directory reader. Supports stored and deflated entries, rejects zip64 and encryption. */
export function readZip(buffer) {
  const minEnd = 22;
  let end = -1;
  for (let i = buffer.length - minEnd; i >= Math.max(0, buffer.length - minEnd - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip archive: end of central directory not found.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('zip64 archives are not supported.');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt central directory.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString((flags & 0x800) ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
    if (flags & 1) throw new Error(`Encrypted entry: ${name}`);
    entries.push({ name, method, compressed, size, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries.map(entry => ({
    ...entry,
    isDirectory: entry.name.endsWith('/'),
    data() {
      if (buffer.readUInt32LE(entry.local) !== 0x04034b50) throw new Error(`Corrupt local header: ${entry.name}`);
      const start = entry.local + 30 + buffer.readUInt16LE(entry.local + 26) + buffer.readUInt16LE(entry.local + 28);
      const raw = buffer.subarray(start, start + entry.compressed);
      if (entry.method === 0) return Buffer.from(raw);
      if (entry.method === 8) return inflateRawSync(raw);
      throw new Error(`Unsupported compression method ${entry.method}: ${entry.name}`);
    },
  }));
}

const allowed = [
  /^\[Content_Types\]\.xml$/,
  /^extension\.vsixmanifest$/,
  /^extension\/package\.json$/,
  /^extension\/(?:README|CHANGELOG)\.md$/i,
  /^extension\/LICENSE(?:\.(?:md|txt))?$/i,
  /^extension\/dist\/host\/extension\.js$/,
  /^extension\/dist\/relay\/relay\.js$/,
  /^extension\/dist\/webview\/(?:sidebar|panel)\.js$/,
  /^extension\/media\/[a-z0-9._-]+\.(?:svg|png|css)$/i,
];

const denied = [
  [/\.map$/i, 'source map'],
  [/(^|\/)\.npm-cache(\/|$)|(^|\/)\.npm(\/|$)|(^|\/)\.cache(\/|$)/i, 'npm or tool cache'],
  [/(^|\/)node_modules(\/|$)/i, 'node_modules'],
  [/(^|\/)(?:tests?|__tests__|fixtures?|dist\/test)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i, 'test or fixture file'],
  [/(^|\/)(?:src|docs?|scripts|scratchpad|plan|\.github|\.vscode|\.claude|\.codex)(\/|$)/i, 'source, documentation, tooling or agent folder'],
  [/\.(?:ts|tsx|mts|cts)$|(^|\/)tsconfig[^/]*\.json$|(^|\/)package-lock\.json$|(^|\/)esbuild[^/]*$/i, 'TypeScript source or build configuration'],
  [/(^|\/)\.git(?:ignore|attributes|\/|$)|(^|\/)\.vscodeignore$|(^|\/)\.env/i, 'repository or environment file'],
  [/(^|\/)(?:auth|credentials?|secrets?|tokens?|api[-_]?keys?|id_(?:rsa|ed25519|ecdsa))(?:\.[a-z0-9]+)?$|(^|\/)\.credentials|\.(?:pem|key|p12|pfx|crt|cer|kdbx)$|(^|\/)(?:config|settings)\.toml$/i, 'credential or secret file'],
  [/(^|\/)(?:claude|codex)(?:\.exe|\.cmd|\.js)?$/i, 'provider binary or launcher'],
  [/\.(?:exe|dll|node|so|dylib|bin|wasm|bat|cmd|ps1|sh|com|msi|jar|apk)$/i, 'binary or script'],
  [/\.(?:vsix|zip|tgz|tar|gz|7z|rar)$/i, 'nested archive'],
  [/(?:^|\/)[^/]*(?:-order|work-?order)[^/]*\.md$|(?:^|\/)m\d+-[^/]*(?:order|report)[^/]*\.md$/i, 'work-order or report document'],
];

const binaryHeaders = [
  [Buffer.from('MZ'), 'Windows executable header'],
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'ELF executable header'],
  [Buffer.from([0xfe, 0xed, 0xfa, 0xce]), 'Mach-O header'],
  [Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), 'Mach-O header'],
  [Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), 'Mach-O header'],
  [Buffer.from([0xce, 0xfa, 0xed, 0xfe]), 'Mach-O header'],
  [Buffer.from([0xca, 0xfe, 0xba, 0xbe]), 'Mach-O or Java class header'],
  [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'zip header'],
  [Buffer.from('SQLite format 3'), 'SQLite database'],
];

const secretPatterns = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key (sk-)'],
  [/\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/"(?:access|refresh|id)_token"\s*:\s*"[^"]{20,}"/i, 'OAuth token field'],
];

const markerPatterns = [
  [/\b(?:private|hidden)-[a-z]+(?:-[a-z]+)*-marker\b/, 'test fixture marker'],
  [/\bIGNORE-[A-Z]+(?:-[A-Z]+)+\b/, 'prompt-injection fixture text'],
  [/\b10000000-0000-4000-8000-0000000000[0-9a-f]{2}\b/i, 'fixture session id'],
  [/\b5[01]000000-0000-4000-8000-[0-9a-f]{12}\b/i, 'synthetic history id'],
  [/X:\\{1,2}(?:perf-)?fixtures/i, 'fixture project path'],
];

const textName = /\.(?:js|cjs|mjs|json|css|svg|md|xml|txt|html)$/i;
const slashes = text => text.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function localPathNeedles(options) {
  const needles = new Set();
  for (const path of [options.repoRoot, ...(options.homes ?? [])]) {
    if (path && path.length > 6) needles.add(slashes(path).replace(/\/+$/, ''));
  }
  return [...needles];
}

/**
 * Inspect a VSIX buffer. Returns { entries, problems, totalBytes } where each problem is { file, rule, detail }.
 * `options.repoRoot` and `options.homes` are local absolute paths that must not appear inside the package.
 */
export function inspectVsix(buffer, options = {}) {
  const problems = [];
  const report = (file, rule, detail) => problems.push({ file, rule, detail });
  const needles = localPathNeedles(options);
  let entries;
  try {
    entries = readZip(buffer).filter(entry => !entry.isDirectory);
  } catch (error) {
    return { entries: [], problems: [{ file: '(archive)', rule: 'archive', detail: error.message }], totalBytes: 0 };
  }
  const limits = { ...sizeLimits, ...options.limits };
  if (buffer.length > limits.vsixBytes) report('(archive)', 'size', `VSIX is ${buffer.length} bytes, limit ${limits.vsixBytes}`);
  const seen = new Set();
  let totalBytes = 0;
  const files = new Map();

  for (const entry of entries) {
    const name = entry.name;
    totalBytes += entry.size;
    if (seen.has(name.toLowerCase())) report(name, 'duplicate', 'file appears twice in the archive');
    seen.add(name.toLowerCase());
    if (name.startsWith('/') || name.includes('..') || /^[a-z]:/i.test(name) || name.includes('\\')) report(name, 'path', 'unsafe path inside the archive');
    const reason = denied.find(([pattern]) => pattern.test(name));
    if (reason) report(name, 'denied', reason[1]);
    else if (!allowed.some(pattern => pattern.test(name))) report(name, 'allowlist', 'not a runtime file the extension ships');
    if (entry.size > limits.fileBytes) report(name, 'size', `${entry.size} bytes, limit ${limits.fileBytes}`);

    let data;
    try {
      data = entry.data();
    } catch (error) {
      report(name, 'archive', error.message);
      continue;
    }
    files.set(name, data);
    const header = binaryHeaders.find(([magic]) => data.length >= magic.length && data.subarray(0, magic.length).equals(magic));
    if (header) report(name, 'binary', header[1]);
    if (!textName.test(name) || data.includes(0)) continue;

    const text = data.toString('utf8');
    const lower = slashes(text);
    for (const match of text.matchAll(/(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=/g)) {
      report(name, 'source-map', `sourceMappingURL reference at line ${lineOf(text, match.index)}`);
    }
    for (const needle of needles) {
      const at = lower.indexOf(needle);
      if (at >= 0) report(name, 'local-path', `contains a local absolute path at line ${lineOf(lower, at)}`);
    }
    for (const [pattern, label] of secretPatterns) {
      const match = pattern.exec(text);
      if (match) report(name, 'secret', `${label} at line ${lineOf(text, match.index)}`);
    }
    for (const [pattern, label] of markerPatterns) {
      const match = pattern.exec(text);
      if (match) report(name, 'fixture', `${label} "${match[0].slice(0, 60)}" at line ${lineOf(text, match.index)}`);
    }
  }
  if (totalBytes > limits.totalBytes) report('(archive)', 'size', `${totalBytes} bytes unpacked, limit ${limits.totalBytes}`);

  // Manifest consistency.
  const manifestData = files.get('extension/package.json');
  if (!manifestData) {
    report('extension/package.json', 'manifest', 'missing');
  } else {
    let manifest;
    try { manifest = JSON.parse(manifestData.toString('utf8')); } catch { report('extension/package.json', 'manifest', 'not valid JSON'); }
    if (manifest) {
      const present = path => files.has('extension/' + String(path).replace(/^\.\//, '').replace(/\\/g, '/'));
      if (!manifest.main) report('extension/package.json', 'manifest', 'main is not set');
      else if (!present(manifest.main)) report('extension/package.json', 'manifest', `main ${manifest.main} is not in the package`);
      if (manifest.icon && !present(manifest.icon)) report('extension/package.json', 'manifest', `icon ${manifest.icon} is not in the package`);
      for (const referenced of new Set(JSON.stringify(manifest.contributes ?? {}).match(/\.?\/?media\/[A-Za-z0-9._-]+/g) ?? [])) {
        if (!present(referenced)) report('extension/package.json', 'manifest', `contributed file ${referenced} is not in the package`);
      }
      if (Object.keys(manifest.dependencies ?? {}).length) report('extension/package.json', 'manifest', 'runtime dependencies would need node_modules');
      if (!manifest.publisher || !manifest.name || !manifest.version) report('extension/package.json', 'manifest', 'publisher, name or version is missing');
    }
  }
  if (!files.has('extension.vsixmanifest')) report('extension.vsixmanifest', 'manifest', 'missing');
  return { entries: entries.map(entry => ({ name: entry.name, size: entry.size })), problems, totalBytes };
}

export function formatInspection(result, vsixBytes) {
  const lines = [];
  const width = Math.max(10, ...result.entries.map(entry => entry.name.length));
  for (const entry of result.entries) lines.push(`  ${entry.name.padEnd(width)}  ${String(entry.size).padStart(9)} B`);
  lines.push(`  ${result.entries.length} files, ${result.totalBytes} bytes unpacked, ${vsixBytes} bytes packed`);
  lines.push('');
  if (result.problems.length) {
    lines.push(`${result.problems.length} problem(s):`);
    for (const problem of result.problems) lines.push(`  [${problem.rule}] ${problem.file}: ${problem.detail}`);
  } else {
    lines.push('No problems found.');
  }
  return lines.join('\n');
}

async function packageExtension(root, directory) {
  const out = join(directory, 'agent-lens-inspect.vsix');
  const vsce = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
  const run = spawnSync(process.execPath, [vsce, 'package', '--skip-license', '--no-dependencies', '--out', out],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`vsce package failed (${run.status}).\n${run.stdout}\n${run.stderr}`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const given = args.find(arg => !arg.startsWith('--'));
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let directory;
  try {
    let file = given && resolve(given);
    if (!file) {
      directory = await mkdtemp(join(tmpdir(), 'agent-lens-vsix-'));
      file = await packageExtension(root, directory);
    }
    const buffer = await readFile(file);
    const result = inspectVsix(buffer, { repoRoot: root, homes: [homedir()] });
    console.log(`Inspected ${given ? file : 'a freshly packaged VSIX'}`);
    console.log(formatInspection(result, (await stat(file)).size));
    if (keep && !given) console.log(`\nKept ${file}`);
    if (result.problems.length) process.exitCode = 1;
  } finally {
    if (directory && !keep) {
      if (!basename(directory).startsWith('agent-lens-vsix-') || dirname(directory) !== tmpdir()) {
        throw new Error('Refusing to remove an unexpected directory.');
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
