import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { reduceSession } from '../src/host/sessions/reduce';
import type { FileAction, Lane, Session } from '../src/host/sessions/types';
import { diffLink, projectTranscript } from '../src/host/views/chat-transcript';
import { buildDetail } from '../src/host/views/models';
import { call, claudeSource, fixtureEvidence, instant, prompt, response, result } from './fixtures/session';

function session(): Session {
  const records = [
    prompt('u1', 'Fix it', 0),
    response('a1', 'u1', 10, [call('Bash', 'c1', { command: 'ls' }), call('Edit', 'c2', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })]),
    result('r1', 'c1', 15, undefined, 'a1'),
    response('a2', 'r1', 30, 'All done', 'end_turn'),
  ];
  return reduceSession([fixtureEvidence(claudeSource(), records)], instant + 60)!.session;
}

const patch = '@@ -1,1 +1,1 @@\n-x\n+y\n';

test('tool activity folds into one block between prompt and reply with outcome and diff state', () => {
  const s = session();
  const tool = s.lanes[0]!.rows.find(row => row.kind === 'tool' && row.label === 'Edit');
  const action: FileAction = { id: 'f1', laneId: s.lanes[0]!.id, rowId: tool!.id, path: 'a.ts', label: 'Edit', kind: 'edit',
    status: 'requested', diff: patch, diffKind: 'hunks' };
  const detail = buildDetail(s, [s], { now: instant + 70, privateMode: false });
  const rows = projectTranscript(detail, [action], false);
  deepEqual(rows.map(row => row.role), ['user', 'tool', 'assistant']);
  const card = rows[1]!.card!;
  ok(card.entries!.length >= 2);
  ok(card.entries!.some(entry => entry.detail?.includes('Proposed change')));
  equal(card.diff?.length, 1);
  ok(card.diff![0]!.heading.startsWith('a.ts'));
  ok(rows[1]!.keys!.length >= 2);
});

test('private display hides diffs and output', () => {
  const s = session();
  const detail = buildDetail(s, [s], { now: instant + 70, privateMode: true });
  const rows = projectTranscript(detail, [], true);
  equal(rows.find(row => row.card)?.card?.diff, undefined);
});

test('an unresolved delegated agent keeps an observed position as a folded group', () => {
  const s = session();
  const main = s.lanes[0]!;
  const child = { ...main, id: 'child', title: 'Reviewer', parent: undefined, parentReason: 'Launch not recorded',
    rows: main.rows.map(row => ({ ...row, id: 'child-' + row.id, laneId: 'child' })) } as unknown as Lane;
  const withChild = { ...s, lanes: [main, child] };
  const detail = buildDetail(withChild, [withChild], { now: instant + 70, privateMode: false });
  const rows = projectTranscript(detail, [], false);
  const group = rows.filter(row => row.id.startsWith('agent:'));
  equal(group.length, 1);
  ok(group[0]!.card!.entries!.some(entry => entry.detail?.includes('Launch not recorded')));
});

test('full diff is offered only for an eligible recorded patch, otherwise the reason is shown', () => {
  const base = { id: 'a'.repeat(64), laneId: 'l', rowId: 'r', path: 'a.ts', label: 'Edit', kind: 'edit', status: 'applied' } as FileAction;
  equal(diffLink({ ...base, diff: patch, diffKind: 'hunks' }, false).request?.type, 'openDiff');
  ok(diffLink({ ...base }, false).reason);
  ok(diffLink({ ...base, diff: 'not a patch' }, false).reason);
  ok(diffLink({ ...base, diff: patch }, true).reason?.includes('private'));
});

test('agent group links reuse existing routes and show a reason when launch is unresolved', () => {
  const s = session();
  const main = s.lanes[0]!;
  const child = { ...main, id: 'child', title: 'Reviewer', parent: undefined, parentReason: 'Launch not recorded',
    rows: main.rows.map(row => ({ ...row, id: 'child-' + row.id, laneId: 'child' })) } as unknown as Lane;
  const withChild = { ...s, lanes: [main, child] };
  const detail = buildDetail(withChild, [withChild], { now: instant + 70, privateMode: false });
  const group = projectTranscript(detail, [], false).find(row => row.id.startsWith('agent:'))!;
  const links = group.card!.entries!.flatMap(entry => entry.links ?? []);
  deepEqual(links.map(link => link.label), ['Transcript', 'Files', 'Agent map', 'Launch evidence'].map((label, i) =>
    i === 0 && links[0]!.request ? 'Open transcript' : label));
  ok(links.find(link => link.label === 'Launch evidence')!.reason?.includes('Launch not recorded'));
});

test('a long history projects bounded output and wide tool output is clipped', () => {
  const rows: unknown[] = [prompt('u0', 'start', 0)];
  let parent = 'u0';
  for (let i = 1; i <= 700; i++) {
    const id = 'a' + i;
    rows.push(response(id, parent, i * 10, [call('Bash', 'c' + i, { command: 'x'.repeat(5000) })]));
    rows.push(result('r' + i, 'c' + i, i * 10 + 5, undefined, id));
    parent = 'r' + i;
  }
  rows.push(response('end', parent, 99999, 'done', 'end_turn'));
  const s = reduceSession([fixtureEvidence(claudeSource(), rows)], instant + 100000)!.session;
  const detail = buildDetail(s, [s], { now: instant + 100000, privateMode: false });
  const out = projectTranscript(detail, [], false);
  ok(out.length < 10);
  const fold = out.find(row => row.card)!.card!;
  ok(fold.entries!.length <= 40);
  ok(fold.message);
  for (const entry of fold.entries!) ok((entry.detail ?? '').length < 400);
});

test('a newly reconciled child row keeps its group position', () => {
  const s = session();
  const main = s.lanes[0]!;
  const mk = (resolved: boolean) => {
    const spawnRow = main.rows.find(row => row.kind === 'tool')!;
    const child = { ...main, id: 'child', title: 'Reviewer', rows: main.rows.map(row => ({ ...row, id: 'child-' + row.id, laneId: 'child' })),
      parent: resolved ? { sessionId: s.id, laneId: main.id, rowId: spawnRow.id, relation: 'agent' } : undefined,
      parentReason: resolved ? undefined : 'Launch not recorded' } as unknown as Lane;
    const x = { ...s, lanes: [main, child] };
    return projectTranscript(buildDetail(x, [x], { now: instant + 70, privateMode: false }), [], false);
  };
  const before = mk(false).map(row => row.id).filter(id => id.startsWith('agent:'));
  const after = mk(true).map(row => row.id).filter(id => id.startsWith('agent:'));
  deepEqual(after, before);
  equal(mk(true).filter(row => row.id.startsWith('agent:')).length, 1);
});
