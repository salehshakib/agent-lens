import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { modelControlFrame, officialResumeText, startupSettings } from '../src/host/adapters/claude-code/chat';
import { ClaudeChatStream } from '../src/host/adapters/claude-code/stream';
import { ChatSessions } from '../src/host/chat/session';
import type { ChatEvent, ChatLaunch } from '../src/host/chat/types';
import { localPath } from '../src/host/discovery/local-path';
import { compactChatCard, compactContextEvidence } from '../src/host/views/chat-cards';
import { projectTranscript } from '../src/host/views/chat-transcript';
import { buildDetail } from '../src/host/views/models';
import { reduceSession } from '../src/host/sessions/reduce';
import { call, claudeSource, fixtureEvidence, instant, prompt, response, result } from './fixtures/session';

const cwd = localPath(resolve('test'))!;
const sessionId = '4f414d32-0000-4000-8000-000000000383';
const first = '4f414d32-0000-4000-8000-000000000381';
const second = '4f414d32-0000-4000-8000-000000000382';
const control = '4f414d32-0000-4000-8000-000000000061';
const launch: ChatLaunch = { owner: 'fixture', resume: false,
  identity: { provider: 'claude-code', profile: 'fixture', home: cwd, cwd, nativeId: sessionId } };
const init = {
  type: 'system', subtype: 'init', cwd, model: 'claude-haiku-5-5', permissionMode: 'default',
  slash_commands: ['compact', 'doctor', 'usage'], terminal_slash_commands: ['doctor', 'color', 'focus', 'reload-plugins'],
  skills: ['humanizer:humanizer'], fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled',
  per_turn_effort_active: true, ultrathink_available: true, claude_code_version: '2.1.330',
  capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'get_usage_detached_v1'],
};
const limit = "You've hit your 5-hour limit · resets 2:20pm (Asia/Dhaka)";

function feed(stream: ClaudeChatStream, id = sessionId) {
  return (row: Record<string, unknown>) => stream.read(JSON.stringify({ session_id: id, ...row }));
}

function fixture() {
  const events: ChatEvent[] = [];
  const stream = new ClaudeChatStream(launch, event => events.push(event), assert.fail, '2.1.330');
  return { stream, events, frame: feed(stream) };
}

function lifecycle(id: string, state: 'queued' | 'started' | 'completed') {
  return { type: 'command_lifecycle', command_uuid: id, state };
}

test('repeated init projects scoped versioned capabilities and no measured effort', () => {
  const { stream, events, frame } = fixture();
  stream.begin(first);
  frame(lifecycle(first, 'started'));
  frame(init);
  const ready = events.find(event => event.kind === 'ready');
  assert.equal(ready?.model, 'claude-haiku-5-5');
  assert.deepEqual(ready?.capabilities, {
    send: true, interrupt: true, commands: ['compact', 'doctor', 'usage'], skills: ['humanizer:humanizer'],
    nativeCommands: true, terminalCommands: ['doctor', 'color', 'focus', 'reload-plugins'],
    version: '2.1.330', literalText: true, permissionMode: 'default',
    effortActive: true, ultrathinkAvailable: true, fastMode: 'off', fastDisabledReason: 'extra_usage_disabled',
  });
  assert.equal('effort' in (ready ?? {}), false);
  frame(lifecycle(first, 'completed'));
  frame({ type: 'result', subtype: 'success', is_error: false });
  stream.begin(second);
  frame({ ...init, model: 'claude-sonnet-5-5', fast_mode_disabled_reason: undefined });
  assert.equal(events.filter(event => event.kind === 'ready').at(-1)?.model, 'claude-sonnet-5-5');
  assert.equal(stream.permits('fast'), false);
});

test('lifecycle acknowledges only the exact UUID and releases the turn once', () => {
  const { stream, events, frame } = fixture();
  stream.begin(first);
  frame(init);
  frame(lifecycle(first, 'queued'));
  frame(lifecycle(second, 'started'));
  assert.equal(events.filter(event => event.kind === 'ack').length, 0);
  frame(lifecycle(first, 'started'));
  frame({ type: 'user', uuid: first, isReplay: true, message: { role: 'user', content: 'Fixture' } });
  frame({ type: 'result', subtype: 'success', is_error: false });
  frame(lifecycle(second, 'completed'));
  assert.equal(stream.active, true);
  frame(lifecycle(first, 'completed'));
  frame(lifecycle(first, 'completed'));
  assert.equal(stream.active, false);
  assert.deepEqual(events.filter(event => event.kind === 'ack').map(event => event.messageId), [first]);
  assert.deepEqual(events.filter(event => event.kind === 'result').map(event => event.turnId), [first]);
});

test('set_model request and exact response are separate from the reported model', () => {
  assert.deepEqual(JSON.parse(modelControlFrame(control, 'sonnet')!), {
    type: 'control_request', request_id: control, request: { subtype: 'set_model', model: 'sonnet' },
  });
  assert.equal(modelControlFrame(control, '--model'), undefined);
  assert.equal(modelControlFrame(control, 'default'), undefined);
  assert.deepEqual(startupSettings({ ...launch, settings: { model: 'haiku', effort: 'low' } }), ['--model', 'haiku', '--effort', 'low']);
  assert.deepEqual(startupSettings({ ...launch, resume: true, settings: { model: 'haiku', effort: 'medium' } }),
    ['--model', 'haiku', '--effort', 'medium']);
  assert.throws(() => startupSettings({ ...launch, settings: { effort: 'unknown' } }), /Invalid requested effort/);
  const { stream, events, frame } = fixture();
  const resolved: (string | undefined)[] = [];
  assert.equal(stream.beginModelChange(control, model => resolved.push(model)), false);
  stream.begin(first);
  frame(init);
  frame(lifecycle(first, 'started'));
  assert.equal(stream.beginModelChange(control, model => resolved.push(model)), false);
  frame(lifecycle(first, 'completed'));
  frame({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(stream.beginModelChange(control, model => resolved.push(model)), true);
  frame({ type: 'control_response', response: { subtype: 'success', request_id: first, response: { model: 'unrelated' } } });
  assert.deepEqual(resolved, []);
  const response = { type: 'control_response', response: { subtype: 'success', request_id: control, response: { model: 'claude-sonnet-5-5' } } };
  frame(response);
  frame(response);
  assert.deepEqual(resolved, ['claude-sonnet-5-5']);
  assert.equal(events.filter(event => event.kind === 'ready').at(-1)?.model, 'claude-haiku-5-5');
  stream.begin(second);
  frame({ ...init, model: 'claude-sonnet-5-5' });
  assert.equal(events.filter(event => event.kind === 'ready').at(-1)?.model, 'claude-sonnet-5-5');
});

test('manual compact frames yield a complete card and a post-compact context measurement', () => {
  const { stream, events, frame } = fixture();
  stream.begin(first, 'compact', '/compact');
  frame(init);
  frame(lifecycle(first, 'started'));
  frame({ type: 'system', subtype: 'status', status: 'compacting' });
  frame({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  frame({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 48036, post_tokens: 6556 } });
  frame({ type: 'user', uuid: second, message: { role: 'user', content: 'Synthetic compact summary' } });
  frame({ type: 'user', uuid: first, isReplay: true, message: { role: 'user',
    content: '<local-command-stdout>Compacted </local-command-stdout><command-name>/compact</command-name>' } });
  frame({ type: 'result', subtype: 'success', result: '', num_turns: 0 });
  assert.equal(stream.active, true);
  frame(lifecycle(first, 'completed'));
  const result = events.find(event => event.kind === 'result');
  assert.equal(result?.outcome, 'completed');
  assert.ok(result?.compact);
  assert.deepEqual([result.compact.preTokens, result.compact.postTokens], [48036, 6556]);
  const card = compactChatCard('Fixture', { state: 'completed', measurement: result.compact });
  assert.match(card.entries?.[0]?.detail ?? '', /48,036.*6,556/);
  const context = compactContextEvidence('Main lane', result.compact);
  assert.equal(context.compactTokens, 6556);
  assert.equal(context.percent, undefined);
  assert.equal(events.some(event => event.kind === 'text'), false);
});

test('the effort acknowledgment and Fast diagnostic remain command results', () => {
  const { stream, events, frame } = fixture();
  stream.begin(first, 'effort', '/effort high');
  frame(init);
  frame(lifecycle(first, 'started'));
  frame({ type: 'user', uuid: first, isReplay: true,
    message: { role: 'user', content: '<command-name>/effort</command-name><command-args>high</command-args>' } });
  frame({ type: 'result', subtype: 'success', num_turns: 0, result: 'Set effort level to high (this session only): Fixture' });
  frame(lifecycle(first, 'completed'));
  stream.begin(second, 'fast', '/fast');
  frame(init);
  frame(lifecycle(second, 'started'));
  frame({ type: 'result', subtype: 'success', num_turns: 0, result: 'Fast mode unavailable: Extra usage is disabled' });
  frame(lifecycle(second, 'completed'));
  const results = events.filter(event => event.kind === 'result');
  assert.equal(results[0]?.effortAcknowledged, true);
  assert.equal(results[1]?.commandText, 'Fast mode unavailable: Extra usage is disabled');
  assert.equal(events.some(event => event.kind === 'text'), false);
});

test('a 5-hour limit failure becomes one error row in chat', async () => {
  const chat = new ChatSessions({
    adapter: () => ({
      async open(opened, emit) {
        const stream = new ClaudeChatStream(opened, emit, assert.fail, '2.1.330');
        const frame = feed(stream, opened.identity.nativeId);
        return {
          async send(message) {
            stream.begin(message.id);
            frame(init);
            frame(lifecycle(message.id, 'started'));
            frame({ type: 'assistant', uuid: second, message: {
              id: 'fixture-assistant', role: 'assistant', content: [{ type: 'text', text: limit }],
            } });
            frame({ type: 'result', subtype: 'success', is_error: true, result: limit });
            frame(lifecycle(message.id, 'completed'));
          },
          async interrupt() { return control; },
          async close() {},
        };
      },
    }),
    async validate() { return undefined; },
    changed() {},
    async persist() {},
    async checkDelivery() { return 'unknown'; },
  });
  const key = chat.create(launch.identity);
  try {
    await chat.handle(key, { type: 'chatSend', text: 'Check fixture', revision: 1 });
    const rows = chat.view(key, { title: 'Fixture', privateMode: false })?.rows ?? [];
    assert.deepEqual(rows.map(row => [row.role, row.text]), [['user', 'Check fixture'], ['error', limit]]);
  } finally {
    await chat.dispose();
  }
});

test('official resume types only a quoted executable and exact recorded UUID', () => {
  const executable = resolve("Provider's tools", 'claude.exe');
  assert.equal(officialResumeText(executable, sessionId), "& '" + executable.replace(/'/g, "''") + "' --resume '" + sessionId + "'");
  assert.equal(officialResumeText('claude.exe', sessionId), undefined);
  assert.equal(officialResumeText(executable + '\nnext', sessionId), undefined);
  assert.equal(officialResumeText(executable, sessionId + ' --other'), undefined);
});

test('chat replaces live prompt, tool result and reply with scoped recorded rows while retaining anchors and usage', async () => {
  const source = claudeSource();
  const scope = { provider: source.provider, profile: source.profileId, home: source.home, cwd };
  const tool = call('Bash', 'fixture-call', { command: 'echo fixture' });
  const reply = [{ type: 'text', text: 'Done' }];
  const usage = { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 };
  let sent = '';
  const chat = new ChatSessions({
    adapter: () => ({
      async open(opened, emit) {
        const stream = new ClaudeChatStream(opened, emit, assert.fail, '2.1.330');
        const frame = feed(stream, opened.identity.nativeId);
        return {
          async send(message) {
            sent = message.id;
            stream.begin(sent);
            frame(init);
            frame(lifecycle(sent, 'started'));
            frame({ ...prompt(sent, 'Check fixture', 0), cwd, isReplay: true });
            frame(response(first, sent, 10, [tool], 'tool_use', 0));
            frame(result(control, tool.id, 15, undefined, first));
            frame(response(second, first, 20, reply, 'end_turn', 0));
            frame({ type: 'result', subtype: 'success', user_message_uuid: sent, usage });
          },
          async interrupt() { return control; },
          async close() {},
        };
      },
    }),
    async validate() { return undefined; },
    changed() {},
    async persist() {},
    async checkDelivery() { return 'unknown'; },
  });
  const key = chat.create(scope);
  const presentation = { title: 'Fixture', privateMode: false };
  try {
    await chat.handle(key, { type: 'chatSend', text: 'Check fixture', revision: 1 });
    const live = chat.view(key, presentation)!;
    assert.deepEqual(live.rows.map(row => row.role), ['user', 'tool', 'assistant']);
    assert.equal(live.rows[1]?.card?.outcome, 'Completed');
    assert.equal(live.usage?.tokens[0]?.total, 32);

    const observed = { ...source, sessionId: chat.identity(key)!.nativeId, laneId: chat.identity(key)!.nativeId };
    const records = [{ ...prompt(sent, 'Check fixture', 0), cwd }, response(first, sent, 10, [tool], 'tool_use', 0)];
    const snapshot = (entries: unknown[], profile = observed.profileId) => {
      const recorded = reduceSession([fixtureEvidence({ ...observed, profileId: profile }, entries)], instant + 100)!.session;
      const detail = buildDetail(recorded, [recorded], { now: instant + 100, privateMode: false });
      return { ...presentation, recorded, history: projectTranscript(detail, recorded.files, false), detail };
    };
    const partial = chat.view(key, snapshot(records))!;
    assert.deepEqual(partial.rows.map(row => row.role), ['user', 'tool', 'assistant']);
    assert.equal(partial.rows[1]?.card?.outcome, 'Completed');
    assert.equal(partial.rows[1]?.card?.entries?.filter(entry => entry.title === 'Output').length, 1);
    assert.ok(partial.rows[1]?.anchors?.includes(live.rows[1]!.id));
    assert.equal(partial.usage?.tokens[0]?.total, 32);

    const completeInput = snapshot([...records, result(control, tool.id, 15, undefined, first), response(second, first, 20, reply, 'end_turn', 0)]);
    const complete = chat.view(key, completeInput)!;
    assert.deepEqual(complete.rows.map(row => row.role), ['user', 'tool', 'assistant']);
    assert.ok(complete.rows[2]?.anchors?.includes(live.rows[2]!.id));
    assert.equal(complete.usage, undefined);
    assert.equal(completeInput.detail.usage.tokens.find(row => row.label === 'Session')?.total, 32);
    const mismatch = chat.view(key, snapshot(records, 'another-profile'))!;
    assert.equal(mismatch.rows.length, 5);
    assert.equal(mismatch.usage, undefined);
  } finally {
    await chat.dispose();
  }
});

