# Agent Lens — Build Plan

Build plan · 23 November 2026 · Approval required before implementation

Agent Lens is a local VS Code extension for chatting with coding agents and inspecting their work from the conversation. Claude Code and Codex are the first two adapters. Both use the common adapter contract and normalized event model.

| Milestone | Scope |
| --- | --- |
| **M1** — View everything (merged) | Claude Code sessions, messages, subagents, files, Codex runs, Agent map, tokens, context fill with High/Critical levels, 5-hour / weekly limits, run signals (Possible loop, Done without checks), Open parent, read-only account status |
| **M2** — Chat-first conversations | One tab per conversation, Claude streaming, slash menu and inline M1 cards, `/resume`, compact tool and run blocks, keyboard controls, live status, verified approvals and Stop, attachments, queue, background work, conversation-scoped Codex launch and follow, Claude sign-in and profiles, M1 carryovers and Marketplace readiness |
| **M3** — Codex control | Independent Codex start, exact follow-up, verified Stop, chat where supported, sign-in and profiles |
| **M4** — Gemini CLI | Third adapter through the same contract |
| **Later** — Run statistics | Stats tab: tool and command failure rates, loop counts, Done without checks share, context pressure, stops |

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
9. [Chat-first conversations](09-chat.md)
10. [M3 Codex controls](10-codex-controls.md)
11. [Model and reasoning selection](11-models.md)
12. [Accounts](12-accounts.md)
13. [Tech stack, layout, and local packaging](13-tech-stack.md)
14. [Security and privacy](14-security.md)
15. [Milestones, checklist, and verification](15-milestones.md)
16. [Slash commands and inline cards](16-slash-commands.md)
17. [Chat runtime, session ownership, and controls](17-chat-runtime.md)

## Implementation plans

- [M1 implementation](m1-implementation.md)
- [M2 implementation phases](m2-implementation.md)
- [M2 steps and exit criteria](15-milestones.md#m2--chat-first-conversations)
- [M2 compatibility evidence](m2-compatibility.md)
