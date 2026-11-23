import { deepEqual, equal, ok } from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseRateLimitLine, probeArgs, probeSamples, profileEnv, UsageReport } from '../src/host/limits/claude-probe';
import { limitSamples, parseSnapshot, projectStatusLine, relayContext, sessionToken } from '../src/host/limits/claude-relay';
import type { RelaySnapshot } from '../src/host/limits/claude-relay';
import { buildGauges, compactGauges, latestSamples } from '../src/host/limits/model';
import type { LimitSample } from '../src/host/limits/model';
import { refreshGate } from '../src/host/limits/refresh';

const now = Date.parse('2031-04-05T06:00:00Z');
const minute = 60_000;

function sample(overrides: Partial<LimitSample> = {}): LimitSample {
  return { provider: 'codex', profile: 'one', bucket: 'codex', minutes: 300, usedPercent: 40, resetsAt: now + 60 * minute, at: now - minute, ...overrides };
}

test('the newest sample wins per profile, bucket and window', () => {
  const kept = latestSamples([sample({ at: now - 10 * minute, usedPercent: 10 }), sample({ at: now - minute, usedPercent: 50 }),
    sample({ at: now - 5 * minute, usedPercent: 20 })]);
  equal(kept.length, 1);
  equal(kept[0]?.usedPercent, 50);
});

test('gauges are labeled by window length and carry fresh, stale, expired and missing states', () => {
  const { main } = buildGauges([{ provider: 'codex', profile: 'one' }], [
    sample({ minutes: 300 }),
    sample({ minutes: 10080, at: now - 40 * minute }),
  ], now);
  deepEqual(main.map(gauge => [gauge.label, gauge.state]), [['5h', 'fresh'], ['7d', 'stale']]);
  const expired = buildGauges([{ provider: 'codex', profile: 'one' }], [sample({ resetsAt: now - minute })], now).main;
  equal(expired[0]?.state, 'expired');
  equal(expired[0]?.percent, undefined);
  const missing = buildGauges([{ provider: 'codex', profile: 'one' }], [], now).main;
  deepEqual(missing.map(gauge => gauge.state), ['missing', 'missing']);
  ok(missing[0]?.reason.length);
});

test('Codex unnamed buckets stay out of the main gauges until their scope is verified', () => {
  const unnamed = sample({ bucket: undefined });
  const hidden = buildGauges([{ provider: 'codex', profile: 'one' }], [unnamed], now);
  deepEqual(hidden.main.map(gauge => gauge.state), ['missing', 'missing']);
  ok(hidden.main[0]?.reason.includes('unnamed'));
  const shown = buildGauges([{ provider: 'codex', profile: 'one' }], [unnamed], now, { acceptUnnamedBucket: true });
  equal(shown.main[0]?.state, 'fresh');
});

test('other named Codex buckets are kept apart from the main gauges', () => {
  const { main, other } = buildGauges([{ provider: 'codex', profile: 'one' }], [
    sample(), sample({ bucket: 'extra-model', usedPercent: 90 }),
  ], now);
  equal(main[0]?.percent, 40);
  deepEqual(other.map(gauge => [gauge.bucket, gauge.percent]), [['extra-model', 90]]);
});

test('profiles never share samples', () => {
  const { main } = buildGauges([{ provider: 'codex', profile: 'one' }, { provider: 'codex', profile: 'two' }],
    [sample({ profile: 'two', usedPercent: 77 })], now);
  equal(main.find(gauge => gauge.profile === 'one' && gauge.label === '5h')?.state, 'missing');
  equal(main.find(gauge => gauge.profile === 'two' && gauge.label === '5h')?.percent, 77);
});

test('compact gauge text uses a dash for missing windows', () => {
  const { main } = buildGauges([{ provider: 'codex', profile: 'one' }], [sample()], now);
  equal(compactGauges(main), '5h 40% 7d -');
});

test('the status-line payload projection keeps only the allowlisted numbers', () => {
  const snapshot = projectStatusLine({
    session_id: 'fixture-session-1', cwd: 'C:/should/not/be/kept', transcript_path: 'C:/nope', model: { display_name: 'nope' },
    context_window: { used_percentage: 61.5, context_window_size: 200000, total_input_tokens: 9 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_900_000_000 }, seven_day: { used_percentage: 130, resets_at: 1_900_100_000 } },
  }, now)!;
  equal(snapshot.fiveHour?.usedPercent, 12);
  equal(snapshot.fiveHour?.resetsAt, 1_900_000_000_000);
  equal(snapshot.sevenDay, undefined, 'a percentage above 100 is rejected');
  equal(snapshot.context?.usedPercent, 61.5);
  const text = JSON.stringify(snapshot);
  ok(!text.includes('should') && !text.includes('nope'));
  equal(projectStatusLine({ session_id: 'x' }, now), undefined);
  equal(projectStatusLine('text', now), undefined);
});

test('session tokens reject path-like values', () => {
  equal(sessionToken('fixture-session-1'), 'fixture-session-1');
  equal(sessionToken('../escape'), undefined);
  equal(sessionToken('a/b'), undefined);
  equal(sessionToken(''), undefined);
});

test('snapshot parsing rejects other versions and drops unknown fields', () => {
  equal(parseSnapshot({ v: 2, capturedAt: now }), undefined);
  const parsed = parseSnapshot({ v: 1, capturedAt: now, sessionId: 'abc', extra: 'x', fiveHour: { usedPercent: 5, resetsAt: now + minute } })!;
  equal('extra' in parsed, false);
  equal(parsed.fiveHour?.usedPercent, 5);
});

test('relay samples map to claude windows and context drops when stale', () => {
  const snapshots: RelaySnapshot[] = [
    { v: 1, capturedAt: now - minute, sessionId: 'abc', fiveHour: { usedPercent: 30, resetsAt: now + 60 * minute },
      sevenDay: { usedPercent: 10, resetsAt: now + 1000 * minute }, context: { usedPercent: 44, windowSize: 200000 } },
  ];
  const samples = limitSamples(snapshots, 'default');
  deepEqual(samples.map(item => [item.provider, item.profile, item.minutes, item.bucket]),
    [['claude-code', 'default', 300, undefined], ['claude-code', 'default', 10080, undefined]]);
  const { main } = buildGauges([{ provider: 'claude-code', profile: 'default' }], samples, now);
  deepEqual(main.map(gauge => gauge.state), ['fresh', 'fresh']);
  equal(relayContext(snapshots, 'abc', now)?.percent, 44);
  equal(relayContext(snapshots, 'other', now), undefined);
  equal(relayContext(snapshots, 'abc', now + 20 * minute), undefined);
});

test('Claude gauges without a relay explain how to get data', () => {
  const { main } = buildGauges([{ provider: 'claude-code', profile: 'default' }], [], now);
  ok(main[0]?.reason.includes('Refresh limits'));
});

const rateLimitEvent = {
  type: 'rate_limit_event',
  rate_limit_info: {
    unifiedWindows: {
      five_hour: { utilization: 0.16, resetsAt: 1_795_445_400, status: 'allowed' },
      seven_day: { utilization: 0.72, resetsAt: 1_795_741_200, status: 'allowed' },
    },
  },
  session_id: 'fixture-session',
};

test('the Claude probe parses unified windows and converts reset seconds to milliseconds', () => {
  deepEqual(parseRateLimitLine(JSON.stringify(rateLimitEvent)), {
    fiveHour: { usedPercent: 16, resetsAt: 1_795_445_400_000 },
    sevenDay: { usedPercent: 72, resetsAt: 1_795_741_200_000 },
  });
});

test('the Claude probe ignores other event types and malformed JSON', () => {
  equal(parseRateLimitLine(JSON.stringify({ ...rateLimitEvent, type: 'result', subtype: 'rate_limit_event' })), undefined);
  equal(parseRateLimitLine('{"type":"rate_limit_event", garbage'), undefined);
});

test('the Claude probe rejects utilization outside 0–1 without dropping a valid sibling window', () => {
  const { unifiedWindows } = rateLimitEvent.rate_limit_info;
  for (const utilization of [-0.01, 1.01]) {
    const line = JSON.stringify({
      ...rateLimitEvent,
      rate_limit_info: { unifiedWindows: { ...unifiedWindows, five_hour: { ...unifiedWindows.five_hour, utilization } } },
    });
    deepEqual(parseRateLimitLine(line), {
      fiveHour: undefined,
      sevenDay: { usedPercent: 72, resetsAt: 1_795_741_200_000 },
    });
  }
});

const usageAt = Date.parse('2026-11-23T13:00:00Z');
const usageText = `You are currently using your subscription to power your Claude Code usage

Current session: 21% used · resets Nov 23, 8:50pm (Asia/Dhaka)
Current week (all models): 73% used · resets Nov 27, 7am (Asia/Dhaka)

What's contributing to your usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 1130 requests · 36 sessions
  39%  Synthetic session title`;
const usageWindows = {
  fiveHour: { usedPercent: 21, resetsAt: Date.parse('2026-11-23T14:50:00Z') },
  sevenDay: { usedPercent: 73, resetsAt: Date.parse('2026-11-27T01:00:00Z') },
};
const unrecognizedUsage = { ok: false, message: 'Claude Code usage report format was not recognized.' };

function usageResult(text: string, at = usageAt) {
  const report = new UsageReport();
  report.read(JSON.stringify({ type: 'result', result: text, num_turns: 0 }), at);
  return report.finish(at);
}

test('the refresh probe passes the literal /usage command and parses the 5-hour and weekly report', () => {
  deepEqual(probeArgs, [
    '-p', '/usage', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--tools', '', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config',
  ]);
  deepEqual(usageResult(usageText), { ok: true, windows: usageWindows, at: usageAt });
});

test('the usage report prefers result text and falls back to synthetic assistant text', () => {
  const report = new UsageReport();
  report.read(JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: usageText }] },
  }), usageAt);
  report.read(JSON.stringify({ type: 'result', result: 'Unrecognized' }), usageAt);
  deepEqual(report.finish(usageAt), { ok: true, windows: usageWindows, at: usageAt });
  report.read(JSON.stringify({ type: 'result', result: usageText.replace('21%', '22%') }), usageAt);
  deepEqual(report.finish(usageAt), {
    ok: true,
    windows: { ...usageWindows, fiveHour: { ...usageWindows.fiveHour, usedPercent: 22 } },
    at: usageAt,
  });
});

test('time-only resets use the local calendar date in the reported IANA zone', () => {
  const at = Date.parse('2026-11-23T03:00:00Z');
  const text = [
    'Current session: 21% used · resets 8pm (America/Los_Angeles)',
    'Current week (all models): 73% used · resets Nov 27, 7:15am (America/Los_Angeles)',
  ].join('\n');
  deepEqual(usageResult(text, at), {
    ok: true, at, windows: {
      fiveHour: { usedPercent: 21, resetsAt: Date.parse('2026-11-23T04:00:00Z') },
      sevenDay: { usedPercent: 73, resetsAt: Date.parse('2026-11-27T15:15:00Z') },
    },
  });
});

test('the usage report selects the upcoming year for a reset after New Year', () => {
  const at = Date.parse('2026-12-30T13:00:00Z');
  const text = usageText.replace('Nov 23', 'Dec 30').replace('Nov 27', 'Jan 2');
  deepEqual(usageResult(text, at), {
    ok: true, at, windows: {
      fiveHour: { usedPercent: 21, resetsAt: Date.parse('2026-12-30T14:50:00Z') },
      sevenDay: { usedPercent: 73, resetsAt: Date.parse('2027-01-02T01:00:00Z') },
    },
  });
});

test('the usage report accepts percentages from 0 to 100 and rejects out-of-range values', () => {
  deepEqual(usageResult(usageText.replace('21%', '0%').replace('73%', '100%')), {
    ok: true, at: usageAt, windows: {
      fiveHour: { ...usageWindows.fiveHour, usedPercent: 0 },
      sevenDay: { ...usageWindows.sevenDay, usedPercent: 100 },
    },
  });
  for (const percent of [-1, 101]) {
    deepEqual(usageResult(usageText.replace('21%', percent + '%')), unrecognizedUsage);
  }
});

test('unrecognized usage output returns a format error even with a rate-limit event', () => {
  const report = new UsageReport();
  report.read(JSON.stringify(rateLimitEvent), usageAt);
  report.read(JSON.stringify({ type: 'result', result: 'Unrecognized' }), usageAt);
  deepEqual(report.finish(usageAt), unrecognizedUsage);
});

test('probe samples map available windows to the requested Claude profile', () => {
  const fiveHour = { usedPercent: 16, resetsAt: now + minute };
  const sevenDay = { usedPercent: 72, resetsAt: now + 60 * minute };
  const expected = [
    { provider: 'claude-code', profile: 'fixture', minutes: 300, ...fiveHour, at: now },
    { provider: 'claude-code', profile: 'fixture', minutes: 10080, ...sevenDay, at: now },
  ];
  deepEqual(probeSamples({ ok: true, windows: { fiveHour, sevenDay }, at: now }, 'fixture'), expected);
  deepEqual(probeSamples({ ok: true, windows: { sevenDay }, at: now }, 'fixture'), expected.slice(1));
});

test('Claude probe environments remove the override for the default home and set it for other homes', () => {
  const userHome = join('fixtures', 'user');
  const otherHome = join(userHome, 'other-profile');
  const env = { PATH: 'fixture-path', CLAUDE_CONFIG_DIR: 'previous-home' };
  deepEqual(profileEnv(join(userHome, '.claude'), env, userHome), { PATH: env.PATH });
  deepEqual(profileEnv(otherHome, env, userHome), { PATH: env.PATH, CLAUDE_CONFIG_DIR: otherHome });
  equal(env.CLAUDE_CONFIG_DIR, 'previous-home');
});

test('the refresh gate reports availability, progress and retryable errors', () => {
  const ready = { claudeFound: true, profiles: 1, running: false };
  deepEqual(refreshGate({ ...ready, claudeFound: false }), {
    enabled: false, reason: 'Claude Code was not found on PATH, so limits cannot be refreshed.',
  });
  deepEqual(refreshGate({ ...ready, profiles: 0 }), { enabled: false, reason: 'No Claude profile is configured.' });
  deepEqual(refreshGate({ ...ready, running: true }), { enabled: false, reason: 'Refreshing Claude limits…' });
  deepEqual(refreshGate({ ...ready, error: 'No limit data.' }), { enabled: true, reason: 'Last refresh failed: No limit data.' });
  const gate = refreshGate(ready);
  equal(gate.enabled, true);
  ok(gate.reason.includes('/usage'));
});
