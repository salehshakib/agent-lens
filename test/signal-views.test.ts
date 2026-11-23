import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import type { Event, Source } from '../src/host/adapters/types';
import { adapters } from '../src/host/adapters/registry';
import { reduceSession } from '../src/host/sessions/reduce';
import { SessionStore } from '../src/host/sessions/store';
import type { Session } from '../src/host/sessions/types';
import { ContextAlerts, alertText } from '../src/host/views/alerts';
import type { ContextCandidate } from '../src/host/views/alerts';
import { buildDetail, buildTree, namesFor } from '../src/host/views/models';
import type { TreeOptions } from '../src/host/views/models';
import { parentInfo } from '../src/host/views/signal-models';
import type { SessionRow } from '../src/shared/protocol';
import { call, childId, claudeSource, codexId, codexSource, fixtureEvents, fixtureEvidence, fixtureRoot, instant,
  prompt, response, result, rollout } from './fixtures/session';

const names = namesFor(false);

function flat(rows: SessionRow[]): SessionRow[] {
  return rows.flatMap(row => [row, ...flat(row.children)]);
}

function tree(sessions: Session[], overrides: Partial<TreeOptions> = {}): SessionRow[] {
  const { tree: nodes } = buildTree(sessions, { now: instant + 1000, timeZone: 'UTC', privateMode: false,
    filters: { search: '', adapter: '', project: '', warnings: false }, earlierLimits: new Map(), ...overrides });
  return flat(nodes.flatMap(node => node.groups.flatMap(group => group.rows)));
}

function textResult(id: string, tool: string, at: number, text: string, isError = false) {
  return { type: 'user', uuid: id, timestamp: new Date(instant + at).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, is_error: isError, content: text }] } };
}

function read(id: string, path = 'src/export.ts') {
  return call('Read', id, { file_path: path });
}

function repeats(count: number, extra: unknown[] = []) {
  const rows: unknown[] = [prompt('start', 'Fixture task', 0)];
  let parent = 'start';
  for (let index = 0; index < count; index++) {
    const uuid = 'read-' + index;
    rows.push(response(uuid, parent, 10 + index * 10, [read('r' + index)]), textResult('res-' + index, 'r' + index, 15 + index * 10, 'Fixture result'));
    parent = uuid;
  }
  return [...rows, ...extra];
}

function claude(rows: unknown[], at: number): Session {
  return reduceSession([fixtureEvidence(claudeSource(), rows)], instant + at)!.session;
}

/** Check outcomes are evaluated across a whole turn tree by the store, so they need the store path. */
async function stored(rows: unknown[], at: number): Promise<Session> {
  const store = new SessionStore(undefined, () => instant + at);
  const source = claudeSource();
  catalog(store, 'claude-code', [source]);
  ingest(store, source, rows);
  return (await store.sessions())[0]!;
}

/** One Completed Claude turn with optional edits and commands. */
function turn(steps: { edit?: string; command?: string; error?: boolean }[]): unknown[] {
  const rows: unknown[] = [prompt('start', 'Change the code', 0)];
  let parent = 'start';
  let at = 10;
  steps.forEach((step, index) => {
    const id = 'call-' + index;
    rows.push(response('s' + index, parent, at, [step.edit
      ? call('Edit', id, { file_path: step.edit, old_string: 'before', new_string: 'after' })
      : call('Bash', id, { command: step.command ?? 'echo ok' })]));
    rows.push(textResult('res-' + index, id, at + 5, step.edit ? 'Edited' : 'Command output', step.error === true));
    parent = 's' + index;
    at += 10;
  });
  rows.push(response('end', parent, at, 'Finished', 'end_turn'));
  return rows;
}

function catalog(store: SessionStore, provider: Source['provider'], sources: Source[]) {
  store.setCatalog(provider, adapters.find(adapter => adapter.id === provider)!, new Map(sources.map(source => [source.key, source])));
}

function ingest(store: SessionStore, source: Source, rows: unknown[]) {
  const events: Event[] = fixtureEvents(source, rows);
  store.ingest({ source, generation: 1, committed: events.length, reset: true, readerEpoch: 1, events, more: false,
    diagnostics: { unknown: 0, malformed: 0, oversized: 0 } });
}

test('the sidebar shows warning labels and the Has warnings filter keeps only warned sessions', () => {
  const calm = claude([prompt('start', 'Calm fixture', 0), response('end', 'start', 10, 'Done', 'end_turn')], 20);
  const looping = { ...claude(repeats(3), 40), id: 'looping' };
  const rows = tree([calm, looping]);
  deepEqual(rows.find(row => row.id === 'looping')?.warnings.map(view => [view.label, view.state, view.tone]), [['Possible loop', 'live', 'warn']]);
  deepEqual(rows.find(row => row.id === calm.id)?.warnings, []);
  const filtered = tree([calm, looping], { filters: { search: '', adapter: '', project: '', warnings: true } });
  deepEqual(filtered.map(row => row.id), ['looping']);
  // Every warning has a text label next to its tone.
  ok(rows.flatMap(row => row.warnings).every(view => view.label.length > 0));
});

test('a streak is a live warning while it is the latest activity and becomes an earlier loop afterwards', () => {
  const live = claude(repeats(3), 40);
  const detail = buildDetail(live, [live], { now: instant + 40, privateMode: false });
  const grouped = detail.rows.filter(row => row.loop);
  ok(grouped.length >= 3);
  equal(new Set(grouped.map(row => row.loop!.id)).size, 1);
  equal(grouped[0]?.loop?.count, 3);
  equal(grouped[0]?.loop?.live, true);
  equal(grouped[0]?.signals?.[0]?.label, 'Possible loop');
  equal(detail.signals.liveLoops, 1);
  equal(detail.agents[0]?.signals.some(view => view.label === 'Possible loop'), true);

  const later = claude(repeats(3, [response('other', 'read-2', 50, [read('other-call', 'src/other.ts')]),
    textResult('other-res', 'other-call', 55, 'Fixture result')]), 60);
  const after = buildDetail(later, [later], { now: instant + 60, privateMode: false });
  equal(after.rows.find(row => row.loop)?.loop?.live, false);
  equal(after.rows.find(row => row.loop)?.signals?.[0]?.label, 'Earlier loop');
  equal(after.signals.liveLoops, 0);
  deepEqual(tree([later])[0]?.warnings, []);
});

test('a Completed turn with edits and no check gets a marker row that links to the edit, and a failed check links to the check', async () => {
  const none = await stored(turn([{ edit: 'src/app.ts' }, { edit: 'src/more.ts' }]), 200);
  const detail = buildDetail(none, [none], { now: instant + 200, privateMode: false });
  const marker = detail.rows.find(row => row.kind === 'signal')!;
  equal(marker.signals?.[0]?.label, 'No checks after edits');
  equal(marker.signals?.[0]?.detail, '2 files changed');
  ok(marker.links?.edit);
  equal(marker.links?.check, undefined);
  ok(detail.rows.some(row => row.id === marker.links!.edit!.rowId && row.kind !== 'signal'));
  // The marker sits right after the last row of its turn.
  equal(detail.rows.at(-1)?.id, marker.id);
  equal(detail.signals.outcome?.label, 'No checks after edits');
  deepEqual(tree([none])[0]?.warnings.map(view => view.label), ['No checks after edits']);

  const failed = await stored(turn([{ edit: 'src/app.ts' }, { command: 'npm run test', error: true }]), 200);
  const failedDetail = buildDetail(failed, [failed], { now: instant + 200, privateMode: false });
  const failedMarker = failedDetail.rows.find(row => row.kind === 'signal')!;
  equal(failedMarker.signals?.[0]?.label, 'Last check failed');
  ok(failedMarker.links?.check);
  ok(failedDetail.rows.some(row => row.id === failedMarker.links!.check!.rowId));

  const passed = await stored(turn([{ edit: 'src/app.ts' }, { command: 'npm run test' }]), 200);
  equal(buildDetail(passed, [passed], { now: instant + 200, privateMode: false }).rows.some(row => row.kind === 'signal'), false);
  const docs = await stored(turn([{ edit: 'README.md' }]), 200);
  equal(buildDetail(docs, [docs], { now: instant + 200, privateMode: false }).rows.some(row => row.kind === 'signal'), false);
});

test('private display mode hides the check command and keeps the label', async () => {
  const failed = await stored(turn([{ edit: 'src/app.ts' }, { command: 'npm run test:secret-check', error: true }]), 200);
  const open = buildDetail(failed, [failed], { now: instant + 200, privateMode: false });
  ok(open.rows.find(row => row.kind === 'signal')?.signals?.[0]?.detail?.includes('secret-check'));
  const hidden = buildDetail(failed, [failed], { now: instant + 200, privateMode: true });
  const marker = hidden.rows.find(row => row.kind === 'signal')!;
  equal(marker.signals?.[0]?.label, 'Last check failed');
  ok(!JSON.stringify(hidden).includes('secret-check'));
  const loop = buildDetail(claude(repeats(3), 40), [claude(repeats(3), 40)], { now: instant + 40, privateMode: true });
  equal(loop.rows.find(row => row.loop)?.signals?.[0]?.detail, undefined);
});

test('Claude context levels come from the status-line percentage and need a fresh percentage', () => {
  const session = claude([prompt('start', 'Fixture', 0), response('end', 'start', 10, 'Done', 'end_turn')], 20);
  const label = (percent: number | undefined) => tree([session],
    { relayContexts: percent === undefined ? new Map() : new Map([[session.id, percent]]) })[0]?.warnings.map(view => view.label);
  deepEqual(label(50), []);
  deepEqual(label(75), ['Context High']);
  deepEqual(label(95), ['Context Critical']);
  deepEqual(label(undefined), []);
  const custom = tree([session], { relayContexts: new Map([[session.id, 75]]), thresholds: { warnPercent: 80, criticalPercent: 95 } });
  deepEqual(custom[0]?.warnings, []);
  const detail = buildDetail(session, [session], { now: instant + 20, privateMode: false, relayContext: 92 });
  equal(detail.contextLevel, 'Critical');
  equal(detail.signals.context?.label, 'Context Critical');
  equal(detail.signals.context?.tone, 'fail');
  equal(detail.agents[0]?.contextLevel, 'Critical');
  equal(buildDetail(session, [session], { now: instant + 20, privateMode: false }).contextLevel, undefined);
});

test('Codex context levels are approximate, cleared by compaction and absent without a known capacity', () => {
  const source = codexSource();
  const rows = (input: number, extra: unknown[] = [], window = true) => [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 1, { type: 'task_started', turn_id: 'one', ...(window ? { model_context_window: 100 } : {}) }),
    rollout('event_msg', 10, { type: 'token_count', info: { last_token_usage: { input_tokens: input } } }),
    ...extra,
  ];
  const labels = (input: number, extra: unknown[] = [], window = true) =>
    tree([reduceSession([fixtureEvidence(source, rows(input, extra, window))], instant + 20)!.session])[0]?.warnings.map(view => view.label);
  deepEqual(labels(75), ['Context High (approximate)']);
  deepEqual(labels(95), ['Context Critical (approximate)']);
  deepEqual(labels(40), []);
  deepEqual(labels(95, [], false), []);
  deepEqual(labels(95, [rollout('event_msg', 15, { type: 'item_completed', turn_id: 'one', item: { id: 'c', type: 'ContextCompaction' } })]), []);
});

/** Claude subagent: the Agent call row in the same session is the parent target of the child lane. */
test('Open parent from a Claude subagent lands on the Agent call row', () => {
  const main = fixtureEvidence(claudeSource(), [
    prompt('start', 'Parent fixture', 0),
    response('spawn', 'start', 10, [call('Agent', 'spawn-agent', { description: 'Reviewer' })]),
    result('spawn-out', 'spawn-agent', 20, { agentId: 'reviewer', isAsync: true }),
    response('done', 'spawn', 25, 'Parent done', 'end_turn'),
  ]);
  const reviewer = fixtureEvidence(claudeSource('reviewer'), [prompt('review', 'Inspect the fixture', 22)]);
  const meta = fixtureEvidence(claudeSource('reviewer', 'agent-metadata'), [
    { description: 'Fixture reviewer', toolUseId: 'spawn-agent', spawnDepth: 1, finished: true },
  ]);
  const session = reduceSession([main, reviewer, meta], instant + 30)!.session;
  const byId = new Map([[session.id, session]]);
  const root = parentInfo(session, session.lanes[0]!, byId, names);
  equal(root.state, 'root');
  equal(root.targets.length, 0);
  const info = parentInfo(session, session.lanes[1]!, byId, names);
  equal(info.state, 'resolved');
  equal(info.targets[0]?.sessionId, session.id);
  equal(info.targets[0]?.laneId, session.lanes[0]?.id);
  equal(info.targets[0]?.rowId, session.lanes[0]?.rows.find(row => row.label === 'Agent')?.id);
  const detail = buildDetail(session, [session], { now: instant + 30, privateMode: false });
  ok(detail.rows.some(row => row.id === info.targets[0]!.rowId && row.laneId === info.targets[0]!.laneId));
  equal(detail.agents[1]?.parentInfo.state, 'resolved');
  equal(detail.agents[0]?.parentInfo.state, 'root');
  equal(detail.parent.state, 'root');
});

test('an unresolved parent has a reason and the root has no action', () => {
  const main = fixtureEvidence(claudeSource(), [
    prompt('start', 'Parent fixture', 0),
    response('spawn', 'start', 10, [call('Agent', 'spawn-agent', { description: 'Reviewer', run_in_background: true })]),
    result('spawn-out', 'spawn-agent', 20, { agentId: 'reviewer', isAsync: true }),
  ]);
  const worker = (lane: string, target: string, id: string) => fixtureEvidence(claudeSource(lane), [
    prompt(lane + '-prompt', 'Inspect the fixture', 100),
    response(lane + '-reply', lane + '-prompt', 101, [call('Agent', id, { description: 'Worker' })]),
    result(lane + '-result', id, 102, { agentId: target }),
  ]);
  const session = reduceSession([main, worker('fixture-a', 'fixture-b', 'call-a'),
    worker('fixture-b', 'fixture-a', 'call-b')], instant + 103)!.session;
  const byId = new Map([[session.id, session]]);
  const cyclic = session.lanes.find(lane => lane.parentReason === 'Cyclic spawn evidence')!;
  const info = parentInfo(session, cyclic, byId, names);
  equal(info.state, 'unresolved');
  equal(info.reason, 'Cyclic spawn evidence');
  ok((info.reason ?? '').length > 0);
  deepEqual(info.targets, []);
  const orphan: Session = { ...session, parentReason: 'Parent session is not loaded' };
  const orphanInfo = parentInfo(orphan, orphan.lanes[0]!, byId, names);
  equal(orphanInfo.state, 'unresolved');
  equal(orphanInfo.reason, 'Parent session is not loaded');
  const summary = tree([orphan])[0]!;
  equal(summary.parent.state, 'unresolved');
  equal(summary.parent.reason, 'Parent session is not loaded');
});

test('Open parent from a Codex child thread lands on the spawn row and the breadcrumb lists the chain', async () => {
  const store = new SessionStore(undefined, () => instant + 10);
  const parent = codexSource();
  const child = codexSource(childId);
  catalog(store, 'codex', [parent, child]);
  ingest(store, parent, [
    rollout('session_meta', 0, { id: codexId, source: 'exec', cwd: fixtureRoot }),
    rollout('event_msg', 1, { type: 'task_started', turn_id: 'one' }),
    rollout('event_msg', 2, { type: 'item_completed', turn_id: 'one', item: { type: 'SubAgentActivity', id: 'spawn-fixture', agent_thread_id: childId, kind: 'started' } }),
  ]);
  ingest(store, child, [rollout('session_meta', 3, { id: childId, parent_thread_id: codexId, cwd: fixtureRoot })]);
  const sessions = await store.sessions();
  const parentSession = sessions.find(session => session.parents.length === 0 && session.lanes[0]?.rows.length)!;
  const childSession = sessions.find(session => session.parents.length > 0)!;
  const byId = new Map(sessions.map(session => [session.id, session]));
  const info = parentInfo(childSession, childSession.lanes[0]!, byId, names);
  equal(info.state, 'resolved');
  equal(info.targets[0]?.sessionId, parentSession.id);
  const detail = buildDetail(parentSession, sessions, { now: instant + 10, privateMode: false });
  ok(detail.rows.some(row => row.id === info.targets[0]!.rowId), 'the target row exists in the parent timeline');
  const childDetail = buildDetail(childSession, sessions, { now: instant + 10, privateMode: false });
  equal(childDetail.parent.state, 'resolved');
  const crumbs = childDetail.breadcrumb;
  ok(crumbs.length >= 4);
  equal(crumbs[0]?.target, undefined);
  equal(crumbs.at(-1)?.target, undefined);
  equal(crumbs.find(crumb => crumb.target?.rowId)?.target?.sessionId, parentSession.id);
  ok(crumbs.slice(1, -1).every(crumb => crumb.target?.sessionId === parentSession.id));
  equal(detail.breadcrumb.length, 2);
});

test('Open parent from a linked Codex run lands on the launching Claude Bash call and several launches list newest first', async () => {
  const store = new SessionStore(undefined, () => instant + 40);
  const claudeFile = claudeSource();
  const codex = codexSource();
  catalog(store, 'claude-code', [claudeFile]);
  catalog(store, 'codex', [codex]);
  ingest(store, claudeFile, [
    prompt('start', 'Run fixture', 0),
    response('launch', 'start', 5, [call('Bash', 'launcher', { command: 'codex exec --json fixture' })]),
    result('launch-result', 'launcher', 30, { stdout: `AGENT_LENS_CODEX_SESSION=${codexId}\n` }),
  ]);
  ingest(store, codex, [
    rollout('session_meta', 10, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 12, { type: 'task_started', turn_id: 'fixture-launch' }),
    rollout('event_msg', 20, { type: 'task_complete', turn_id: 'fixture-launch' }),
  ]);
  const sessions = await store.sessions();
  const claudeSession = sessions.find(session => session.provider === 'claude-code')!;
  const codexSession = sessions.find(session => session.provider === 'codex')!;
  const byId = new Map(sessions.map(session => [session.id, session]));
  const bash = claudeSession.lanes[0]!.rows.find(row => row.label === 'Bash')!;
  const info = parentInfo(codexSession, codexSession.lanes[0]!, byId, names);
  equal(info.state, 'resolved');
  equal(info.targets.length, 1);
  equal(info.targets[0]?.sessionId, claudeSession.id);
  equal(info.targets[0]?.rowId, bash.id);
  ok(buildDetail(claudeSession, sessions, { now: instant + 40, privateMode: false }).rows.some(row => row.id === bash.id));
  const detail = buildDetail(codexSession, sessions, { now: instant + 40, privateMode: false });
  equal(detail.agents.find(agent => agent.kind === 'main')?.parentInfo.targets[0]?.rowId, bash.id);
  equal(detail.breadcrumb.at(-1)?.target, undefined);
  ok(detail.breadcrumb.some(crumb => crumb.target?.rowId === bash.id));

  // The same thread launched twice: both launches are listed, newest first.
  const launch = codexSession.parents[0] ?? codexSession.launches![0]!.parent;
  const older = { ...launch, at: instant + 100 };
  const newer = { ...launch, at: instant + 900 };
  const resumed: Session = { ...codexSession, parents: [older, newer] };
  const choices = parentInfo(resumed, resumed.lanes[0]!, byId, names).targets;
  deepEqual(choices.map(choice => choice.at), [instant + 900, instant + 100]);
  ok(choices.every(choice => choice.label.length > 0 && choice.rowId === bash.id));
});

const candidate = (overrides: Partial<ContextCandidate> = {}): ContextCandidate => ({
  sessionId: 's', laneId: 'l', title: 'Fixture', level: 'High', percent: 75, approximate: false, at: instant + 10, epoch: 0, ...overrides,
});

test('context alerts fire once per session, lane, level and compaction epoch, and never for earlier samples', () => {
  const alerts = new ContextAlerts(instant);
  equal(alerts.next([candidate()]).length, 1);
  equal(alerts.next([candidate()]).length, 0, 'the same crossing is not repeated');
  equal(alerts.next([candidate({ level: 'Critical', percent: 95 })]).length, 1, 'a higher level alerts once');
  equal(alerts.next([candidate({ level: 'Critical', percent: 96 })]).length, 0);
  equal(alerts.next([candidate({ epoch: 1 })]).length, 1, 'a new epoch after compaction can alert again');
  equal(alerts.next([candidate({ laneId: 'other' })]).length, 1, 'another lane alerts separately');

  const jump = new ContextAlerts(instant);
  const first = jump.next([candidate({ level: 'Critical', percent: 95 })]);
  equal(first.length, 1);
  equal(first[0]?.level, 'Critical');
  equal(jump.next([candidate({ level: 'High', percent: 75 })]).length, 0, 'High is covered by the earlier Critical alert');

  const later = new ContextAlerts(instant + 1000);
  equal(later.next([candidate({ at: instant + 10 })]).length, 0, 'a sample from before the tracker started is historical');
  equal(later.next([candidate({ at: undefined })]).length, 0, 'a sample without a time cannot be shown to be current');
  later.reset(instant);
  equal(later.next([candidate({ at: instant + 10 })]).length, 1);
  equal(alertText(candidate({ approximate: true, level: 'Critical', percent: 91.4 })), 'Context Critical (approximate) at 91% in Fixture.');
});
