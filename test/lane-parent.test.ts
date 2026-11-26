import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { reduceSession } from '../src/host/sessions/reduce';
import type { Lane, ParentTarget, Session } from '../src/host/sessions/types';
import { buildDetail } from '../src/host/views/models';
import { claudeSource, codexId, codexSource, fixtureEvidence, fixtureRoot, instant, prompt, response, rollout } from './fixtures/session';

function base(): Session {
  const records = [prompt('first', 'Fixture prompt', 0), response('reply', 'first', 10, 'Done', 'end_turn')];
  return reduceSession([fixtureEvidence(claudeSource(), records)], instant + 40)!.session;
}

const target = (rowId: string, at: number): ParentTarget => ({ sessionId: 'parent', laneId: 'main', rowId, relation: 'launch', at });

function withLanes(): Session {
  const session = base();
  const main = session.lanes[0]!;
  const resolved: Lane = { ...main, id: 'resolved', title: 'Resolved', parent: {
    sessionId: session.id, laneId: main.id, rowId: main.rows[0]!.id, relation: 'agent',
  } };
  const unresolved: Lane = { ...main, id: 'unresolved', title: 'Unresolved', parent: undefined, parentReason: 'Spawning call not recorded' };
  return { ...session, lanes: [main, resolved, unresolved] };
}

test('lane Open parent projection: root, resolved and unresolved lanes', () => {
  const session = withLanes();
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  const by = (id: string) => detail.lanes.find(lane => lane.id === id)!.parent;
  equal(by(session.lanes[0]!.id).state, 'root');
  const resolved = by('resolved');
  equal(resolved.state, 'resolved');
  equal(resolved.targets[0]?.rowId, session.lanes[0]!.rows[0]!.id);
  equal(resolved.targets[0]?.laneId, session.lanes[0]!.id);
  const unresolved = by('unresolved');
  equal(unresolved.state, 'unresolved');
  equal(unresolved.reason, 'Spawning call not recorded');
});

test('lane Open parent projection: multi-launch main lane lists launches newest first', () => {
  const session = reduceSession([fixtureEvidence(codexSource(), [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
  ])], instant + 40)!.session;
  session.parents = [target('older', 1), target('newer', 5)];
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  const info = detail.lanes[0]!.parent;
  equal(info.state, 'resolved');
  deepEqual(info.targets.map(item => item.rowId), ['newer', 'older']);
});

test('lane Open parent projection: Codex child thread resolves to the exact parent spawn', () => {
  const parent = reduceSession([fixtureEvidence(codexSource(), [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
  ])], instant + 40)!.session;
  const child = reduceSession([fixtureEvidence(codexSource('20000000-0000-4000-8000-000000000003'), [])], instant + 40)!.session;
  child.lanes[0]!.parent = { sessionId: parent.id, laneId: parent.lanes[0]!.id, rowId: 'exact-spawn', relation: 'child' };
  const detail = buildDetail(child, [parent, child], { now: instant + 50, privateMode: false });
  equal(detail.lanes[0]!.parent.state, 'resolved');
  equal(detail.lanes[0]!.parent.targets[0]?.rowId, 'exact-spawn');
  equal(detail.lanes[0]!.parent.targets[0]?.laneId, parent.lanes[0]!.id);
});

test('a focused spawning row remains available outside the recent Timeline window', () => {
  const session = withLanes();
  const main = session.lanes[0]!;
  const spawn = main.rows[0]!;
  main.rows.push(...Array.from({ length: 1_505 }, (_, index) => ({ ...spawn, id: `recent-${index}`, at: instant + 100 + index })));
  const options = { now: instant + 5_000, privateMode: false };
  const detail = buildDetail(session, [session], options);
  equal(detail.rows.some(row => row.id === spawn.id && row.laneId === main.id), false);
  const opened = buildDetail(session, [session], { ...options, focus: { row: spawn.id, lane: main.id } });
  equal(opened.rows.filter(row => row.id === spawn.id && row.laneId === main.id).length, 1);
  equal(opened.rows.at(-1)?.id, detail.rows.at(-1)?.id);
});
