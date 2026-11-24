import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { reduceSession } from '../src/host/sessions/reduce';
import type { Lane, ParentTarget, Session } from '../src/host/sessions/types';
import { buildDetail } from '../src/host/views/models';
import { claudeSource, fixtureEvidence, instant, prompt, response } from './fixtures/session';

function base(): Session {
  const records = [prompt('first', 'Fixture prompt', 0), response('reply', 'first', 10, 'Done', 'end_turn')];
  return reduceSession([fixtureEvidence(claudeSource(), records)], instant + 40)!.session;
}

const target = (rowId: string, at: number): ParentTarget => ({ sessionId: 'parent', laneId: 'main', rowId, relation: 'launch', at });

function withLanes(): Session {
  const session = base();
  const main = session.lanes[0]!;
  const resolved = { ...main, id: 'resolved', title: 'Resolved', parent: { ...target('row-1', 1), relation: 'agent' } } as unknown as Lane;
  const unresolved = { ...main, id: 'unresolved', title: 'Unresolved', parent: undefined, parentReason: 'Spawning call not recorded' } as unknown as Lane;
  return { ...session, lanes: [main, resolved, unresolved] };
}

test('lane Open parent projection: root, resolved and unresolved lanes', () => {
  const session = withLanes();
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  const by = (id: string) => detail.lanes.find(lane => lane.id === id)!.parent;
  equal(by(session.lanes[0]!.id).state, 'root');
  const resolved = by('resolved');
  equal(resolved.state, 'resolved');
  equal(resolved.targets[0]?.rowId, 'row-1');
  const unresolved = by('unresolved');
  equal(unresolved.state, 'unresolved');
  equal(unresolved.reason, 'Spawning call not recorded');
});

test('lane Open parent projection: multi-launch main lane lists launches newest first', () => {
  const session = base();
  session.parents = [target('older', 1), target('newer', 5)];
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  const info = detail.lanes[0]!.parent;
  equal(info.state, 'resolved');
  deepEqual(info.targets.map(item => item.rowId), ['newer', 'older']);
});
