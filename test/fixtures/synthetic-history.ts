import { mkdir, open, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Deterministic synthetic provider histories for profiling and discovery checks.
 * Everything here is invented: identifiers, paths, prompts and tool output. The generator writes only inside
 * the directory it is given and never reads provider data.
 */

export const anchor = Date.parse('2031-04-05T06:00:00Z');
const minute = 60_000;

export interface HistoryShape {
  claudeProjects: number;
  claudeSessionsPerProject: number;
  turnsPerSession: number;
  /** One in N Claude sessions delegates to subagents. */
  spawnEvery: number;
  childrenPerSpawningSession: number;
  childTurns: number;
  codexDays: number;
  codexPerDay: number;
  codexTurns: number;
}

/** `reference` follows the plan's reference machine: 1,800-plus child files beside a deep project list. */
export const shapes = {
  smoke: {
    claudeProjects: 3, claudeSessionsPerProject: 4, turnsPerSession: 4, spawnEvery: 3,
    childrenPerSpawningSession: 3, childTurns: 2, codexDays: 2, codexPerDay: 3, codexTurns: 3,
  },
  default: {
    claudeProjects: 12, claudeSessionsPerProject: 20, turnsPerSession: 8, spawnEvery: 3,
    childrenPerSpawningSession: 8, childTurns: 3, codexDays: 14, codexPerDay: 10, codexTurns: 6,
  },
  reference: {
    claudeProjects: 40, claudeSessionsPerProject: 25, turnsPerSession: 10, spawnEvery: 3,
    childrenPerSpawningSession: 6, childTurns: 3, codexDays: 30, codexPerDay: 10, codexTurns: 8,
  },
} as const satisfies Record<string, HistoryShape>;

export type ShapeName = keyof typeof shapes;

export function syntheticId(kind: number, n: number): string {
  return kind.toString(16).padStart(8, '0') + '-0000-4000-8000-' + n.toString(16).padStart(12, '0');
}

const claudeKind = 0x50000000;
const codexKind = 0x51000000;
export const claudeSessionId = (n: number) => syntheticId(claudeKind, n);
export const codexThreadId = (n: number) => syntheticId(codexKind, n);

export const projectDirectory = (n: number) => 'X:\\perf-fixtures\\project-' + n;
const slugFor = (n: number) => 'X--perf-fixtures-project-' + n;

const words = ['renderer', 'ledger', 'catalog', 'timeline', 'gauge', 'probe', 'window', 'sample', 'shard', 'index'];
const sentence = (n: number) => `Synthetic note ${n}: inspect the ${words[n % words.length]} module and report the ${words[(n + 3) % words.length]} state.`;

/** A paragraph of `bytes` characters of invented text. Content is ASCII so size equals length. */
export function filler(bytes: number, seed = 0): string {
  let text = '';
  for (let i = seed; text.length < bytes; i++) text += sentence(i) + ' ';
  return text.slice(0, bytes);
}

const iso = (at: number) => new Date(at).toISOString();

export interface ClaudeTurnOptions {
  sessionId: string;
  laneId?: string;
  index: number;
  at: number;
  cwd: string;
  /** Bytes of invented text carried by the tool result. */
  resultBytes?: number;
  spawn?: { callId: string };
}

/** One Claude turn as JSONL lines: prompt, assistant tool call, tool result and a closing answer. */
export function claudeTurn(options: ClaudeTurnOptions): string[] {
  const { sessionId, index, at, cwd } = options;
  const tag = sessionId.slice(0, 8) + (options.laneId ? '-' + options.laneId : '') + '-t' + index;
  const owner = options.laneId ? { agentId: options.laneId } : {};
  const usage = { input_tokens: 400 + index, output_tokens: 90 + (index % 7), cache_read_input_tokens: 1200 + index * 3, cache_creation_input_tokens: index % 4 === 0 ? 300 : 0 };
  const callId = options.spawn?.callId ?? 'call-' + tag;
  const tool = options.spawn
    ? { type: 'tool_use', name: 'Task', id: callId, input: { description: 'Synthetic subtask ' + index, subagent_type: 'reviewer', prompt: sentence(index), run_in_background: 'false' } }
    : { type: 'tool_use', name: index % 3 === 0 ? 'Bash' : 'Read', id: callId,
      input: index % 3 === 0 ? { command: 'echo synthetic-' + index, description: 'Run a synthetic check' } : { file_path: 'src\\module-' + (index % 17) + '.ts' } };
  const records = [
    { type: 'user', uuid: tag + '-prompt', parentUuid: index ? sessionId.slice(0, 8) + '-t' + (index - 1) + '-end' : undefined, sessionId, ...owner, timestamp: iso(at), cwd, version: '2.1.330',
      message: { role: 'user', content: sentence(index) } },
    { type: 'assistant', uuid: tag + '-tools', parentUuid: tag + '-prompt', sessionId, ...owner, timestamp: iso(at + 1000), cwd, perTurnEffort: 'medium',
      message: { role: 'assistant', id: 'reply-' + tag + '-a', model: 'synthetic-model', content: [{ type: 'text', text: sentence(index + 1) }, tool], stop_reason: 'tool_use', usage } },
    { type: 'user', uuid: tag + '-result', sessionId, ...owner, timestamp: iso(at + 2000), sourceToolAssistantUUID: tag + '-tools',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: false, content: filler(options.resultBytes ?? 160, index) }] } },
    { type: 'assistant', uuid: tag + '-end', parentUuid: tag + '-result', sessionId, ...owner, timestamp: iso(at + 3000), cwd,
      message: { role: 'assistant', id: 'reply-' + tag + '-b', model: 'synthetic-model', content: [{ type: 'text', text: sentence(index + 2) }], stop_reason: 'end_turn', usage } },
  ];
  return records.map(record => JSON.stringify(record));
}

export const claudeTranscript = (sessionId: string, turns: number, start: number, cwd: string, extra?: (index: number) => Partial<ClaudeTurnOptions>) =>
  Array.from({ length: turns }, (_, index) => claudeTurn({ sessionId, index, at: start + index * 8_000, cwd, ...extra?.(index) }).join('\n')).join('\n') + '\n';

export function childMeta(callId: string): string {
  return JSON.stringify({ agentType: 'reviewer', description: 'Synthetic subtask', toolUseId: callId, spawnDepth: 1, model: 'synthetic-model', effort: 'medium', finished: true });
}

export interface CodexTurnOptions {
  threadId: string;
  index: number;
  at: number;
  cwd: string;
}

/** A Codex rollout body: meta, context, then per turn a started marker, a command, a reply, usage and completion. */
export function codexRollout(threadId: string, turns: number, start: number, cwd: string): string {
  const lines: unknown[] = [
    { timestamp: iso(start), type: 'session_meta', payload: { id: threadId, cwd, cli_version: '0.170.0', source: 'exec' } },
  ];
  for (let index = 0; index < turns; index++) {
    const at = start + 1000 + index * 9_000;
    const turn = 'turn-' + threadId.slice(-6) + '-' + index;
    lines.push(
      { timestamp: iso(at), type: 'turn_context', payload: { turn_id: turn, cwd, model: 'synthetic-model', effort: 'high' } },
      { timestamp: iso(at + 100), type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: 200_000 } },
      { timestamp: iso(at + 200), type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, turn_id: turn, item: { type: 'UserMessage', id: 'user-' + turn, content: [{ type: 'text', text: sentence(index) }] } } },
      { timestamp: iso(at + 2000), type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type: 'CommandExecution', id: 'cmd-' + turn, command: ['echo', 'synthetic-' + index], cwd, exit_code: 0, status: 'completed', stdout: filler(120, index) } } },
      { timestamp: iso(at + 3000), type: 'event_msg', payload: { type: 'token_count', turn_id: turn, info: { total_token_usage: { input_tokens: 900 * (index + 1), total_tokens: 1000 * (index + 1) }, last_token_usage: { input_tokens: 900, output_tokens: 100 }, model_context_window: 200_000 } } },
      { timestamp: iso(at + 4000), type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type: 'AgentMessage', id: 'final-' + turn, phase: 'final_answer', content: [{ type: 'text', text: sentence(index + 4) }] } } },
      { timestamp: iso(at + 5000), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, duration_ms: 5000 } },
    );
  }
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

async function put(path: string, text: string, modified?: number): Promise<void> {
  await writeFile(path, text);
  if (modified !== undefined) await utimes(path, modified / 1000, modified / 1000);
}

export interface HistoryManifest {
  claudeHome: string;
  codexHome: string;
  claudeSessions: string[];
  claudeChildren: number;
  codexThreads: string[];
  files: number;
  bytes: number;
  /** Paths of the newest main transcripts, newest first. */
  recentClaude: string[];
  recentCodex: string[];
}

export interface WriteOptions {
  now?: number;
  /** Newest N sessions per provider get a modification time of `now`, as a live writer would. */
  live?: number;
  /** Create a thread-writer lock beside each live Codex rollout. */
  locks?: boolean;
}

/** Write a synthetic Claude home and Codex home under `base`. Returns what was written. */
export async function writeHistory(base: string, shape: HistoryShape, options: WriteOptions = {}): Promise<HistoryManifest> {
  const now = options.now ?? Date.now();
  const live = options.live ?? 0;
  const claudeHome = join(base, 'claude-home');
  const codexHome = join(base, 'codex-home');
  const manifest: HistoryManifest = { claudeHome, codexHome, claudeSessions: [], claudeChildren: 0, codexThreads: [], files: 0, bytes: 0, recentClaude: [], recentCodex: [] };
  const write = async (path: string, text: string, modified?: number) => {
    await put(path, text, modified);
    manifest.files++;
    manifest.bytes += Buffer.byteLength(text);
  };

  let ordinal = 0;
  const claude: { path: string; modified: number }[] = [];
  for (let project = 0; project < shape.claudeProjects; project++) {
    const cwd = projectDirectory(project);
    const directory = join(claudeHome, 'projects', slugFor(project));
    await mkdir(directory, { recursive: true });
    for (let n = 0; n < shape.claudeSessionsPerProject; n++, ordinal++) {
      const sessionId = claudeSessionId(ordinal + 1);
      const start = now - (ordinal + 1) * 25 * minute - shape.turnsPerSession * 8_000;
      const modified = ordinal < live ? now : start + shape.turnsPerSession * 8_000;
      const spawning = ordinal % shape.spawnEvery === 0 && shape.childrenPerSpawningSession > 0;
      const spawns = spawning ? Array.from({ length: shape.childrenPerSpawningSession }, (_, i) => 'spawn-' + ordinal + '-' + i) : [];
      const body = claudeTranscript(sessionId, shape.turnsPerSession, start, cwd, index => {
        const callId = spawns[index];
        return callId ? { spawn: { callId } } : {};
      });
      const path = join(directory, sessionId + '.jsonl');
      await write(path, body, modified);
      manifest.claudeSessions.push(path);
      claude.push({ path, modified });
      if (spawning) {
        const children = join(directory, sessionId, 'subagents');
        await mkdir(children, { recursive: true });
        for (const [i, callId] of spawns.entries()) {
          const laneId = 'child-' + ordinal + '-' + i;
          await write(join(children, 'agent-' + laneId + '.jsonl'), claudeTranscript(sessionId, shape.childTurns, start + i * 8_000, cwd, () => ({ laneId })), modified);
          await write(join(children, 'agent-' + laneId + '.meta.json'), childMeta(callId), modified);
          manifest.claudeChildren++;
        }
      }
    }
  }

  let thread = 0;
  const codex: { path: string; modified: number; id: string }[] = [];
  for (let day = 0; day < shape.codexDays; day++) {
    const date = new Date(now - day * 86_400_000);
    const folder = join(codexHome, 'sessions', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0'));
    await mkdir(folder, { recursive: true });
    for (let n = 0; n < shape.codexPerDay; n++, thread++) {
      const id = codexThreadId(thread + 1);
      const start = now - day * 86_400_000 - (n + 1) * 40 * minute;
      const modified = thread < live ? now : start + shape.codexTurns * 9_000;
      const stamp = iso(start).slice(0, 19).replace(/:/g, '-');
      const path = join(folder, 'rollout-' + stamp + '-' + id + '.jsonl');
      await write(path, codexRollout(id, shape.codexTurns, start, projectDirectory(thread % Math.max(1, shape.claudeProjects))), modified);
      manifest.codexThreads.push(id);
      codex.push({ path, modified, id });
    }
  }
  if (codex.length) {
    const index = codex.map((entry, i) => JSON.stringify({ id: entry.id, thread_name: 'Synthetic thread ' + i, updated_at: iso(entry.modified) })).join('\n') + '\n';
    await write(join(codexHome, 'session_index.jsonl'), index);
    if (options.locks) {
      await mkdir(join(codexHome, 'thread-writer-locks'), { recursive: true });
      for (const entry of codex.slice(0, live)) await write(join(codexHome, 'thread-writer-locks', entry.id + '.lock'), '');
    }
  }
  const newest = (items: { path: string; modified: number }[]) => [...items].sort((a, b) => b.modified - a.modified).map(item => item.path);
  manifest.recentClaude = newest(claude);
  manifest.recentCodex = newest(codex);
  return manifest;
}

export interface LargeTranscriptOptions {
  sessionId: string;
  bytes: number;
  cwd?: string;
  start?: number;
  /** Size of the tool result text in each turn. Larger values mean fewer, heavier records. */
  resultBytes?: number;
  /** Append one extra record whose tool result carries this many bytes of text. */
  hugeRecordBytes?: number;
  /** Append a line of this many bytes with no structure, which the reader must discard. */
  oversizedLineBytes?: number;
}

/** Stream a long Claude transcript of roughly `bytes` to `path` without holding it in memory. */
export async function writeLargeClaudeTranscript(path: string, options: LargeTranscriptOptions): Promise<{ bytes: number; records: number }> {
  const cwd = options.cwd ?? projectDirectory(0);
  const start = options.start ?? anchor;
  const handle = await open(path, 'w');
  let bytes = 0;
  let records = 0;
  const emit = async (text: string) => {
    await handle.write(text);
    bytes += Buffer.byteLength(text);
    records += text.split('\n').length - 1;
  };
  try {
    let batch = '';
    for (let index = 0; bytes + batch.length < options.bytes; index++) {
      batch += claudeTurn({ sessionId: options.sessionId, index, at: start + index * 8_000, cwd, resultBytes: options.resultBytes }).join('\n') + '\n';
      if (batch.length >= 1 << 20) {
        await emit(batch);
        batch = '';
      }
    }
    if (batch) await emit(batch);
    if (options.hugeRecordBytes) {
      const tail = claudeTurn({ sessionId: options.sessionId, index: 9_999_990, at: start + 9_999_990 * 8_000, cwd, resultBytes: options.hugeRecordBytes });
      await emit(tail.join('\n') + '\n');
    }
    if (options.oversizedLineBytes) {
      await emit('{"type":"user","padding":"' + 'x'.repeat(options.oversizedLineBytes) + '"}\n');
      await emit(claudeTurn({ sessionId: options.sessionId, index: 9_999_991, at: start + 9_999_991 * 8_000, cwd }).join('\n') + '\n');
    }
  } finally {
    await handle.close();
  }
  return { bytes, records };
}

/** A Codex rollout whose `compacted` record embeds `bytes` of replaced history, which the reader must drop. */
export async function writeCodexCompaction(path: string, threadId: string, bytes: number, cwd = projectDirectory(0)): Promise<void> {
  const head = codexRollout(threadId, 2, anchor, cwd);
  const compacted = JSON.stringify({ timestamp: iso(anchor + 60_000), type: 'compacted', payload: { replacement_history: 'h'.repeat(bytes) } });
  await writeFile(path, head + compacted + '\n');
}
