import { deepEqual, equal, fail, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { adapters } from '../src/host/adapters/registry';
import { ClaudeChatStream } from '../src/host/adapters/claude-code/stream';
import { recordedTurnId, reconcileRows, reconcileTurnUsage } from '../src/host/chat/reconcile';
import type { ProvisionalRow } from '../src/host/chat/reconcile';
import type { ChatEvent, ChatLaunch } from '../src/host/chat/types';
import { identityKey } from '../src/host/sessions/evidence';
import { reduceSession } from '../src/host/sessions/reduce';
import { SessionStore } from '../src/host/sessions/store';
import type { Session } from '../src/host/sessions/types';
import { buildDetail } from '../src/host/views/models';
import { call, claudeSource, fixtureEvents, fixtureEvidence, fixtureRoot, instant, prompt, response, result, stamp } from './fixtures/session';

function recorded() {
  const records = [
    prompt('user-1', 'Fix it', 0),
    response('a1', 'user-1', 10, [call('Bash', 'call-1', { command: 'ls' })]),
    response('a2', 'a1', 20, 'Done', 'end_turn'),
  ];
  const session = reduceSession([fixtureEvidence(claudeSource(), records)], instant + 40)!.session;
  return buildDetail(session, [session], { now: instant + 50, privateMode: false }).rows;
}

const live: ProvisionalRow[] = [
  { id: 'l-user', identity: { kind: 'user', id: 'user-1' } },
  { id: 'l-text', identity: { kind: 'response', id: 'reply-a2', record: 'a2', block: 0 } },
  { id: 'l-call', identity: { kind: 'call', id: 'call-1' } },
  { id: 'l-new', identity: { kind: 'response', id: 'reply-unseen' } },
  { id: 'l-notice' },
];

test('stream rows resolve to recorded rows by exact provider identity and drop once', () => {
  const rows = recorded();
  const out = reconcileRows(rows.map(row => ({ id: row.id, keys: row.nativeKeys })), live, true);
  deepEqual([...out.resolved.keys()].sort(), ['l-call', 'l-text', 'l-user']);
  deepEqual(out.live.map(row => row.id), ['l-new', 'l-notice']);
  const again = reconcileRows(rows.map(row => ({ id: row.id, keys: row.nativeKeys })), out.live, true);
  equal(again.resolved.size, 0);
});

test('unverified scope merges nothing and unresolved identities stay explicit', () => {
  const rows = recorded();
  const out = reconcileRows(rows.map(row => ({ id: row.id, keys: row.nativeKeys })), live, false);
  equal(out.live.length, live.length);
  equal(out.resolved.size, 0);
  equal(out.unresolved.length, live.length);
  const verified = reconcileRows([], live, true);
  deepEqual(verified.unresolved.map(row => row.id), ['l-new', 'l-notice']);
});

test('replay or rewrite of the same recorded rows does not change the result', () => {
  const rows = recorded().map(row => ({ id: row.id, keys: row.nativeKeys }));
  const first = reconcileRows(rows, live, true);
  const second = reconcileRows([...rows, ...rows], live, true);
  deepEqual([...second.resolved], [...first.resolved]);
  deepEqual(second.live, first.live);
});

test('a repeated block identity without a unique record stays visible', () => {
  const identity = { kind: 'response', id: 'reply', block: 5 } as const;
  const record = { ...identity, record: 'assistant-2' };
  const rows = [
    { id: 'one', keys: [identityKey(identity)!] },
    { id: 'two', keys: [identityKey(identity)!, identityKey(record)!] },
  ];
  const unproved = reconcileRows(rows, [{ id: 'unproved', identity }], true);
  deepEqual(unproved.unresolved.map(row => row.id), ['unproved']);
  deepEqual(unproved.live, unproved.unresolved);
  const exact = reconcileRows(rows, [{ id: 'exact', identity, aliases: [record] }], true);
  deepEqual([...exact.resolved], [['exact', 'two']]);
});

const inputId = '20000000-0000-4000-8000-000000000011';
const frameId = (number: number) => '20000000-0000-4000-8000-' + String(number).padStart(12, '0');
const source = claudeSource();
const launch: ChatLaunch = { owner: 'fixture', resume: false, identity: { provider: source.provider,
  profile: source.profileId, home: source.home, cwd: fixtureRoot, nativeId: source.sessionId } };
const sharedAssistantId = frameId(20);
const tool = call('Bash', 'tool-example', { command: 'echo fixture' });
const orphanedCallId = 'tool-orphan';
const textBlock = (text: string) => ({ type: 'text', text });

function assistant(index: number, at: number, block: object, stopReason = 'tool_use') {
  const row = response(sharedAssistantId, inputId, at, [block], stopReason, index);
  return { ...row, message: { ...row.message, id: 'reply-blocks' } };
}

const user = prompt(inputId, 'Run the fixture', 0);
const first = assistant(0, 10, textBlock('First block'));
const callRecord = assistant(1, 11, tool);
const resultRecord = result(frameId(21), tool.id, 13);
const orphanedResult = result(frameId(25), orphanedCallId, 14);
const taskRecord = { type: 'attachment', uuid: frameId(22), parentUuid: inputId, timestamp: stamp(15),
  attachment: { type: 'task_status', taskId: 'fixture-task', status: 'completed' } };
const second = assistant(2, 16, textBlock('Second block'), 'end_turn');

function stdout(): ChatEvent[] {
  const events: ChatEvent[] = [];
  const stream = new ClaudeChatStream(launch, event => events.push(event), fail, '2.1.330');
  const push = (row: object) => stream.read(JSON.stringify({ session_id: source.sessionId, ...row }));
  stream.begin(inputId);
  push({ type: 'system', subtype: 'init', cwd: fixtureRoot });
  push({ ...user, isReplay: true });
  push({ ...user, isReplay: true });
  push({ type: 'stream_event', uuid: frameId(30), event: { type: 'message_start', message: { role: 'assistant', id: 'reply-blocks' } } });
  push({ type: 'stream_event', uuid: frameId(31), event: { type: 'content_block_start', index: 0, content_block: textBlock('') } });
  const delta = { type: 'stream_event', uuid: frameId(32), event: {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First block' },
  } };
  push(delta);
  push(delta);
  push(first);
  push(resultRecord);
  push(callRecord);
  push(callRecord);
  push(orphanedResult);
  push(second);
  const terminal = { type: 'result', uuid: frameId(35), subtype: 'success', user_message_uuid: inputId,
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } };
  push(terminal);
  push(terminal);
  return events;
}

function provisionalRows(events: readonly ChatEvent[]): ProvisionalRow[] {
  const rows = new Map<string, ProvisionalRow>();
  for (const event of events) {
    if (event.kind === 'ack') rows.set(event.messageId, { id: event.messageId, identity: { kind: 'user', id: event.messageId } });
    if (event.kind === 'text') rows.set(event.blockId, { id: event.blockId, identity: event.rowIdentity, aliases: event.aliases });
    if (event.kind === 'tool') rows.set(event.callId, { id: event.callId, identity: { kind: 'call', id: event.callId } });
    if (event.kind === 'toolResult') {
      const id = 'result:' + event.callId;
      rows.set(id, { id, identity: { kind: 'result', id: event.callId } });
    }
  }
  return [...rows.values()];
}

function mainRows(session: Session) {
  return session.lanes[0]!.rows.map(row => ({ id: row.id, keys: row.nativeKeys }));
}

test('stdout, replay, append and rewrites reconcile exact blocks, results and turn usage', async () => {
  const events = stdout();
  equal(events.filter(event => event.kind === 'ack').length, 1);
  const resultEvents = events.filter(event => event.kind === 'toolResult');
  equal(resultEvents.length, 2);
  equal(resultEvents[0]?.output, 'Fixture result');
  equal(resultEvents[1]?.callId, orphanedCallId);
  equal(resultEvents[1]?.unpaired, true);
  equal(resultEvents[1]?.output, undefined);
  const text = events.filter(event => event.kind === 'text');
  deepEqual(text.filter(event => event.text).map(event => event.text), ['First block', 'Second block']);
  equal(new Set(text.map(event => event.blockId)).size, 2);
  const metrics = events.flatMap(event => event.kind === 'result' && event.usage ? [{ id: event.turnId, tokens: event.usage }] : []);
  equal(metrics.length, 1);
  const liveRows = provisionalRows(events);
  deepEqual(liveRows.map(row => row.identity?.kind), ['user', 'response', 'call', 'result', 'response', 'result']);

  const store = new SessionStore(undefined, () => instant + 500);
  store.setCatalog('fixture', adapters.find(adapter => adapter.id === source.provider)!, new Map([[source.key, source]]));
  function ingest(records: unknown[], generation: number, committed: number, reset = false) {
    store.ingest({ source, readerEpoch: 1, generation, committed, more: false, reset,
      events: fixtureEvents(source, records), diagnostics: { malformed: 0, oversized: 0, unknown: 0 } });
  }
  ingest([user, first, callRecord], 0, 300);
  const incomplete = (await store.sessions())[0]!;
  const lane = incomplete.lanes[0]!;
  const partial = reconcileRows(mainRows(incomplete), liveRows, true);
  deepEqual(partial.live.map(row => row.identity?.kind), ['result', 'response', 'result']);
  const measured = reconcileTurnUsage(lane.turns, lane.id, [...metrics, ...metrics]);
  equal(measured.live.length, 1);
  deepEqual([...measured.replacedTurnIds], [recordedTurnId(lane.id, inputId)]);

  ingest([resultRecord, orphanedResult, taskRecord, second, taskRecord], 0, 600);
  const appended = (await store.sessions())[0]!;
  const complete = reconcileRows(mainRows(appended), liveRows, true);
  equal(complete.live.length, 0);
  equal(complete.resolved.get(tool.id), complete.resolved.get('result:' + tool.id));
  equal(new Set(text.map(event => complete.resolved.get(event.blockId))).size, 2);
  const currentLane = appended.lanes[0]!;
  equal(currentLane.turns.length, 1);
  equal(currentLane.turns[0]?.usage?.output, 4);
  equal(appended.usageObservations.length, 1);
  equal(reconcileTurnUsage(currentLane.turns, lane.id, metrics).live.length, 0);
  equal(currentLane.rows.filter(row => row.kind === 'task').length, 1);
  const taskKey = identityKey({ kind: 'task', id: 'fixture-task', state: 'completed' });
  ok(currentLane.rows.find(row => row.kind === 'task')?.nativeKeys?.includes(taskKey!));

  ingest([user, first, callRecord, resultRecord, orphanedResult, taskRecord, second], 1, 650, true);
  ingest([prompt(frameId(23), 'Stale generation', 17)], 0, 700);
  const rewritten = (await store.sessions())[0]!;
  deepEqual(mainRows(rewritten), mainRows(appended));
  deepEqual(rewritten.usageObservations, appended.usageObservations);
  deepEqual(reconcileRows(mainRows(rewritten), liveRows, true), complete);
});
