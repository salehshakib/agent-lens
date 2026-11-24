import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGauges } from '../src/host/limits/model';
import { reduceSession } from '../src/host/sessions/reduce';
import type { FileAction } from '../src/host/sessions/types';
import { chatContextEvidence, compactChatCard, projectChatCard } from '../src/host/views/chat-cards';
import type { ChatCardInput, ChatCardTarget } from '../src/host/views/chat-cards';
import { buildDetail, gaugeView } from '../src/host/views/models';
import { claudeSource, fixtureEvidence, instant, prompt, response } from './fixtures/session';

function fixture() {
  const source = claudeSource();
  const session = reduceSession([fixtureEvidence(source, [
    prompt('prompt', 'Synthetic fixture', 0),
    response('answer', 'prompt', 20, 'Synthetic reply', 'end_turn'),
  ])], instant + 60)!.session;
  const lane = session.lanes[0]!;
  const edited: FileAction = {
    id: 'recorded-change', path: 'src/a.ts', label: 'src/a.ts', laneId: lane.id, rowId: 'recorded-change',
    status: 'applied', kind: 'edit', diffKind: 'hunks', diff: '@@ -4 +4 @@\n-old\n+new',
  };
  session.files = [
    edited,
    { ...edited, id: 'path-only', status: 'inferred', diff: undefined, diffUnavailable: 'Preimage not recorded' },
    { ...edited, id: 'recorded-read', path: 'src/b.ts', status: 'read', kind: 'read', diff: undefined },
  ];
  session.background.push({ id: 'task', laneId: lane.id, rowId: 'task-row', status: 'Live', title: 'Fixture task', at: instant });
  return { session, lane, edited, profile: source.profileId };
}

function cardInput(overrides: Partial<ChatCardInput> = {}) {
  const now = instant + 120_000;
  const { session } = fixture();
  const targets = new Map<string, ChatCardTarget>();
  const privateMode = overrides.privateMode ?? false;
  const input: ChatCardInput = {
    scope: 'Fixture project · Fixture profile', now, privateMode,
    detail: buildDetail(session, [session], { now, privateMode }),
    action(target, label, input) {
      const id = 'test-grant-' + targets.size;
      targets.set(id, target);
      return { id, label, input };
    },
    ...overrides,
  };
  return { input, targets };
}

test('Usage keeps independent scoped windows and reuses M1 session token totals', () => {
  const { session, profile } = fixture();
  const { input, targets } = cardInput();
  const sample = {
    provider: 'claude-code' as const, profile, minutes: 300, usedPercent: 18,
    at: instant, resetsAt: instant + 600_000,
  };
  const gauges = buildGauges([{ provider: sample.provider, profile }], [
    sample,
    { ...sample, profile: 'other-profile', minutes: 10080, usedPercent: 73 },
  ], input.now).main.map(gaugeView);
  const card = projectChatCard('usage', { ...input, gauges });
  assert.deepEqual(card.gauges?.map(gauge => [gauge.label, gauge.state, gauge.percent]), [
    ['5h', 'Fresh', 18], ['7d', 'No data', undefined],
  ]);
  assert.deepEqual(card.usage, buildDetail(session, [session], { now: input.now, privateMode: false }).usage);
  assert.deepEqual([...targets.values()], [{ kind: 'view', view: 'usage' }]);
});

test('Context distinguishes fresh relay fill from recorded input and selects lanes with opaque actions', () => {
  const { session, lane } = fixture();
  lane.context = { input: 500, approximate: false, at: instant };
  const context = chatContextEvidence(session, lane, 'Main', { percent: 87, windowSize: 1000, at: instant + 119_000 });
  const { input, targets } = cardInput({
    context, contextLanes: [{ id: lane.id, label: 'Main' }, { id: 'child-lane', label: 'Child' }],
  });
  const card = projectChatCard('context', input);
  assert.match(card.entries?.[0]?.detail ?? '', /87% used.*1\.0k tokens capacity.*relay.*just now/i);
  assert.match(card.entries?.[1]?.detail ?? '', /500 tokens.*2 min ago/);
  const choose = card.actions?.find(action => action.label === 'Show context for Child');
  assert.deepEqual(choose && targets.get(choose.id), { kind: 'contextLane', lane: 'child-lane' });
  const waiting = projectChatCard('context', { ...input, context: undefined, selectedContextLane: 'child-lane' });
  assert.equal(waiting.entries?.[0]?.title, 'Child');
  assert.match(waiting.message ?? '', /Waiting for context/);
});

test('Compact card distinguishes pending, confirmed and failed work and displays exact token counts', () => {
  const scope = 'Fixture session';
  assert.equal(compactChatCard(scope, { state: 'pending' }).state, 'loading');
  const complete = compactChatCard(scope, { state: 'completed', measurement: { preTokens: 48_036, postTokens: 6_556, at: instant } });
  assert.equal(complete.scope, scope);
  assert.equal(complete.state, 'ready');
  assert.equal(complete.entries?.[0]?.detail, '48,036 → 6,556 tokens');
  assert.equal(complete.announcement, 'Context compacted. 6,556 tokens remain.');
  const failed = compactChatCard(scope, { state: 'failed' });
  assert.equal(failed.state, 'unavailable');
  assert.match(failed.message ?? '', /confirmed context measurement/);
  assert.equal(failed.entries, undefined);
});

test('Context replaces older main-lane fill with verified post-compaction tokens until fresher evidence', () => {
  const { session, lane } = fixture();
  const measurement = { preTokens: 48_036, postTokens: 6_556, at: instant + 100_000 };
  lane.context = { input: 48_036, approximate: true, capacity: 80_000, percent: 60, at: instant };
  const relay = { percent: 87, windowSize: 80_000, at: instant + 90_000 };
  const context = chatContextEvidence(session, lane, 'Main', relay, undefined, measurement);
  assert.deepEqual(context, {
    lane: 'Main', compactTokens: 6_556, source: 'Live compaction boundary', at: measurement.at,
  });
  const { input } = cardInput({ context });
  const card = projectChatCard('context', input);
  assert.match(card.entries?.[0]?.detail ?? '', /6,556 tokens after compaction.*Context fill unavailable.*Capacity unknown.*Live compaction boundary/);
  assert.equal(card.entries?.length, 1);
  const fresh = chatContextEvidence(session, lane, 'Main', { ...relay, at: instant + 101_000 }, undefined, measurement);
  assert.equal(fresh?.percent, 87);
  assert.equal(fresh?.compactTokens, undefined);
  const child = { ...lane, id: 'child' };
  session.lanes.push(child);
  assert.equal(chatContextEvidence(session, child, 'Child', relay, undefined, measurement)?.compactTokens, undefined);
});

test('Files filters indexed paths and summaries without converting them to filesystem targets', () => {
  const { input, targets } = cardInput({ argument: 'A.TS', fileKind: 'changed' });
  const card = projectChatCard('files', input);
  assert.deepEqual(card.entries?.map(entry => entry.title), ['src/a.ts']);
  assert.match(card.entries?.[0]?.detail ?? '', /2 changed/);
  assert.ok([...targets.values()].some(target => target.kind === 'file' && target.id === 'path-only'));
  assert.equal(card.actions?.find(action => action.label === 'Filter paths')?.input?.value, 'A.TS');
  assert.match(projectChatCard('files', { ...input, argument: 'unknown' }).message ?? '', /No files match/);
});

test('Diff keeps path-only and individual changes visible, previews line numbers and rejects stale or private evidence', () => {
  const { edited } = fixture();
  const { input, targets } = cardInput({ argument: 'src/a.ts', selectedDiff: { action: edited, title: edited.label } });
  const card = projectChatCard('diff', input);
  assert.deepEqual(card.entries?.map(entry => entry.title), ['src/a.ts', 'src/a.ts']);
  assert.match(card.entries?.[1]?.detail ?? '', /Preimage not recorded/);
  const preview = card.entries?.[0]?.actions?.find(action => action.label === 'Preview recorded diff');
  assert.deepEqual(preview && targets.get(preview.id), { kind: 'previewDiff', id: edited.id });
  assert.deepEqual(card.diff?.[0]?.lines, [{ text: '-old', before: 4, after: undefined }, { text: '+new', before: undefined, after: 4 }]);
  const stale = projectChatCard('diff', { ...input, argument: 'src/b.ts' });
  assert.equal(stale.state, 'changed');
  assert.equal(stale.diff, undefined);
  const hidden = projectChatCard('diff', { ...input, privateMode: true });
  assert.equal(hidden.state, 'denied');
  assert.equal(hidden.diff, undefined);
  assert.ok(hidden.entries?.every(entry => !entry.actions?.length));
  const sensitive = projectChatCard('diff', {
    ...input, selectedDiff: { action: { ...edited, diff: '@@ -4 +4 @@\n-reads .env\n+new' }, title: edited.label },
  });
  assert.equal(sensitive.state, 'unavailable');
  assert.equal(sensitive.diff, undefined);
});

test('Diff previews bound both line count and line length while retaining the full recorded diff action', () => {
  const { edited } = fixture();
  const longLine = 'x'.repeat(600);
  const patch = ['@@ -0,0 +1,90 @@', ...Array.from({ length: 90 }, () => '+' + longLine)].join('\n');
  const { input } = cardInput({ selectedDiff: { action: { ...edited, diff: patch }, title: edited.label } });
  const card = projectChatCard('diff', input);
  assert.equal(card.diff?.[0]?.lines.length, 80);
  assert.equal(card.diff?.[0]?.lines[0]?.text, '+' + longLine.slice(0, 500) + '…');
  assert.match(card.message ?? '', /Preview limited/);
  assert.ok(card.actions?.some(action => action.label === 'Open recorded diff'));
});

test('Agents distinguish loading and use M1 transcript identity and the eligible turn action', () => {
  const { input, targets } = cardInput({ status: { channel: 'Working', canInterrupt: true } });
  assert.equal(projectChatCard('agents', { ...input, detail: undefined, loading: true }).state, 'loading');
  const card = projectChatCard('agents', input);
  const agent = input.detail?.agents[0];
  assert.ok(agent);
  assert.deepEqual(card.entries?.map(entry => entry.title), [agent.title]);
  assert.ok([...targets.values()].some(target => target.kind === 'interrupt'));
  assert.ok([...targets.values()].some(target => target.kind === 'transcript'
    && target.session === agent.sessionId && target.lane === agent.laneId));
});

test('Tasks use scoped background projections and disclose missing structured to-do evidence', () => {
  const { input, targets } = cardInput({ privateMode: true });
  const todos = projectChatCard('tasks', input);
  assert.equal(todos.state, 'unavailable');
  assert.match(todos.message ?? '', /Structured to-do evidence/);
  const background = projectChatCard('tasks', { ...input, argument: 'background' });
  assert.equal(background.entries?.[0]?.title, 'Background task');
  assert.match(background.entries?.[0]?.detail ?? '', /Live.*Indexed session evidence/);
  assert.ok([...targets.values()].some(target => target.kind === 'session' && target.session === input.detail?.id));
});

test('Status distinguishes the live owner and channel from the last recorded session state', () => {
  const { input } = cardInput({ status: { channel: 'Working', owner: 'Agent Lens', model: 'live-model', queued: 0 } });
  const card = projectChatCard('status', input);
  assert.deepEqual(card.entries?.map(entry => [entry.title, entry.detail]), [
    ['Channel', 'Working · Agent Lens'],
    ['Recorded session', input.detail?.status],
    ['Effective model', 'live-model'],
    ['Effective effort', 'Unknown'],
    ['Queued drafts', '0'],
  ]);
});
