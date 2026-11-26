import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { reduceSession } from '../src/host/sessions/reduce';
import type { FileAction, Lane, Session } from '../src/host/sessions/types';
import { diffLink, projectTranscript } from '../src/host/views/chat-transcript';
import { buildDetail } from '../src/host/views/models';
import { call, claudeSource, codexId, codexSource, fixtureEvidence, fixtureRoot, instant, prompt, response, result, rollout } from './fixtures/session';

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

test('tools fold separately between prompt and reply with outcome, file evidence and diff state', () => {
  const s = session();
  const tool = s.lanes[0]!.rows.find(row => row.kind === 'tool' && row.label === 'Edit');
  const action: FileAction = { id: 'f1', laneId: s.lanes[0]!.id, rowId: tool!.id, path: 'a.ts', label: 'Edit', kind: 'edit',
    status: 'requested', diff: patch, diffKind: 'hunks' };
  const detail = buildDetail(s, [s], { now: instant + 70, privateMode: false });
  const rows = projectTranscript(detail, [action], false);
  deepEqual(rows.map(row => row.role), ['user', 'tool', 'tool', 'assistant']);
  const card = rows[2]!.card!;
  equal(rows[1]!.card?.title, 'Bash');
  equal(rows[1]!.card?.outcome, 'Completed');
  equal(rows[2]!.id, tool!.id);
  ok(card.title.startsWith('Edit'));
  ok(card.entries!.some(entry => entry.detail?.includes('Proposed change')));
  ok(card.entries!.some(entry => entry.links?.some(link => link.request?.type === 'openFile')));
  equal(card.diff?.length, 1);
  ok(card.diff![0]!.heading.startsWith('a.ts'));
  ok(rows[2]!.keys?.length);
});

test('private display hides diffs and output', () => {
  const s = session();
  const detail = buildDetail(s, [s], { now: instant + 70, privateMode: true });
  const rows = projectTranscript(detail, s.files, true);
  equal(rows.find(row => row.card)?.card?.diff, undefined);
  ok(!JSON.stringify(rows).includes('Fixture result'));
  ok(!JSON.stringify(rows).includes('Fix it'));
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

test('file evidence keeps applied, failed and unknown states and labels a missing Write preimage', () => {
  const recorded = session();
  const tool = recorded.lanes[0]!.rows.find(row => row.label === 'Edit')!;
  const base = { id: 'c'.repeat(64), laneId: tool.laneId, rowId: tool.id, path: 'fixture.ts', label: 'fixture.ts', kind: 'edit' as const };
  const detail = buildDetail(recorded, [recorded], { now: instant + 70, privateMode: false });
  for (const [status, label] of [['applied', 'Applied'], ['failed', 'Failed'], ['recorded', 'Unknown']] as const) {
    const rows = projectTranscript(detail, [{ ...base, status, diffUnavailable: 'Preimage not recorded' }], false);
    const file = rows.find(row => row.id === tool.id)?.card?.entries?.find(entry => entry.title === base.path);
    ok(file?.detail);
    ok(file.detail.includes(label + ' change'));
    ok(file.detail.includes('Previous content unavailable'));
    deepEqual(file.links?.map(link => link.request?.type), ['openFile']);
  }
});

test('an observed Codex command without a verified run stays at its call with an explicit reason', () => {
  const records = [prompt('u', 'Fixture', 0), response('launch', 'u', 10, [call('Bash', 'codex-call', { command: 'codex exec --json fixture' })]),
    response('next', 'launch', 20, 'Done', 'end_turn')];
  const selected = reduceSession([fixtureEvidence(claudeSource(), records)], instant + 70)!.session;
  const detail = buildDetail(selected, [selected], { now: instant + 70, privateMode: false });
  const rows = projectTranscript(detail, selected.files, false, { session: selected, sessions: [selected] });
  deepEqual(rows.map(row => row.role), ['user', 'tool', 'assistant']);
  equal(rows[1]?.card?.message, 'No verified Codex run is linked to this call.');
});

test('agent group links reuse existing routes and show a reason when launch is unresolved', () => {
  const s = session();
  const main = s.lanes[0]!;
  const child = { ...main, id: 'child', title: 'Reviewer', parent: undefined, parentReason: 'Launch not recorded',
    rows: main.rows.map(row => ({ ...row, id: 'child-' + row.id, laneId: 'child' })) } as unknown as Lane;
  const withChild = { ...s, lanes: [main, child] };
  const detail = buildDetail(withChild, [withChild], { now: instant + 70, privateMode: false });
  const group = projectTranscript(detail, [], false).find(row => row.id.startsWith('agent:'))!;
  const links = group.card!.links!;
  deepEqual(links.map(link => link.label), ['Transcript', 'Files', 'Agent map', 'Launch evidence', 'Open parent'].map((label, i) =>
    i === 0 && links[0]!.request ? 'Open transcript' : label));
  ok(links.find(link => link.label === 'Launch evidence')!.reason?.includes('Launch not recorded'));
});

test('a long history projects bounded output and wide tool output is clipped', () => {
  const rows: unknown[] = [prompt('u0', 'start', 0)];
  let parent = 'u0';
  for (let i = 1; i <= 700; i++) {
    const id = 'a' + i;
    rows.push(response(id, parent, i * 10, [call('Bash', 'c' + i, { command: 'x'.repeat(5000) })]));
    rows.push(result('r' + i, 'c' + i, i * 10 + 5, { stdout: 'yes\n'.repeat(2000) }, id));
    parent = 'r' + i;
  }
  rows.push(response('end', parent, 99999, 'done', 'end_turn'));
  const s = reduceSession([fixtureEvidence(claudeSource(), rows)], instant + 100000)!.session;
  const detail = buildDetail(s, [s], { now: instant + 100000, privateMode: false });
  const out = projectTranscript(detail, [], false);
  equal(out.length, 702);
  equal(out.at(-1)?.text, 'done');
  const fold = out[1]!.card!;
  const output = fold.entries!.find(entry => entry.title === 'Output')!.output!;
  ok(output.includes('Output shortened for display.'));
  ok(output.split('\n').length < 30);
  const command = fold.entries!.find(entry => entry.title === 'Command')!.output!;
  ok(command.length < 1700);
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
    return projectTranscript(buildDetail(x, [x], { now: instant + 70, privateMode: false }), [], false, { session: x, sessions: [x] });
  };
  const before = mk(false).map(row => row.id).filter(id => id.startsWith('agent:'));
  const after = mk(true).map(row => row.id).filter(id => id.startsWith('agent:'));
  deepEqual(after, before);
  equal(mk(true).filter(row => row.id.startsWith('agent:')).length, 1);
  const spawn = main.rows.find(row => row.kind === 'tool')!;
  const resolved = mk(true);
  const afterSpawn = resolved[resolved.findIndex(row => row.id === spawn.id) + 1]!;
  equal(afterSpawn.id, after[0]);
  deepEqual(afterSpawn.card?.children?.map(row => row.text).filter(Boolean), ['Fix it', 'All done']);
});

test('a linked Codex run groups the attributed turn at its exact launch and exposes child-scoped links', () => {
  const parent = session();
  const child = reduceSession([fixtureEvidence(codexSource(), [
    rollout('session_meta', 5, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 6, { type: 'task_started', turn_id: 'other' }),
    rollout('event_msg', 7, { type: 'user_message', message: 'Separate turn' }),
    rollout('event_msg', 8, { type: 'task_complete', turn_id: 'other' }),
    rollout('event_msg', 11, { type: 'task_started', turn_id: 'linked' }),
    rollout('event_msg', 12, { type: 'user_message', message: 'Linked prompt' }),
    rollout('response_item', 14, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Visible summary' }], encrypted_content: 'Hidden token' }),
    rollout('event_msg', 16, { type: 'task_complete', turn_id: 'linked' }),
  ])], instant + 70)!.session;
  const spawn = parent.lanes[0]!.rows.find(row => row.label === 'Bash')!;
  const childLane = child.lanes[0]!;
  const linkedTurn = childLane.turns.find(turn => turn.nativeId === 'linked')!.id;
  const edge = { sessionId: parent.id, laneId: spawn.laneId, rowId: spawn.id, relation: 'launch' as const };
  child.parents = [edge];
  parent.children = [{ ...edge, sessionId: child.id, laneId: childLane.id, turnId: linkedTurn }];
  const sessions = [parent, child];
  const detail = buildDetail(parent, sessions, { now: instant + 70, privateMode: false });
  const rows = projectTranscript(detail, parent.files, false, { session: parent, sessions });
  const group = rows[rows.findIndex(row => row.id === spawn.id) + 1]!;
  ok(group.id.startsWith('agent:'));
  const nested = JSON.stringify(group.card?.children);
  ok(nested.includes('Linked prompt'));
  ok(nested.includes('Visible summary'));
  ok(!nested.includes('Hidden token'));
  ok(!nested.includes('Separate turn'));
  deepEqual(group.card?.links?.map(link => link.request), [
    { type: 'goto', session: child.id, lane: childLane.id, row: childLane.rows.findLast(row => row.turnId === linkedTurn)?.id },
    { type: 'goto', session: child.id, lane: '', row: '', tab: 'files' },
    { type: 'goto', session: child.id, lane: '', row: '', tab: 'map' },
    { type: 'goto', session: parent.id, lane: spawn.laneId, row: spawn.id },
    { type: 'openParent', session: child.id, lane: childLane.id },
  ]);
});
