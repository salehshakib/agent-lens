import { classifyClaudeRecord, parseClaudeRecords } from './claude-code/records';
import { claudeChatAdapter } from './claude-code/chat';
import { classifyCodexRecord, parseCodexRecords } from './codex/records';
import type { Adapter } from './types';

export const adapters = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    homeOverride: 'CLAUDE_CONFIG_DIR',
    defaultHome: '.claude',
    historyDirectory: 'projects',
    capabilities: { watch: true, usage: true, limits: [300, 10_080], auth: { status: false }, chat: true, modelSelect: false },
    chat: claudeChatAdapter,
    classifyRecord: classifyClaudeRecord,
    parseRecords: parseClaudeRecords,
  },
  {
    id: 'codex',
    label: 'Codex',
    homeOverride: 'CODEX_HOME',
    defaultHome: '.codex',
    historyDirectory: 'sessions',
    capabilities: { watch: true, usage: true, limits: [300, 10_080], auth: { status: false }, chat: false, modelSelect: false },
    classifyRecord: classifyCodexRecord,
    parseRecords: parseCodexRecords,
  },
] as const satisfies readonly Adapter[];
