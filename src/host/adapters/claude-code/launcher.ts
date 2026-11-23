import { posix, win32 } from 'node:path';
import { containsSensitivePath, record, safePath } from '../../privacy/projection';
import type { LauncherEvidence } from '../types';

const uuid = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}';
export const threadIdPattern = new RegExp(`^${uuid}$`);
const markerLine = new RegExp(`^AGENT_LENS_CODEX_SESSION=(${uuid})$`);
const nativeSession = new RegExp(`^session id: (${uuid})$`);
const nativeBanner = /^OpenAI Codex v\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?$/;
const requiredFields = ['workdir', 'model', 'provider', 'approval', 'sandbox'];
const allowedFields = new Set([...requiredFields, 'workspace roots', 'reasoning effort', 'reasoning summaries']);
const sgr = /\x1b\[[0-9;]*m/g;
export const launcherPrefix = 64 * 1024;

type KnownEvidence = Extract<LauncherEvidence, { threadId: string }>;

function headerPathKey(path: string): string {
  return /^[a-z]:[\\/]/i.test(path) ? win32.normalize(path).toLowerCase() : posix.normalize(path);
}

export function reconcileStartupEvidence(...samples: (LauncherEvidence | undefined)[]): LauncherEvidence | undefined {
  let result: KnownEvidence | undefined;
  for (const sample of samples) {
    if (!sample) continue;
    if (sample.evidence === 'conflicting' || (result && result.threadId !== sample.threadId) ||
      (result?.cwd && sample.cwd && headerPathKey(result.cwd) !== headerPathKey(sample.cwd))) return { evidence: 'conflicting' };
    const evidence = sample.evidence === 'marker' || result?.evidence === 'marker' ? 'marker'
      : sample.evidence === 'native-header' || result?.evidence === 'native-header' ? 'native-header' : 'thread-started';
    const cwd = result?.cwd ?? sample.cwd;
    result = { evidence, threadId: sample.threadId, ...(cwd === undefined ? {} : { cwd }) };
  }
  return result;
}

function nativeHeader(lines: string[], start: number): KnownEvidence | undefined {
  if (!nativeBanner.test(lines[start] ?? '') || lines[start + 1] !== '--------') return undefined;
  const fields = new Set<string>();
  let cwd: string | undefined;
  for (let index = start + 2; index < start + 12; index++) {
    const line = (lines[index] ?? '').replace(sgr, '');
    const threadId = nativeSession.exec(line)?.[1];
    if (threadId && cwd && lines[index + 1] === '--------' && requiredFields.every(field => fields.has(field))) {
      return { threadId: threadId.toLowerCase(), evidence: 'native-header', cwd };
    }
    const setting = /^([a-z ]+): (\S.*)$/.exec(line);
    const key = setting?.[1];
    if (!key || !allowedFields.has(key) || fields.has(key)) return undefined;
    fields.add(key);
    if (key === 'workdir') cwd = safePath(setting?.[2]);
  }
  return undefined;
}

function jsonStartup(line: string): KnownEvidence | undefined {
  if (!line.startsWith('{') || line.length > 2048) return undefined;
  try {
    const data = record(JSON.parse(line));
    const threadId = data?.thread_id;
    return data?.type === 'thread.started' && typeof threadId === 'string' && threadIdPattern.test(threadId)
      ? { evidence: 'thread-started', threadId: threadId.toLowerCase() } : undefined;
  } catch {
    return undefined;
  }
}

/** Extract only launch identity from a bounded prefix of one recorded output stream. */
export function extractCodexStartupEvidence(value: unknown): LauncherEvidence | undefined {
  if (typeof value !== 'string') return undefined;
  const lines = value.slice(0, launcherPrefix).split(/\r?\n/);
  if (value.length > launcherPrefix && value[launcherPrefix - 1] !== '\n') lines.pop();
  let result: LauncherEvidence | undefined;
  for (const [index, line] of lines.entries()) {
    const threadId = markerLine.exec(line)?.[1];
    const next = threadId ? { evidence: 'marker' as const, threadId: threadId.toLowerCase() }
      : jsonStartup(line) ?? nativeHeader(lines, index);
    result = reconcileStartupEvidence(result, next);
    if (result?.evidence === 'conflicting') return result;
  }
  return result;
}

const taskLayout = new RegExp(`(?:^|/)Temp/claude/([\\p{L}\\p{M}\\p{N}_-]{1,255})/(${uuid})/tasks/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\\.output$`, 'iu');

/** Project a task-file reference from an allowlisted result/notification field. */
export function claudeTaskOutputReference(value: unknown) {
  const path = safePath(value);
  if (!path) return undefined;
  const windows = /^[a-z]:[\\/]/i.test(path);
  if (!windows && (!posix.isAbsolute(path) || path.includes('\\'))) return undefined;
  const slashPath = windows ? path.replaceAll('\\', '/') : path;
  const normalized = windows ? win32.normalize(path).replaceAll('\\', '/') : posix.normalize(path);
  if (normalized !== slashPath || slashPath.startsWith('//') || containsSensitivePath(slashPath)) return undefined;
  const match = taskLayout.exec(slashPath);
  const [, bucket, sessionId, taskId] = match ?? [];
  return bucket && sessionId && taskId ? { path, bucket, sessionId: sessionId.toLowerCase(), taskId } : undefined;
}

export function scheduledTaskReference(value: unknown) {
  const block = Array.isArray(value) && value.length === 1 ? record(value[0]) : undefined;
  const text = block?.type === 'text' ? block.text : value;
  if (typeof text !== 'string' || text.length > 4600) return undefined;
  const line = /^Command running in background with ID: ([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\. Output is being written to:\s+([^\r\n]+)$/.exec(text);
  const recorded = line?.[2];
  const reference = claudeTaskOutputReference(recorded?.endsWith('.output.') ? recorded.slice(0, -1) : recorded);
  return reference && reference.taskId === line?.[1] ? reference : undefined;
}
