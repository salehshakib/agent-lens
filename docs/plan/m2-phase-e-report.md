# M2 Phase E report

## Checklist

- 5.1 Keyboard: partly. `src/webview/panel/chat-keys.ts` (`resolveKey`, `PromptHistory`) wired in `composer.ts`. Done: Enter, Shift+Enter, Esc order (menu, then interrupt), Up/Down history at the boundary with the draft stashed, IME ignored, Ctrl+O fold toggle (`chat.ts` `toggleFolds`), platform shortcuts pass through. Shift+Tab mode cycle: done (follow-up). `default, acceptEdits, plan, auto` via a typed `set_permission_mode` request (`chat.ts` `permissionModeFrame`, `stream.ts` `beginModeChange`, `session.ts` `cycleMode`). The shown mode is only what the CLI reports (init, response, `system/status`); an error keeps the old mode and shows its message. Gated on version, owned initialized channel and no active turn. Announced through a status region in `composer.ts`. Evidence is in `m2-compatibility.md`. Limit: the stream initializes inside the first turn, so the control appears after the first turn, not before it.
- 5.2 `!` and `@`: partly. `!` already returns an unavailable reason and never reaches a shell (`src/host/chat/commands.ts`); the reason now names the official terminal as the handoff. `@` shows "unavailable until attachments ship" in the key hint; Phase G picker not built.
- 5.3 Status line: partly. `src/host/views/chat-status.ts` projects state, profile, elapsed, model/Fast, mode, context, tokens, limit windows and pending count, each with a reason when Unknown. `src/webview/panel/chat-status.ts` renders it (elapsed ticks, not announced; state changes use the existing status region). Not done: effort (CLI does not echo it), `src/host/views/status.ts` untouched.
- 5.4 `rate_limit_event`: partly. `rateLimitWindows` (claude-probe.ts) is shared with the probe; `stream.ts` publishes a `limits` event after init; `session.ts` forwards it with the owner-checked identity; `RelayManager.recordStream` merges via `latestSamples` and tags the sample `source: 'chat'`. A missing window keeps its prior sample. Not done: account generation (no verified account generation exists in this codebase); binding is owner plus profile plus home.
- 5.5 Refresh limits: done in code (see below); VS Code check pending.
- Phase gate: automated checks pass; the disposable VS Code profile checks are manual.

## 5.5 findings

- Installed CLI 2.1.330. Shipped probe args on PowerShell give a result with `num_turns: 0` and no model call. The `/usage` text route parses.
- The same CLI also attaches `usage_report.rate_limits.limits` to the local command record (kinds `session` and `weekly_all`, `percent`, ISO `resets_at`). No `rate_limit_event` is emitted for `/usage`. Structured decoding is now preferred, text is the fallback.
- Root cause of the disabled control: `resolveClaude` searched only `process.env.PATH`, while chat searched `~/.local/bin` and `%APPDATA%\npm` as well. A VS Code started from a launcher often lacks those folders, so `claudeFound` was false and the control read "not found on PATH". Fix: `claudeSearchDirectories` adds both folders.
- Test pitfall: Git Bash rewrites `/usage` into a Windows path, so run the probe from PowerShell.

## Files

src/host/limits/claude-probe.ts, manager.ts, model.ts; src/host/adapters/claude-code/stream.ts; src/host/chat/session.ts, types.ts, commands.ts; src/host/views/chat-status.ts (new), data.ts; src/shared/protocol.ts; src/webview/panel/chat-keys.ts (new), chat-status.ts (new), composer.ts, chat.ts; media/chat.css; src/extension.ts; tests: limits, chat-keys (new), chat-status (new).

## Manual checks

Refresh limits in the installed extension with VS Code started from the Start menu; both windows and reset times against `/usage`; failure keeps a prior sample; Esc/Enter/Ctrl+O and Up/Down focus behavior with a screen reader and an IME; status line announcements.
