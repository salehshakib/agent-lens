import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { adapters } from '../src/host/adapters/registry';
import type { Event, Source } from '../src/host/adapters/types';
import { discoverSources } from '../src/host/discovery/catalog';
import type { ApprovedRoot } from '../src/host/discovery/roots';
import { sourceSessionId } from '../src/host/sessions/evidence';
import { mergeTimeline } from '../src/host/sessions/items';
import { resolveProject } from '../src/host/sessions/project';
import { reduceSession } from '../src/host/sessions/reduce';
import { SessionStore } from '../src/host/sessions/store';
import { call, childId, claudeId, claudeSource, codexId, codexSource, fixtureEvents, fixtureEvidence,
  fixtureRoot, instant, prompt, response, result, rollout } from './fixtures/session';

function catalog(store: SessionStore, provider: Source['provider'], sources: Source[]) {
  store.setCatalog(provider, adapters.find(adapter => adapter.id === provider)!, new Map(sources.map(source => [source.key, source])));
}

function batch(store: SessionStore, source: Source, events: Event[], generation = 1, committed = events.length) {
  store.ingest({ source, generation, committed, reset: committed === events.length, readerEpoch: 1, events, more: false,
    diagnostics: { unknown: 0, malformed: 0, oversized: 0 } });
}

test('Claude branches keep split blocks and attach an early result to its exact tool and turn', () => {
  const records = [
    prompt('first', 'Fixture prompt', 0),
    result('early-result', 'read', 15, undefined, 'same-response'),
    response('same-response', 'first', 10, [call('Read', 'read', { file_path: 'example.ts', offset: 2, limit: 3 })], 'tool_use', 0),
    response('same-response', 'first', 10, [{ type: 'text', text: 'Fixture progress' }], 'tool_use', 1),
    response('first-end', 'same-response', 20, 'First result', 'end_turn'),
    prompt('second', 'Other fixture prompt', 30, 'first'),
    response('second-end', 'second', 40, 'Second result', 'end_turn'),
    { type: 'last-prompt', lastPrompt: 'Other fixture prompt', leafUuid: 'second-end' },
  ];
  const { session, tools } = reduceSession([fixtureEvidence(claudeSource(), records)], instant + 40)!;
  const lane = session.lanes[0]!;
  deepEqual(lane.turns.map(turn => turn.state), ['Completed', 'Completed']);
  const read = lane.rows.find(row => row.label === 'Read')!;
  equal(read.output, 'Fixture result');
  equal(read.turnId, lane.turns[0]?.id);
  equal(read.currentBranch, false);
  equal(lane.rows.at(-1)?.currentBranch, true);
  equal(lane.rows.find(row => row.text === 'Fixture progress')?.responseId, read.responseId);
  equal(session.usage?.total, 48);
  equal(session.files[0]?.rowId, read.id);
  equal(session.files[0]?.status, 'read');
  equal(tools.length, 1);
});

test('Claude child metadata joins late and ambiguous or cyclic spawn evidence stays unresolved', () => {
  const mainSource = claudeSource();
  const main = fixtureEvidence(mainSource, [
    prompt('start', 'Parent fixture', 0),
    response('spawn', 'start', 10, [call('Agent', 'spawn-agent', { description: 'Reviewer', run_in_background: true })]),
    result('spawn-out', 'spawn-agent', 20, { agentId: 'reviewer', isAsync: true }),
    response('done', 'spawn', 25, 'Parent done', 'end_turn'),
  ]);
  const pending = reduceSession([main], instant + 30)!.session;
  equal(pending.lanes[1]?.pending, true);
  equal(pending.lanes[0]?.status, 'Completed');
  equal(pending.status, 'Live');

  const reviewer = fixtureEvidence(claudeSource('reviewer'), [prompt('review', 'Inspect the fixture', 22)]);
  const meta = fixtureEvidence(claudeSource('reviewer', 'agent-metadata'), [
    { description: 'Fixture reviewer', toolUseId: 'spawn-agent', spawnDepth: 1, finished: true },
  ]);
  const complete = reduceSession([main, reviewer, meta], instant + 30)!.session;
  equal(complete.lanes.length, 2);
  equal(complete.lanes[1]?.status, 'Completed');
  equal(complete.lanes[1]?.parent?.rowId, complete.lanes[0]?.rows.find(row => row.label === 'Agent')?.id);

  const worker = (lane: string, target: string, id: string) => fixtureEvidence(claudeSource(lane), [
    prompt(lane + '-prompt', 'Inspect the fixture', 100),
    response(lane + '-reply', lane + '-prompt', 101, [call('Agent', id, { description: 'Worker' })]),
    result(lane + '-result', id, 102, { agentId: target }),
  ]);
  const cycle = reduceSession([main, worker('fixture-a', 'fixture-b', 'call-a'),
    worker('fixture-b', 'fixture-a', 'call-b')], instant + 103)!.session;
  ok(cycle.lanes.slice(1).some(lane => lane.parentReason === 'Cyclic spawn evidence'));
  const wrongBucket = fixtureEvidence(claudeSource('reviewer', 'agent-metadata', 'other-project'), [{ toolUseId: 'spawn-agent' }]);
  equal(reduceSession([main, wrongBucket], instant + 30)!.session.lanes[1]?.parent, undefined);
});

test('Codex keeps turn identity, reconciles structured copies and separates command failure from completion', () => {
  const source = codexSource();
  const records = [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 0, { type: 'thread_settings_applied', thread_settings: { model: 'thread-default' } }),
    rollout('turn_context', 1, { turn_id: 'one', model: 'fixture-turn-model', effort: 'high' }),
    rollout('event_msg', 10, { type: 'task_started', turn_id: 'one', model_context_window: 100 }),
    rollout('response_item', 11, { type: 'function_call_output', call_id: 'early-output', output: 'Output fixture' }),
    rollout('response_item', 12, { type: 'function_call', call_id: 'early-output', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'npm run check' }) }),
    rollout('event_msg', 13, { type: 'item_completed', turn_id: 'one', item: {
      id: 'exact-command', type: 'CommandExecution', command: ['npm', 'run', 'check'], status: 'failed', exit_code: 1 } }),
    rollout('response_item', 14, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final fixture' }] }),
    rollout('event_msg', 15, { type: 'token_count', info: { last_token_usage: { input_tokens: 60 } } }),
    rollout('event_msg', 16, { type: 'task_complete', turn_id: 'one', last_agent_message: 'Final fixture' }),
    rollout('event_msg', 20, { type: 'task_started', turn_id: 'two' }),
    rollout('event_msg', 21, { type: 'task_complete', turn_id: 'one' }),
  ];
  const provisional = reduceSession([fixtureEvidence(source, records.slice(0, 6))], instant + 12)!;
  let reduced = reduceSession([fixtureEvidence(source, records)], instant + 22)!;
  let lane = reduced.session.lanes[0]!;
  deepEqual(lane.turns.map(turn => [turn.nativeId, turn.state]), [['one', 'Completed'], ['two', 'Live']]);
  equal(lane.rows.filter(row => row.kind === 'tool').length, 1);
  equal(lane.rows.find(row => row.kind === 'tool')?.id, provisional.session.lanes[0]?.rows[0]?.id);
  equal(lane.rows.find(row => row.kind === 'tool')?.output, 'Output fixture');
  equal(lane.rows.filter(row => row.kind === 'final').length, 1);
  equal(reduced.tools[0]?.exitCode, 1);
  equal(lane.turns[0]?.model, 'fixture-turn-model');
  equal(lane.turns[1]?.model, 'thread-default');
  equal(lane.context?.percent, 60);

  records.push(rollout('event_msg', 30, { type: 'task_complete', turn_id: 'two', error: { message: 'Failed fixture' } }));
  reduced = reduceSession([fixtureEvidence(source, records)], instant + 100_000)!;
  lane = reduced.session.lanes[0]!;
  equal(lane.turns[1]?.state, 'Failed');
});

test('Codex repeats stay separate and stale writer hints do not make a thread live', () => {
  const source = { ...codexSource(), writerPresent: true };
  const repeated = [rollout('event_msg', 0, { type: 'task_started', turn_id: 'turn' })];
  for (let index = 0; index < 2; index++) repeated.push(
    rollout('response_item', 10 + index, { type: 'function_call', call_id: 'command-' + index, name: 'shell',
      arguments: JSON.stringify({ command: 'echo fixture' }) }),
    rollout('event_msg', 12 + index, { type: 'item_completed', turn_id: 'turn', item: {
      type: 'CommandExecution', id: 'completed-' + index, command: ['echo', 'fixture'], status: 'completed', exit_code: 0,
    } }),
  );
  const reduced = reduceSession([fixtureEvidence(source, repeated)], instant + 60_000)!;
  equal(reduced.session.status, 'Writer present');
  equal(reduced.tools.length, 2);
  equal(reduced.session.lanes[0]?.rows.filter(row => row.ambiguous).length, 2);
});

test('the store joins a late Codex child and keeps identical thread IDs isolated by source home', async () => {
  const store = new SessionStore(undefined, () => instant + 10);
  const parent = codexSource();
  const child = codexSource(childId);
  const separate = codexSource(childId, 'fixture-separate');
  catalog(store, 'codex', [parent, separate]);
  batch(store, parent, fixtureEvents(parent, [
    rollout('session_meta', 0, { id: codexId, source: 'exec' }),
    rollout('event_msg', 1, { type: 'task_started', turn_id: 'one' }),
    rollout('event_msg', 2, { type: 'item_completed', turn_id: 'one', item: {
      type: 'SubAgentActivity', id: 'spawn-fixture', agent_thread_id: childId, kind: 'started',
    } }),
  ]));
  let sessions = await store.sessions();
  equal(sessions.find(session => session.id === sourceSessionId(parent))?.lanes[1]?.pending, true);
  catalog(store, 'codex', [parent, child, separate]);
  batch(store, child, fixtureEvents(child, [rollout('session_meta', 3, { id: childId, parent_thread_id: codexId })]));
  sessions = await store.sessions();
  const parentSession = sessions.find(session => session.id === sourceSessionId(parent));
  equal(sessions.find(session => session.id === sourceSessionId(child))?.parents[0]?.rowId, parentSession?.lanes[0]?.rows[0]?.id);
  equal(parentSession?.lanes.length, 1);
  equal(sessions.find(session => session.id === sourceSessionId(separate))?.parents.length, 0);
});

test('the store links a late approved rollout to the exact Claude Bash row without a duplicate session', async () => {
  const store = new SessionStore(undefined, () => instant + 40);
  const claude = claudeSource();
  const codex = codexSource();
  catalog(store, 'claude-code', [claude]);
  batch(store, claude, fixtureEvents(claude, [
    prompt('start', 'Run fixture', 0),
    response('launch', 'start', 5, [call('Bash', 'launcher', { command: 'codex exec --json fixture' })]),
    result('launch-result', 'launcher', 30, { stdout: `AGENT_LENS_CODEX_SESSION=${codexId}\n` }),
  ]));
  equal((await store.sessions())[0]?.children.length, 0);
  catalog(store, 'codex', [codex]);
  batch(store, codex, fixtureEvents(codex, [
    rollout('session_meta', 10, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 12, { type: 'task_started', turn_id: 'fixture-launch' }),
    rollout('event_msg', 20, { type: 'task_complete', turn_id: 'fixture-launch' }),
  ]));
  const sessions = await store.sessions();
  equal(sessions.length, 2);
  const launch = sessions.find(session => session.provider === 'codex')?.launches?.[0];
  const bash = sessions.find(session => session.provider === 'claude-code')?.lanes[0]?.rows.find(row => row.label === 'Bash');
  equal(launch?.parent.rowId, bash?.id);
  equal(launch?.turnId, sessions.find(session => session.provider === 'codex')?.lanes[0]?.turns[0]?.id);
});

test('historical selection is lazy and generation replacement clears file evidence and tool counts', async (t) => {
  const home = await mkdtemp(join(fixtureRoot, '.phase-b-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const history = join(home, 'projects');
  const project = join(history, 'synthetic');
  await mkdir(project, { recursive: true });
  const path = join(project, claudeId + '.jsonl');
  const original = [prompt('first', 'Original fixture', 0), response('first-reply', 'first', 10,
    [call('Read', 'read-fixture', { file_path: 'fixture.ts' })]), result('first-result', 'read-fixture', 15)];
  await writeFile(path, original.map(row => JSON.stringify(row)).join('\n') + '\n');
  const root: ApprovedRoot = { key: basename(home), adapter: adapters[0], boundary: home, history,
    profile: { id: 'fixture', label: 'Fixture', provider: 'claude-code', home } };
  const { sources } = await discoverSources(root, new AbortController().signal);
  const source = [...sources.values()][0]!;
  const id = sourceSessionId(source);
  let now = instant + 100;
  const store = new SessionStore(undefined, () => now);
  store.setCatalog(root.key, root.adapter, sources);
  equal((await store.sessions())[0]?.lanes[0]?.rows.length, 0);
  const selected = await store.materialize(id);
  equal(selected?.title, 'Original fixture');
  equal(selected?.files.length, 1);
  equal(store.file(selected!.files[0]!.id)?.path.endsWith('fixture.ts'), true);
  equal(store.ledger.runTotals().reduce((sum, item) => sum + item.counts.pairedTools, 0), 1);

  batch(store, source, fixtureEvents(source, [prompt('new', 'Replacement fixture', 30)]), 2);
  equal(store.file(selected!.files[0]!.id), undefined);
  equal((await store.sessions())[0]?.title, 'Replacement fixture');
  equal((await store.sessions())[0]?.files.length, 0);
  equal(store.ledger.runTotals().length, 0);
  batch(store, source, fixtureEvents(source, original), 1);
  equal((await store.sessions())[0]?.title, 'Replacement fixture');
  now += 60_000;
  equal((await store.sessions())[0]?.status, 'Outcome unknown');
});

test('opening a historical launcher materializes its explicitly identified Codex thread', async (t) => {
  const scratch = await mkdtemp(join(fixtureRoot, '.phase-b-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const claudeHome = join(scratch, 'claude-home');
  const codexHome = join(scratch, 'codex-home');
  const claudeRoot = join(claudeHome, 'projects');
  const codexRoot = join(codexHome, 'sessions');
  const bucket = join(claudeRoot, 'fixture-project');
  const date = join(codexRoot, '2031', '04', '05');
  await mkdir(bucket, { recursive: true });
  await mkdir(date, { recursive: true });
  const stringify = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(join(bucket, claudeId + '.jsonl'), stringify([
    prompt('history', 'Historical fixture', 0),
    response('launcher', 'history', 5, [call('Bash', 'fixture-launcher', { command: 'codex exec --json fixture' })]),
    result('launcher-result', 'fixture-launcher', 30, { stdout: 'AGENT_LENS_CODEX_SESSION=' + codexId + '\n' }),
  ]));
  await writeFile(join(date, basename(codexSource().path)), stringify([
    rollout('session_meta', 10, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 15, { type: 'task_started', turn_id: 'old-fixture-turn' }),
    rollout('event_msg', 20, { type: 'task_complete', turn_id: 'old-fixture-turn' }),
  ]));
  const store = new SessionStore(undefined, () => instant + 60_000);
  const roots: ApprovedRoot[] = [
    { key: 'claude-fixture', adapter: adapters[0], boundary: claudeHome, history: claudeRoot,
      profile: { id: 'claude', provider: 'claude-code', home: claudeHome, label: 'Fixture Claude' } },
    { key: 'codex-fixture', adapter: adapters[1], boundary: codexHome, history: codexRoot,
      profile: { id: 'codex', provider: 'codex', home: codexHome, label: 'Fixture Codex' } },
  ];
  for (const root of roots) {
    const { sources } = await discoverSources(root, new AbortController().signal);
    store.setCatalog(root.key, root.adapter, sources);
  }
  const before = await store.sessions();
  equal(before.length, 2);
  ok(before.every(session => session.lanes[0]?.rows.length === 0));
  const selected = await store.materialize(before.find(session => session.provider === 'claude-code')!.id);
  equal(selected?.children.length, 1);
  equal((await store.sessions()).find(session => session.provider === 'codex')?.launches?.[0]?.role, 'fresh');
});

test('recorded project identities distinguish worktrees and the mixed timeline preserves lane order', async (t) => {
  const repo = await mkdtemp(join(fixtureRoot, '.phase-b-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const worktree = join(repo, 'fixture-worktree');
  const nested = join(worktree, 'src');
  await mkdir(nested, { recursive: true });
  await writeFile(join(worktree, '.git'), 'gitdir: fixture-metadata\n');
  equal((await resolveProject(nested)).root, worktree);
  equal((await resolveProject(join(repo, 'missing-fixture'))).state, 'unresolved');
  equal((await resolveProject('\\\\fixture-server\\fixture-share')).state, 'remote');
  const rows = mergeTimeline([
    { rows: [{ id: 'a1', laneId: 'a', kind: 'user', label: 'fixture', at: 20 },
      { id: 'a2', laneId: 'a', kind: 'user', label: 'fixture', at: 10 }] },
    { rows: [{ id: 'b1', laneId: 'b', kind: 'user', label: 'fixture', at: 15 }] },
  ]);
  deepEqual(rows.map(row => row.id), ['b1', 'a1', 'a2']);
});
