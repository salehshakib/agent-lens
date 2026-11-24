import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileRows, reconcileUsage } from '../src/host/chat/reconcile';
import type { ProvisionalRow } from '../src/host/chat/reconcile';
import { reduceSession } from '../src/host/sessions/reduce';
import { buildDetail } from '../src/host/views/models';
import { call, claudeSource, fixtureEvidence, instant, prompt, response } from './fixtures/session';

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
