import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { maxChatDraft, maxSearch, parsePanelRequest } from '../src/shared/protocol';
import { claudeChatSettings, normalizeEffortChoice, normalizeModelChoice } from '../src/host/adapters/claude-code/chat-settings';
import { ClaudeChatStream } from '../src/host/adapters/claude-code/stream';
import { supportsClaudeCodeVersion } from '../src/host/adapters/claude-code/version';
import { codexLinkedRuns, codexStartReason } from '../src/host/chat/codex-launch';
import { parseChatInput, slashCatalog, slashSuggestions, terminalHandoffReason } from '../src/host/chat/commands';
import { ChatSessions } from '../src/host/chat/session';
import type { ChatCapabilities, ChatEvent, ChatLaunch, ChatSend } from '../src/host/chat/types';
import { localPath } from '../src/host/discovery/local-path';
import type { Lane, Session, TimelineRow } from '../src/host/sessions/types';

const capabilities: ChatCapabilities = {
  version: '2.1.330', send: true, interrupt: true, literalText: true, nativeCommands: true,
  commands: ['compact', 'usage', 'model', 'Shared', 'mcp', 'doctor', 'Demo', 'Demo', 'bad name', 'sk-SYNTHETIC_LEAK'],
  skills: ['Shared', 'DemoSkill', 'humanizer:humanizer'],
  terminalCommands: ['doctor', 'color', 'focus', 'reload-plugins'],
  effortActive: true, fastMode: 'off', fastDisabledReason: 'extra_usage_disabled',
};

test('Claude Code version gate accepts the verified minimum and newer numeric versions', () => {
  for (const version of ['2.1.330', '2.1.331', '2.2.0', '3.0.0']) {
    assert.equal(supportsClaudeCodeVersion(version), true, version);
  }
  for (const version of ['2.1.329', '2.0.999', 'garbage']) {
    assert.equal(supportsClaudeCodeVersion(version), false, version);
  }
});

test('slash grammar preserves ordinary and verified literal input and never sends a bare slash', () => {
  assert.deepEqual(parseChatInput('Read /usage\nAnother line'), { kind: 'text', text: 'Read /usage\nAnother line' });
  const escaped = String.raw`  \/usage in the README`;
  assert.deepEqual(parseChatInput(escaped, capabilities), { kind: 'literal', text: escaped });
  for (const unverified of [undefined, { ...capabilities, version: '2.1.329' }, { ...capabilities, literalText: false }]) {
    assert.equal(parseChatInput(escaped, unverified).kind, 'invalid');
  }
  assert.equal(parseChatInput('  /  ').kind, 'incomplete');
  assert.equal(parseChatInput('/re').kind, 'incomplete');
  assert.equal(parseChatInput('  !echo hello').kind, 'invalid');
  assert.equal(parseChatInput('message\0with null').kind, 'invalid');
  assert.equal(parseChatInput('x'.repeat(maxChatDraft + 1)).kind, 'invalid');
});

test('local case, path quoting, filters and subcommands follow the catalog grammar', () => {
  assert.deepEqual(parseChatInput(' \t/UsAgE', capabilities, true), { kind: 'local', name: 'usage', argument: '' });
  const path = String.raw`src\double  spaces\file.ts`;
  assert.deepEqual(parseChatInput(`/FILES\t "${path}"  `), { kind: 'local', name: 'files', argument: path });
  assert.deepEqual(parseChatInput('/resume --all-projects "two words"'), {
    kind: 'local', name: 'resume', argument: 'two words', allProjects: true,
  });
  assert.deepEqual(parseChatInput('/resume "--all-projects"'), {
    kind: 'local', name: 'resume', argument: '--all-projects', allProjects: false,
  });
  assert.deepEqual(parseChatInput('/codex start Check  output'), {
    kind: 'local', name: 'codex', argument: 'Check  output', codexMode: 'start',
  });
  assert.deepEqual(parseChatInput('/codex follow "review output"'), {
    kind: 'local', name: 'codex', argument: 'review output', codexMode: 'follow',
  });
  assert.deepEqual(parseChatInput('/help /Demo'), { kind: 'local', name: 'help', argument: 'Demo' });
  for (const input of ['/usage now', '/tasks queued', '/stop all', '/files x --extra', '/diff src\\example --',
    '/files ' + 'a'.repeat(maxSearch + 1), '/resume --all-projects --all-projects', '/codex bogus prompt',
    '/effort fastest', '/fast maybe', '/model with spaces', '/diff path\nextra', '/usage\n']) {
    const result = parseChatInput(input);
    assert.equal(result.kind, 'invalid', input);
    assert.match('reason' in result ? result.reason ?? '' : '', /^Usage:/, input);
  }
});

test('unknown commands get suggestions and literal recovery only when verified', () => {
  const result = parseChatInput('/resuem', capabilities);
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.equal(result.suggestions?.[0]?.name, 'resume');
  assert.equal(result.canSendAsText, true);
  const unverified = parseChatInput('/resuem');
  assert.equal(unverified.kind === 'invalid' && unverified.canSendAsText, undefined);
  assert.equal(slashSuggestions('usage', slashCatalog())[0]?.name, 'usage');
  assert.equal(slashSuggestions('resume', slashCatalog())[0]?.name, 'resume');
});

test('native dispatch requires a verified idle owner and respects advertised names and terminal exclusions', () => {
  const options = slashCatalog(capabilities);
  assert.equal(options.filter(option => option.name === 'usage').length, 1);
  assert.equal(options.find(option => option.name === 'usage')?.route, 'Local');
  assert.equal(options.filter(option => option.name === 'Demo').length, 1);
  assert.equal(options.some(option => option.name === 'bad name' || option.name === 'sk-SYNTHETIC_LEAK'), false);
  assert.equal(slashCatalog({ ...capabilities, version: undefined }).some(option => option.name === 'Demo'), false);
  assert.equal(parseChatInput('/de', capabilities).kind, 'invalid');
  for (const [text, name, route] of [
    ['/compact', 'compact', 'Native'],
    ['/Shared', 'Shared', 'Native'],
    ['/humanizer:humanizer  keep the literal  arguments', 'humanizer:humanizer', 'Native'],
    ['/mcp', 'mcp', 'Official terminal'],
    ['/doctor', 'doctor', 'Official terminal'],
  ] as const) {
    assert.deepEqual(parseChatInput(text, capabilities), { kind: 'native', name, text, route });
  }
  for (const [input, scope, busy, reason] of [
    ['/compact', undefined, false, /initialized/],
    ['/compact with instructions', capabilities, false, /bare/],
    ['/DemoSkill', { ...capabilities, version: '2.1.329' }, false, /initialized/],
    ['/DemoSkill', capabilities, true, /current turn/],
    ['/native:usage args', capabilities, false, /overlaps/],
    ['/native:model haiku', capabilities, false, /overlaps/],
  ] as const) {
    const result = parseChatInput(input, scope, busy);
    assert.equal(result.kind, 'native');
    if (result.kind === 'native') assert.match(result.reason ?? '', reason);
  }
  assert.deepEqual(parseChatInput('/model haiku', capabilities),
    { kind: 'local', name: 'model', argument: 'haiku' });
  assert.deepEqual(parseChatInput('/doctor', capabilities, true),
    { kind: 'native', name: 'doctor', route: 'Official terminal', text: '/doctor' });
});

test('later phases and setting pickers distinguish requested, resolved, and reported values', () => {
  for (const name of ['login', 'logout', 'profile']) {
    const result = parseChatInput('/' + name);
    assert.equal(result.kind, 'local');
    assert.match(result.kind === 'local' ? result.reason ?? '' : '', /phase/i);
    assert.ok(slashCatalog().find(option => option.name === name)?.reason);
  }
  // Phase F resolves /stop per target in the host, so the catalog carries no blanket reason.
  assert.equal(slashCatalog().find(option => option.name === 'stop')?.reason, undefined);
  const action = (id: string, label: string) => ({ id, label });
  const model = claudeChatSettings('model', 'Current project', 'sonnet', { model: 'claude-haiku-5-5' }, {
    capabilities, requested: { model: 'sonnet' }, resolvedModel: 'claude-sonnet-5-5', action,
  });
  assert.equal(model.state, 'ready');
  assert.ok(model.entries?.some(entry => entry.title === 'sonnet' && entry.actions?.[0]?.label === 'Apply'));
  assert.ok(model.entries?.some(entry => entry.title === 'claude-sonnet-5-5' && entry.detail === 'Resolved by the CLI'));
  assert.equal(model.entries?.find(entry => entry.title === 'Reported')?.detail, 'claude-haiku-5-5');
  assert.equal(model.entries?.find(entry => entry.title === 'Default')?.actions, undefined);
  const startup = claudeChatSettings('model', 'Current project', 'default', undefined, { canStage: true, action });
  assert.equal(startup.entries?.find(entry => entry.title === 'Default')?.actions?.[0]?.id, 'default');
  const effort = claudeChatSettings('effort', 'Current project', 'high', { effort: 'high' }, {
    capabilities, requested: { effort: 'medium' }, action,
  });
  assert.equal(effort.entries?.find(entry => entry.title === 'Requested')?.detail, 'medium');
  assert.equal(effort.entries?.find(entry => entry.title === 'Reported')?.detail, 'Unavailable in the chat stream');
  assert.equal(effort.entries?.find(entry => entry.title === 'high')?.actions?.[0]?.id, 'high');
  assert.equal(normalizeEffortChoice('ultra'), undefined);
  assert.equal(normalizeEffortChoice('inherit'), 'default');
  assert.equal(normalizeModelChoice('--resume'), undefined);
  assert.equal(normalizeModelChoice('sk-SYNTHETIC_LEAK'), undefined);
  const fast = claudeChatSettings('fast', 'Current project', '', undefined, { capabilities, action });
  assert.match(fast.message ?? '', /Extra usage is disabled/);
  assert.equal(fast.entries?.[0]?.detail, 'Off');
  assert.equal(fast.actions?.[0]?.id, '');
  const fastOn = claudeChatSettings('fast', 'Current project', 'on', undefined, { capabilities, action });
  assert.match(fastOn.message ?? '', /Changing Fast on or off is unverified/);
  assert.equal(fastOn.actions, undefined);
  const enabledProfile = { ...capabilities, fastDisabledReason: undefined };
  assert.equal(claudeChatSettings('fast', 'Current project', '', undefined, { capabilities: enabledProfile, action }).actions, undefined);
});

test('terminal handoff requires a verified released writer in an exact approved scope', () => {
  const ready = { trusted: true, exactSession: true, approvedProfile: true, localProject: true };
  assert.equal(terminalHandoffReason(ready, true), undefined);
  assert.match(terminalHandoffReason(ready) ?? '', /writer could not be verified/);
  assert.equal(terminalHandoffReason({ ...ready, writer: 'absent' }), undefined);
  assert.match(terminalHandoffReason({ ...ready, writer: 'unknown' }, true) ?? '', /writer could not be verified/);
  assert.match(terminalHandoffReason({ ...ready, writer: 'present' }) ?? '', /Another client/);
  assert.match(terminalHandoffReason({ ...ready, owner: true, writer: 'absent' }) ?? '', /Release/);
  assert.match(terminalHandoffReason({ ...ready, busy: true, writer: 'absent' }) ?? '', /current operation/);
  assert.match(terminalHandoffReason({ ...ready, trusted: false, writer: 'absent' }) ?? '', /Trust/);
  assert.match(terminalHandoffReason({ ...ready, exactSession: false, writer: 'absent' }) ?? '', /confirmed conversation/);
  assert.match(terminalHandoffReason({ ...ready, approvedProfile: false, writer: 'absent' }) ?? '', /approved profile/);
  assert.match(terminalHandoffReason({ ...ready, localProject: false, writer: 'absent' }) ?? '', /trusted local project/);
});

test('inline card action protocol accepts only an opaque host key and bounded input', () => {
  const id = 'a'.repeat(64);
  const request = { type: 'chatCardAction', id, input: 'filter' };
  assert.deepEqual(parsePanelRequest(request), request);
  assert.equal(parsePanelRequest({ ...request, id: 'codex-start' }), undefined);
  assert.equal(parsePanelRequest({ ...request, input: 'x'.repeat(maxChatDraft + 1) }), undefined);
  assert.equal(parsePanelRequest({ ...request, path: 'C:/fake' }), undefined);
});

test('local rows run during a turn, deduplicate submissions and keep parked drafts local', async () => {
  const cwd = localPath(resolve('test'))!;
  const scope = { provider: 'claude-code' as const, profile: 'fixture', home: cwd, cwd };
  const sent: ChatSend[] = [];
  const chat = new ChatSessions({
    adapter: () => ({
      async open(launch, emit) {
        return {
          async send(message) {
            sent.push(message);
            emit({ ...launch, kind: 'ready', nativeId: launch.identity.nativeId, capabilities });
            emit({ ...launch, kind: 'ack', turnId: message.id, messageId: message.id });
          },
          async interrupt() { return 'unused'; },
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
  const view = () => chat.view(key, { title: 'Fixture', privateMode: false });
  try {
    await chat.handle(key, { type: 'chatSend', text: 'Check the fixture.', revision: 1 });
    assert.equal(view()?.state, 'working');
    await chat.handle(key, { type: 'chatDraft', text: 'Keep this draft.', revision: 2 });
    await chat.handle(key, { type: 'chatDraft', text: '/usage', revision: 3 });
    assert.equal(chat.local(key, 4, '/usage', { name: 'usage', argument: '' }), true);
    assert.equal(chat.local(key, 4, '/usage', { name: 'usage', argument: '' }), false);
    assert.equal(view()?.draft, 'Keep this draft.');
    assert.equal(view()?.state, 'working');
    assert.deepEqual(sent.map(message => message.text), ['Check the fixture.']);
    assert.equal(chat.localRows(key).length, 1);
    assert.ok(view()?.rows.some(row => row.id === chat.localRows(key)[0]?.id));
    assert.ok(!chat.view(key, { title: 'Fixture', privateMode: true })?.rows
      .some(row => row.id === chat.localRows(key)[0]?.id));
    const fresh = chat.create(scope);
    assert.equal(chat.local(fresh, 1, '/clear', { name: 'clear', argument: '' }), true);
    assert.ok(chat.parked(key).some(item => item.key === fresh));
  } finally {
    await chat.dispose();
  }
});

test('a newer Claude Code version routes advertised skills when init still proves the capabilities', () => {
  const cwd = localPath(resolve('test'))!;
  const nativeId = '4f414d32-0000-4000-8000-000000000383';
  const launch: ChatLaunch = { owner: 'fixture-owner', resume: false,
    identity: { provider: 'claude-code', profile: 'fixture', home: cwd, cwd, nativeId } };
  const version = '2.1.331';
  for (const features of [
    { capabilities: ['msg_lifecycle_v1'], terminal_slash_commands: ['fixture-terminal'] },
    { capabilities: [], terminal_slash_commands: ['fixture-terminal'] },
    { capabilities: ['msg_lifecycle_v1'], terminal_slash_commands: undefined },
  ]) {
    const events: ChatEvent[] = [];
    const stream = new ClaudeChatStream(launch, event => events.push(event), assert.fail, version);
    stream.begin('4f414d32-0000-4000-8000-000000000381');
    stream.read(JSON.stringify({ type: 'system', subtype: 'init', session_id: nativeId, cwd,
      slash_commands: ['compact', 'usage'], skills: ['fixture-skill'], claude_code_version: version, ...features }));
    const event = events[0];
    assert.equal(event?.kind, 'ready');
    if (event?.kind === 'ready') {
      assert.equal(event.capabilities.literalText, true);
      const hasNativeShape = features.capabilities.length > 0 && Array.isArray(features.terminal_slash_commands);
      assert.equal(event.capabilities.nativeCommands, hasNativeShape);
      assert.equal(stream.permits('native'), hasNativeShape);
      assert.equal(parseChatInput(String.raw`\/usage in the README`, event.capabilities).kind, 'literal');
      const command = '/fixture-skill keep these arguments';
      const parsed = parseChatInput(command, event.capabilities);
      if (hasNativeShape) {
        assert.deepEqual(parsed, { kind: 'native', name: 'fixture-skill', text: command, route: 'Native' });
        assert.equal(slashCatalog(event.capabilities).find(option => option.name === 'fixture-terminal')?.route, 'Official terminal');
      } else {
        assert.ok(parsed.kind === 'native' && parsed.reason);
      }
    }
  }
});

function session(id: string, provider: Session['provider']): Session {
  return { id, provider, nativeId: id, profile: 'fixture-profile', title: 'Fixture ' + id,
    status: 'Recorded', lanes: [], parents: [], children: [], files: [], signals: [], background: [],
    usageObservations: [], coverage: 'recorded' };
}

function lane(id: string, row: TimelineRow): Lane {
  return { id, nativeId: id, title: 'Fixture lane', status: 'Recorded', rows: [row],
    turns: row.turnId ? [{ id: row.turnId, state: 'Completed' }] : [], signals: [] };
}

test('Codex follow uses exact M1 launch and turn evidence, leaving standalone runs observable separately', () => {
  const origin = session('origin', 'claude-code');
  const run = session('review', 'codex');
  const elsewhere = session('elsewhere', 'claude-code');
  const launchRow: TimelineRow = { id: 'launch', laneId: 'parent-lane', kind: 'tool', label: 'Bash' };
  const outputRow: TimelineRow = { id: 'output', laneId: 'run-lane', turnId: 'turn', kind: 'user', label: 'User' };
  origin.lanes = [lane(launchRow.laneId, launchRow)];
  run.lanes = [lane(outputRow.laneId, outputRow)];
  const parent = { sessionId: origin.id, rowId: launchRow.id, laneId: launchRow.laneId, relation: 'launch' as const };
  run.launches = [{ sessionId: run.id, parent, laneId: outputRow.laneId, turnId: 'turn', role: 'fresh', evidence: 'marker' },
    { sessionId: run.id, parent: { ...parent, sessionId: elsewhere.id }, laneId: outputRow.laneId, turnId: 'other-turn',
      role: 'resume', evidence: 'resume-argument' }];
  origin.children = [{ ...parent, sessionId: run.id, laneId: outputRow.laneId, turnId: 'turn' }];
  const unrelated = session('other reVIew', 'codex');
  const runs = codexLinkedRuns(origin, [origin, run, unrelated, elsewhere], 'review', false);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]?.origin, { sessionId: origin.id, rowId: launchRow.id, laneId: launchRow.laneId });
  assert.deepEqual(runs[0]?.target, { sessionId: run.id, rowId: outputRow.id, laneId: outputRow.laneId });
  origin.lanes[0]!.rows = [];
  assert.equal(codexLinkedRuns(origin, [run, unrelated], '', false)[0]?.target, undefined);
  assert.match(codexStartReason(resolve('test'), false, true), /profile/);
  assert.match(codexStartReason(resolve('test'), true, true), /exact startup and rollout binding/);
});
