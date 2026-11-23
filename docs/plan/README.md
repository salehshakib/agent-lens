# Agent Lens — Build Plan

Build plan · 23 November 2026 · Approval required before implementation

Agent Lens is a VS Code extension for watching and chatting with coding agents. Claude Code and Codex are the first two adapters; more agents plug in through the same adapter contract.

| Milestone | Scope |
| --- | --- |
| **M1** — View everything | Claude Code sessions, messages, subagents, files, Codex runs, Agent map, tokens, context fill, 5-hour / weekly limits, read-only account status |
| **M2** — Chat with Claude Code | Chat, background runs, approvals, model/effort picker, targeted Stop, Claude sign-in / profiles |
| **M3** — Codex control | Start, follow-up, verified Stop, Codex chat where supported, Codex sign-in / profiles |
| **M4** — Gemini CLI | Third adapter through the same contract |

Decisions and the remaining open question are in [15. Milestones](15-milestones.md#decisions).

## Parts

1. [Goal and scope](01-goal-and-scope.md)
2. [Claude Code data sources and schema](02-claude-code-data.md)
3. [Codex data sources and schema](03-codex-data.md)
4. [Unified session model and live state](04-session-model.md)
5. [Subagents, delegation, and Files](05-subagents-and-files.md)
6. [Usage in M1](06-usage-and-limits.md)
7. [Architecture and file watching](07-architecture.md)
8. [UI](08-ui.md)
9. [M2 Chat](09-chat.md)
10. [M3 Codex controls](10-codex-controls.md)
11. [Model and reasoning selection](11-models.md)
12. [Accounts](12-accounts.md)
13. [Tech stack, layout, and local packaging](13-tech-stack.md)
14. [Security and privacy](14-security.md)
15. [Milestones, checklist, and verification](15-milestones.md)
