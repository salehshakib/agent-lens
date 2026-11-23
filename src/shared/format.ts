/** Display formatting shared by the host models and the webviews. */

export function formatTokens(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1) + 'M';
  if (value >= 10_000) return Math.round(value / 1000) + 'k';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
  return String(value);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? hours + ':' + pad(minutes) + ':' + pad(seconds % 60) : pad(minutes) + ':' + pad(seconds % 60);
}

export function formatClock(at: number | undefined): string {
  if (at === undefined) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? '-' : Math.round(value) + '%';
}

export function formatReset(at: number | undefined, now: number): string {
  if (at === undefined) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes());
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay ? clock : date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + clock;
}

export function formatAge(at: number | undefined, now: number): string {
  if (at === undefined) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
  if (seconds < 86_400) return Math.round(seconds / 3600) + ' h ago';
  return Math.round(seconds / 86_400) + ' d ago';
}
