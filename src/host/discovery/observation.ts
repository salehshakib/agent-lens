import { watch } from 'node:fs';
import type { BigIntStats, FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import type { Source } from '../adapters/types';
import { classifyHint, discoverSources, probeSource, watchDirectories } from './catalog';
import { accessError, inspectLocal, pathKey, sameFile, within } from './local-path';
import type { Access } from './local-path';
import { SourceReader } from './reader';
import type { RecordDiagnostics, SourceBatch } from './reader';
import type { ApprovedRoot } from './roots';

const recentMs = 30_000;
const maxReaders = 8;
const maxHints = 256;

type GenerationBatch = SourceBatch & { readerEpoch: number };

export interface RootState {
  state: Access | 'scanning';
  partial: boolean;
  transcripts: number;
  companions: number;
  versions: string[];
  diagnostics: RecordDiagnostics;
}

interface Options {
  watch?: typeof watch;
  now?: () => number;
  onChange?: () => void;
  onBatch?: (batch: GenerationBatch) => void;
}

interface WatchState {
  file?: BigIntStats;
  watcher?: FSWatcher;
  failures: number;
  retryAfter: number;
}

interface ActiveReader {
  cursor: SourceReader;
  epoch: number;
  access: Access;
  committed?: number;
  more?: boolean;
}

export class RootObservation {
  private readonly controller = new AbortController();
  private readonly watches = new Map<string, WatchState>();
  private readonly readers = new Map<string, ActiveReader>();
  private readonly hints = new Set<string>();
  private readonly versions = new Set<string>();
  private readonly diagnostics: RecordDiagnostics = { malformed: 0, oversized: 0, unknown: 0 };
  private sources = new Map<string, Source>();
  private watchedPaths = new Map<string, string>();
  private readonly now: () => number;
  private scanRequested = true;
  private nextScan = 0;
  private readerEpoch = 0;
  private state: RootState['state'] = 'scanning';
  private partial = false;
  private selectedKey?: string;
  private visible = false;
  private discoveryRun?: Promise<void>;
  private readRun?: Promise<void>;
  private discoveryTimer?: NodeJS.Timeout;
  private discoveryDue = 0;
  private readTimer?: NodeJS.Timeout;

  constructor(private readonly root: ApprovedRoot, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
  }

  get catalog(): ReadonlyMap<string, Source> {
    return this.sources;
  }

  get status(): RootState {
    let transcripts = 0;
    let companions = 0;
    for (const source of this.sources.values()) {
      if (source.kind === 'transcript') transcripts++;
      else companions++;
    }
    return {
      state: this.state,
      partial: this.partial || [...this.readers.values()].some(reader => reader.access !== 'available'),
      transcripts,
      companions,
      versions: [...this.versions].sort(),
      diagnostics: { ...this.diagnostics },
    };
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.scheduleDiscovery(0);
    this.scheduleRead(0);
  }

  select(key: string | undefined): void {
    this.selectedKey = key;
    this.scheduleRead(0);
  }

  start(): void {
    this.scheduleDiscovery(0);
    this.scheduleRead(0);
  }

  dispose(): void {
    this.controller.abort();
    clearTimeout(this.discoveryTimer);
    clearTimeout(this.readTimer);
    for (const state of this.watches.values()) state.watcher?.close();
    this.watches.clear();
    this.readers.clear();
  }

  private scheduleDiscovery(delay: number): void {
    if (this.controller.signal.aborted) return;
    const due = Date.now() + delay;
    if (this.discoveryTimer && this.discoveryDue <= due) return;
    this.discoveryDue = due;
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined;
      void this.pollDiscovery().finally(() => {
        if (!this.discoveryTimer) this.scheduleDiscovery(this.visible ? 3_000 : 12_000);
      });
    }, delay);
  }

  private scheduleRead(delay: number): void {
    if (this.controller.signal.aborted) return;
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      void this.pollReaders().finally(() => {
        if (!this.readTimer) this.scheduleRead(this.visible || this.selectedKey ? 750 : 4_000);
      });
    }, delay);
  }

  private onHint(directory: string, filename: string | null): void {
    if (this.controller.signal.aborted) return;
    if (!filename) {
      this.scanRequested = true;
    } else {
      const path = resolve(directory, filename);
      if (!within(directory, path)) return;
      const hint = classifyHint(this.root, path);
      if (!hint) return;
      if (hint === 'source' && this.hints.size < maxHints) this.hints.add(path);
      else this.scanRequested = true;
    }
    // Schedule at most one follow-up for a burst, including hints during enumeration.
    this.scheduleDiscovery(100);
  }

  private async updateWatches(): Promise<void> {
    for (const { path, recursive } of watchDirectories(this.root)) {
      if (this.controller.signal.aborted) return;
      const state = this.watches.get(path) ?? { failures: 0, retryAfter: 0 };
      this.watches.set(path, state);
      if (state.retryAfter > this.now()) continue;
      const failed = () => {
        state.watcher?.close();
        state.watcher = undefined;
        state.failures++;
        state.retryAfter = this.now() + Math.min(60_000, 1_000 * (2 ** Math.min(state.failures, 6)));
        this.scanRequested = true;
      };
      try {
        const file = await inspectLocal(path, 'directory');
        if (this.controller.signal.aborted) return;
        if (state.watcher && state.file && sameFile(state.file, file)) continue;
        state.watcher?.close();
        const watcher = (this.options.watch ?? watch)(path, { recursive, persistent: false },
          (_event, filename) => this.onHint(path, filename));
        state.watcher = watcher;
        state.file = file;
        watcher.on('error', () => {
          if (state.watcher !== watcher) return;
          failed();
          this.scheduleDiscovery(100);
        });
        // A successful directory stat and watch subscription starts a new read.
        this.scanRequested = true;
      } catch {
        failed();
      }
    }
  }

  pollDiscovery(): Promise<void> {
    this.discoveryRun ??= this.reconcile().finally(() => { this.discoveryRun = undefined; });
    return this.discoveryRun;
  }

  private async reconcile(): Promise<void> {
    if (this.controller.signal.aborted) return;
    await this.updateWatches();
    if (this.scanRequested || this.nextScan <= this.now()) {
      this.scanRequested = false;
      const result = await discoverSources(this.root, this.controller.signal);
      if (this.controller.signal.aborted) return;
      this.state = result.state;
      this.partial = result.partial;
      this.sources = result.partial ? new Map([...this.sources, ...result.sources]) : result.sources;
      this.watchedPaths = new Map([...this.sources.values()].map(source => [pathKey(source.path), source.key]));
      const large = this.sources.size > 300;
      this.nextScan = this.now() + (result.state !== 'available' || !large
        ? (this.visible ? 3_000 : 12_000)
        : (this.visible ? 30_000 : 60_000));
    }
    const hints = [...this.hints];
    this.hints.clear();
    for (const path of hints) {
      if (this.controller.signal.aborted) return;
      const key = this.watchedPaths.get(pathKey(path));
      try {
        const source = await probeSource(this.root, path);
        if (!source) continue;
        if (key) source.writerPresent = this.sources.get(key)?.writerPresent;
        this.watchedPaths.set(pathKey(path), source.key);
        this.sources.set(source.key, source);
      } catch (error) {
        if (accessError(error) === 'unavailable') this.partial = true;
        else if (key) {
          this.sources.delete(key);
          this.watchedPaths.delete(pathKey(path));
          this.readers.delete(key);
        }
      }
    }
    if (!this.controller.signal.aborted) this.options.onChange?.();
    if (this.hints.size || this.scanRequested) this.scheduleDiscovery(100);
  }

  pollReaders(): Promise<void> {
    this.readRun ??= this.readRecent().finally(() => { this.readRun = undefined; });
    return this.readRun;
  }

  private async readRecent(): Promise<void> {
    if (this.controller.signal.aborted) return;
    const now = this.now();
    const priority = [...this.sources.values()].filter(source => source.key === this.selectedKey
      || source.kind === 'index' || source.writerPresent || now - source.updatedAt <= recentMs);
    priority.sort((a, b) => Number(b.key === this.selectedKey) - Number(a.key === this.selectedKey)
      || Number(b.kind === 'index') - Number(a.kind === 'index')
      || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    const chosen = new Set(priority.slice(0, maxReaders).map(source => source.key));
    for (const key of this.readers.keys()) {
      if (!chosen.has(key)) this.readers.delete(key);
    }
    let changed = false;
    for (const original of priority.slice(0, maxReaders)) {
      if (this.controller.signal.aborted) break;
      const source = this.sources.get(original.key);
      if (!source) continue;
      let active = this.readers.get(source.key);
      if (!active) {
        active = { cursor: new SourceReader(this.root.adapter, source), access: 'available', epoch: ++this.readerEpoch };
        this.readers.set(source.key, active);
      }
      try {
        const batch = await active.cursor.read(source);
        if (this.controller.signal.aborted || this.readers.get(source.key) !== active) continue;
        changed ||= active.access !== 'available' || batch.reset;
        active.access = 'available';
        for (const event of batch.events) {
          if (this.versions.size < 16 && event.kind === 'metadata' && event.version && /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]{1,32})?$/i.test(event.version)) {
            changed ||= !this.versions.has(event.version);
            this.versions.add(event.version);
          }
        }
        for (const kind of ['malformed', 'oversized', 'unknown'] as const) {
          changed ||= batch.diagnostics[kind] > 0;
          this.diagnostics[kind] = Math.min(999_999, this.diagnostics[kind] + batch.diagnostics[kind]);
        }
        if (batch.reset || batch.committed !== active.committed || batch.more !== active.more) {
          active.committed = batch.committed;
          active.more = batch.more;
          this.options.onBatch?.({ ...batch, readerEpoch: active.epoch });
        }
      } catch (error) {
        const access = accessError(error);
        changed ||= active.access !== access;
        active.access = access;
      }
    }
    if (changed && !this.controller.signal.aborted) this.options.onChange?.();
  }
}
