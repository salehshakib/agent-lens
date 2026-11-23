import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseClaudeRecords } from '../src/host/adapters/claude-code/records';
import { extractCodexStartupEvidence } from '../src/host/adapters/claude-code/tools';
import { adapters } from '../src/host/adapters/registry';
import type { Event, Source } from '../src/host/adapters/types';
import { discoverSources } from '../src/host/discovery/catalog';
import { SourceReader } from '../src/host/discovery/reader';
import {
  claudeTaskRoot, delegationThreadId, resolveDelegations, TaskStartupReader,
} from '../src/host/sessions/delegation';
import type { ClaudeLaunchCandidate, CodexLaunchCandidate } from '../src/host/sessions/delegation';
import { parseCodexInvocation } from '../src/host/sessions/launch-command';
import type { Turn } from '../src/host/sessions/types';

const claudeId = '42000000-0000-4000-8000-000000000001';
const codexId = '42000000-0000-4000-8000-000000000002';
const otherId = '42000000-0000-4000-8000-000000000003';
const time = Date.parse('2035-05-06T08:00:00Z');
const cwd = resolve('test/fixtures/synthetic-launch-project');
const otherCwd = resolve('test/fixtures/synthetic-other-project');
const claudeHome = resolve('test/fixtures/synthetic-claude-home');
const claudeSource: Source = {
  key: 'synthetic-child-log', provider: 'claude-code', home: claudeHome, root: join(claudeHome, 'projects'),
  path: join(claudeHome, 'projects', 'synthetic', claudeId, 'subagents', 'agent-synthetic.jsonl'),
  sessionId: claudeId, laneId: 'synthetic', kind: 'transcript', updatedAt: time,
};
const codexHome = resolve('test/fixtures/synthetic-codex-home');
const codexSource: Source = {
  key: 'synthetic-codex-rollout', provider: 'codex', home: codexHome, root: join(codexHome, 'sessions'),
  path: join(codexHome, 'sessions', '2035', '05', '06', `rollout-2035-05-06T08-00-00-${codexId}.jsonl`),
  profileId: 'synthetic-codex-profile', sessionId: codexId, laneId: codexId, kind: 'transcript', updatedAt: time,
};

const marker = `AGENT_LENS_CODEX_SESSION=${codexId}`;
const startup = { evidence: 'marker' as const, threadId: codexId };

function launch(command: string, at = time, rowId = 'synthetic-bash-row'): ClaudeLaunchCandidate {
  return {
    source: claudeSource,
    parent: { sessionId: 'synthetic-claude', laneId: 'synthetic-child-lane', turnId: 'synthetic-parent-turn', rowId, relation: 'launch' },
    call: { id: rowId, kind: 'call', name: 'Bash', callId: rowId, cwd, command, at },
    result: { id: `${rowId}-result`, kind: 'result', callId: rowId, at: at + 5_000, status: 'success', launcher: startup },
  };
}

function turn(id: string, startedAt: number, workdir = cwd): Turn {
  return { id, startedAt, cwd: workdir, state: 'Live' };
}

function rollout(turns = [turn('synthetic-fresh-turn', time + 2_000)]): CodexLaunchCandidate {
  return {
    source: codexSource, sessionId: 'synthetic-codex', laneId: 'synthetic-codex-lane',
    cwd, origin: 'exec', at: time + 1_500, turns,
  };
}

test('delegation recognizes literal Git Bash invocations and rejects command-shaped text and dynamic shell', () => {
  assert.deepEqual(parseCodexInvocation(
    String.raw`cd -- 'X:/Synthetic Repos/fixture' && CODEX_HOME='X:/Synthetic Profile' codex exec --json --color never -o report.md - < prompt.md 2>&1`,
  ), { role: 'fresh', changedDirectory: 'X:/Synthetic Repos/fixture', home: 'X:/Synthetic Profile',
    workdir: undefined, threadId: undefined, json: true });
  assert.equal(parseCodexInvocation(`bash -lc 'codex exec resume --json -m test-model ${codexId} -'`)?.threadId, codexId);
  assert.equal(parseCodexInvocation('codex exec --cd="synthetic subdir" -')?.workdir, 'synthetic subdir');
  for (const command of [
    `echo 'codex exec resume ${codexId}'`, `printf '%s' '${marker}'`, 'codex exec resume --last -',
    'codex exec -C "$DYNAMIC" -', 'codex exec - | other', 'codex exec --cd a -C b -',
    'codex exec - <<EOF\nsynthetic body\nEOF', 'codex exec - && codex exec -',
  ]) assert.equal(parseCodexInvocation(command), undefined, command);
});

test('delegation accepts only a structured native startup header and recognizes explicit Bash exit codes', () => {
  const header = [
    'OpenAI Codex v0.170.0', '--------', String.raw`workdir: X:\Synthetic Repos\example`, 'model: fixture-model',
    'provider: fixture-provider', 'approval: never', 'sandbox: read-only', 'workspace roots: synthetic',
    'reasoning effort: high', 'reasoning summaries: auto', `\x1b[1msession id:\x1b[0m ${codexId}`, '--------',
    'user', 'synthetic input',
  ].join('\r\n');
  const native = extractCodexStartupEvidence(header);
  assert.deepEqual(native, { evidence: 'native-header', threadId: codexId, cwd: String.raw`X:\Synthetic Repos\example` });
  assert.equal(extractCodexStartupEvidence(`session id: ${codexId}`), undefined);
  assert.equal(extractCodexStartupEvidence(header.replace('sandbox: read-only', 'random: synthetic')), undefined);
  assert.deepEqual(extractCodexStartupEvidence(`${header}\nAGENT_LENS_CODEX_SESSION=${otherId}`), { evidence: 'conflicting' });
  const events = parseClaudeRecords({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-bash', content: 'Exit' }] },
    toolUseResult: { stderr: header, exitCode: 7 },
  }, claudeSource, 0);
  const result = events.find(event => event.kind === 'result');
  assert.equal(result?.exitCode, 7);
  assert.equal(result?.status, 'failed');
  assert.deepEqual(result?.launcher, native);
});

test('delegation joins late fresh rollouts under the exact lane and scope and rejects weak or competing evidence', async () => {
  const input = launch('codex exec --json -');
  assert.equal(delegationThreadId(input.call, input.result), codexId);
  assert.deepEqual(await resolveDelegations([input], [], undefined, time + 9_000), []);
  const link = (await resolveDelegations([input], [rollout()], undefined, time + 9_000))[0];
  assert.deepEqual(link?.parent, { ...input.parent, at: time });
  assert.equal(link?.sessionId, 'synthetic-codex');
  assert.equal(link?.turnId, 'synthetic-fresh-turn');
  assert.equal(link?.evidence, 'marker');
  const negativeCandidates = [
    { ...rollout(), source: { ...codexSource, profileId: undefined } },
    { ...rollout(), cwd: otherCwd },
    { ...rollout(), at: time - 1_000 },
    { ...rollout(), origin: 'vscode' },
    { ...rollout(), parentThreadId: otherId },
    rollout([turn('synthetic-extra-turn', time + 3_000), turn('synthetic-fresh-turn', time + 2_000)]),
  ];
  for (const candidate of negativeCandidates) {
    assert.deepEqual(await resolveDelegations([input], [candidate], undefined, time + 9_000), []);
  }
  const competitor = launch('codex exec -', time, 'synthetic-other-bash');
  assert.deepEqual(await resolveDelegations([input, competitor], [rollout()], undefined, time + 9_000), []);
  const unmarked = { ...input, result: { ...input.result!, launcher: undefined } };
  assert.deepEqual(await resolveDelegations([unmarked], [rollout()], undefined, time + 9_000), []);
  const json = { ...input, result: { ...input.result!, launcher: { evidence: 'thread-started' as const, threadId: codexId } } };
  assert.equal((await resolveDelegations([json], [rollout()], undefined, time + 9_000))[0]?.evidence, 'thread-started');
  const noJsonFlag = { ...json, call: { ...json.call, command: 'codex exec -' } };
  assert.deepEqual(await resolveDelegations([noJsonFlag], [rollout()], undefined, time + 9_000), []);
  const crossProject = launch(`codex exec -C '${otherCwd}' -`);
  const changedRoot = { ...rollout([turn('synthetic-cross-project-turn', time + 2_000, otherCwd)]), cwd: otherCwd };
  assert.equal((await resolveDelegations([crossProject], [changedRoot], undefined, time + 9_000))[0]?.turnId,
    'synthetic-cross-project-turn');
  const wrongHeaderCwd = { ...crossProject, result: { ...crossProject.result!, launcher: { ...startup, cwd } } };
  assert.deepEqual(await resolveDelegations([wrongHeaderCwd], [changedRoot], undefined, time + 9_000), []);
  const duplicate = { ...rollout(), source: { ...codexSource, profileId: 'synthetic-other-profile', key: 'other-rollout' } };
  assert.deepEqual(await resolveDelegations([input], [rollout(), duplicate], undefined, time + 9_000), []);
});

test('delegation binds resume to one new turn and sorts distinct launcher edges newest first', async () => {
  const first = launch('codex exec -');
  const resumed = launch(`codex exec resume ${codexId} -`, time + 60_000, 'synthetic-resume-bash');
  const argsOnly = { ...resumed, result: { ...resumed.result!, launcher: undefined } };
  const target = rollout([turn('synthetic-fresh-turn', time + 2_000), turn('synthetic-resumed-turn', time + 62_000)]);
  const links = await resolveDelegations([first, argsOnly], [target], undefined, time + 70_000);
  assert.deepEqual(links.map(link => [link.parent.rowId, link.turnId, link.evidence]), [
    ['synthetic-resume-bash', 'synthetic-resumed-turn', 'resume-argument'],
    ['synthetic-bash-row', 'synthetic-fresh-turn', 'marker'],
  ]);
  const wrongId = { ...resumed, result: { ...resumed.result!, launcher: { ...startup, threadId: otherId } } };
  assert.deepEqual(await resolveDelegations([wrongId], [target], undefined, time + 70_000), []);
  const overlapping = { ...target, turns: [...target.turns, turn('synthetic-competing-turn', time + 63_000)] };
  assert.deepEqual(await resolveDelegations([resumed], [overlapping], undefined, time + 70_000), []);
});

test('delegation waits for a complete scoped task prefix and a discovered profile rollout', async () => {
  const area = await mkdtemp(resolve('test/fixtures/.phase-b-delegation-'));
  try {
    const taskRoot = claudeTaskRoot(area)!;
    const path = join(taskRoot, 'synthetic-hash', claudeId, 'tasks', 'synthetic-task.output');
    await mkdir(dirname(path), { recursive: true });
    const adapter = adapters[1];
    const home = join(area, 'synthetic-codex');
    const history = join(home, 'sessions');
    const profile = { id: 'synthetic-disposable', label: 'Synthetic', home, provider: adapter.id };
    const dateDir = join(history, '2035', '05', '06');
    const rolloutPath = join(dateDir, `rollout-2035-05-06T08-00-00-${codexId}.jsonl`);
    await mkdir(dateDir, { recursive: true });
    await writeFile(rolloutPath, [
      { timestamp: new Date(time + 1_500).toISOString(), type: 'session_meta', payload: { id: codexId, cwd, source: 'exec' } },
      { timestamp: new Date(time + 2_000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'fixture-turn' } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    const catalog = await discoverSources({ key: 'synthetic-profile', adapter, boundary: home, history, profile }, new AbortController().signal);
    const source = [...catalog.sources.values()].find(item => item.kind === 'transcript');
    assert.ok(source);
    const batch = await new SourceReader(adapter, source).read(source);
    const meta = batch.events.find(event => event.kind === 'metadata');
    const started = batch.events.find(event => event.kind === 'turn');
    assert.ok(meta && started?.turnId && started.at !== undefined);
    const discovered = { ...rollout([turn(started.turnId, started.at)]), source, cwd: meta.cwd, origin: meta.origin, at: meta.at };

    const initial = launch('codex exec -');
    const events = parseClaudeRecords({
      type: 'user', timestamp: new Date(time + 100).toISOString(), message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: initial.call.callId,
          content: `Command running in background with ID: synthetic-task. Output is being written to: ${path}.` },
      ] },
    }, claudeSource, 0);
    const result = events.find(event => event.kind === 'result');
    assert.equal(result?.backgroundTaskId, 'synthetic-task');
    assert.equal(result?.taskOutputPath, path);
    const candidate = { ...initial, result };
    const cache = new TaskStartupReader();
    assert.deepEqual(await resolveDelegations([candidate], [discovered], taskRoot, time + 9_000, cache), []);
    await writeFile(path, marker);
    await utimes(path, new Date(time + 4_000), new Date(time + 4_000));
    assert.deepEqual(await resolveDelegations([candidate], [discovered], taskRoot, time + 12_000, cache), []);
    await writeFile(path, `${marker}\n`);
    await utimes(path, new Date(time + 5_000), new Date(time + 5_000));
    const links = await resolveDelegations([candidate], [discovered], taskRoot, time + 15_000, cache);
    assert.equal(links[0]?.taskId, 'synthetic-task');
    assert.equal(links[0]?.turnId, 'fixture-turn');

    const notification: Extract<Event, { kind: 'task' }> = {
      kind: 'task', id: 'fixture-notification', state: 'running', taskId: 'synthetic-task',
      sourceCallId: initial.call.callId, taskOutputPath: path, at: time + 200,
    };
    assert.equal((await resolveDelegations([{ ...candidate, result: undefined, tasks: [notification] }],
      [discovered], taskRoot, time + 15_000, cache))[0]?.taskId, 'synthetic-task');
    const wrongTask = { ...candidate, result: { ...result!, backgroundTaskId: 'different-task' } };
    assert.deepEqual(await resolveDelegations([wrongTask], [discovered], taskRoot, time + 15_000, cache), []);
    const wrongSession = { ...candidate, source: { ...claudeSource, sessionId: otherId } };
    assert.deepEqual(await resolveDelegations([wrongSession], [discovered], taskRoot, time + 15_000, cache), []);
    await writeFile(path, `${'x'.repeat(64 * 1024)}\n${marker}\n`);
    await utimes(path, new Date(time + 6_000), new Date(time + 6_000));
    assert.deepEqual(await resolveDelegations([candidate], [discovered], taskRoot, time + 18_000, cache), []);
  } finally {
    await rm(area, { recursive: true, force: true });
  }
});
