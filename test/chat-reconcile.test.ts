import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { reconcileRows, reconcileUsage, scopeSessionId } from '../src/host/chat/reconcile';
import type { ProvisionalRow } from '../src/host/chat/reconcile';
import { ChatSessions } from '../src/host/chat/session';
import type { ChatHistoryRow } from '../src/host/chat/session';
import { identityKey } from '../src/host/sessions/evidence';
import { reduceSession } from '../src/host/sessions/reduce';
import { buildDetail } from '../src/host/views/models';
import type { AgentDelegation } from '../src/shared/protocol';
import { call, claudeId, claudeSource, fixtureEvidence, fixtureRoot, instant, prompt, response } from './fixtures/session';

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
  { id: 'l-text', identity: { kind: 'response', id: 'reply-a2' } },
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
  deepEqual(verified.unresolved.map(row => row.id), ['l-notice']);
});

test('replay or rewrite of the same recorded rows does not change the result', () => {
  const rows = recorded().map(row => ({ id: row.id, keys: row.nativeKeys }));
  const first = reconcileRows(rows, live, true);
  const second = reconcileRows([...rows, ...rows], live, true);
  deepEqual([...second.resolved], [...first.resolved]);
  deepEqual(second.live, first.live);
});

test('usage counts each observed response once across stdout and the transcript', () => {
  const tokens = { input: 10, output: 4 };
  const out = reconcileUsage(new Set(['reply-a2']), [
    { id: 'reply-a2', tokens }, { id: 'reply-new', tokens }, { id: 'reply-new', tokens },
  ]);
  deepEqual(out.map(item => item.id), ['reply-new']);
});

const spawnCall = 'fixture-private-call-id';
const snapshotRow: ChatHistoryRow = { id: 'snapshot', role: 'user', text: 'Saved row', sourceRowId: 'timeline-start' };
const delegation: AgentDelegation = {
  id: 'a'.repeat(32), ref: 'b'.repeat(64), label: 'Private agent name', provider: 'Claude Code',
  status: 'Running', tone: 'live', reason: 'Waiting for transcript', recent: 'Private command payload',
  links: [{ label: 'Open transcript', request: { type: 'openTranscript', session: 'c'.repeat(32), lane: 'd'.repeat(32) } }],
};

function lateSpawn(callId = spawnCall, id = 'late-spawn'): ChatHistoryRow {
  return { id, role: 'tool', text: '', delegation, delegationCallKeys: [identityKey('call', callId)], sourceRowId: 'timeline-spawn' };
}

async function frozenChat(t: TestContext) {
  const identity = { provider: 'claude-code' as const, profile: 'fixture', home: fixtureRoot, cwd: fixtureRoot, nativeId: claudeId };
  const chat = new ChatSessions({
    adapter: () => ({
      async open(launch, emit) {
        return {
          async send({ id }) {
            emit({ ...launch, kind: 'ready', nativeId: launch.identity.nativeId,
              capabilities: { send: true, interrupt: true, commands: [], skills: [] } });
            emit({ ...launch, kind: 'tool', turnId: id, callId: spawnCall, name: 'Private custom tool name' });
          },
          async close() {},
          async interrupt() { return 'fixture-interrupt'; },
        };
      },
    }),
    async validate() { return undefined; }, changed() {}, async persist() {}, async checkDelivery() { return 'unknown'; },
  });
  t.after(() => chat.dispose());
  const key = chat.observe(identity, 'fixture-chat');
  const view = (history: readonly ChatHistoryRow[], privateMode = false, loadEarlier = false) =>
    chat.view(key, { title: 'Fixture', sessionId: scopeSessionId(identity), history, privateMode, loadEarlier })!;
  view([snapshotRow]);
  await chat.handle(key, { type: 'chatContinue' });
  await chat.handle(key, { type: 'chatSend', revision: 1, text: 'Start fixture' });
  equal(chat.frozenHistoryStart(key), snapshotRow.sourceRowId);
  return view;
}

test('late exact spawn decorates one live tool row with a stable delegation block', async t => {
  const view = await frozenChat(t);
  const first = view([snapshotRow]).rows.find(row => row.role === 'tool')!;
  const next = view([snapshotRow, lateSpawn()]).rows.filter(row => row.role === 'tool');
  equal(next.length, 1);
  equal(next[0]?.id, first.id);
  equal(next[0]?.delegation?.id, delegation.id);
  equal(next[0]?.delegation?.reason, 'Waiting for transcript');
  const complete = { ...lateSpawn(), delegation: { ...delegation, status: 'Completed' as const, reason: undefined } };
  equal(view([snapshotRow, complete]).rows.find(row => row.role === 'tool')?.delegation?.id, delegation.id);
  ok(!JSON.stringify(next).includes(spawnCall));
  ok(!JSON.stringify(next).includes('delegationCallKeys'));
});

test('different, missing and competing call keys leave the live row undecorated', async t => {
  const view = await frozenChat(t);
  for (const evidence of [[lateSpawn('other-call')], [{ ...lateSpawn(), delegationCallKeys: undefined }],
    [lateSpawn(), lateSpawn(spawnCall, 'another-claim')]]) {
    const rows = view([snapshotRow, ...evidence]).rows;
    equal(rows.filter(row => row.role === 'tool').length, 1);
    ok(!rows.some(row => row.delegation));
    ok(rows.some(row => row.role === 'notice' && row.text.startsWith('Launch unresolved')));
  }
});

test('private display posts only structural delegation data on the matched live row', async t => {
  const view = await frozenChat(t);
  const row = view([snapshotRow, lateSpawn()], true).rows.find(item => item.delegation)!;
  equal(row.text, 'Tool');
  equal(row.delegation?.label, 'Agent');
  equal(row.delegation?.ref, delegation.ref);
  const serialized = JSON.stringify(row);
  for (const sensitive of [spawnCall, 'Private agent name', 'Private command payload', 'Private custom tool name', 'openTranscript', 'timeline-spawn']) {
    ok(!serialized.includes(sensitive));
  }
});

test('a root earlier request admits only rows before the exact frozen anchor and clears on privacy change', async t => {
  const view = await frozenChat(t);
  const older: ChatHistoryRow = { id: 'older', role: 'user', text: 'Older evidence', sourceRowId: 'older-source' };
  const newer: ChatHistoryRow = { id: 'newer', role: 'assistant', text: 'Newer evidence', sourceRowId: 'newer-source' };
  const history = [older, snapshotRow, newer];
  equal(view(history).rows.some(row => row.id === older.id), false);
  const loaded = view(history, false, true).rows;
  deepEqual(loaded.slice(0, 2).map(row => row.id), [older.id, snapshotRow.id]);
  equal(loaded.some(row => row.id === newer.id), false);
  equal(view([snapshotRow, older]).rows.some(row => row.id === older.id), false);
  equal(view(history).rows.some(row => row.id === older.id), true);
  equal(view(history, true).rows.some(row => row.id === older.id), false);
  equal(view(history).rows.some(row => row.id === older.id), false);
});
