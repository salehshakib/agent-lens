# Phase F report: approvals, input and scoped Stop

Branch `m2/phase-f`. Not committed.

## Checklist

| Item | Status | Where |
| --- | --- | --- |
| 6.1 Spawn switch with version gate; falls back to `--permission-prompts none` | done | `src/host/adapters/claude-code/approval-bridge.ts` `permissionPromptArgs`; `chat.ts` `openWorker` |
| 6.1 Strict request parse (subtype, request_id, tool_name, tool_use_id, input object) | done | `approval-bridge.ts` `parseApprovalRequest` |
| 6.1 Live store: request_id, tool_use_id, epoch (owner token), turn, deadline | done | `approval-bridge.ts` `ApprovalBridge`; host ledger in `src/host/chat/approvals.ts` |
| 6.1 Decision-time recheck: owner, channel, pending, duplicate, own panel | done | `ApprovalBridge.decide`, `ApprovalLedger.claim`, `ChatSessions.decideApproval` |
| 6.1 Always original `updatedInput`; webview cannot send input | done | `allowFrame`; `chatApproval` request has only id and decision (`protocol.ts` parser) |
| 6.1 Timeout, close, interrupt, owner change: auto deny, retire, no late allow | done | `ApprovalBridge.retire/interrupted/close/turnEnded`; `chat.ts` hooks in `close()` and `interrupt()` |
| 6.2 Inline card: tool name, redacted bounded preview, description, Allow once / Deny | done | `src/webview/panel/chat-approvals.ts`, `chat.ts` `updateApproval`, `media/chat.css` |
| 6.2 Persistent rules not offered; "not available yet" text | done | `chat-approvals.ts` `rulesNote` |
| 6.2 Retire after decision or any terminal/channel transition | done | `session.ts` `endApproval`, `retireApprovals` (called from `finish` and `disconnect`) |
| 6.2 Keyboard accessible, no focus stealing | done in code; manual check needed | buttons are native; focus moves only if it was already inside the card |
| 6.3 Interrupt turn uses the verified interrupt | done | `src/host/chat/control.ts`, `/stop` card in `src/extension.ts` |
| 6.3 Stop agent and Stop session | not enabled, no verified route | reasons in `src/shared/stop-reasons.ts`; `adapters/claude-code/control.ts`; Agents tab `agents.ts` |
| 6.3 `/stop` resolves the chosen target and shows its action | done | `extension.ts` `commandCards` stop branch; catalog blanket reason removed |
| Phase gate: allow/deny/stale/disconnect/interrupt in a disposable setup; one-child Stop | partly | unit tests cover the logic; live VS Code run and one-child Stop not done (Stop route unverified) |

## Decisions

- Deadline: 10 minutes (`approvalDeadlineMs`). The plan gives no value.
- Private display mode shows the card without arguments or buttons; the request is denied on timeout.
- The version gate always passes today because the launcher already requires 2.1.330. It is kept so a lowered minimum falls back to auto-deny.

## Unverified

- `permission_suggestions` and persistent rules, `updatedInput` edits, CLI behavior on no answer, and a reply after interrupt (Agent Lens never sends one: interrupt denies first).
- Any control subtype for stopping one agent, a background task or a session. No probe was run.

## Checks

`npm run typecheck`, `npm test` (230 pass, 1 skipped, 0 fail), `npm run build` all pass.
