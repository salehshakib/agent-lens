import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { adapters } from '../../src/host/adapters/registry';
import { discoverSources, probeSource } from '../../src/host/discovery/catalog';
import { RootObservation } from '../../src/host/discovery/observation';
import { SourceReader } from '../../src/host/discovery/reader';
import { configureRoots } from '../../src/host/discovery/roots';
import type { ApprovedRoot } from '../../src/host/discovery/roots';
import { SessionStore } from '../../src/host/sessions/store';
import { buildDetail, buildTree } from '../../src/host/views/models';
import {
  claudeSessionId, claudeTurn, codexThreadId, projectDirectory, shapes, writeCodexCompaction, writeHistory,
  writeLargeClaudeTranscript,
} from './synthetic-history';
import type { HistoryManifest, HistoryShape, ShapeName } from './synthetic-history';

const mib = 1024 * 1024;
const workspacePrefix = 'agent-lens-profile-';

/** Limits a run is checked against. Plan targets are marked `plan`; the rest are derived from them or from cadence. */
export interface Budgets {
  /** plan §7: first sidebar rows within one second from a warm start. */
  firstRowsMs: number;
  /** Warm full discovery of one provider root. */
  discoveryMs: number;
  /** One bounded reader cycle with dozens of live lanes. Must stay below the 750 ms selected-file cadence. */
  readCycleMs: number;
  /** plan §7: visible appends within two seconds, minus the 750 ms poll cadence. */
  appendMs: number;
  /** View-model build for a 1.2 MB session (smooth scroll). */
  detailMs: number;
  /** Longest single reader call and longest event-loop delay while reading a large transcript. */
  stallMs: number;
  /** Heap growth after a 42 MiB transcript is materialized and released from the reader. */
  heapGrowthMiB: number;
  /** One 8 MiB record, end to end. */
  recordMs: number;
}

export const planBudgets: Budgets = {
  firstRowsMs: 1000, discoveryMs: 2000, readCycleMs: 750, appendMs: 1250, detailMs: 250, stallMs: 250, heapGrowthMiB: 256, recordMs: 1500,
};

/** Default `npm test` run on a small history. Loose on purpose: it catches order-of-magnitude regressions only. */
export const smokeBudgets: Budgets = {
  firstRowsMs: 5000, discoveryMs: 10_000, readCycleMs: 5000, appendMs: 5000, detailMs: 2000, stallMs: 2000, heapGrowthMiB: 512, recordMs: 10_000,
};

export interface Check {
  label: string;
  actual: number;
  limit: number;
  unit: string;
  ok: boolean;
}

export interface Measurement {
  name: string;
  ms: number;
  facts: Record<string, string | number>;
  checks: Check[];
}

export interface ProfileOptions {
  directory: string;
  shape: HistoryShape;
  budgets: Budgets;
  liveLanes: number;
  /** Size of the long Claude transcript. 42 matches the plan; 0 skips it. */
  transcriptMiB: number;
  /** Size of the single large record. 8 matches the plan; 0 skips it. */
  recordMiB: number;
  /** Size of the mid-size session used for view-model timing. */
  sessionMiB: number;
  log?: (line: string) => void;
}

export async function makeWorkspace(): Promise<string> {
  // Resolve 8.3 short names so the source guard's realpath comparison accepts the path.
  const directory = await mkdtemp(join(await realpath(tmpdir()), workspacePrefix));
  return realpath(directory);
}

export async function removeWorkspace(directory: string): Promise<void> {
  if (!basename(directory).startsWith(workspacePrefix) || dirname(directory) !== (await realpath(tmpdir()))) {
    throw new Error('Refusing to remove a directory that was not created by makeWorkspace.');
  }
  await rm(directory, { recursive: true, force: true });
}

class QuietWatch extends EventEmitter {
  close() { return this; }
}
const quietWatch = () => new QuietWatch() as unknown as FSWatcher;

function rootsFor(manifest: HistoryManifest, userHome: string): { claude: ApprovedRoot; codex: ApprovedRoot } {
  const config = configureRoots(adapters, {}, userHome, { CLAUDE_CONFIG_DIR: manifest.claudeHome, CODEX_HOME: manifest.codexHome });
  const claude = config.get('claude-code')?.roots[0];
  const codex = config.get('codex')?.roots[0];
  if (!claude || !codex) throw new Error('Synthetic roots were rejected.');
  return { claude, codex };
}

function check(checks: Check[], label: string, actual: number, limit: number, unit: string): void {
  checks.push({ label, actual: Math.round(actual * 10) / 10, limit, unit, ok: actual <= limit });
}

/** Samples memory and event-loop delay while a scenario runs. */
class Probe {
  private readonly loop = monitorEventLoopDelay({ resolution: 5 });
  private readonly timer: NodeJS.Timeout;
  peakRss = 0;
  peakHeap = 0;
  readonly startHeap: number;
  private readonly started = performance.now();

  constructor() {
    (globalThis as { gc?: () => void }).gc?.();
    this.startHeap = process.memoryUsage().heapUsed;
    this.loop.enable();
    const sample = () => {
      const usage = process.memoryUsage();
      this.peakRss = Math.max(this.peakRss, usage.rss);
      this.peakHeap = Math.max(this.peakHeap, usage.heapUsed);
    };
    sample();
    this.timer = setInterval(sample, 20);
  }

  stop() {
    clearInterval(this.timer);
    this.loop.disable();
    return {
      ms: performance.now() - this.started,
      maxLoopDelayMs: this.loop.max / 1e6,
      peakHeapMiB: this.peakHeap / mib,
      peakRssMiB: this.peakRss / mib,
    };
  }
}

async function scenario(name: string, run: (checks: Check[], facts: Measurement['facts'], probe: Probe) => Promise<void>): Promise<Measurement> {
  const checks: Check[] = [];
  const facts: Measurement['facts'] = {};
  const probe = new Probe();
  await run(checks, facts, probe);
  const result = probe.stop();
  facts['peak heap MiB'] = Math.round(result.peakHeapMiB);
  facts['peak rss MiB'] = Math.round(result.peakRssMiB);
  facts['max loop delay ms'] = Math.round(result.maxLoopDelayMs * 10) / 10;
  return { name, ms: Math.round(result.ms), facts, checks };
}

async function openModel(roots: ApprovedRoot[], now: number) {
  const store = new SessionStore(undefined, () => now);
  const observers = roots.map(root => {
    const observer: RootObservation = new RootObservation(root, {
      watch: quietWatch, now: () => now,
      onChange: () => store.setCatalog(root.key, root.adapter, observer.catalog),
      onBatch: batch => store.ingest(batch),
    });
    return observer;
  });
  return { store, observers, dispose: () => observers.forEach(observer => observer.dispose()) };
}

const treeOptions = (now: number) => ({ now, privateMode: false, filters: { search: '', adapter: '', project: '', warnings: false }, earlierLimits: new Map<string, number>() });

function countRows(tree: ReturnType<typeof buildTree>['tree']): number {
  let rows = 0;
  const visit = (items: { children?: unknown[] }[]) => { for (const item of items) { rows++; visit((item.children ?? []) as { children?: unknown[] }[]); } };
  for (const project of tree) for (const group of project.groups) visit(group.rows as unknown as { children?: unknown[] }[]);
  return rows;
}

export async function runProfile(options: ProfileOptions): Promise<Measurement[]> {
  const log = options.log ?? (() => undefined);
  const { budgets } = options;
  const now = Date.now();
  const results: Measurement[] = [];
  const base = options.directory;

  log('generating synthetic history');
  const manifest = await writeHistory(join(base, 'history'), options.shape, { now, live: options.liveLanes, locks: true });
  const { claude, codex } = rootsFor(manifest, join(base, 'home'));
  const expectedSessions = manifest.claudeSessions.length + manifest.codexThreads.length;
  log(`  ${manifest.files} files, ${(manifest.bytes / mib).toFixed(1)} MiB, ${manifest.claudeSessions.length} Claude + ${manifest.codexThreads.length} Codex sessions, ${manifest.claudeChildren} child lanes`);

  results.push(await scenario('catalog discovery', async (checks, facts) => {
    const signal = new AbortController().signal;
    for (const pass of ['cold', 'warm'] as const) {
      const started = performance.now();
      const [a, b] = await Promise.all([discoverSources(claude, signal), discoverSources(codex, signal)]);
      const ms = performance.now() - started;
      facts[pass + ' ms'] = Math.round(ms);
      facts['sources'] = a.sources.size + b.sources.size;
      facts['partial'] = String(a.partial || b.partial);
      if (pass === 'warm') check(checks, 'warm discovery of both roots', ms, budgets.discoveryMs, 'ms');
    }
    const expected = manifest.claudeSessions.length + manifest.claudeChildren * 2 + manifest.codexThreads.length + 1;
    facts['expected sources'] = expected;
    check(checks, 'sources missing from the catalog', Math.max(0, expected - Number(facts['sources'])), 0, 'files');
  }));

  results.push(await scenario('first sidebar rows', async (checks, facts) => {
    for (const pass of ['cold', 'warm'] as const) {
      const model = await openModel([claude, codex], now);
      const started = performance.now();
      for (const observer of model.observers) await observer.pollDiscovery();
      const discovered = performance.now();
      for (const observer of model.observers) await observer.pollReaders();
      const read = performance.now();
      const sessions = await model.store.sessions();
      const reduced = performance.now();
      const { tree, total } = buildTree(sessions, treeOptions(now));
      const rows = performance.now();
      model.dispose();
      facts[pass + ' ms'] = Math.round(rows - started);
      if (pass === 'warm') {
        facts['discovery ms'] = Math.round(discovered - started);
        facts['first reads ms'] = Math.round(read - discovered);
        facts['reduce ms'] = Math.round(reduced - read);
        facts['tree ms'] = Math.round(rows - reduced);
        facts['sessions'] = sessions.length;
        facts['tree rows'] = countRows(tree);
        facts['total'] = total;
        check(checks, 'warm start to first rows', rows - started, budgets.firstRowsMs, 'ms');
        check(checks, 'sessions missing from the model', Math.max(0, expectedSessions - sessions.length), 0, 'sessions');
      }
    }
  }));

  results.push(await scenario('live lanes and append', async (checks, facts) => {
    const model = await openModel([claude, codex], now);
    for (const observer of model.observers) await observer.pollDiscovery();
    const cycles: number[] = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      for (const observer of model.observers) await observer.pollReaders();
      await model.store.sessions();
      cycles.push(performance.now() - started);
    }
    facts['live lanes'] = options.liveLanes;
    facts['cycle ms'] = cycles.map(ms => Math.round(ms)).join(' ');
    check(checks, 'slowest read cycle', Math.max(...cycles), budgets.readCycleMs, 'ms');

    const path = manifest.recentClaude[0];
    if (path) {
      const nativeId = basename(path, '.jsonl');
      const before = (await model.store.sessions()).find(session => session.nativeId === nativeId)?.lanes[0]?.rows.length ?? 0;
      const started = performance.now();
      await appendFile(path, claudeTurn({ sessionId: nativeId, index: 500, at: now + 5000, cwd: projectDirectory(0) }).join('\n') + '\n');
      const claudeObserver = model.observers[0]!;
      await claudeObserver.pollDiscovery();
      await claudeObserver.pollReaders();
      const after = (await model.store.sessions()).find(session => session.nativeId === nativeId)?.lanes[0]?.rows.length ?? 0;
      const ms = performance.now() - started;
      facts['rows before/after append'] = before + ' / ' + after;
      check(checks, 'append to visible update (compute path)', ms, budgets.appendMs, 'ms');
      check(checks, 'append not visible', after > before ? 0 : 1, 0, 'misses');
    }
    model.dispose();
  }));

  const historyRoot = join(claude.history, 'X--perf-large');
  await mkdir(historyRoot, { recursive: true });

  if (options.sessionMiB > 0) {
    results.push(await scenario(`${options.sessionMiB} MiB session view model`, async (checks, facts) => {
      const id = claudeSessionId(900_001);
      const path = join(historyRoot, id + '.jsonl');
      const written = await writeLargeClaudeTranscript(path, { sessionId: id, bytes: Math.round(options.sessionMiB * mib), resultBytes: 600 });
      const source = await probeSource(claude, path);
      if (!source) throw new Error('large session was not cataloged');
      const store = new SessionStore(undefined, () => now);
      store.setCatalog(claude.key, claude.adapter, new Map([[source.key, source]]));
      const started = performance.now();
      const listed = (await store.sessions())[0];
      if (!listed) throw new Error('session was not listed');
      const session = await store.materialize(listed.id);
      const materialized = performance.now();
      if (!session) throw new Error('session was not materialized');
      const detail = buildDetail(session, [session], { now, privateMode: false });
      const built = performance.now();
      facts['records'] = written.records;
      facts['timeline rows'] = session.lanes[0]?.rows.length ?? 0;
      facts['detail rows'] = detail.rows.length;
      facts['materialize ms'] = Math.round(materialized - started);
      facts['detail ms'] = Math.round(built - materialized);
      facts['detail JSON KiB'] = Math.round(JSON.stringify(detail).length / 1024);
      check(checks, 'view model build', built - materialized, budgets.detailMs, 'ms');
      check(checks, 'session not materialized', (session.lanes[0]?.rows.length ?? 0) > 0 ? 0 : 1, 0, 'misses');
    }));
  }

  if (options.transcriptMiB > 0) {
    results.push(await scenario(`${options.transcriptMiB} MiB Claude transcript`, async (checks, facts, probe) => {
      const id = claudeSessionId(900_002);
      const path = join(historyRoot, id + '.jsonl');
      const written = await writeLargeClaudeTranscript(path, { sessionId: id, bytes: Math.round(options.transcriptMiB * mib), resultBytes: 2048 });
      const source = await probeSource(claude, path);
      if (!source) throw new Error('large transcript was not cataloged');
      const reader = new SourceReader(claude.adapter, source);
      const started = performance.now();
      let longest = 0;
      let cycles = 0;
      let events = 0;
      for (;;) {
        const t = performance.now();
        const batch = await reader.read(source);
        longest = Math.max(longest, performance.now() - t);
        cycles++;
        events += batch.events.length;
        if (!batch.more) break;
      }
      const read = performance.now() - started;
      facts['file MiB'] = Math.round(written.bytes / mib);
      facts['records'] = written.records;
      facts['events'] = events;
      facts['read cycles'] = cycles;
      facts['read ms'] = Math.round(read);
      facts['MiB/s'] = Math.round(written.bytes / mib / (read / 1000));
      check(checks, 'longest single reader call', longest, budgets.stallMs, 'ms');

      const store = new SessionStore(undefined, () => now);
      store.setCatalog(claude.key, claude.adapter, new Map([[source.key, source]]));
      const materialStarted = performance.now();
      await store.materialize([...(await store.sessions())][0]!.id);
      facts['materialize ms'] = Math.round(performance.now() - materialStarted);
      (globalThis as { gc?: () => void }).gc?.();
      const growth = (process.memoryUsage().heapUsed - probe.startHeap) / mib;
      facts['retained heap growth MiB'] = Math.round(growth);
      check(checks, 'heap growth after materialize', growth, budgets.heapGrowthMiB, 'MiB');
    }));
  }

  if (options.recordMiB > 0) {
    results.push(await scenario(`${options.recordMiB} MiB records`, async (checks, facts, probe) => {
      const bytes = options.recordMiB * mib;
      const id = claudeSessionId(900_003);
      const path = join(historyRoot, id + '.jsonl');
      await writeLargeClaudeTranscript(path, { sessionId: id, bytes: 64 * 1024, hugeRecordBytes: bytes });
      const source = await probeSource(claude, path);
      if (!source) throw new Error('record transcript was not cataloged');
      const started = performance.now();
      const reader = new SourceReader(claude.adapter, source);
      let events = 0;
      let oversized = 0;
      for (;;) {
        const batch = await reader.read(source);
        events += batch.events.length;
        oversized += batch.diagnostics.oversized;
        if (!batch.more) break;
      }
      const ms = performance.now() - started;
      facts['claude record ms'] = Math.round(ms);
      facts['claude events'] = events;
      check(checks, 'Claude record read', ms, budgets.recordMs, 'ms');
      check(checks, 'record discarded as oversized', oversized, 0, 'records');

      const threadId = codexThreadId(900_004);
      const rollout = join(codex.history, '2031', '04', '05', 'rollout-2031-04-05T06-00-00-' + threadId + '.jsonl');
      await mkdir(dirname(rollout), { recursive: true });
      await writeCodexCompaction(rollout, threadId, bytes);
      const codexSource = await probeSource(codex, rollout);
      if (!codexSource) throw new Error('compaction rollout was not cataloged');
      const codexStarted = performance.now();
      const codexReader = new SourceReader(codex.adapter, codexSource);
      let kinds = '';
      for (;;) {
        const batch = await codexReader.read(codexSource);
        kinds += batch.events.filter(event => event.kind === 'compaction').length;
        if (!batch.more) break;
      }
      const codexMs = performance.now() - codexStarted;
      facts['codex compaction ms'] = Math.round(codexMs);
      facts['compaction events'] = kinds.replace(/0/g, '') || '0';
      check(checks, 'Codex compaction read', codexMs, budgets.recordMs, 'ms');

      // A record above the 16 MiB ceiling is discarded, and the next line still parses.
      const big = join(historyRoot, claudeSessionId(900_005) + '.jsonl');
      await writeLargeClaudeTranscript(big, { sessionId: claudeSessionId(900_005), bytes: 4096, oversizedLineBytes: 17 * mib });
      const bigSource = await probeSource(claude, big);
      if (!bigSource) throw new Error('oversized transcript was not cataloged');
      const bigReader = new SourceReader(claude.adapter, bigSource);
      let discarded = 0;
      let after = 0;
      for (;;) {
        const batch = await bigReader.read(bigSource);
        discarded += batch.diagnostics.oversized;
        after += batch.events.length;
        if (!batch.more) break;
      }
      facts['oversized discarded'] = discarded;
      check(checks, 'oversized line not discarded exactly once', Math.abs(discarded - 1), 0, 'lines');
      check(checks, 'events lost after the oversized line', after > 0 ? 0 : 1, 0, 'misses');
      check(checks, 'event-loop delay during record reads', probe.stop().maxLoopDelayMs, budgets.stallMs, 'ms');
    }));
  }

  return results;
}

export function formatReport(results: readonly Measurement[], shapeName: string): string {
  const lines: string[] = [`Agent Lens profile (${shapeName})`, ''];
  for (const result of results) {
    lines.push(`${result.name}  ${result.ms} ms`);
    for (const [key, value] of Object.entries(result.facts)) lines.push(`  ${key}: ${value}`);
    for (const item of result.checks) {
      lines.push(`  [${item.ok ? 'pass' : 'FAIL'}] ${item.label}: ${item.actual} ${item.unit} (limit ${item.limit})`);
    }
    lines.push('');
  }
  const failed = results.flatMap(result => result.checks).filter(item => !item.ok).length;
  lines.push(failed ? `${failed} budget check(s) failed.` : 'All budget checks passed.');
  return lines.join('\n');
}

export { shapes };
export const shapeNames = Object.keys(shapes) as ShapeName[];
