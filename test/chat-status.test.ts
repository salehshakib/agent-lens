import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ClaudeChatStream } from '../src/host/adapters/claude-code/stream';
import type { ChatEvent, ChatLaunch } from '../src/host/chat/types';
import { localPath } from '../src/host/discovery/local-path';
import { rateLimitWindows } from '../src/host/limits/claude-probe';
import { projectChatStatus } from '../src/host/views/chat-status';
import type { ChatView, GaugeView } from '../src/shared/protocol';
import { formatElapsed, statusSummary } from '../src/webview/panel/chat-status';

const base: ChatView = {
  key: 'k', title: 'T', state: 'idle', rows: [], draft: '', revision: 0, canSend: true, canContinue: false,
  canInterrupt: false, canRetry: false, canChooseScope: false, privateMode: false,
};
const now = 1_000_000;

test('status line shows Unknown for everything the provider did not report', () => {
  const status = projectChatStatus({ chat: base, gauges: [], now });
  const byId = Object.fromEntries(status.items.map(item => [item.id, item]));
  for (const id of ['profile', 'model', 'mode', 'context', 'tokens', 'limit']) {
    assert.equal(byId[id]?.known, false, id);
    assert.equal(byId[id]?.value, 'Unknown', id);
    assert.ok(byId[id]?.detail, id + ' keeps its reason');
  }
  assert.equal(byId.elapsed, undefined);
  assert.equal(byId.pending, undefined);
  assert.equal(status.interruptHint, false);
});

test('status line projects reported facts, elapsed runtime, limits and the interrupt hint', () => {
  const gauges: GaugeView[] = [
    { provider: 'Claude Code', profile: 'p', label: '5-hour', state: 'Fresh', percent: 21, reason: '', source: 'Chat turn event', observedAt: now - 5000 },
    { provider: 'Claude Code', profile: 'p', label: 'Weekly', state: 'Stale', percent: 15, reason: '' },
  ];
  const chat: ChatView = { ...base, state: 'working', profile: 'Work', canInterrupt: true,
    live: { model: 'claude-haiku-5-5', permissionMode: 'acceptEdits', fastMode: 'off', turnStartedAt: now - 65_000, pending: 2 } };
  const status = projectChatStatus({ chat, gauges, tokens: 12_345, now });
  const text = statusSummary(status, now);
  assert.match(text, /State Working/);
  assert.match(text, /Elapsed 1:05/);
  assert.match(text, /Model claude-haiku-5-5/);
  assert.match(text, /Mode Accept edits/);
  assert.match(text, /Tokens 12k/);
  assert.match(text, /5-hour 21%.*Weekly 15%.*\(stale\)/);
  assert.match(text, /Pending 2/);
  assert.equal(status.interruptHint, true);
  assert.equal(formatElapsed(3_725_000), '1:02:05');
});

test('rate_limit_event normalization validates each window independently', () => {
  const event = (windows: unknown) => ({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: windows } });
  assert.deepEqual(rateLimitWindows(event({
    five_hour: { utilization: 0.215, resetsAt: 1_795_523_400 }, seven_day: { utilization: 0.15, resetsAt: 1_796_007_600_000 },
  })), { fiveHour: { usedPercent: 21.5, resetsAt: 1_795_523_400_000 }, sevenDay: { usedPercent: 15, resetsAt: 1_796_007_600_000 } });
  assert.deepEqual(rateLimitWindows(event({ seven_day: { utilization: 0, resetsAt: 1_796_007_600 } })),
    { fiveHour: undefined, sevenDay: { usedPercent: 0, resetsAt: 1_796_007_600_000 } });
  assert.equal(rateLimitWindows(event({ five_hour: { utilization: 1.4, resetsAt: 1_795_523_400 }, seven_day: { utilization: 0.1, resetsAt: 'x' } })), undefined);
  assert.equal(rateLimitWindows(event(undefined)), undefined);
  assert.equal(rateLimitWindows({ type: 'rate_limit_event' }), undefined);
});

const cwd = localPath(resolve('test'))!;
const launch: ChatLaunch = { owner: 'owner-1', resume: false,
  identity: { provider: 'claude-code', profile: 'work', home: cwd, cwd, nativeId: '4f414d32-0000-4000-8000-000000000383' } };
const init = {
  type: 'system', subtype: 'init', cwd, model: 'claude-haiku-5-5', permissionMode: 'default', slash_commands: [], skills: [],
  terminal_slash_commands: [], claude_code_version: '2.1.330', capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
};

test('the chat stream publishes limit windows bound to its owner and identity, and only after init', () => {
  const events: ChatEvent[] = [];
  const stream = new ClaudeChatStream(launch, event => events.push(event), assert.fail, '2.1.330');
  const frame = (row: Record<string, unknown>) => stream.read(JSON.stringify({ session_id: launch.identity.nativeId, ...row }));
  const limit = { type: 'rate_limit_event', uuid: '4f414d32-0000-4000-8000-000000000501',
    rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.17, resetsAt: 1_795_523_400 } } } };
  frame(limit);
  assert.equal(events.some(event => event.kind === 'limits'), false, 'ignored before init');
  stream.begin('4f414d32-0000-4000-8000-000000000381');
  frame(init);
  frame(limit);
  const published = events.find(event => event.kind === 'limits');
  assert.equal(published?.owner, 'owner-1');
  assert.equal(published?.identity.profile, 'work');
  assert.deepEqual(published?.kind === 'limits' && published.windows,
    { fiveHour: { usedPercent: 17, resetsAt: 1_795_523_400_000 }, sevenDay: undefined });
  frame({ ...limit, rate_limit_info: { unifiedWindows: { five_hour: { utilization: 3, resetsAt: 1 } } } });
  assert.equal(events.filter(event => event.kind === 'limits').length, 1, 'invalid windows publish nothing');
});
