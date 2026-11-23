import { threadIdPattern } from '../adapters/claude-code/launcher';

const maximumCommandLength = 64 * 1024;
const executable = /(?:^|[/\\])codex(?:\.exe|\.cmd)?$/i;
const shell = /(?:^|[/\\])bash(?:\.exe)?$/i;
const optionsWithValue = new Set([
  '-C', '--cd', '-m', '--model', '-c', '--config', '-p', '--profile', '-o', '--output-last-message',
  '-s', '--sandbox', '--color', '--output-schema', '--enable', '--disable', '-i', '--image',
  '--add-dir', '--local-provider',
]);
const flags = new Set([
  '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto', '--oss', '--ignore-user-config', '--ignore-rules',
]);
const shellControl = /[|&;()<>\n]/;
const redirect = /^(?:[012])?(?:>>?|<)(?:&[012])?/;

type Token = { value: string; operator?: true };

export type CodexInvocation = {
  role: 'fresh' | 'resume';
  threadId?: string;
  changedDirectory?: string;
  workdir?: string;
  home?: string;
  json: boolean;
};

/** Tokenize only static Bash words and the operators the launch recognizer can verify. */
function shellTokens(command: string): Token[] | undefined {
  if (!command || command.length > maximumCommandLength || /\[redacted|[\u0000-\u0008\u000b-\u001f]/.test(command)) return undefined;
  const tokens: Token[] = [];
  let quote = '';
  let value = '';
  let started = false;
  function endWord() {
    if (started) tokens.push({ value });
    value = '';
    started = false;
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote === "'") {
      if (char === quote) quote = '';
      else value += char;
    } else if (char === '\\') {
      if (next === undefined) return undefined;
      if (quote === '"' && !/["\\$`\n]/.test(next)) value += char;
      else {
        index++;
        if (next !== '\n') {
          started = true;
          value += next;
        }
      }
    } else if (quote === '"') {
      if (char === quote) quote = '';
      else if (char === '$' || char === '`') return undefined;
      else value += char;
    } else if (char === '"' || char === "'") {
      started = true;
      quote = char;
    } else if (char === '\n' && !command.slice(index).trim()) {
      break;
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (char === '&' && next === '&') {
      endWord();
      tokens.push({ value: '&&', operator: true });
      index++;
    } else if (char === '<' || char === '>' || (!started && /[012]/.test(char) && next && /[<>]/.test(next))) {
      endWord();
      const operation = redirect.exec(command.slice(index))?.[0];
      if (!operation || /[<>]/.test(command[index + operation.length] ?? '')) return undefined;
      tokens.push({ value: operation, operator: true });
      index += operation.length - 1;
    } else if (shellControl.test(char) || /[$`*?\[\]{}~]/.test(char) || (!started && char === '#')) {
      return undefined;
    } else {
      started = true;
      value += char;
    }
  }
  if (quote) return undefined;
  endWord();
  return tokens;
}

function commandWords(tokens: readonly Token[]): string[] | undefined {
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.operator) words.push(token.value);
    else if (token.value === '&&') return undefined;
    else if (!token.value.includes('&')) {
      const target = tokens[++index];
      if (!target || target.operator || !target.value) return undefined;
    }
  }
  return words;
}

/** Recognize an invocation in recorded text. No shell, wrapper or redirected file is opened. */
export function parseCodexInvocation(command: string, insideWrapper = false): CodexInvocation | undefined {
  const tokens = shellTokens(command);
  if (!tokens?.length) return undefined;
  let changedDirectory: string | undefined;
  const join = tokens.findIndex(token => token.operator && token.value === '&&');
  if (join >= 0) {
    const prefix = tokens.slice(0, join);
    if (prefix.some(token => token.operator) || prefix[0]?.value !== 'cd') return undefined;
    const operands = prefix.slice(prefix[1]?.value === '--' ? 2 : 1);
    if (operands.length !== 1 || !operands[0]?.value || operands[0].value.startsWith('-')) return undefined;
    changedDirectory = operands[0].value;
  }
  const words = commandWords(tokens.slice(join + 1));
  if (!words?.length) return undefined;

  const first = words[0]!;
  if (shell.test(first) && /^-(?:l?c|cl)$/.test(words[1] ?? '') && words.length === 3 && !insideWrapper) {
    const invocation = parseCodexInvocation(words[2]!, true);
    if (!invocation || (invocation.changedDirectory && changedDirectory)) return undefined;
    return { ...invocation, changedDirectory: invocation.changedDirectory ?? changedDirectory };
  }
  const explicitHome = first.startsWith('CODEX_HOME=');
  const home = explicitHome ? first.slice('CODEX_HOME='.length) : undefined;
  let index = explicitHome ? 1 : 0;
  if (!executable.test(words[index++] ?? '') || words[index++] !== 'exec') return undefined;
  const role = words[index] === 'resume' ? 'resume' : 'fresh';
  if (role === 'resume') index++;

  const positional: string[] = [];
  let workdir: string | undefined;
  let json = false;
  let parseOptions = true;
  for (; index < words.length; index++) {
    const word = words[index]!;
    if (!parseOptions || word === '-' || !word.startsWith('-')) {
      positional.push(word);
      continue;
    }
    if (word === '--') {
      parseOptions = false;
      continue;
    }
    if (flags.has(word)) {
      json ||= word === '--json';
      continue;
    }
    const equalsAt = word.indexOf('=');
    const option = equalsAt < 0 ? word : word.slice(0, equalsAt);
    if (!optionsWithValue.has(option)) return undefined;
    const value = equalsAt < 0 ? words[++index] : word.slice(equalsAt + 1);
    if (!value || (equalsAt < 0 && value.startsWith('-'))) return undefined;
    if (option === '-C' || option === '--cd') {
      if (workdir !== undefined) return undefined;
      workdir = value;
    }
  }
  const maximumPositionals = role === 'resume' ? 2 : 1;
  const threadId = role === 'resume' ? positional[0]?.toLowerCase() : undefined;
  if (positional.length > maximumPositionals || (role === 'resume' && (!threadId || !threadIdPattern.test(threadId)))) {
    return undefined;
  }
  return { role, threadId, changedDirectory, workdir, home, json };
}
