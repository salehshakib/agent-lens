import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { reduceSession } from '../src/host/sessions/reduce';
import type { Lane, Session } from '../src/host/sessions/types';
import { buildDetail, buildTree } from '../src/host/views/models';
import type { TreeOptions } from '../src/host/views/models';
import { notRecorded, observedModels } from '../src/host/views/observed';
import { claudeSource, codexId, codexSource, fixtureEvidence, fixtureRoot, instant, prompt, response, rollout } from './fixtures/session';

function claudeSession(): Session {
  const records = [
    prompt('first', 'Fixture prompt', 0),
    response('reply', 'first', 10, 'Done', 'end_turn'),
    prompt('second', 'Other prompt', 20, 'reply'),
    response('end', 'second', 30, 'Done again', 'end_turn'),
  ];
  return reduceSession([fixtureEvidence(claudeSource(), records)], instant + 40)!.session;
}

function codexSession(): Session {
  const records = [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('turn_context', 1, { turn_id: 'one', model: 'fixture-model', effort: 'high' }),
    rollout('event_msg', 10, { type: 'task_started', turn_id: 'one' }),
    rollout('turn_context', 20, { turn_id: 'two', model: 'fixture-other', effort: 'low' }),
    rollout('event_msg', 30, { type: 'task_started', turn_id: 'two' }),
  ];
  return reduceSession([fixtureEvidence(codexSource(), records)], instant + 40)!.session;
}

const tree = (overrides: Partial<TreeOptions> = {}): TreeOptions => ({
  now: instant + 1000, timeZone: 'UTC', privateMode: false, filters: { search: '', adapter: '', project: '', warnings: false },
  earlierLimits: new Map(), ...overrides,
});

test('Claude observed rows group turns by model and mark the source as a transcript record', () => {
  const rows = observedModels(claudeSession());
  equal(rows.length, 1);
  const [row] = rows;
  equal(row?.model, 'fixture-model');
  equal(row?.effort, undefined);
  equal(row?.turns, 2);
  equal(row?.source, 'Transcript record');
  equal(row?.current, true);
});

test('Codex observed rows keep one row per model and effort pair in order, with the latest marked current', () => {
  const rows = observedModels(codexSession());
  deepEqual(rows.map(row => [row.model, row.effort, row.turns, row.source]), [
    ['fixture-model', 'high', 1, 'Turn context'],
    ['fixture-other', 'low', 1, 'Turn context'],
  ]);
  deepEqual(rows.map(row => row.current), [false, true]);
});

test('a lane without any record shows Not recorded, and a lane-level value is labelled Agent metadata', () => {
  const lane = (patch: Partial<Lane>) => ({ lanes: [{ title: 'Reviewer', turns: [], ...patch } as unknown as Lane] });
  const empty = observedModels(lane({}));
  deepEqual(empty.map(row => [row.lane, row.model, row.effort, row.source, row.current]), [['Reviewer', undefined, undefined, notRecorded, false]]);
  const meta = observedModels(lane({ model: 'fixture-child', effort: 'medium' }));
  deepEqual(meta.map(row => [row.model, row.effort, row.source, row.current]), [['fixture-child', 'medium', 'Agent metadata', true]]);
});

test('session detail carries observed rows and a profile label only when one is given', () => {
  const session = codexSession();
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  equal(detail.observed.length, 2);
  equal(detail.profile, undefined);
  const named = buildDetail(session, [session], { now: instant + 50, privateMode: false, profileLabel: 'Work' });
  equal(named.profile, 'Work');
  const hidden = buildDetail(session, [session], { now: instant + 50, privateMode: true });
  equal(hidden.observed.length, 2);
});

test('the Agent map node shows the lane effort next to its model', () => {
  const session = codexSession();
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  const main = detail.agents.find(node => node.kind === 'main');
  equal(main?.model, session.lanes[0]?.model);
  equal(main?.effort, session.lanes[0]?.effort);
});

test('the profile filter keeps only that profile and rows name the profile when a provider has several', () => {
  const work = { ...claudeSession(), id: 'work-one', profile: 'work' };
  const main = { ...claudeSession(), id: 'main-one', profile: 'default' };
  const rowsOf = (result: ReturnType<typeof buildTree>) => result.tree.flatMap(project => project.groups.flatMap(group => group.rows));
  const labels = new Map([['claude-code:work', 'Work'], ['claude-code:default', 'Default']]);
  const all = buildTree([work, main], tree({ profileLabels: labels }));
  equal(all.total, 2);
  deepEqual(rowsOf(all).map(row => row.profile).sort(), ['Default', 'Work']);
  const scoped = buildTree([work, main], tree({ profileLabels: labels, filters: { search: '', adapter: '', project: '', warnings: false, profile: 'claude-code:work' } }));
  equal(scoped.total, 1);
  equal(rowsOf(scoped)[0]?.id, 'work-one');
  const single = buildTree([work], tree({ profileLabels: new Map([['claude-code:work', 'Work']]) }));
  equal(rowsOf(single)[0]?.profile, undefined);
  const none = buildTree([work, main], tree({ filters: { search: '', adapter: '', project: '', warnings: false, profile: 'codex:default' } }));
  equal(none.total, 0);
});
