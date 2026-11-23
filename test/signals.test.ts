import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { reduceSession } from '../src/host/sessions/reduce';
import { SessionStore } from '../src/host/sessions/store';
import { checkMatcher, contextLevel, defaultSignalSettings, deriveContext, globToRegExp, ignoreMatcher, parseSignalSettings } from '../src/host/sessions/signals';
import type { Event, Source } from '../src/host/adapters/types';
import { adapters } from '../src/host/adapters/registry';
import { call, claudeSource, codexId, codexSource, fixtureEvents, fixtureEvidence, fixtureRoot, instant, prompt,
  response, result, rollout, stamp } from './fixtures/session';

function textResult(id: string, tool: string, at: number, text: string, isError = false) {
  return { type: 'user', uuid: id, timestamp: stamp(at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, is_error: isError, content: text }] } };
}

function read(id: string, path = 'src/export.ts') {
  return call('Read', id, { file_path: path });
}

/** A Claude lane with `count` repeated Read calls, each answered, starting at time 10. */
function repeats(count: number, finish = false) {
  const rows: unknown[] = [prompt('start', 'Fixture task', 0)];
  let parent = 'start';
  for (let index = 0; index < count; index++) {
    const uuid = 'read-' + index;
    rows.push(response(uuid, parent, 10 + index * 10, [read('r' + index)]), textResult('res-' + index, 'r' + index, 15 + index * 10, 'Fixture result'));
    parent = uuid;
  }
  if (finish) rows.push(response('end', parent, 10 + count * 10, 'Done', 'end_turn'));
  return rows;
}

function reduceClaude(rows: unknown[], at: number, settings = defaultSignalSettings) {
  return reduceSession([fixtureEvidence(claudeSource(), rows)], instant + at, () => undefined, undefined, [], settings)!;
}

test('a call repeated three times is a live loop that turns historical when a different call follows', () => {
  const live = reduceClaude(repeats(3), 40);
  const lane = live.session.lanes[0]!;
  equal(lane.status, 'Live');
  const loop = lane.signals.find(signal => signal.kind === 'loop')!;
  equal(loop.state, 'live');
  equal(loop.count, 3);
  equal(loop.label, 'Possible loop');
  equal(loop.detail, 'Read ×3');
  equal(loop.rowIds.length, 3);
  ok(loop.rowIds.every(id => lane.rows.some(row => row.id === id)));
  equal(live.session.signals.filter(signal => signal.kind === 'loop').length, 1);

  const rows = repeats(3);
  rows.push(response('other', 'read-2', 50, [read('other-call', 'src/other.ts')]), textResult('other-res', 'other-call', 55, 'Fixture result'));
  const after = reduceClaude(rows, 60).session.lanes[0]!.signals.find(signal => signal.kind === 'loop')!;
  equal(after.state, 'historical');
  equal(after.count, 3);
  equal(after.id, loop.id);
});

test('two repeats stay below the default threshold and a lower or higher threshold is honoured', () => {
  equal(reduceClaude(repeats(2), 30).session.signals.length, 0);
  const strict = parseSignalSettings({ loopThreshold: 2 });
  equal(reduceClaude(repeats(2), 30, strict).session.signals.filter(signal => signal.kind === 'loop').length, 1);
  const lenient = parseSignalSettings({ loopThreshold: 5 });
  equal(reduceClaude(repeats(4), 50, lenient).session.signals.length, 0);
  equal(reduceClaude(repeats(5), 60, lenient).session.signals.filter(signal => signal.kind === 'loop').length, 1);
});

test('assistant text between identical calls does not break a streak but a different call in the same lane does', () => {
  const rows: unknown[] = [prompt('start', 'Fixture task', 0)];
  rows.push(response('a', 'start', 10, [read('r1')]), textResult('a-res', 'r1', 15, 'ok'));
  rows.push(response('b', 'a', 20, [{ type: 'text', text: 'Thinking aloud' }, read('r2')]), textResult('b-res', 'r2', 25, 'ok'));
  rows.push(response('c', 'b', 30, [read('r3')]), textResult('c-res', 'r3', 35, 'ok'));
  rows.push(response('d', 'c', 40, [read('r4', 'src/else.ts')]), textResult('d-res', 'r4', 45, 'ok'));
  rows.push(response('e', 'd', 50, [read('r5')]), textResult('e-res', 'r5', 55, 'ok'));
  const loops = reduceClaude(rows, 60).session.signals.filter(signal => signal.kind === 'loop');
  equal(loops.length, 1);
  equal(loops[0]?.count, 3);
});

test('polling counts as a repeat only while the result is unchanged and calls without a result do not extend a streak', () => {
  const poll = (index: number) => call('TaskOutput', 'poll-' + index, { task_id: 'fixture-task' });
  const build = (texts: string[]) => {
    const rows: unknown[] = [prompt('start', 'Wait for it', 0)];
    let parent = 'start';
    texts.forEach((text, index) => {
      rows.push(response('p' + index, parent, 10 + index * 10, [poll(index)]), textResult('pr' + index, 'poll-' + index, 15 + index * 10, text));
      parent = 'p' + index;
    });
    return rows;
  };
  equal(reduceClaude(build(['running', 'running 2', 'running 3', 'running 4']), 60).session.signals.length, 0);
  const unchanged = reduceClaude(build(['still running', 'still running', 'still running']), 60).session.signals;
  equal(unchanged.length, 1);
  equal(unchanged[0]?.count, 3);
  // The third call has no result yet, so the streak is only two long.
  const rows = build(['same', 'same']);
  rows.push(response('p2', 'p1', 30, [poll(2)]));
  equal(reduceClaude(rows, 40).session.signals.length, 0);
});

test('loops do not cross lanes and every loop is counted once with its final length in the ledger', async () => {
  const store = new SessionStore(undefined, () => instant + 40);
  const source = claudeSource();
  store.setCatalog('claude-code', adapters.find(adapter => adapter.id === 'claude-code')!, new Map([[source.key, source]]));
  const events = fixtureEvents(source, repeats(3));
  store.ingest({ source, generation: 1, committed: events.length, reset: true, readerEpoch: 1, events, more: false,
    diagnostics: { unknown: 0, malformed: 0, oversized: 0 } });
  await store.sessions();
  await store.sessions();
  const counts = store.ledger.runTotals().reduce((sum, run) => ({ loops: sum.loops + run.counts.loopStreaks,
    longest: Math.max(sum.longest, run.counts.longestLoop) }), { loops: 0, longest: 0 });
  deepEqual(counts, { loops: 1, longest: 3 });
});

function editCall(id: string, path: string) {
  return call('Edit', id, { file_path: path, old_string: 'before', new_string: 'after' });
}

function bash(id: string, command: string) {
  return call('Bash', id, { command });
}

/** One Completed Claude turn: optional edits, then optional commands with explicit results, then an end. */
function turn(steps: { edit?: string; command?: string; error?: boolean }[]) {
  const rows: unknown[] = [prompt('start', 'Change the code', 0)];
  let parent = 'start';
  let at = 10;
  steps.forEach((step, index) => {
    const uuid = 's' + index;
    const id = 'call-' + index;
    rows.push(response(uuid, parent, at, [step.edit ? editCall(id, step.edit) : bash(id, step.command ?? 'echo ok')]));
    rows.push(textResult('res-' + index, id, at + 5, step.edit ? 'Edited' : 'Command output', step.error === true));
    parent = uuid;
    at += 10;
  });
  rows.push(response('end', parent, at, 'Finished', 'end_turn'));
  return rows;
}

function outcome(session: ReturnType<typeof reduceClaude>['session']) {
  return session.signals.find(signal => signal.kind === 'check');
}

async function evaluate(rows: unknown[], at = 200) {
  const store = new SessionStore(undefined, () => instant + at);
  const source = claudeSource();
  store.setCatalog('claude-code', adapters.find(adapter => adapter.id === 'claude-code')!, new Map([[source.key, source]]));
  const events = fixtureEvents(source, rows);
  store.ingest({ source, generation: 1, committed: events.length, reset: true, readerEpoch: 1, events, more: false,
    diagnostics: { unknown: 0, malformed: 0, oversized: 0 } });
  return (await store.sessions())[0]!;
}

test('Done without checks reports edits with no later check, a failed check and an unknown result', async () => {
  const none = outcome(await evaluate(turn([{ edit: 'src/app.ts' }, { edit: 'src/more.ts' }])))!;
  equal(none.label, 'No checks after edits');
  equal(none.detail, '2 files changed');
  equal(none.outcome, 'no-checks');
  ok(none.edit);

  const failed = outcome(await evaluate(turn([{ edit: 'src/app.ts' }, { command: 'npm run test', error: true }])))!;
  equal(failed.label, 'Last check failed');
  equal(failed.outcome, 'check-failed');
  ok(failed.check);
  ok(failed.detail?.startsWith('npm run test'));
});

test('a passing latest check, a check before the edit and docs-only edits give no outcome or a stale one', async () => {
  equal(outcome(await evaluate(turn([{ edit: 'src/app.ts' }, { command: 'npm run test' }]))), undefined);
  equal(outcome(await evaluate(turn([{ command: 'npm test' }, { edit: 'src/app.ts' }])))?.label, 'No checks after edits');
  equal(outcome(await evaluate(turn([{ edit: 'README.md' }, { edit: 'docs/guide.mdx' }, { edit: 'notes.txt' }]))), undefined);
  equal(outcome(await evaluate(turn([{ edit: 'docs/guide.md' }, { edit: 'src/app.ts' }])))?.detail, '1 file changed');
  equal(outcome(await evaluate(turn([{ edit: 'src/app.ts' }, { command: 'echo build done' }])))?.label, 'No checks after edits');
  // A failing check followed by a passing one leaves nothing to report.
  equal(outcome(await evaluate(turn([{ edit: 'src/app.ts' }, { command: 'npx tsc --noEmit', error: true }, { command: 'npm run lint' }]))), undefined);
});

test('turns that are not Completed get no badge and late evidence re-evaluates the outcome', async () => {
  const rows = turn([{ edit: 'src/app.ts' }]);
  const open = rows.slice(0, -1);
  equal(outcome(await evaluate(open, 500_000)), undefined);
  equal(outcome(await evaluate(rows))?.label, 'No checks after edits');
  const extended = [...rows, prompt('next', 'Run the tests', 100, 'end'),
    response('run', 'next', 110, [bash('late', 'npm run test')]), textResult('late-res', 'late', 115, 'ok'),
    response('end-two', 'run', 120, 'Passed', 'end_turn')];
  const session = await evaluate(extended);
  const first = session.signals.find(signal => signal.kind === 'check');
  equal(first?.state, 'historical');
  equal(session.status === 'Live', false);
});

test('Codex results without an exit code are reported as an unknown check result', () => {
  const source = codexSource();
  const records = [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 1, { type: 'task_started', turn_id: 'one' }),
    rollout('event_msg', 5, { type: 'item_completed', turn_id: 'one', item: {
      id: 'edit', type: 'FileChange', status: 'completed', changes: { 'src/app.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b' } } } }),
    rollout('event_msg', 10, { type: 'item_completed', turn_id: 'one', item: {
      id: 'check', type: 'CommandExecution', command: ['npm', 'run', 'test'], status: 'completed' } }),
    rollout('event_msg', 20, { type: 'task_complete', turn_id: 'one' }),
  ];
  const reduced = reduceSession([fixtureEvidence(source, records)], instant + 30)!;
  equal(reduced.evidence.edits.length, 1);
  equal(reduced.evidence.checks[0]?.result, 'unknown');
  const exit = [...records];
  exit[3] = rollout('event_msg', 10, { type: 'item_completed', turn_id: 'one', item: {
    id: 'check', type: 'CommandExecution', command: ['npm', 'run', 'test'], status: 'completed', exit_code: 0 } });
  equal(reduceSession([fixtureEvidence(source, exit)], instant + 30)!.evidence.checks[0]?.result, 'passed');
});

function ingest(store: SessionStore, source: Source, rows: unknown[]) {
  const events: Event[] = fixtureEvents(source, rows);
  store.ingest({ source, generation: 1, committed: events.length, reset: true, readerEpoch: 1, events, more: false,
    diagnostics: { unknown: 0, malformed: 0, oversized: 0 } });
}

test('a Codex edit followed by a Claude check in the same turn tree counts as checked', async () => {
  const claude = claudeSource();
  const codex = codexSource();
  const launcher = (checkAt: number | undefined) => {
    const rows: unknown[] = [
      prompt('start', 'Run fixture', 0),
      response('launch', 'start', 5, [bash('launcher', 'codex exec --json fixture')]),
      result('launch-result', 'launcher', 30, { stdout: `AGENT_LENS_CODEX_SESSION=${codexId}\n` }),
    ];
    let parent = 'launch';
    if (checkAt !== undefined) {
      rows.push(response('check', parent, checkAt, [bash('check-call', 'npm run test')]), textResult('check-result', 'check-call', checkAt + 5, 'ok'));
      parent = 'check';
    }
    rows.push(response('end', parent, 90, 'Done', 'end_turn'));
    return rows;
  };
  const codexRows = [
    rollout('session_meta', 10, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 12, { type: 'task_started', turn_id: 'fixture-launch' }),
    rollout('event_msg', 15, { type: 'item_completed', turn_id: 'fixture-launch', item: {
      id: 'edit', type: 'FileChange', status: 'completed', changes: { 'src/app.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b' } } } }),
    rollout('event_msg', 20, { type: 'task_complete', turn_id: 'fixture-launch' }),
  ];
  const run = async (checkAt: number | undefined) => {
    const store = new SessionStore(undefined, () => instant + 200);
    store.setCatalog('claude-code', adapters.find(adapter => adapter.id === 'claude-code')!, new Map([[claude.key, claude]]));
    store.setCatalog('codex', adapters.find(adapter => adapter.id === 'codex')!, new Map([[codex.key, codex]]));
    ingest(store, claude, launcher(checkAt));
    ingest(store, codex, codexRows);
    return store.sessions();
  };
  const without = await run(undefined);
  const claudeSession = without.find(session => session.provider === 'claude-code')!;
  equal(claudeSession.signals.find(signal => signal.kind === 'check')?.label, 'No checks after edits');
  equal(without.find(session => session.provider === 'codex')?.signals.some(signal => signal.kind === 'check'), false);
  const checked = await run(60);
  equal(checked.find(session => session.provider === 'claude-code')?.signals.some(signal => signal.kind === 'check'), false);
});

test('context levels come from a percentage, clear after compaction or a stale sample, and need capacity', () => {
  const source = codexSource();
  const rows = (percentInput: number, extra: unknown[] = []) => [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 1, { type: 'task_started', turn_id: 'one', model_context_window: 100 }),
    rollout('event_msg', 10, { type: 'token_count', info: { last_token_usage: { input_tokens: percentInput } } }),
    ...extra,
  ];
  const levelOf = (input: number, extra: unknown[] = [], now = 20) =>
    reduceSession([fixtureEvidence(source, rows(input, extra))], instant + now)!.session.lanes[0]!.context;
  equal(levelOf(50)?.level, 'Normal');
  equal(levelOf(70)?.level, 'High');
  equal(levelOf(89)?.level, 'High');
  equal(levelOf(90)?.level, 'Critical');
  equal(levelOf(90)?.approximate, true);
  equal(levelOf(90, [], 20 + 11 * 60_000)?.level, undefined);
  const high = reduceSession([fixtureEvidence(source, rows(95))], instant + 20)!;
  equal(high.session.lanes[0]?.signals.find(signal => signal.kind === 'context')?.label, 'Context critical (approximate)');
  const compacted = levelOf(95, [rollout('event_msg', 15, { type: 'item_completed', turn_id: 'one', item: { id: 'c', type: 'ContextCompaction' } })]);
  equal(compacted?.level, undefined);
  // Unknown capacity gives no percentage and so no level.
  const unknown = reduceSession([fixtureEvidence(source, [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('event_msg', 1, { type: 'task_started', turn_id: 'one' }),
    rollout('event_msg', 10, { type: 'token_count', info: { last_token_usage: { input_tokens: 99 } } }),
  ])], instant + 20)!.session.lanes[0]!.context;
  equal(unknown?.percent, undefined);
  equal(unknown?.level, undefined);
});

test('context history keeps one crossing per compaction epoch and flags compaction after a crossing', () => {
  const sample = (percent: number, at: number) => ({ kind: 'sample' as const, sample: { percent, approximate: true, at: instant + at } });
  const history = deriveContext('lane', [sample(75, 1), sample(95, 2), sample(96, 3), { kind: 'compaction' }, sample(80, 4), { kind: 'compaction' }, sample(10, 5)],
    defaultSignalSettings, instant + 6);
  deepEqual(history.ledger.map(entry => entry.kind), ['context-critical', 'compaction-after-crossing', 'context-high', 'compaction-after-crossing']);
  equal(new Set(history.ledger.map(entry => entry.id)).size, 4);
  equal(history.epoch, 2);
  equal(history.current?.level, 'Normal');
  equal(deriveContext('lane', [sample(95, 1), { kind: 'compaction' }], defaultSignalSettings, instant + 2).current, undefined);
  equal(deriveContext('lane', [{ kind: 'sample', sample: { approximate: false, input: 5 } }], defaultSignalSettings, instant).current, undefined);
});

test('settings are validated and fall back to the documented defaults', () => {
  const bad = parseSignalSettings({ loopThreshold: 1, warnPercent: 95, criticalPercent: 80, checkIgnore: 'x', checkCommands: 'x' });
  equal(bad.loopThreshold, 3);
  equal(bad.warnPercent, 70);
  equal(bad.criticalPercent, 90);
  deepEqual([...bad.checkIgnore], ['**/*.md', '**/*.mdx', '**/*.txt']);
  equal(bad.checkCommands.length, 0);
  const good = parseSignalSettings({ loopThreshold: 4, warnPercent: 60, criticalPercent: 85 });
  deepEqual([good.loopThreshold, good.warnPercent, good.criticalPercent], [4, 60, 85]);
  equal(contextLevel(60, good), 'High');
  equal(contextLevel(59.9, good), 'Normal');
  equal(contextLevel(undefined, good), undefined);
});

test('check patterns match recorded commands as text, per project root, and bad patterns are dropped', () => {
  const defaults = checkMatcher(defaultSignalSettings);
  for (const command of ['npm test', 'npm run lint', 'pnpm typecheck', 'yarn build', 'bun run check', 'tsc --noEmit', 'npx tsc -p .',
    'vitest run', 'npx jest', 'eslint .', 'pytest -q', 'cargo test', 'cargo clippy', 'go vet ./...', 'dotnet build', 'cd app && npm run test']) {
    ok(defaults(command), command);
  }
  for (const command of ['echo test', 'npm install', 'git commit -m "tsc"', 'cat build.log']) equal(defaults(command), false, command);
  const custom = parseSignalSettings({ checkCommands: { '*': ['^make verify'], 'X:/Fixture/App': { replace: true, patterns: ['^just ci$', '['] } } });
  ok(checkMatcher(custom)('make verify'));
  ok(checkMatcher(custom)('npm test'));
  const scoped = checkMatcher(custom, 'X:\\Fixture\\App\\');
  ok(scoped('just ci'));
  equal(scoped('npm test'), false);
  ok(scoped('make verify'));
});

test('ignore globs match docs anywhere in a path and keep source files', () => {
  const ignored = ignoreMatcher(['**/*.md', '**/*.mdx', '**/*.txt']);
  for (const path of ['README.md', 'docs/guide.md', 'X:\\Fixture\\docs\\page.mdx', 'a/b/notes.txt']) ok(ignored(path), path);
  for (const path of ['src/app.ts', 'src/readme.md.ts', 'notes.txt.bak']) equal(ignored(path), false, path);
  ok(globToRegExp('src/**/*.gen.ts').test('src/a/b/x.gen.ts'));
  ok(globToRegExp('src/**/*.gen.ts').test('src/x.gen.ts'));
});

test('stable ids do not change between refreshes', () => {
  const first = reduceClaude(repeats(3), 40).session.signals[0]!.id;
  const second = reduceClaude(repeats(3), 45).session.signals[0]!.id;
  equal(first, second);
});
