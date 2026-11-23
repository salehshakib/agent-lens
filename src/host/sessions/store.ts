import type { Adapter, Event, Source } from '../adapters/types';
import { SourceReader } from '../discovery/reader';
import type { SourceBatch } from '../discovery/reader';
import type { LimitSample } from '../limits/model';
import { UsageLedger } from '../usage/ledger';
import { codexChildren } from './ancestry';
import type { CodexAncestry } from './ancestry';
import { delegationThreadId, resolveDelegations, TaskStartupReader } from './delegation';
import type { ClaudeLaunchCandidate, CodexLaunchCandidate } from './delegation';
import { key as evidenceKey, sourceSessionId } from './evidence';
import type { Kind, SourceEvidence } from './evidence';
import { rowFor } from './items';
import { resolveProject } from './project';
import type { ProjectIdentity } from './project';
import { reduceSession } from './reduce';
import type { ReducedSession } from './reduce';
import { defaultSignalSettings, evaluateChecks } from './signals';
import type { SignalSettings } from './signals';
import type { FileAction, Session } from './types';

type ObservedBatch = SourceBatch & { readerEpoch: number };
type Buffered = Omit<SourceEvidence, 'events'> & {
  events: Map<string, Event>;
  epoch: number;
  generation: number;
  committed: number;
  bytes: number;
  limited: boolean;
  diagnosticsGap: boolean;
};
type CatalogRoot = { adapter: Adapter; sources: ReadonlyMap<string, Source> };

const globalBudget = 32 * 1024 * 1024;
const sourceBudget = 8 * 1024 * 1024;
const lazyCycles = 128;
const projectCacheLimit = 1024;

function eventBytes(event: Event): number {
  const files = 'files' in event ? event.files : undefined;
  return 384 + 2 * ((('text' in event && event.text?.length) || 0) +
    (('command' in event && event.command?.length) || 0) +
    (files?.reduce((size, file) => size + file.path.length + (file.patch?.length ?? 0) +
      (file.before?.length ?? 0) + (file.after?.length ?? 0), 0) ?? 0));
}

function buffer(batch: SourceBatch, epoch: number): Buffered {
  return {
    source: batch.source, events: new Map(), epoch, generation: batch.generation, committed: 0,
    bytes: 0, limited: false, diagnosticsGap: false, partial: false,
  };
}

function append(state: Buffered, batch: SourceBatch): number {
  let bytes = 0;
  for (const event of batch.events) {
    const old = state.events.get(event.id);
    const size = eventBytes(event) - (old ? eventBytes(old) : 0);
    if (state.bytes + bytes + size > sourceBudget) {
      // Retain correlation, counters and file locations when the payload budget fills.
      state.limited = true;
      const summary = summarize(event);
      if (summary) {
        const cost = eventBytes(summary) - (old ? eventBytes(old) : 0);
        if (state.bytes + bytes + cost <= sourceBudget) {
          state.events.set(event.id, summary);
          bytes += cost;
        }
      }
      continue;
    }
    state.events.set(event.id, event);
    bytes += size;
  }
  state.bytes += bytes;
  state.committed = batch.committed;
  state.diagnosticsGap ||= batch.diagnostics.malformed > 0 || batch.diagnostics.oversized > 0;
  state.partial = batch.more || state.limited || state.diagnosticsGap;
  return bytes;
}

function summarize(event: Event): Event | undefined {
  if (event.kind === 'message') {
    return { ...event, text: event.text.slice(0, 160) };
  }
  if (event.kind === 'result' || event.kind === 'call' || event.kind === 'file') {
    const files = event.files?.map(file => ({ ...file, patch: undefined, before: undefined, after: undefined }));
    return event.kind === 'file' ? { ...event, files: files ?? [] }
      : { ...event, files, text: undefined };
  }
  return event;
}

/** Generation-scoped host state. Catalog entries exist before their transcripts are requested. */
export class SessionStore {
  readonly ledger = new UsageLedger();
  private readonly roots = new Map<string, CatalogRoot>();
  private readonly sources = new Map<string, Source>();
  private readonly groups = new Map<string, Set<string>>();
  private readonly observed = new Map<string, Buffered>();
  private readonly projects = new Map<string, ProjectIdentity>();
  private readonly dirty = new Set<string>();
  private readonly models = new Map<string, ReducedSession>();
  private readonly catalogOnly = new Map<string, Session>();
  private readonly taskReader = new TaskStartupReader();
  private sessionCache: Session[] = [];
  private totalBytes = 0;
  private revision = 0;
  private cleanRevision = -1;
  private running?: Promise<readonly Session[]>;
  private evidenceChanged = true;
  private selectedId?: string;
  private historyRequest = 0;
  private nextAgingCheck = 0;

  private settings: SignalSettings = defaultSignalSettings;

  constructor(private readonly taskRoot?: string, private readonly now: () => number = Date.now) {}

  /** Apply new signal settings. Every session is reduced again, since loops, checks and levels depend on them. */
  setSignalSettings(settings: SignalSettings): void {
    this.settings = settings;
    this.evidenceChanged = true;
    this.revision++;
  }

  setCatalog(key: string, adapter: Adapter, sources: ReadonlyMap<string, Source>): void {
    this.roots.set(key, { adapter, sources: new Map(sources) });
    this.updateCatalog();
  }

  clear(): void {
    this.roots.clear();
    this.updateCatalog();
    this.selectedId = undefined;
    this.historyRequest++;
  }

  private updateCatalog(): void {
    const current = new Map<string, Source>();
    for (const root of this.roots.values()) for (const [key, source] of root.sources) current.set(key, source);
    for (const [key, previous] of this.sources) {
      if (current.has(key)) continue;
      this.sources.delete(key);
      this.forget(key);
      this.mark(previous);
    }
    for (const [key, source] of current) {
      const old = this.sources.get(key);
      if (old && source.updatedAt === old.updatedAt && source.writerPresent === old.writerPresent) continue;
      this.sources.set(key, source);
      this.mark(source);
    }
    this.groups.clear();
    for (const source of this.sources.values()) {
      if (source.kind !== 'transcript' && source.kind !== 'agent-metadata') continue;
      const id = sourceSessionId(source);
      const keys = this.groups.get(id) ?? new Set<string>();
      keys.add(source.key);
      this.groups.set(id, keys);
    }
  }

  private mark(source: Source): void {
    if (source.kind === 'transcript' || source.kind === 'agent-metadata') this.dirty.add(sourceSessionId(source));
    else this.evidenceChanged = true;
    this.revision++;
  }

  private forget(key: string): void {
    const data = this.observed.get(key);
    if (!data) return;
    this.totalBytes -= data.bytes;
    this.observed.delete(key);
    this.mark(data.source);
  }

  private trim(): void {
    if (this.totalBytes <= globalBudget) return;
    for (const [key, state] of this.observed) {
      if (sourceSessionId(state.source) === this.selectedId) continue;
      this.forget(key);
      if (this.totalBytes <= globalBudget) return;
    }
    for (const key of this.observed.keys()) {
      this.forget(key);
      if (this.totalBytes <= globalBudget) return;
    }
  }

  ingest(batch: ObservedBatch): void {
    const known = this.sources.get(batch.source.key);
    if (!known) return;
    let state = this.observed.get(batch.source.key);
    if (state && (batch.readerEpoch < state.epoch || (batch.readerEpoch === state.epoch && batch.generation < state.generation))) return;
    if (state && state.epoch === batch.readerEpoch && state.generation === batch.generation && batch.committed < state.committed) return;
    if (!state || (state.epoch !== batch.readerEpoch || state.generation !== batch.generation)) {
      this.forget(batch.source.key);
      state = buffer(batch, batch.readerEpoch);
    }
    this.totalBytes += append(state, batch);
    this.observed.delete(batch.source.key);
    this.observed.set(batch.source.key, state);
    this.mark(known);
    this.trim();
  }

  /** Open historical lane sources on demand with bounded read cycles and the existing allowlisted reader. */
  async materialize(id: string): Promise<Session | undefined> {
    if (!this.groups.has(id)) return undefined;
    this.selectedId = id;
    const request = ++this.historyRequest;
    const remaining = await this.readHistory(id, request, lazyCycles);
    let sessions = await this.sessions();
    if (request !== this.historyRequest) return undefined;
    const model = this.models.get(id);
    if (model?.session.provider === 'claude-code' && remaining > 0) {
      const threadIds = new Set(model.calls.flatMap(call => {
        const threadId = call.ambiguous ? undefined : delegationThreadId(call.event, call.result?.event);
        return threadId ? [threadId] : [];
      }));
      const candidates = new Set<string>();
      for (const source of this.sources.values()) {
        if (source.provider === 'codex' && source.profileId && threadIds.has(source.sessionId)) {
          candidates.add(sourceSessionId(source));
        }
      }
      let budget = remaining;
      for (const candidate of candidates) {
        if (budget <= 0 || request !== this.historyRequest) break;
        budget = await this.readHistory(candidate, request, budget);
      }
      sessions = await this.sessions();
    }
    return request === this.historyRequest ? sessions.find(session => session.id === id) : undefined;
  }

  private async readHistory(id: string, request: number, budget: number): Promise<number> {
    for (const root of this.roots.values()) {
      for (const sourceKey of this.groups.get(id) ?? []) {
        const source = root.sources.get(sourceKey);
        if (!source) continue;
        if (request !== this.historyRequest || budget <= 0) return 0;
        const existing = this.observed.get(sourceKey);
        const committed = existing?.committed;
        if (existing && !existing.partial) continue;
        const reader = new SourceReader(root.adapter, source);
        let state: Buffered | undefined;
        while (budget > 0 && request === this.historyRequest) {
          budget--;
          try {
            const batch = await reader.read(source);
            if (!state || batch.reset) state = buffer(batch, 0);
            append(state, batch);
            if (!batch.more) break;
          } catch {
            if (state) state.partial = true;
            break;
          }
        }
        if (request !== this.historyRequest) return 0;
        // Live observation owns any generation that changed during the on-demand read.
        if (!state || this.sources.get(sourceKey)?.updatedAt !== source.updatedAt ||
            this.observed.get(sourceKey) !== existing || existing?.committed !== committed) continue;
        this.forget(sourceKey);
        this.observed.set(sourceKey, state);
        this.totalBytes += state.bytes;
        this.mark(source);
        this.trim();
      }
    }
    return budget;
  }

  /** Account-window observations recorded by provider limit events, keyed by profile namespace. */
  limitSamples(): LimitSample[] {
    const samples: LimitSample[] = [];
    for (const state of this.observed.values()) {
      const { source } = state;
      if (source.kind !== 'transcript') continue;
      for (const event of state.events.values()) {
        if (event.kind !== 'limits' || event.at === undefined) continue;
        for (const window of event.windows) {
          samples.push({ provider: source.provider, profile: source.profileId ?? source.home, bucket: event.bucket,
            minutes: window.minutes, usedPercent: window.usedPercent, resetsAt: window.resetsAt, at: event.at });
        }
      }
    }
    return samples;
  }

  /** Resolve a lane's catalog transcript source. The path always comes from the approved catalog. */
  transcriptSource(sessionId: string, laneId: string): Source | undefined {
    for (const sourceKey of this.groups.get(sessionId) ?? []) {
      const source = this.sources.get(sourceKey);
      if (source?.kind === 'transcript' && evidenceKey(sessionId, 'lane', source.laneId) === laneId) return source;
    }
    return undefined;
  }

  file(id: string): FileAction | undefined {
    if (this.cleanRevision !== this.revision) return undefined;
    for (const session of this.sessionCache) {
      const file = session.files.find(action => action.id === id);
      if (file) return file;
    }
    return undefined;
  }

  sessions(): Promise<readonly Session[]> {
    const now = this.now();
    if (now >= this.nextAgingCheck) {
      this.nextAgingCheck = now + 3_000;
      for (const model of this.models.values()) {
        if (model.session.status === 'Live' || model.session.status === 'Waiting') {
          this.dirty.add(model.session.id);
          this.revision++;
        }
      }
      if (this.taskRoot && this.models.size > 1) this.revision++;
    }
    if (this.cleanRevision === this.revision) return Promise.resolve(this.sessionCache);
    this.running ??= this.refresh().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async refresh(): Promise<readonly Session[]> {
    const revision = this.revision;
    const updates = new Set(this.dirty);
    const removals = new Set<string>();
    this.dirty.clear();
    const titles = new Map<string, Kind<'metadata'>>();
    const presence = new Map<string, Kind<'metadata'>[]>();
    for (const state of this.observed.values()) {
      if (state.source.kind !== 'presence' && state.source.kind !== 'index') continue;
      for (const event of state.events.values()) {
        if (event.kind !== 'metadata' || !event.threadId) continue;
        const id = sourceSessionId(state.source, event.threadId);
        if (state.source.kind === 'index') {
          const previous = titles.get(id);
          if (!previous || (event.at ?? -1) >= (previous.at ?? -1)) titles.set(id, event);
        } else {
          const markers = presence.get(id) ?? [];
          markers.push(event);
          presence.set(id, markers);
        }
      }
    }
    if (this.evidenceChanged) {
      for (const id of this.groups.keys()) updates.add(id);
      this.evidenceChanged = false;
    }
    for (const id of updates) {
      const keys = this.groups.get(id);
      if (!keys) {
        removals.add(id);
        this.models.delete(id);
        this.catalogOnly.delete(id);
        continue;
      }
      const evidence = [...keys].flatMap(key => {
        const source = this.sources.get(key);
        if (!source) return [];
        const state = this.observed.get(key);
        return [{ source, events: state?.events.values() ?? [], partial: state?.partial ?? true }];
      });
      for (const entry of evidence) {
        const state = this.observed.get(entry.source.key);
        if (!state) continue;
        const cwds = new Set<string>();
        for (const event of state.events.values()) if (event.cwd) cwds.add(event.cwd);
        for (const cwd of cwds) {
          if (!this.projects.has(cwd)) {
            this.projects.set(cwd, await resolveProject(cwd));
            if (this.projects.size > projectCacheLimit) this.projects.delete(this.projects.keys().next().value!);
          }
        }
      }
      const model = reduceSession(evidence, this.now(), cwd => this.projects.get(cwd), titles.get(id)?.title, presence.get(id),
        this.settings);
      if (!model) continue;
      if (evidence.some(entry => this.observed.has(entry.source.key))) {
        this.models.set(id, model);
        this.catalogOnly.delete(id);
      } else {
        this.models.delete(id);
        this.catalogOnly.set(id, model.session);
        removals.add(id);
      }
    }
    const retained = [...this.models.values()];
    const now = this.now();
    const copies = retained.map(model => {
      const session = { ...model.session, parents: [], children: [], signals: [...model.session.signals],
        lanes: model.session.lanes.map(lane => ({ ...lane, signals: [...lane.signals] })) } as Session;
      return { ...model, session, codex: model.codex && { ...model.codex, session } };
    });
    const ancestry = copies.flatMap(model => model.codex ? [model.codex] : []);
    const catalogOnly = [...this.catalogOnly.values()].map(session => ({
      ...session, lanes: session.lanes.map(lane => ({ ...lane })), parents: [], children: [],
    } satisfies Session));
    const known = new Map(copies.map(model => [model.session.id, model]));
    for (const session of catalogOnly) {
      if (session.provider !== 'codex') continue;
      const key = this.groups.get(session.id)?.values().next().value;
      const source = key ? this.sources.get(key) : undefined;
      if (source) ancestry.push({ session, source, spawns: [] });
    }
    codexChildren(ancestry, now);
    await this.joinDelegations(copies, ancestry, known);
    const sessionCache = [...copies.map(model => model.session), ...catalogOnly];
    for (const session of sessionCache) {
      const main = session.lanes[0];
      if (session.lanes.some(lane => lane.status === 'Live') || session.background.some(task => task.status === 'Live')) {
        session.status = 'Live';
      } else if (main) session.status = main.status;
    }
    const sessionById = new Map(sessionCache.map(session => [session.id, session]));
    const active = sessionCache.filter(session => session.status === 'Live');
    while (active.length) {
      const child = active.pop()!;
      const parentIds = new Set(child.parents.map(edge => edge.sessionId));
      const metadataParent = child.lanes[0]?.parentSessionId;
      if (metadataParent) parentIds.add(metadataParent);
      for (const id of parentIds) {
        const parent = sessionById.get(id);
        if (!parent || parent.status === 'Live') continue;
        parent.status = 'Live';
        active.push(parent);
      }
    }
    if (revision !== this.revision) {
      for (const id of removals) this.dirty.add(id);
      return this.refresh();
    }
    for (const id of removals) this.ledger.remove(id);
    const outcomes = evaluateChecks(copies.map(model => ({ session: model.session, evidence: model.evidence })));
    for (const model of copies) {
      const checks = outcomes.signals.get(model.session.id) ?? [];
      const main = model.session.lanes[0];
      if (checks.length && main) {
        main.signals = [...main.signals, ...checks];
        model.session.signals = [...model.session.signals, ...checks];
      }
      this.ledger.replace(model.session, model.tools, [...model.ledgerSignals, ...(outcomes.ledger.get(model.session.id) ?? [])]);
    }
    this.sessionCache = sessionCache.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
    this.cleanRevision = revision;
    return this.sessionCache;
  }

  private async joinDelegations(models: ReducedSession[], ancestry: CodexAncestry[], known: Map<string, ReducedSession>): Promise<void> {
    const launches: ClaudeLaunchCandidate[] = [];
    for (const model of models) {
      if (model.session.provider !== 'claude-code') continue;
      for (const call of model.calls) {
        if (call.event.name !== 'Bash' || call.ambiguous || call.event.restricted) continue;
        const tasks = model.tasks.filter(task => task.laneId === call.laneId || task.event.taskId === call.result?.event.backgroundTaskId);
        if (!call.result && !tasks.some(task => task.event.sourceCallId === call.event.callId)) continue;
        const { session } = model;
        launches.push({ source: call.source, call: call.event, result: call.result?.event, cwd: call.cwd,
          tasks: tasks.map(task => task.event),
          parent: { sessionId: session.id, laneId: call.laneId, rowId: rowFor(call)!.id, turnId: call.turnId,
            at: call.event.at, relation: 'launch' } });
      }
    }
    if (!launches.length) return;
    const rollouts: CodexLaunchCandidate[] = ancestry.flatMap(({ source, session, metadata }) => {
      const lane = session.lanes[0];
      if (!lane || !metadata || metadata.parentConflict) return [];
      const duplicates = [...(this.groups.get(session.id) ?? [])].filter(id => this.sources.get(id)?.kind === 'transcript');
      if (duplicates.length !== 1) return [];
      return [{ source, sessionId: session.id, laneId: lane.id, cwd: metadata.cwd, at: metadata.at,
        origin: metadata.origin, parentThreadId: metadata.parentThreadId, turns: lane.turns }];
    });
    for (const link of await resolveDelegations(launches, rollouts, this.taskRoot, this.now(), this.taskReader)) {
      const child = known.get(link.sessionId)?.session;
      const parent = known.get(link.parent.sessionId)?.session;
      if (!child || !parent || child.parents.some(edge => edge.relation === 'child')) continue;
      (child.launches ??= []).push(link);
      child.parents.push(link.parent);
      parent.children.push({ ...link.parent, sessionId: child.id, laneId: link.laneId, turnId: link.turnId });
    }
    // A resumed Codex thread keeps every launch edge, newest first. The newest one is the lane's resolved parent.
    for (const model of models) {
      const { session } = model;
      if (!session.launches || session.launches.length < 1) continue;
      session.launches.sort((a, b) => (b.parent.at ?? -Infinity) - (a.parent.at ?? -Infinity));
      session.parents = session.launches.map(link => link.parent);
      const main = session.lanes[0];
      if (main) main.parent = session.launches[0]!.parent;
    }
  }
}
