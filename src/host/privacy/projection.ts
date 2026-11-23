import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

const maxText = 16 * 1024 * 1024;
const terminalSequence = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\|$)|[PX^_][^\x1b]*(?:\x1b\\|$)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-_])/g;
const control = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const injected = /<(system-reminder|environment_context|user_instructions|developer_instructions)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const secret = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9_-]{8,})\b/gi;
const labeledSecret = /(\b[a-z0-9_-]{0,64}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\b["']?\s*[:=]\s*|\bbearer\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|Bearer[ \t]+[^\s,;]+|[^\s,;]+)/gi;
const sensitiveSegment = /(?:^|[\/\\\s"'=])(?:\.aws|\.ssh|\.gnupg|\.azure|\.kube|\.docker|\.env(?:\.[\w.-]+)?|\.netrc|\.npmrc|\.pypirc|(?:auth|\.?credentials?|secrets?|tokens?)\.(?:json|toml|yaml|yml|txt|ini)|(?:id_rsa|id_ed25519)(?:\.pub)?|[\w.-]+\.(?:pem|pfx|key))(?=$|[\/\\\s"'\u0060,;:)])/i;
const pathToken = /"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'<>|=]+/g;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function containsSensitivePath(value: string): boolean {
  return sensitiveSegment.test(value.replace(terminalSequence, '').replace(control, ''));
}

export function safeText(value: unknown, maxLength = maxText): string | undefined {
  if (typeof value !== 'string') return undefined;
  let clean = value.slice(0, maxText)
    .replace(terminalSequence, '')
    .replace(/\r\n?/g, '\n')
    .replace(control, '')
    .replace(injected, '')
    .replace(secret, '[redacted]')
    .replace(labeledSecret, '$1[redacted]');
  if (sensitiveSegment.test(clean)) {
    clean = clean.replace(pathToken, token => sensitiveSegment.test(token) ? '[redacted path]' : token);
  }
  if (!clean.trim()) return undefined;
  return value.length > maxText || clean.length > maxLength ? clean.slice(0, maxLength) + '…' : clean;
}

export function safePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || containsSensitivePath(value)) {
    return undefined;
  }
  return safeText(value) === value ? value : undefined;
}

export function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(value)) return undefined;
  return safeText(value) === value ? value : undefined;
}

export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function timestamp(value: unknown): number | undefined {
  const numeric = count(value);
  if (numeric !== undefined && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return milliseconds <= 8_640_000_000_000_000 ? milliseconds : undefined;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedPath(value: string, cwd?: string): string {
  if (/^[a-z]:[\\/]|^\\\\/i.test(value) || (cwd && /^[a-z]:[\\/]|^\\\\/i.test(cwd))) {
    const resolved = cwd && !win32.isAbsolute(value) ? win32.join(cwd, value) : win32.normalize(value);
    return resolved.toLowerCase();
  }
  return cwd && !posix.isAbsolute(value) ? posix.join(cwd, value) : posix.normalize(value);
}

export function toolArgumentKey(name: string, value: unknown, cwd?: string): string | undefined {
  const entries = record(value);
  if (!entries) return undefined;
  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(entries).sort()) {
    const input = entries[key];
    if (typeof input === 'string') {
      if (input && (input.includes('[redacted') || safeText(input) !== input)) return undefined;
      normalized[key] = /^(?:cmd|command)$/.test(key)
        ? input.trim().replace(/\s+/g, ' ')
        : /^(?:path|file_path|filePath|cwd|workdir)$/.test(key) ? normalizedPath(input, cwd) : input;
    } else if (typeof input === 'boolean' || typeof input === 'number') {
      normalized[key] = input;
    } else if (Array.isArray(input) && input.every(item => typeof item === 'string' && safeText(item) === item && !item.includes('[redacted'))) {
      normalized[key] = input;
    } else if (input !== undefined) {
      return undefined;
    }
  }
  if (!Object.keys(normalized).length) return undefined;
  return createHash('sha256').update(JSON.stringify([name.toLowerCase(), normalized])).digest('hex');
}
