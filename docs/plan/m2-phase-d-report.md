# M2 Phase D report

1. **4.1 · Reconciliation**
   1. Match provisional and recorded rows by exact provider identity and verified scope.
   2. Deduplicate prompts, replies, tool calls and results, task events and usage across stdout, replay, append and rewrite.
   3. Preserve unresolved identities and count each observed turn and its usage once.
   4. Preserve source order for historical materialization and attach existing parent, file and signal targets to stable rows.
2. **4.2 · Transcript presentation**
   1. Render prompts and replies at readable width.
   2. Fold provider-visible thinking and tool activity with label, outcome, duration and bounded redacted output. Exclude internal payloads and signatures.
   3. Show compact recorded Edit and Write diffs, eligible full diff actions and available file evidence. Label missing sides and proposed, applied, failed and unknown changes.
3. **4.3 · Tasks and delegation**
   1. Normalize verified to-dos with per-item state and completed count. Place the latest checklist near its evidence and reuse it in `/tasks`.
   2. Group delegated agents and linked runs at the spawning call with owner, status, transcript, files, Agent map and launch evidence actions.
   3. Preserve child chronology and unresolved launch positions through reconciliation.
4. **4.4 · Incremental rendering and navigation**
   1. Reuse the existing projections and private display rules.
   2. Update text incrementally and preserve focus and open blocks. Follow only at the bottom and show Jump to latest when reading earlier rows.
   3. Preserve anchors through card, lane and secondary-view navigation.
   4. Check long histories, wide command output, narrow layouts and newly reconciled child rows.
5. **4.5 · Timeline Open parent**
   1. Use the selected lane’s existing parent projection and `parentAction` for the exact spawning row and multi-launch menu.
   2. Show unresolved reasons and hide the action for root lanes.
   3. Preserve destination highlight and focus. Restore the source lane, filters and scroll anchor with Back.
6. **Phase gate**
   1. Replay deterministic stream and history evidence and compare rows and usage. Cover transcript folding, diffs, tasks, groups and lane parent projection in tests.
   2. Verify a Claude subagent, Codex child and linked Codex run in VS Code, including multiple launch targets, unresolved and root lanes, keyboard focus and Back.
   3. Run `npm run typecheck`, `npm test` and `npm run build`.

## File ownership

- A owns `src/host/chat/reconcile.ts`, `src/host/sessions/store.ts`, `src/host/sessions/evidence.ts` and `src/host/adapters/claude-code/stream.ts`.
- B owns `src/host/views/chat-transcript.ts`, `src/host/views/models.ts` and `src/host/views/chat-cards.ts`.
- C owns `src/webview/panel/chat-transcript.ts`, `src/webview/panel/timeline.ts`, `src/webview/panel/chat-cards.ts` and `src/webview/panel/nav.ts` if needed.
- The coordinator owns `src/shared/protocol.ts`, `src/host/chat/types.ts`, `src/host/chat/session.ts`, `src/host/views/data.ts`, `src/webview/panel/chat.ts` and `media/chat.css`, plus integration, gates and this report.

## Status (implementation worker)

- 4.5 done. `src/shared/protocol.ts` `LaneOption.parent`; `src/host/views/models.ts` lanes carry `parentInfo`; `src/webview/panel/timeline.ts` lane header uses `parentAction` for the selected lane (hidden for root, disabled with reason when unresolved, host quick-pick for multi-launch via existing `openParent`). Back/highlight reuse existing nav. Test: `test/lane-parent.test.ts`.
- 4.1 done (chat view path). `src/host/chat/reconcile.ts` (`reconcileRows`, `reconcileUsage`, `scopeSessionId`); recorded rows carry opaque `nativeKeys` (`items.ts`, `evidence.ts` `identityKey`, `types.ts`, `RowView`); live stream rows carry exact identity (`session.ts`); `view()` drops live rows covered by recorded rows only when the conversation scope derives the session id. Unresolved rows are kept. Live usage is not shown by the chat today, so `reconcileUsage` is the single-count helper and is not yet wired. Test: `test/chat-reconcile.test.ts`. Not changed: `store.ts`, `stream.ts` (no change needed).
- 4.2 partly. `src/host/views/chat-transcript.ts` folds thinking/tools with outcome, duration, bounded output, change state, compact diff (via exported `previewHunks` in `chat-cards.ts`). Rendered as folded cards (`ChatCard.folded`, `src/webview/panel/chat-cards.ts`, open state kept in `chat.ts`). Not done: full diff action on inline diffs (card actions need the host action registry).
- 4.3 partly. Agent/Codex-run groups at the spawning row, unresolved launches at observed position: done (owner/status/launch reason). Not done: to-do checklist and `/tasks` reuse, because no verified to-do payload shape is recorded in `m2-compatibility.md` or any adapter; transcript/files/Agent map/launch-evidence actions on groups not wired.
- 4.4 partly. Existing follow-at-bottom, Jump to latest and anchor code reused; folds keep open state. Not exercised: long histories, narrow layouts.
- Tests: `test/chat-transcript.test.ts` covers folding, diff states, agent group.

## Follow-up (second pass)

- 4.2 full diff: done. `src/host/views/chat-transcript.ts` `diffLink` offers `openDiff` (the Files-tab route) only for an eligible recorded patch; otherwise shows the reason (private mode, no patch, no eligible hunks). Rendered by `renderLinks` in `src/webview/panel/chat-cards.ts`; type `CardLink` in `src/shared/protocol.ts`.
- 4.3 group actions: done. Agent and Codex groups link Open transcript (`openTranscript`), Files and Agent map (local tab switch via `ChatPane` `openTab` / `select` in `src/webview/panel.ts`), Launch evidence (`goto` to the spawning row). Unresolved targets show the reason text, not a dead button.
- 4.3 to-do checklist: Not available: provider exposes no to-do tool (evidence: m2-compatibility.md, "To-do tool availability"). `/tasks` keeps background tasks.
- 4.4: deterministic tests added in `test/chat-transcript.test.ts` for a 1,400-row history (bounded output), wide tool output clipping, and a reconciled child keeping its group position. Narrow-layout checks stay manual.
