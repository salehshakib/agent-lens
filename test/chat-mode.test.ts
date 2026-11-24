import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { nextPermissionMode, permissionCycle, permissionModeFrame } from '../src/host/adapters/claude-code/chat';
import { ClaudeChatStream } from '../src/host/adapters/claude-code/stream';
import type { ChatEvent, ChatLaunch } from '../src/host/chat/types';
import { localPath } from '../src/host/discovery/local-path';

const cwd = localPath(resolve('test'))!;
const sessionId = '4f414d32-0000-4000-8000-000000000383';
const first = '4f414d32-0000-4000-8000-000000000381';
const request = '4f414d32-0000-4000-8000-000000000071';
const launch: ChatLaunch = { owner: 'owner', resume: false,
  identity: { provider: 'claude-code', profile: 'p', home: cwd, cwd, nativeId: sessionId } };
const init = {
  type: 'system', subtype: 'init', cwd, model: 'claude-haiku-5-5', permissionMode: 'default', slash_commands: [], skills: [],
  terminal_slash_commands: [], claude_code_version: '2.1.330', capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
};

function fixture(version = '2.1.330') {
  const events: ChatEvent[] = [];
  const stream = new ClaudeChatStream(launch, event => events.push(event), assert.fail, version);
  const frame = (row: Record<string, unknown>) => stream.read(JSON.stringify({ session_id: sessionId, ...row }));
  /** Init arrives inside the first turn, so the channel is ready for a control request once that turn completes. */
  const ready = (row: Record<string, unknown> = init) => {
    stream.begin(first);
    frame({ type: 'command_lifecycle', command_uuid: first, state: 'started' });
    frame(row);
    frame({ type: 'command_lifecycle', command_uuid: first, state: 'completed' });
    frame({ type: 'result', subtype: 'success', is_error: false });
  };
  return { stream, events, frame, ready };
}

test('the cycle is default, acceptEdits, plan, auto and never includes bypass or dontAsk', () => {
  assert.deepEqual([...permissionCycle], ['default', 'acceptEdits', 'plan', 'auto']);
  assert.equal(nextPermissionMode('default'), 'acceptEdits');
  assert.equal(nextPermissionMode('acceptEdits'), 'plan');
  assert.equal(nextPermissionMode('plan'), 'auto');
  assert.equal(nextPermissionMode('auto'), 'default');
  assert.equal(nextPermissionMode('bypassPermissions'), 'default');
  assert.equal(nextPermissionMode(undefined), 'default');
});

test('the request is a typed set_permission_mode control request for cycle modes only', () => {
  assert.deepEqual(JSON.parse(permissionModeFrame(request, 'plan')!),
    { type: 'control_request', request_id: request, request: { subtype: 'set_permission_mode', mode: 'plan' } });
  assert.equal(permissionModeFrame(request, 'bypassPermissions'), undefined);
  assert.equal(permissionModeFrame(request, 'dontAsk'), undefined);
  assert.equal(permissionModeFrame('not-a-uuid', 'plan'), undefined);
});

test('a success response and a status frame update the reported mode', () => {
  const { stream, events, frame, ready } = fixture();
  ready();
  const results: unknown[] = [];
  assert.equal(stream.beginModeChange(request, value => results.push(value)), true);
  frame({ type: 'control_response', response: { subtype: 'success', request_id: request, response: { mode: 'plan' } } });
  assert.deepEqual(results, [{ mode: 'plan' }]);
  assert.deepEqual(events.filter(event => event.kind === 'mode').map(event => event.kind === 'mode' && event.mode), ['plan']);
  frame({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' });
  assert.equal(events.filter(event => event.kind === 'mode').at(-1)?.kind === 'mode' && (events.filter(event => event.kind === 'mode').at(-1) as { mode: string }).mode, 'acceptEdits');
});

test('an error response reports its message and publishes no mode', () => {
  const { stream, events, frame, ready } = fixture();
  ready();
  const results: { mode?: string; error?: string }[] = [];
  assert.equal(stream.beginModeChange(request, value => results.push(value)), true);
  frame({ type: 'control_response', response: { subtype: 'error', request_id: request,
    error: 'Cannot set permission mode: must be one of acceptEdits, auto, default, plan', error_code: 'invalid_mode' } });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.mode, undefined);
  assert.match(results[0]?.error ?? '', /Cannot set permission mode/);
  assert.equal(events.some(event => event.kind === 'mode'), false);
});

test('a mode change needs an initialized channel on a supported version and no other control or turn', () => {
  const early = fixture();
  assert.equal(early.stream.beginModeChange(request, () => undefined), false, 'before init');
  const old = fixture('2.0.0');
  old.ready({ ...init, claude_code_version: '2.0.0' });
  assert.equal(old.stream.beginModeChange(request, () => undefined), false, 'unsupported version');
  const busy = fixture();
  busy.ready();
  assert.equal(busy.stream.beginModeChange(request, () => undefined), true);
  assert.equal(busy.stream.beginModeChange('4f414d32-0000-4000-8000-000000000072', () => undefined), false, 'one change at a time');
  const turn = fixture();
  turn.stream.begin('4f414d32-0000-4000-8000-000000000381');
  turn.frame(init);
  assert.equal(turn.stream.beginModeChange(request, () => undefined), false, 'not during a turn');
});
