import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { adapters } from '../src/host/adapters/registry';
import { profileKey, shortHome } from '../src/host/accounts/profiles';
import { accountStatus, unknownStatus, verifiedProbes } from '../src/host/accounts/status';
import { statusTerminal } from '../src/host/accounts/terminal';
import { buildAccounts, profileOptions } from '../src/host/accounts/view';
import { reduceSession } from '../src/host/sessions/reduce';
import type { Session } from '../src/host/sessions/types';
import type { UsageTotal } from '../src/host/usage/ledger';
import { parseSidebarRequest } from '../src/shared/protocol';
import { claudeSource, codexId, codexSource, fixtureEvidence, fixtureRoot, instant, prompt, response, rollout } from './fixtures/session';

const claude = adapters.find(adapter => adapter.id === 'claude-code')!;
const codex = adapters.find(adapter => adapter.id === 'codex')!;
const userHome = 'C:\\Users\\fixture-user';

function claudeSession(): Session {
  const records = [prompt('first', 'Fixture prompt', 0), response('end', 'first', 10, 'Done', 'end_turn')];
  return reduceSession([fixtureEvidence(claudeSource(), records)], instant + 20)!.session;
}

function codexSession(): Session {
  const records = [
    rollout('session_meta', 0, { id: codexId, cwd: fixtureRoot, source: 'exec' }),
    rollout('turn_context', 1, { turn_id: 'one', model: 'fixture-model', effort: 'high' }),
    rollout('event_msg', 10, { type: 'task_started', turn_id: 'one' }),
  ];
  return reduceSession([fixtureEvidence(codexSource(), records)], instant + 20)!.session;
}

const profiles = [
  { provider: 'codex' as const, id: 'default', label: 'Default', home: userHome + '\\.codex' },
  { provider: 'claude-code' as const, id: 'work', label: 'Work', home: 'D:\\profiles\\claude-work' },
  { provider: 'claude-code' as const, id: 'default', label: 'Default', home: userHome + '\\.claude' },
];

test('no provider has a verified status probe, so every status is Unknown with a reason', () => {
  equal(verifiedProbes.size, 0);
  for (const provider of ['claude-code', 'codex'] as const) {
    const status = accountStatus(provider, { state: 'Signed in', email: 'fixture@example.invalid' });
    equal(status.state, 'Unknown');
    ok(status.reason.length > 0);
    deepEqual(Object.keys(status).sort(), ['reason', 'state']);
  }
  equal(unknownStatus('codex', 'Custom reason').reason, 'Custom reason');
});

test('a verified probe result keeps only the allowlisted state, mode and check time', () => {
  const verified = new Set(['claude-code' as const]);
  const status = accountStatus('claude-code', {
    state: 'Signed in', mode: 'Subscription', checkedAt: instant, email: 'fixture@example.invalid', plan: 'fixture-plan', token: 'secret',
  }, verified);
  deepEqual(status, { state: 'Signed in', mode: 'Subscription', checkedAt: instant, reason: 'Reported by the official status command.' });
  equal(JSON.stringify(status).includes('example.invalid'), false);
  equal(accountStatus('claude-code', { state: 'Signed in', mode: 'fixture@example.invalid' }, verified).mode, undefined);
  equal(accountStatus('claude-code', { state: 'Signed in', mode: 'x'.repeat(60) }, verified).mode, undefined);
  equal(accountStatus('claude-code', { state: 'Admin' }, verified).state, 'Unknown');
  equal(accountStatus('claude-code', 'Signed in', verified).state, 'Unknown');
  equal(accountStatus('claude-code', [], verified).state, 'Unknown');
  equal(accountStatus('codex', { state: 'Signed in' }, verified).state, 'Unknown');
  equal(accountStatus('claude-code', { state: 'Signed out' }, verified).state, 'Signed out');
  equal(accountStatus('claude-code', { state: 'External configuration' }, verified).state, 'External configuration');
});

test('the status terminal types a constant official command and scopes the home to saved profiles only', () => {
  const main = statusTerminal(claude, { id: 'default', label: 'Default', home: userHome + '\\.claude' });
  equal(main.text, 'claude auth status --text');
  equal(main.env, undefined);
  const saved = statusTerminal(claude, { id: 'work', label: 'Work', home: 'D:\\profiles\\claude-work' });
  deepEqual(saved.env, { CLAUDE_CONFIG_DIR: 'D:\\profiles\\claude-work' });
  const other = statusTerminal(codex, { id: 'alt', label: 'Alt', home: 'D:\\profiles\\codex-alt' });
  equal(other.text, 'codex login status');
  deepEqual(other.env, { CODEX_HOME: 'D:\\profiles\\codex-alt' });
  ok(!other.text.includes('\n'));
  ok(!saved.text.includes('profiles'));
});

test('shortHome replaces only the user home prefix and ignores case and trailing slashes', () => {
  equal(shortHome('C:\\Users\\fixture-user\\.claude', userHome), '~\\.claude');
  equal(shortHome('c:/users/FIXTURE-USER/.codex/', userHome + '/'), '~/.codex');
  equal(shortHome(userHome, userHome), '~');
  equal(shortHome('C:\\Users\\fixture-user2\\.claude', userHome), 'C:\\Users\\fixture-user2\\.claude');
  equal(shortHome('D:\\profiles\\claude-work', userHome), 'D:\\profiles\\claude-work');
  equal(profileKey('codex', 'default'), 'codex:default');
  equal(profileKey('codex'), 'codex:');
});

test('accounts list each profile with its own counts and mark the default as active', () => {
  const main = { ...claudeSession(), profile: 'default', status: 'Live' as const };
  const work = { ...claudeSession(), id: 'work-one', profile: 'work' };
  const orphan = { ...codexSession(), profile: undefined };
  const totals: UsageTotal[] = [
    { sessionId: main.id, provider: 'claude-code', profile: 'default', laneId: 'main', counts: { input: 10, output: 5 }, partial: false },
    { sessionId: work.id, provider: 'claude-code', profile: 'work', laneId: 'main', counts: { total: 40 }, partial: false },
  ];
  const view = buildAccounts({ profiles, sessions: [main, work, orphan], totals, userHome });
  deepEqual(view.profiles.map(item => item.key), ['claude-code:default', 'claude-code:work', 'codex:default']);
  const [first, second, third] = view.profiles;
  equal(first?.active, true);
  equal(first?.role, 'Default');
  equal(first?.home, '~\\.claude');
  equal(first?.sessions, 1);
  equal(first?.live, 1);
  equal(first?.tokens, 15);
  equal(second?.active, false);
  equal(second?.role, 'Saved');
  equal(second?.sessions, 1);
  equal(second?.live, 0);
  equal(second?.tokens, 40);
  equal(third?.sessions, 0);
  equal(third?.tokens, undefined);
  for (const item of view.profiles) equal(item.state, 'Unknown');
  deepEqual(view.unassigned, [{ provider: 'Codex', sessions: 1 }]);
});

test('profile options list configured profiles by provider and add Unassigned only when needed', () => {
  const none = profileOptions(profiles, [{ ...claudeSession(), profile: undefined }]);
  deepEqual(none.map(item => item.id), ['claude-code:default', 'claude-code:work', 'codex:default', 'claude-code:']);
  deepEqual(none.map(item => item.label), ['Claude Code · Default', 'Claude Code · Work', 'Codex · Default', 'Claude Code · Unassigned']);
  const assigned = profileOptions(profiles, [{ ...claudeSession(), profile: 'work' }]);
  equal(assigned.some(item => item.label.endsWith('Unassigned')), false);
});

test('the sidebar accepts an account status request with a bounded key and nothing else', () => {
  deepEqual(parseSidebarRequest({ type: 'accountStatus', profile: 'claude-code:work' }), { type: 'accountStatus', profile: 'claude-code:work' });
  equal(parseSidebarRequest({ type: 'accountStatus', profile: '' }), undefined);
  equal(parseSidebarRequest({ type: 'accountStatus', profile: 'x'.repeat(181) }), undefined);
  equal(parseSidebarRequest({ type: 'accountStatus', profile: 'codex:default', command: 'login' }), undefined);
  equal(parseSidebarRequest({ type: 'accountStatus' }), undefined);
});

test('the sidebar filter accepts an optional profile key and rejects extras', () => {
  const base = { search: '', adapter: '', project: '', warnings: false };
  deepEqual(parseSidebarRequest({ type: 'filter', filters: base }), { type: 'filter', filters: base });
  const scoped = { ...base, profile: 'codex:default' };
  deepEqual(parseSidebarRequest({ type: 'filter', filters: scoped }), { type: 'filter', filters: scoped });
  equal(parseSidebarRequest({ type: 'filter', filters: { ...base, profile: 7 } }), undefined);
  equal(parseSidebarRequest({ type: 'filter', filters: { ...scoped, extra: '' } }), undefined);
});

test('account code never touches the file system, child processes or the environment', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['status', 'terminal', 'profiles', 'view']) {
    const source = await readFile('src/host/accounts/' + file + '.ts', 'utf8');
    ok(!/from ['"]node:(fs|child_process|os)|process\.env|require\(/.test(source), file + ' stays pure');
  }
});
