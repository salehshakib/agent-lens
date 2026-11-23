import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { buildGauges } from '../src/host/limits/model';
import { reduceSession } from '../src/host/sessions/reduce';
import type { Session } from '../src/host/sessions/types';
import type { UsageTotal } from '../src/host/usage/ledger';
import { providerQuota } from '../src/host/views/data';
import { buildDetail, buildTasks, buildTree, buildUsage, earlierPage, localDay } from '../src/host/views/models';
import type { TreeOptions } from '../src/host/views/models';
import { call, claudeId, claudeSource, codexId, codexSource, fixtureEvidence, fixtureRoot, instant, prompt, response, result, rollout } from './fixtures/session';

const day = 86_400_000;

function claudeSession(): Session {
  const records = [
    prompt('first', 'Secret fixture prompt', 0),
    response('reply', 'first', 10, [
      { type: 'thinking', thinking: 'Secret reasoning' },
      call('Bash', 'run', { command: 'echo secret-command' }),
    ]),
    result('run-result', 'run', 20, undefined, 'reply'),
    response('end', 'reply', 30, 'Final fixture', 'end_turn'),
  ];
  return reduceSession([fixtureEvidence(claudeSource(), records)], instant + 40)!.session;
}

function codexSession(): Session {
  const records = [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('turn_context', 1, { turn_id: 'one', model: 'fixture-model', effort: 'high' }),
    rollout('event_msg', 10, { type: 'task_started', turn_id: 'one' }),
  ];
  return reduceSession([fixtureEvidence(codexSource(), records)], instant + 20)!.session;
}

/** Copy a session with a new id and recency so tree grouping can be tested without more fixtures. */
function variant(base: Session, id: string, updatedAt: number, patch: Partial<Session> = {}): Session {
  return { ...base, id, updatedAt, status: 'Completed', ...patch };
}

const options = (overrides: Partial<TreeOptions> = {}): TreeOptions => ({
  now: instant + day, timeZone: 'UTC', privateMode: false, filters: { search: '', adapter: '', project: '' },
  earlierLimits: new Map(), ...overrides,
});

test('the tree groups sessions into Live, Today and Earlier inside one project', () => {
  const base = claudeSession();
  const sessions = [
    variant(base, 'live', instant + day, { status: 'Live' }),
    variant(base, 'today', instant + day - 1000),
    variant(base, 'old', instant - 3 * day),
  ];
  const { tree, total } = buildTree(sessions, options());
  equal(total, 3);
  equal(tree.length, 1);
  deepEqual(tree[0]?.groups.map(group => [group.key, group.rows.length]), [['live', 1], ['today', 1], ['earlier', 1]]);
});

test('Earlier pages by 20 and reports how many more remain', () => {
  const base = claudeSession();
  const sessions = Array.from({ length: 45 }, (_, index) => variant(base, 's' + String(index).padStart(2, '0'), instant - (index + 2) * day));
  const first = buildTree(sessions, options()).tree[0]!;
  const earlier = first.groups.find(group => group.key === 'earlier')!;
  equal(earlier.rows.length, earlierPage);
  equal(earlier.more, 25);
  const second = buildTree(sessions, options({ earlierLimits: new Map([[first.id, 40]]) })).tree[0]!.groups[0]!;
  equal(second.rows.length, 40);
  equal(second.more, 5);
});

test('children nest under their parent and a cycle is not nested', () => {
  const base = claudeSession();
  const edge = (sessionId: string) => ({ sessionId, relation: 'child' as const, laneId: 'x', rowId: 'x' });
  const parent = variant(base, 'parent', instant);
  const child = variant(base, 'child', instant - 10, { parents: [edge('parent')] });
  const nested = buildTree([parent, child], options()).tree[0]!.groups.flatMap(group => group.rows);
  equal(nested.length, 1);
  equal(nested[0]?.children.length, 1);
  equal(nested[0]?.children[0]?.id, 'child');
  const a = variant(base, 'a', instant, { parents: [edge('b')] });
  const b = variant(base, 'b', instant - 10, { parents: [edge('a')] });
  const rows = buildTree([a, b], options()).tree.flatMap(node => node.groups.flatMap(group => group.rows));
  ok(rows.length >= 1, 'a cycle never hides every row');
});

test('search and adapter filters narrow the tree and private mode hides titles', () => {
  const claude = claudeSession();
  const codex = codexSession();
  equal(buildTree([claude, codex], options({ filters: { search: '', adapter: 'codex', project: '' } })).total, 1);
  equal(buildTree([claude, codex], options({ filters: { search: 'no-such-text', adapter: '', project: '' } })).total, 0);
  const open = buildTree([claude], options()).tree[0]!.groups[0]!.rows[0]!;
  ok(open.title.includes('Secret fixture prompt'));
  const hidden = buildTree([claude], options({ privateMode: true })).tree[0]!.groups[0]!.rows[0]!;
  ok(!hidden.title.includes('Secret'));
  equal(buildTree([claude], options({ privateMode: true, filters: { search: 'Secret', adapter: '', project: '' } })).total, 0);
});

test('session detail shows ordered rows, and private mode strips prompts, commands and output', () => {
  const session = claudeSession();
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  equal(detail.id, session.id);
  ok(detail.rows.length >= 3);
  const text = JSON.stringify(detail);
  ok(text.includes('Secret fixture prompt'));
  equal(detail.agents[0]?.kind, 'main');
  const privateDetail = buildDetail(session, [session], { now: instant + 50, privateMode: true });
  const hidden = JSON.stringify(privateDetail);
  ok(!hidden.includes('Secret fixture prompt'));
  ok(!hidden.includes('Secret reasoning'));
  ok(!hidden.includes('secret-command'));
  equal(privateDetail.privateMode, true);
});

test('relay context outranks the transcript estimate and is labeled as the status line', () => {
  const session = claudeSession();
  const detail = buildDetail(session, [session], { now: instant + 50, privateMode: false, relayContext: 47 });
  equal(detail.contextPercent, 47);
  ok(detail.contextText.includes('status line'));
  const without = buildDetail(session, [session], { now: instant + 50, privateMode: false });
  ok(without.contextText.length > 0);
});

test('background tasks are collected from sessions and titles are hidden in private mode', () => {
  const base = claudeSession();
  const withTask = variant(base, 'tasked', instant, {
    background: [{ id: 'task-1', laneId: base.lanes[0]!.id, title: 'Secret task title', status: 'Live', at: instant }] as Session['background'],
  });
  const tasks = buildTasks([base, withTask], false);
  equal(tasks.length, 1);
  equal(tasks[0]?.title, 'Secret task title');
  equal(buildTasks([withTask], true)[0]?.title, 'Background task');
});

test('usage groups ledger rows by local day, filters by range and keeps tokens only', () => {
  const session = claudeSession();
  const row = (dayKey: string, total: number, extra: Partial<UsageTotal> = {}): UsageTotal => ({
    sessionId: session.id, provider: 'claude-code', laneId: 'lane', day: dayKey, model: 'fixture-model',
    counts: { input: total, output: 0, total }, partial: false, ...extra,
  });
  const today = localDay(instant, 'UTC');
  const old = localDay(instant - 60 * day, 'UTC');
  const totals = [row(today, 100), row(today, 50), row(old, 900), row(today, 7, { provider: 'codex' })];
  const usage = buildUsage({ now: instant, timeZone: 'UTC', filters: { range: '7', project: '', adapter: '' }, totals, sessions: [session] });
  deepEqual(usage.days.map(item => [item.day, item.claude, item.codex, item.total]), [[today, 150, 7, 157]]);
  equal(usage.models.length, 2);
  const all = buildUsage({ now: instant, timeZone: 'UTC', filters: { range: 'all', project: '', adapter: 'claude-code' }, totals, sessions: [session] });
  equal(all.days.length, 2);
  deepEqual(all.summaries.map(item => item.provider), ['Claude Code']);
  ok(!JSON.stringify(all).toLowerCase().includes('usd'));
});

test('provider quota text is compact and empty when a provider has no gauges', () => {
  const { main } = buildGauges([{ provider: 'codex', profile: 'one' }], [], instant);
  equal(providerQuota(main, 'claude-code'), undefined);
  const quota = providerQuota(main, 'codex')!;
  ok(quota.text.startsWith('Codex 5h -'));
  ok(quota.tooltip.length > 0);
  equal(claudeId.length, 36);
});
