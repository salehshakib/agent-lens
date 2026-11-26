import type { Source } from '../../src/host/adapters/types';
import { call, claudeSource, codexId, codexSource, fixtureRoot, prompt, response, result, rollout } from './session';

export type AgentReplay = readonly [Source, unknown[]];

export const longCommandOutput = 'Retained fixture command output.\n'.repeat(220);

/** A flat Claude subagent catalog with two children of the same non-main lane. */
export function claudeAgentReplay(): { root: AgentReplay; children: AgentReplay[] } {
  const reviewPrompt = 'Review the export changes.';
  const root: AgentReplay = [claudeSource(), [
    prompt('main-prompt', 'Please inspect the export.', 0),
    response('reviewer-spawn', 'main-prompt', 100, [call('Agent', 'reviewer-call', { description: 'Reviewer', prompt: reviewPrompt })]),
  ]];
  const createWorker = (lane: string, promptText: string, at: number, last?: string): AgentReplay => [claudeSource(lane), [
    prompt(lane + '-prompt', promptText, at),
    response(lane + '-read', lane + '-prompt', at + 10, [call('Read', lane + '-read-call', { file_path: lane + '.ts', offset: 2, limit: 5 })]),
    result(lane + '-read-result', lane + '-read-call', at + 20, { stdout: lane === 'schema' ? longCommandOutput : 'Error checks output' }, lane + '-read'),
    response(lane + '-comment', lane + '-read-result', at + 30, `${lane} progress reported.`),
    ...(last ? [response(lane + '-final', lane + '-comment', at + 40, last, 'end_turn')] : []),
  ]];
  return { root, children: [
    [claudeSource('reviewer'), [
      prompt('reviewer-prompt', reviewPrompt, 200),
      response('reviewer-children', 'reviewer-prompt', 230, [
        call('Agent', 'schema-call', { description: 'Schema', prompt: 'Inspect the schema.' }),
        call('Task', 'errors-call', { description: 'Errors', subagent_type: 'fixture-review', prompt: 'Inspect the errors.' }),
      ]),
    ]],
    [claudeSource('reviewer', 'agent-metadata'), [{ description: 'Reviewer', toolUseId: 'reviewer-call', spawnDepth: 1 }]],
    createWorker('schema', 'Inspect the schema.', 300, 'Schema review completed.'),
    [claudeSource('schema', 'agent-metadata'), [{ description: 'Schema', toolUseId: 'schema-call', spawnDepth: 2, finished: true }]],
    createWorker('errors', 'Check how exports report errors.', 400),
    [claudeSource('errors', 'agent-metadata'), [{ description: 'Errors', toolUseId: 'errors-call', spawnDepth: 2, finished: true }]],
  ] };
}

const checks = '20000000-0000-4000-8000-000000000011';
const api = '20000000-0000-4000-8000-000000000012';
const deep = '20000000-0000-4000-8000-000000000013';

function start(turn: string, at: number, parentTurn?: string) {
  return rollout('event_msg', at, { type: 'task_started', turn_id: turn,
    turn_attribution: parentTurn ? { turn_id: turn, parent_turn_id: parentTurn } : undefined });
}

function item(turn: string, at: number, payload: object, owner?: string) {
  return rollout('event_msg', at, { type: 'item_completed', turn_id: turn, thread_id: owner, item: payload });
}

function codexPrompt(turn: string, at: number, text: string, owner?: string) {
  return item(turn, at, { type: 'UserMessage', id: turn + '-prompt', content: [{ type: 'text', text }] }, owner);
}

function assistant(turn: string, at: number, phase: 'commentary' | 'final_answer', text: string, owner?: string) {
  return item(turn, at, { type: 'AgentMessage', id: turn + '-' + phase, phase, content: [{ type: 'text', text }] }, owner);
}

function childStart(turn: string, at: number, thread: string) {
  return item(turn, at, { type: 'SubAgentActivity', id: 'spawn-' + thread, agent_thread_id: thread, kind: 'started' });
}

/** The same rollout is linked twice. The first occurrence has two siblings and one deeper child. */
export function codexAgentReplay(): { root: AgentReplay; run: AgentReplay; children: AgentReplay[] } {
  const marker = `AGENT_LENS_CODEX_SESSION=${codexId}\n`;
  const root: AgentReplay = [claudeSource(), [
    prompt('main-launch-prompt', 'Verify exports before release.', 0),
    response('fresh-launch', 'main-launch-prompt', 1_000, [call('Bash', 'fresh-call', { command: 'codex exec --json fixture' })]),
    result('fresh-receipt', 'fresh-call', 4_000, { stdout: marker }, 'fresh-launch'),
    response('resume-launch', 'fresh-receipt', 8_000, [call('Bash', 'resume-call', { command: `codex exec resume --json ${codexId} fixture` })]),
    result('resume-receipt', 'resume-call', 11_000, { stdout: marker }, 'resume-launch'),
  ]];
  const run: AgentReplay = [codexSource(), [
    rollout('session_meta', 1_100, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    start('fresh-turn', 1_200),
    codexPrompt('fresh-turn', 1_250, 'Fresh export checks'),
    assistant('fresh-turn', 1_260, 'commentary', 'I will divide the checks.'),
    childStart('fresh-turn', 1_400, checks),
    childStart('fresh-turn', 1_500, api),
    assistant('fresh-turn', 3_700, 'final_answer', 'Fresh checks passed.'),
    rollout('event_msg', 3_800, { type: 'task_complete', turn_id: 'fresh-turn', last_agent_message: 'Duplicate fallback' }),
    start('resume-turn', 8_400),
    codexPrompt('resume-turn', 8_500, 'Resume the exported checks'),
    rollout('event_msg', 10_000, { type: 'task_complete', turn_id: 'resume-turn', last_agent_message: 'Follow-up complete.' }),
  ]];
  const branch = (id: string, turn: string, parent: string, parentTurn: string, at: number, task: string, grandchild?: string): AgentReplay => [codexSource(id), [
    rollout('session_meta', at, { id, parent_thread_id: parent, subagent_history_start_ordinal: 99 }),
    codexPrompt('inherited-turn', at + 10, 'Inherited parent instructions'),
    start(turn, at + 20, parentTurn),
    codexPrompt(turn, at + 30, task, id),
    item(turn, at + 60, { type: 'CommandExecution', id: turn + '-check', command: ['npm', 'test'],
      status: 'completed', exit_code: 0, stdout: `${task} output`, stderr: 'Recorded diagnostic', duration: { secs: 1, nanos: 0 } }, id),
    rollout('response_item', at + 70, { type: 'agent_message', id: turn + '-message', turn_id: turn,
      content: [{ type: 'input_text', text: `${task} message` }, { type: 'encrypted_content', text: 'Opaque message body' }] }),
    ...(grandchild ? [childStart(turn, at + 80, grandchild)] : []),
    assistant(turn, at + 700, 'final_answer', `${task} final`, id),
    rollout('event_msg', at + 710, { type: 'task_complete', turn_id: turn }),
  ]];
  return { root, run, children: [branch(checks, 'tests-turn', codexId, 'fresh-turn', 1_410, 'Test checks', deep),
    branch(api, 'api-turn', codexId, 'fresh-turn', 1_510, 'API checks'), branch(deep, 'deep-turn', checks, 'tests-turn', 1_500, 'Deep checks')] };
}
