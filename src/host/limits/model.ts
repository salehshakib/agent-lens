import type { Provider } from '../adapters/types';

/** One validated account-window observation. Times are epoch milliseconds. */
export interface LimitSample {
  provider: Provider;
  profile: string;
  /** Provider bucket name. Claude samples are bound to their profile and carry no bucket. */
  bucket?: string;
  minutes: number;
  usedPercent: number;
  resetsAt: number;
  at: number;
}

export type GaugeState = 'fresh' | 'stale' | 'expired' | 'missing';

export interface Gauge {
  provider: Provider;
  profile: string;
  bucket?: string;
  /** Duration label derived from the window length, never from a provider slot. */
  label: '5h' | '7d';
  minutes: 300 | 10080;
  state: GaugeState;
  percent?: number;
  resetsAt?: number;
  observedAt?: number;
  /** Plain-language explanation shown as the accessible description. */
  reason: string;
}

export interface ProfileScope {
  provider: Provider;
  profile: string;
}

export interface GaugeOptions {
  /** Age after which a still-valid sample is labeled stale. */
  staleAfterMs?: number;
  /** Provider buckets whose scope is independently verified for the main gauges. */
  verifiedBuckets?: Partial<Record<Provider, readonly string[]>>;
  /** Accept unnamed buckets for the main gauges. Off until scope is independently verified. */
  acceptUnnamedBucket?: boolean;
}

export const defaultStaleAfterMs = 30 * 60_000;
export const windows = [
  { minutes: 300, label: '5h' },
  { minutes: 10080, label: '7d' },
] as const;

const defaultVerified: Record<Provider, readonly string[]> = { 'claude-code': [], codex: ['codex'] };

function sampleKey(sample: LimitSample): string {
  return JSON.stringify([sample.provider, sample.profile, sample.bucket ?? null, sample.minutes]);
}

/** Keep the newest valid observation per profile namespace, bucket and duration. */
export function latestSamples(samples: readonly LimitSample[]): LimitSample[] {
  const latest = new Map<string, LimitSample>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.at) || !Number.isFinite(sample.usedPercent) || !Number.isFinite(sample.resetsAt)) continue;
    const key = sampleKey(sample);
    const previous = latest.get(key);
    if (!previous || sample.at >= previous.at) latest.set(key, sample);
  }
  return [...latest.values()];
}

function mainBucket(sample: LimitSample, options: GaugeOptions): boolean {
  if (sample.provider === 'claude-code') return sample.bucket === undefined;
  if (sample.bucket === undefined) return options.acceptUnnamedBucket === true;
  const verified = options.verifiedBuckets?.[sample.provider] ?? defaultVerified[sample.provider];
  return verified.includes(sample.bucket);
}

function gauge(scope: ProfileScope, window: typeof windows[number], sample: LimitSample | undefined,
  now: number, options: GaugeOptions, missing: string, bucket?: string): Gauge {
  const base = { provider: scope.provider, profile: scope.profile, label: window.label, minutes: window.minutes, bucket };
  if (!sample) return { ...base, state: 'missing', reason: missing };
  const common = { ...base, percent: sample.usedPercent, resetsAt: sample.resetsAt, observedAt: sample.at };
  if (sample.resetsAt <= now) {
    return { ...common, percent: undefined, state: 'expired',
      reason: 'The ' + window.label + ' window reset after the last observation. Waiting for a new observation.' };
  }
  const limit = options.staleAfterMs ?? defaultStaleAfterMs;
  if (now - sample.at > limit) {
    return { ...common, state: 'stale', reason: 'Last observed more than ' + Math.round(limit / 60_000) +
      ' minutes ago. The value may have changed.' };
  }
  return { ...common, state: 'fresh', reason: 'Recent local snapshot.' };
}

/**
 * Build the main 5h and 7d gauges for every profile scope, and keep other named buckets separate.
 * Codex samples reach the main gauges only through an explicit verified bucket.
 */
export function buildGauges(scopes: readonly ProfileScope[], samples: readonly LimitSample[], now: number,
  options: GaugeOptions = {}): { main: Gauge[]; other: Gauge[] } {
  const latest = latestSamples(samples);
  const main: Gauge[] = [];
  const other: Gauge[] = [];
  for (const scope of scopes) {
    const own = latest.filter(sample => sample.provider === scope.provider && sample.profile === scope.profile);
    const primary = own.filter(sample => mainBucket(sample, options));
    const unverifiedNull = own.some(sample => sample.bucket === undefined && sample.provider !== 'claude-code' &&
      !mainBucket(sample, options));
    const missing = scope.provider === 'claude-code'
      ? 'No Claude limit snapshot yet. Use Refresh limits or enable the relay and send a message in Claude Code.'
      : unverifiedNull
        ? 'Only unnamed limit buckets were recorded. Their account scope is not verified, so they are not shown.'
        : 'No Codex limit observation in the recorded sessions.';
    for (const window of windows) {
      main.push(gauge(scope, window, primary.find(sample => sample.minutes === window.minutes), now, options, missing));
    }
    const buckets = new Set(own.filter(sample => !mainBucket(sample, options) && sample.bucket !== undefined)
      .map(sample => sample.bucket!));
    for (const bucket of [...buckets].sort()) {
      for (const window of windows) {
        const sample = own.find(row => row.bucket === bucket && row.minutes === window.minutes);
        if (sample) other.push(gauge(scope, window, sample, now, options, 'No observation.', bucket));
      }
    }
  }
  return { main, other };
}

/** Compact status-bar text for one provider, for example "5h 62% 7d 39%". A dash stands for a missing window. */
export function compactGauges(gauges: readonly Gauge[]): string {
  return gauges.map(item => item.label + ' ' + (item.percent === undefined ? '-' : Math.round(item.percent) + '%')).join(' ');
}
