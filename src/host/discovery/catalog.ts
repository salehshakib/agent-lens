import type { BigIntStats, Dirent } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { Source } from '../adapters/types';
import { accessError, inspectLocal, pathKey, within } from './local-path';
import type { Access } from './local-path';
import type { ApprovedRoot } from './roots';

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const sessionFile = new RegExp('^(' + uuid + ')\\.jsonl$', 'i');
const sessionFolder = new RegExp('^' + uuid + '$', 'i');
const childFile = /^agent-([a-z0-9][a-z0-9_-]{0,127})\.(jsonl|meta\.json)$/i;
const rollout = new RegExp('^rollout-[0-9T_-]{1,45}-(' + uuid + ')\\.jsonl$', 'i');
const lockFile = new RegExp('^(' + uuid + ')\\.lock$', 'i');
const presenceFile = /^([1-9][0-9]{0,9})\.json$/;
const slug = /^[\p{L}\p{M}\p{N}_-]{1,255}$/u;
const year = /^\d{4}$/;
const month = /^(?:0[1-9]|1[0-2])$/;
const day = /^(?:0[1-9]|[12]\d|3[01])$/;

type Candidate = Pick<Source, 'sessionId' | 'laneId' | 'kind'>;

function partsWithin(directory: string, path: string): string[] {
  return within(directory, path) ? relative(directory, path).split(sep) : [];
}

function describe(root: ApprovedRoot, path: string): Candidate | undefined {
  const [first = '', second = '', third = '', fourth = '', ...rest] = partsWithin(root.history, path);
  if (root.adapter.id === 'claude-code') {
    if (slug.test(first) && !third && !fourth && rest.length === 0) {
      const sessionId = sessionFile.exec(second)?.[1]?.toLowerCase();
      if (sessionId) return { kind: 'transcript', sessionId, laneId: sessionId };
    }
    const child = childFile.exec(fourth);
    if (slug.test(first) && sessionFolder.test(second) && third === 'subagents' && child?.[1] && rest.length === 0) {
      return { kind: child[2]?.toLowerCase() === 'jsonl' ? 'transcript' : 'agent-metadata',
        sessionId: second.toLowerCase(), laneId: child[1] };
    }
    if (root.profile) {
      const parts = partsWithin(join(root.boundary, 'sessions'), path);
      const pid = parts.length === 1 && presenceFile.exec(parts[0] ?? '')?.[1];
      if (pid) return { kind: 'presence', sessionId: pid, laneId: '' };
    }
  } else {
    if (year.test(first) && month.test(second) && day.test(third) && rest.length === 0) {
      const sessionId = rollout.exec(fourth)?.[1]?.toLowerCase();
      if (sessionId) return { kind: 'transcript', sessionId, laneId: sessionId };
    }
    if (root.profile && pathKey(path) === pathKey(join(root.boundary, 'session_index.jsonl'))) {
      return { kind: 'index', sessionId: '', laneId: '' };
    }
  }
  return undefined;
}

export async function probeSource(root: ApprovedRoot, path: string): Promise<Source | undefined> {
  if (!isAbsolute(path) || !within(root.boundary, path)) return undefined;
  const candidate = describe(root, path);
  if (!candidate) return undefined;
  const info = await inspectLocal(path, 'file');
  return {
    ...candidate,
    key: JSON.stringify([root.key, pathKey(relative(root.boundary, path))]),
    provider: root.adapter.id,
    profileId: root.profile?.id,
    home: root.boundary,
    root: root.history,
    path,
    updatedAt: Number(info.mtimeMs),
  };
}

export function watchDirectories(root: ApprovedRoot): { path: string; recursive: boolean }[] {
  const locations = [{ path: root.history, recursive: true }];
  if (root.profile) {
    locations.push(root.adapter.id === 'claude-code'
      ? { path: join(root.boundary, 'sessions'), recursive: false }
      : { path: root.boundary, recursive: false },
    );
    if (root.adapter.id === 'codex') locations.push({ path: join(root.boundary, 'thread-writer-locks'), recursive: false });
  }
  return locations;
}

export function classifyHint(root: ApprovedRoot, path: string): 'source' | 'scan' | undefined {
  if (describe(root, path)) return 'source';
  const parent = join(root.boundary, 'thread-writer-locks');
  if (root.profile && root.adapter.id === 'codex' && within(parent, path)
      && relative(parent, path) === basename(path) && lockFile.test(basename(path))) return 'scan';
  const [first, second, third, fourth] = partsWithin(root.history, path);
  const directoryHint = first && !fourth && (root.adapter.id === 'claude-code'
    ? slug.test(first) && (!second || (sessionFolder.test(second) && (!third || third === 'subagents')))
    : year.test(first) && (!second || (month.test(second) && (!third || day.test(third)))));
  if (directoryHint || watchDirectories(root).some(directory => pathKey(directory.path) === pathKey(path))) return 'scan';
  return undefined;
}

const probeConcurrency = 24;

export async function discoverSources(root: ApprovedRoot, signal: AbortSignal) {
  const sources = new Map<string, Source>();
  const writers = new Set<string>();
  let state: Access = 'available';
  let partial = false;

  function classify(error: unknown): void {
    const status = accessError(error);
    if (status === 'unavailable') partial = true;
  }

  // Probes run with bounded concurrency; results are inserted in walk order.
  const pending: string[] = [];
  async function add(path: string) {
    pending.push(path);
  }

  async function flush() {
    const paths = pending.splice(0);
    const results: (Source | undefined)[] = new Array(paths.length);
    let next = 0;
    async function worker() {
      while (next < paths.length && !signal.aborted) {
        const index = next++;
        try {
          results[index] = await probeSource(root, paths[index]!);
        } catch (error) {
          classify(error);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(probeConcurrency, paths.length) }, worker));
    for (const source of results) if (source) sources.set(source.key, source);
  }

  async function visit(path: string, onEntry: (entry: Dirent, path: string) => Promise<void>, optional = true) {
    if (signal.aborted) return;
    try {
      await inspectLocal(path, 'directory');
      const dir = await opendir(path);
      for await (const entry of dir) {
        if (signal.aborted) break;
        if (!entry.isSymbolicLink()) await onEntry(entry, join(path, entry.name));
      }
    } catch (error) {
      if (!optional) state = accessError(error);
      classify(error);
    }
  }

  if (root.adapter.id === 'claude-code') {
    await visit(root.history, async (project, projectPath) => {
      if (!project.isDirectory() || !slug.test(project.name)) return;
      await visit(projectPath, async (entry, path) => {
        if (entry.isFile() && sessionFile.test(entry.name)) await add(path);
        if (!entry.isDirectory() || !sessionFolder.test(entry.name)) return;
        await visit(join(path, 'subagents'), async (child, childPath) => {
          if (child.isFile() && childFile.test(child.name)) await add(childPath);
        });
      });
    }, false);
    if (root.profile) {
      await visit(join(root.boundary, 'sessions'), async (entry, path) => {
        if (entry.isFile() && presenceFile.test(entry.name)) await add(path);
      });
    }
  } else {
    await visit(root.history, async (y, yPath) => {
      if (!y.isDirectory() || !year.test(y.name)) return;
      await visit(yPath, async (m, mPath) => {
        if (!m.isDirectory() || !month.test(m.name)) return;
        await visit(mPath, async (d, dPath) => {
          if (!d.isDirectory() || !day.test(d.name)) return;
          await visit(dPath, async (entry, path) => {
            if (entry.isFile() && rollout.test(entry.name)) await add(path);
          });
        });
      });
    }, false);
    if (root.profile) {
      await add(join(root.boundary, 'session_index.jsonl'));
      await visit(join(root.boundary, 'thread-writer-locks'), async (entry, path) => {
        const id = entry.isFile() && lockFile.exec(entry.name)?.[1]?.toLowerCase();
        if (!id) return;
        try {
          const info: BigIntStats = await inspectLocal(path, 'file');
          if (info.size === 0n) writers.add(id);
        } catch (error) {
          classify(error);
        }
      });
      await flush();
      for (const source of sources.values()) {
        if (source.kind === 'transcript') source.writerPresent = writers.has(source.sessionId);
      }
    }
  }
  await flush();
  return { sources, state: state as Access, partial };
}
