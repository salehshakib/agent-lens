import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
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
  ok(main[0]?.reason.includes('Enable Claude limits'));
});

test('refresh stays disabled until a signed-in probe is verified', () => {
  const gate = refreshGate();
  equal(gate.enabled, false);
  ok(gate.reason.length > 0);
  equal(refreshGate({ usageReportVerified: true }).enabled, true);
});
