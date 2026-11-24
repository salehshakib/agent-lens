import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ApprovalBridge, allowFrame, denyFrame, parseApprovalRequest, permissionPromptArgs } from '../src/host/adapters/claude-code/approval-bridge';
import type { BridgeEvent } from '../src/host/adapters/claude-code/approval-bridge';
import { ClaudeChatStream } from '../src/host/adapters/claude-code/stream';
import { ApprovalLedger, approvalDeadlineMs, previewInput } from '../src/host/chat/approvals';
import { resolveAllStops, resolveStop } from '../src/host/chat/control';
import type { ChatEvent, ChatLaunch } from '../src/host/chat/types';
import { localPath } from '../src/host/discovery/local-path';
import { approvalActionable } from '../src/shared/approval-state';
import { parsePanelRequest } from '../src/shared/protocol';
import type { ChatApproval } from '../src/shared/protocol';

const input = { command: 'mkdir x', description: 'Create directory x' };
type Row = Record<string, unknown>;

function request(overrides: Row = {}, id = 'req-1'): Row {
  return { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input,
    description: 'Create directory x', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }], tool_use_id: 'toolu_1', ...overrides } };
}

function rig(options: { turn?: string | undefined; deadlineMs?: number } = {}) {
  const state = { turn: 'turn' in options ? options.turn : 'turn-1', writable: true, now: 1000 };
  const written: { response: { request_id: string; response: { behavior: string; message?: string; updatedInput?: unknown } } }[] = [];
  const events: BridgeEvent[] = [];
  const timers: { run: () => void; ms: number; live: boolean }[] = [];
  const bridge = new ApprovalBridge({
    epoch: 'owner-1', turn: () => state.turn, emit: event => events.push(event), now: () => state.now, deadlineMs: options.deadlineMs,
    write: line => { if (!state.writable) return false; written.push(JSON.parse(line)); return true; },
    setTimer: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: handle => { (handle as { live: boolean }).live = false; },
  });
  const answers = () => written.map(line => line.response.response);
  const last = () => (events.at(-1) as { state?: string }).state;
  return { bridge, state, written, events, timers, answers, last };
}
const ctx = { epoch: 'owner-1', turnId: 'turn-1' };

test('request parsing validates subtype and every required field', () => {
  assert.deepEqual(parseApprovalRequest(request()), { requestId: 'req-1', toolUseId: 'toolu_1', toolName: 'Bash', input, description: 'Create directory x' });
  assert.equal(parseApprovalRequest(request({ subtype: 'interrupt' })), undefined);
  assert.equal(parseApprovalRequest(request({ tool_name: undefined })), undefined);
  assert.equal(parseApprovalRequest(request({ tool_use_id: undefined })), undefined);
  assert.equal(parseApprovalRequest(request({ input: 'rm -rf' })), undefined);
  assert.equal(parseApprovalRequest(request({ input: [1] })), undefined);
  assert.equal(parseApprovalRequest(request({ description: 5 })), undefined);
  assert.equal(parseApprovalRequest({ ...request(), request_id: '' }), undefined);
  assert.equal(parseApprovalRequest({ ...request(), type: 'control_response' }), undefined);
});

test('response frames carry the exact original input on allow and a message on deny', () => {
  assert.deepEqual(JSON.parse(allowFrame('req-1', input)), { type: 'control_response',
    response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: input } } });
  assert.deepEqual(JSON.parse(denyFrame('req-1', 'no')), { type: 'control_response',
    response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'deny', message: 'no' } } });
});

test('allow replays the original input and retires the card', () => {
  const { bridge, written, events, answers, last } = rig();
  assert.equal(bridge.receive(request()), true);
  assert.equal(events[0]!.kind, 'approval');
  assert.equal(written.length, 0);
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: true });
  assert.deepEqual(answers(), [{ behavior: 'allow', updatedInput: input }]);
  assert.equal(written[0]!.response.request_id, 'req-1');
  assert.equal(last(), 'allowed');
});

test('deny answers with a message and never an allow', () => {
  const { bridge, answers, last } = rig();
  bridge.receive(request());
  assert.deepEqual(bridge.decide('req-1', 'deny', ctx), { ok: true });
  assert.equal(answers()[0]!.behavior, 'deny');
  assert.ok(answers()[0]!.message!.length > 5);
  assert.equal(last(), 'denied');
});

test('the preview is redacted and bounded and the card never carries the raw input', () => {
  const { bridge, events } = rig();
  bridge.receive(request({ input: { command: 'curl -H "authorization: Bearer abc123secret" ' + 'x'.repeat(5000) } }));
  const shown = events[0] as Extract<BridgeEvent, { kind: 'approval' }>;
  assert.ok(shown.preview.length <= 6001);
  assert.ok(!shown.preview.includes('abc123secret'));
  assert.ok(!('input' in shown));
  assert.ok(previewInput({ key: 'sk-abcdefgh12345678' }).includes('[redacted]'));
});

test('decisions are rejected when stale, duplicate, from the wrong owner or turn, or after close', () => {
  const { bridge, answers } = rig();
  assert.deepEqual(bridge.decide('nope', 'allow', ctx), { ok: false, reason: 'unknown' });
  bridge.receive(request());
  assert.deepEqual(bridge.decide('req-1', 'allow', { epoch: 'owner-2', turnId: 'turn-1' }), { ok: false, reason: 'owner' });
  assert.deepEqual(bridge.decide('req-1', 'allow', { epoch: 'owner-1', turnId: 'turn-0' }), { ok: false, reason: 'turn' });
  assert.equal(answers().length, 0);
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: true });
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: false, reason: 'duplicate' });
  assert.deepEqual(bridge.decide('req-1', 'deny', ctx), { ok: false, reason: 'duplicate' });
  assert.equal(answers().length, 1);
  bridge.receive(request({}, 'req-2'));
  bridge.close();
  assert.deepEqual(bridge.decide('req-2', 'allow', ctx), { ok: false, reason: 'closed' });
  assert.deepEqual(answers().map(answer => answer.behavior), ['allow', 'deny']);
});

test('a turn change makes the request stale', () => {
  const { bridge, state, answers } = rig();
  bridge.receive(request());
  state.turn = 'turn-2';
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: false, reason: 'turn' });
  assert.equal(answers().length, 0);
});

test('interrupt auto-denies waiting requests, refuses new ones and rejects a late allow', () => {
  const { bridge, answers, last } = rig();
  bridge.receive(request());
  bridge.interrupted();
  assert.deepEqual(answers().map(answer => answer.behavior), ['deny']);
  assert.equal(last(), 'interrupted');
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: false, reason: 'duplicate' });
  assert.equal(bridge.receive(request({}, 'req-2')), false);
  assert.deepEqual(answers().map(answer => answer.behavior), ['deny', 'deny']);
});

test('timeout auto-denies once and a later allow is refused', () => {
  const { bridge, timers, answers, last, state } = rig({ deadlineMs: 5000 });
  bridge.receive(request());
  assert.equal(timers[0]!.ms, 5000);
  state.now += 5000;
  timers[0]!.run();
  assert.deepEqual(answers().map(answer => answer.behavior), ['deny']);
  assert.equal(last(), 'expired');
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: false, reason: 'duplicate' });
  assert.deepEqual(answers().map(answer => answer.behavior), ['deny']);
});

test('an expired deadline is enforced at decision time even before the timer fires', () => {
  const { bridge, answers, state } = rig({ deadlineMs: 5000 });
  bridge.receive(request());
  state.now += 5001;
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: false, reason: 'expired' });
  assert.deepEqual(answers().map(answer => answer.behavior), ['deny']);
});

test('the default deadline is ten minutes', () => {
  assert.equal(approvalDeadlineMs, 600_000);
  const { bridge, timers } = rig();
  bridge.receive(request());
  assert.equal(timers[0]!.ms, 600_000);
});

test('channel close denies only while writable and never allows', () => {
  const open = rig();
  open.bridge.receive(request());
  open.bridge.close(true);
  assert.deepEqual(open.answers().map(answer => answer.behavior), ['deny']);
  const dead = rig();
  dead.bridge.receive(request());
  dead.state.writable = false;
  dead.bridge.close(false);
  assert.equal(dead.written.length, 0);
  assert.equal(dead.last(), 'closed');
  assert.equal(dead.bridge.receive(request({}, 'req-9')), false);
});

test('an unwritable channel at decision time retires the card without an allow', () => {
  const { bridge, state, written, last } = rig();
  bridge.receive(request());
  state.writable = false;
  assert.deepEqual(bridge.decide('req-1', 'allow', ctx), { ok: false, reason: 'write' });
  assert.equal(written.length, 0);
  assert.equal(last(), 'closed');
});

test('unreadable, idle and repeated requests are denied rather than shown', () => {
  const { bridge, answers, events } = rig();
  assert.equal(bridge.receive(request({ input: 'x' })), false);
  assert.equal(bridge.receive(request({}, 'dup')), true);
  assert.equal(bridge.receive(request({}, 'dup')), false);
  assert.equal(events.length, 1);
  assert.deepEqual(answers().map(answer => answer.behavior), ['deny', 'deny']);
  const idle = rig({ turn: undefined });
  assert.equal(idle.bridge.receive(request()), false);
  assert.equal(idle.answers()[0]!.behavior, 'deny');
});

test('turn end retires waiting requests silently', () => {
  const { bridge, written, last } = rig();
  bridge.receive(request());
  bridge.turnEnded();
  assert.equal(written.length, 0);
  assert.equal(last(), 'closed');
});

test('version gate falls back to auto-deny below the verified version', () => {
  assert.deepEqual(permissionPromptArgs('2.1.330'), ['--permission-prompt-tool', 'stdio']);
  assert.deepEqual(permissionPromptArgs('2.2.0'), ['--permission-prompt-tool', 'stdio']);
  assert.deepEqual(permissionPromptArgs('2.1.329'), ['--permission-prompts', 'none']);
  assert.deepEqual(permissionPromptArgs(undefined), ['--permission-prompts', 'none']);
});

const cwd = localPath(resolve('test'))!;
const launch: ChatLaunch = { identity: { provider: 'claude-code', profile: 'p', home: cwd, cwd, nativeId: '4f414d32-0000-4000-8000-000000000383' },
  owner: 'owner-1', resume: false };

test('the stream hands approvals to the bridge and closes only when there is none', () => {
  const seen: Row[] = [];
  const closed: string[] = [];
  const bridged = new ClaudeChatStream(launch, (_event: ChatEvent) => undefined, reason => closed.push(reason), '2.1.330',
    { receive: row => { seen.push(row); return true; }, turnEnded: () => undefined });
  bridged.read(JSON.stringify(request()));
  assert.equal(seen.length, 1);
  assert.equal(closed.length, 0);
  const bare = new ClaudeChatStream(launch, () => undefined, reason => closed.push(reason), '2.1.330');
  bare.read(JSON.stringify(request()));
  assert.equal(closed.length, 1);
});

test('ledger refuses a decision from another panel, owner or turn and settles once', () => {
  const ledger = new ApprovalLedger();
  const entry = ledger.add({ requestId: 'req-1', toolUseId: 't', key: 'chat-a', owner: 'owner-1', turnId: 'turn-1' });
  assert.equal(entry.id.length, 64);
  assert.deepEqual(ledger.claim(entry.id, { key: 'chat-b', owner: 'owner-1', turnId: 'turn-1' }), { refused: 'panel' });
  assert.deepEqual(ledger.claim(entry.id, { key: 'chat-a', owner: 'owner-2', turnId: 'turn-1' }), { refused: 'owner' });
  assert.deepEqual(ledger.claim(entry.id, { key: 'chat-a', owner: undefined, turnId: 'turn-1' }), { refused: 'owner' });
  assert.deepEqual(ledger.claim(entry.id, { key: 'chat-a', owner: 'owner-1', turnId: 'turn-2' }), { refused: 'turn' });
  assert.ok('entry' in ledger.claim(entry.id, { key: 'chat-a', owner: 'owner-1', turnId: 'turn-1' }));
  assert.deepEqual(ledger.claim(entry.id, { key: 'chat-a', owner: 'owner-1', turnId: 'turn-1' }), { refused: 'duplicate' });
  assert.deepEqual(ledger.claim('f'.repeat(64), { key: 'chat-a', owner: 'owner-1', turnId: 'turn-1' }), { refused: 'unknown' });
});

test('the webview request carries only an opaque id and a decision, never input', () => {
  const id = 'a'.repeat(64);
  assert.deepEqual(parsePanelRequest({ type: 'chatApproval', id, decision: 'allow' }), { type: 'chatApproval', id, decision: 'allow' });
  assert.equal(parsePanelRequest({ type: 'chatApproval', id, decision: 'allow', input: { command: 'rm' } }), undefined);
  assert.equal(parsePanelRequest({ type: 'chatApproval', id, decision: 'always' }), undefined);
  assert.equal(parsePanelRequest({ type: 'chatApproval', id: 'req-1', decision: 'deny' }), undefined);
});

test('card controls exist only for a pending, unpaused request', () => {
  const card: ChatApproval = { id: 'a'.repeat(64), toolName: 'Bash', preview: '{}', state: 'pending' };
  assert.equal(approvalActionable(card), true);
  assert.equal(approvalActionable({ ...card, note: 'paused' }), false);
  for (const state of ['allowed', 'denied', 'expired', 'closed', 'interrupted'] as const) assert.equal(approvalActionable({ ...card, state }), false);
});

test('Stop targets enable only the verified interrupt route and name every other reason', () => {
  const live = { provider: 'claude-code', turnActive: true, canInterrupt: true };
  const [turn, agent, session] = resolveAllStops(live);
  assert.equal(turn!.available, true);
  assert.equal(turn!.action, 'interrupt');
  assert.equal(agent!.available, false);
  assert.equal(agent!.action, undefined);
  assert.match(agent!.message, /single subagent/);
  assert.equal(session!.available, false);
  assert.match(session!.message, /Stopping a session is not available/);
  assert.equal(resolveStop('turn', { ...live, turnActive: false }).message, 'No turn is running in this chat.');
  assert.match(resolveStop('turn', { ...live, canInterrupt: false }).message, /unavailable/);
  assert.equal(resolveStop('turn', { ...live, provider: 'codex' }).available, false);
});
