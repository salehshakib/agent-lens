import { join, resolve } from 'node:path';
import { adapters } from '../../src/host/adapters/registry';
import type { Event, Source } from '../../src/host/adapters/types';
import type { SourceEvidence } from '../../src/host/sessions/evidence';

export const fixtureRoot = resolve('test', 'fixtures');
export const claudeId = '20000000-0000-4000-8000-000000000001';
export const codexId = '20000000-0000-4000-8000-000000000002';
export const childId = '20000000-0000-4000-8000-000000000003';
export const instant = Date.parse('2031-04-05T06:00:00Z');
export const stamp = (offset: number) => new Date(instant + offset).toISOString();

export function claudeSource(laneId = claudeId, kind: Source['kind'] = 'transcript', bucket = 'example') {
  const home = join(fixtureRoot, 'claude-code');
  const root = join(home, 'projects');
  const suffix = kind === 'agent-metadata' ? '.meta.json' : '.jsonl';
  const path = laneId === claudeId
    ? join(root, bucket, `${claudeId}.jsonl`)
    : join(root, bucket, claudeId, 'subagents', `agent-${laneId}${suffix}`);
  return { key: path, provider: 'claude-code', profileId: 'fixture-claude', kind,
    sessionId: claudeId, laneId, path, home, root, updatedAt: instant } satisfies Source;
}

export function codexSource(sessionId = codexId, profile = 'fixture-codex') {
  const home = join(fixtureRoot, profile);
  const root = join(home, 'sessions');
  const path = join(root, '2031', '04', '05', `rollout-2031-04-05T06-00-00-${sessionId}.jsonl`);
  return { key: path, provider: 'codex', profileId: profile, kind: 'transcript',
    sessionId, laneId: sessionId, path, home, root, updatedAt: instant } satisfies Source;
}

export function fixtureEvents(source: Source, records: unknown[]): Event[] {
  const adapter = adapters.find(adapter => adapter.id === source.provider)!;
  return records.flatMap((record, index) => adapter.parseRecords(record, source, index));
}

export function fixtureEvidence(source: Source, records: unknown[]): SourceEvidence {
  return { source, events: fixtureEvents(source, records), partial: false };
}

export function prompt(uuid: string, text: string, at: number, parentUuid?: string) {
  return { type: 'user', uuid, parentUuid, timestamp: stamp(at), cwd: fixtureRoot, message: { role: 'user', content: text } };
}

export function response(uuid: string, parentUuid: string, at: number, content: unknown, stop_reason = 'tool_use', apiBlockIndex?: number) {
  return { type: 'assistant', uuid, parentUuid, timestamp: stamp(at), apiBlockIndex,
    message: { role: 'assistant', id: `reply-${uuid}`, content, stop_reason, model: 'fixture-model',
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } };
}

export function result(id: string, tool: string, at: number, meta?: unknown, sourceToolAssistantUUID?: string) {
  return { type: 'user', uuid: id, timestamp: stamp(at), sourceToolAssistantUUID, toolUseResult: meta,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, is_error: false, content: 'Fixture result' }] } };
}

export function call(name: string, id: string, input: unknown) {
  return { type: 'tool_use', name, id, input };
}

export function rollout(type: string, at: number, payload: object) {
  return { type, timestamp: stamp(at), payload };
}
