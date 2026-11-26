# M2 Phase D report

## Checklist and results

1. **4.1 · Reconciliation**
   1. **Done.** Match prompts, assistant blocks and tool evidence by exact identity in the verified provider, home, profile, session and cwd. [Scope check](../../src/host/chat/session.ts#L154), [recorded identities](../../src/host/sessions/evidence.ts#L54)
   2. **Done for verified routes.** Deduplicate stdout and replayed prompts, blocks, tool calls and results, and recorded task events across append and rewrite. **Not done for live task events.** The capture lacks a verified stdout task envelope. [Stream adapter](../../src/host/adapters/claude-code/stream.ts#L454), [replay fixture](../../test/chat-reconcile.test.ts#L144), [compatibility record](m2-compatibility.md#open-coverage)
   3. **Done for attributed turns.** Select one usage source per turn and use it in `/usage`. Preserve unresolved identities. A partial and a final can remain separate when the final lacks shared block coordinates. [Reconciliation](../../src/host/chat/reconcile.ts#L36), [usage integration](../../src/host/chat/session.ts#L160), [integration test](../../test/chat-live-routes.test.ts#L209)
   4. **Done.** Use M1 source order and stable row targets for Timeline, file and signal evidence. Transfer provisional anchors when recorded rows take over. [Row merge](../../src/host/chat/session.ts#L183), [recorded evidence links](../../src/host/views/chat-transcript.ts#L147)
2. **4.2 · Transcript presentation**
   1. **Done.** Render prompts and replies in order with a readable line length. [Projection](../../src/host/views/chat-transcript.ts#L159), [transcript width](../../media/chat.css#L37)
   2. **Done for tool activity and recorded thinking metadata.** Fold tool names, outcomes, durations and bounded redacted output. **Not done for provider-visible thinking summaries.** The available Claude capture and M1 parser supply no display-safe summary field. Internal reasoning and signatures stay out of the view. [Activity projection](../../src/host/views/chat-transcript.ts#L91), [live tools](../../src/host/chat/session.ts#L840), [private display test](../../test/chat-transcript.test.ts#L41)
   3. **Done.** Show recorded Edit and Write previews, eligible full diff and file actions, missing sides, and proposed, applied, failed and unknown states. [Diff and file projection](../../src/host/views/chat-transcript.ts#L20), [state coverage](../../test/chat-transcript.test.ts#L63)
3. **4.3 · Tasks and delegation**
   1. **Not done.** The tested Claude Code 2.1.330 stream and recorded histories supplied no structured to-do payload. The checklist, completed count and shared `/tasks` projection require that evidence. `/tasks` shows background tasks. [Provider probe](m2-compatibility.md#to-do-tool-availability-phase-d), [Tasks projection](../../src/host/views/chat-cards.ts#L341)
   2. **Done.** Fold Claude agents and verified linked Codex runs at their spawning calls with owner, status, transcript, Files, Agent map, launch evidence and Open parent actions. Linked Files and Agent map open the owning session. [Grouping](../../src/host/views/chat-transcript.ts#L211), [group actions](../../src/host/views/chat-transcript.ts#L235)
   3. **Done.** Preserve child source order and exact Codex turn attribution. Unresolved launches retain their observed position and reason. [Child projection](../../src/host/views/chat-transcript.ts#L253), [late child and linked run coverage](../../test/chat-transcript.test.ts#L133)
4. **4.4 · Incremental rendering and navigation**
   1. **Done.** Reuse M1 row, signal, file and private display projections, with bounded output for chat. [Lane rows](../../src/host/views/models.ts#L208), [activity projection](../../src/host/views/chat-transcript.ts#L91)
   2. **Done.** Patch mounted text and disclosures in place with stable focus, bottom-follow and Jump to latest. [Keyed renderer](../../src/webview/panel/chat-transcript.ts#L110), [scroll and jump](../../src/webview/panel/chat.ts#L170)
   3. **Done in code.** Preserve chat anchors and secondary view scroll positions. Use local and cross-editor Back for evidence navigation. [Chat scroll anchors](../../src/webview/panel/chat.ts#L174), [navigation](../../src/webview/panel/nav.ts#L120), [panel integration](../../src/webview/panel.ts#L166)
   4. **Done for deterministic history, wide output and late child coverage.** Offline Chromium verified 1,402 rows at 320 × 640, independently scrolling command output, and stable focus and open disclosures when a provisional tool resolved and a child row arrived. VS Code viewport and focus checks are pending. [Projection tests](../../test/chat-transcript.test.ts#L110)
5. **4.5 · Timeline Open parent**
   1. **Done.** The selected lane header uses M1 parent evidence and the existing Open parent handler, including the newest-first launch chooser. An exact spawning row can be included outside the recent Timeline window. [Lane projection](../../src/host/views/models.ts#L448), [lane action](../../src/webview/panel/timeline.ts#L240), [older target test](../../test/lane-parent.test.ts#L62)
   2. **Done.** Hide the action on root lanes and show an unavailable reason on unresolved lanes. [Shared control](../../src/webview/panel/nav.ts#L159), [lane parent tests](../../test/lane-parent.test.ts#L25)
   3. **Done in code and verified offline for same-editor navigation.** Highlight and focus the destination row. Back restores the originating lane, event filter and scroll anchor. Offline Chromium also verified the root, unresolved and sole-lane controls and the scoped host request for multiple launch choices. Native VS Code Quick Pick and cross-editor verification are pending. [Timeline landing](../../src/webview/panel/timeline.ts#L169), [Back](../../src/webview/panel/nav.ts#L140)
6. **Phase gate**
   1. **Done for deterministic replay and projections.** Replayed duplicate stdout and history records, compared rows and usage through append and rewrite, and tested tool folds, diff states, recorded background tasks, delegation and the lane parent projection. The structured to-do evidence gate remains open. [Replay](../../test/chat-reconcile.test.ts#L144), [chat integration](../../test/chat-live-routes.test.ts#L209), [projection](../../test/chat-transcript.test.ts#L21), [parent projection](../../test/lane-parent.test.ts#L25)
   2. **Not done in VS Code.** Run the live and manual checks below in a disposable workspace and approved test profile. [Manual checks](#live-and-manual-checks-for-the-orchestrator)
   3. **Done.** Typecheck, 198 tests and build passed. [Command output](#exact-command-output-tails)

## Files changed

- A · `src/host/chat/reconcile.ts`, `src/host/sessions/evidence.ts`, `src/host/sessions/items.ts`, `src/host/sessions/types.ts`, `src/host/adapters/claude-code/stream.ts` and `test/chat-reconcile.test.ts`. The M1 row constructor attaches opaque identities to the existing rows. Append and rewrite reuse the store’s generation handling.
- B · `src/host/views/chat-transcript.ts`, `src/host/views/models.ts`, `src/host/views/chat-cards.ts`, `test/chat-transcript.test.ts` and `test/lane-parent.test.ts`.
- C · `src/webview/panel/chat-transcript.ts`, `src/webview/panel/chat-cards.ts`, `src/webview/panel/timeline.ts` and `src/webview/panel/nav.ts`.
- Coordinator · `src/shared/protocol.ts`, `src/host/chat/types.ts`, `src/host/chat/session.ts`, `src/host/views/data.ts`, `src/host/views/panel.ts`, `src/extension.ts`, `src/webview/panel.ts`, `src/webview/panel/chat.ts`, `media/chat.css`, `test/chat-live-routes.test.ts`, `test/protocol.test.ts` and this report. The panel handler routes child Files and Agent map actions to their owning editor and keeps the target row available through refreshes.

## Exact command output tails

### `npm run typecheck`

```text
> agent-lens@0.1.3 typecheck
> tsc --noEmit
```

### `npm test`

```text
# Subtest: the files vsce would package today pass the inspector
ok 198 - the files vsce would package today pass the inspector
  ---
  duration_ms: 2528.1206
  ...
1..198
# tests 198
# suites 0
# pass 198
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3245.1015
```

### `npm run build`

```text
> agent-lens@0.1.3 build
> node scripts/build.mjs


  dist\relay\relay.js  5.3kb

Done in 12ms

  dist\webview\panel.js    94.5kb
  dist\webview\sidebar.js  18.5kb

Done in 29ms

  dist\host\extension.js  500.3kb

Done in 37ms
```

## Live and manual checks for the orchestrator

1. In the Extension Development Host, start a conversation in a trusted disposable workspace on the approved Claude profile and then continue its exact session. Send a harmless prompt that produces several response blocks, a tool result and a terminal usage frame. Collect scrubbed stdout and a copy of the corresponding recorded transcript. Compare prompt UUID, assistant response ID and block coordinates, tool call/result IDs, and usage before the transcript arrives and after append or rewrite of the copy. Verify one row per resolved item, one turn’s usage in `/usage`, and a visible unresolved state where identity is missing. Check whether this capture supplies a display-safe thinking summary, a scoped stdout task event or a structured to-do update.
2. Use disposable files and benign tool output to verify a folded tool call and result, readable prompt/reply width, outcome, duration, truncation, and the compact Edit/Write diff. Use recorded samples for proposed, applied, failed and unknown changes and a Write with no preimage. Open full diff and file evidence, then enable private display and confirm prompts, commands, output, reasoning bodies and diffs are hidden.
3. Open a long conversation near the bottom and then scroll to earlier rows while a new reply streams. At a narrow editor width, use a wide command output and expand a delegation as a child row arrives. Verify bounded output scrolling, stable focus and disclosure, Jump to latest, child order and unchanged reading position. Open Files and Agent map from the child group and return to the original chat disclosure and scroll anchor.
4. In Timeline, select a Claude subagent lane, a Codex child thread and a verified Claude-linked Codex run. Press Open parent with the keyboard and verify the exact Agent, spawn or Bash row is scrolled into view, highlighted and focused. Repeat with a parent row outside the recent Timeline window. For a twice-launched Codex thread, verify the native chooser lists launches newest first and each choice reaches its own row. Check that a root lane hides the action and that an unresolved lane shows its disabled action and reason.
5. Before each Open parent jump, set a lane and event filter and scroll away from the latest row. Use Back after same-editor and cross-editor jumps and verify the original lane, filter and scroll anchor. From the destination of a cross-editor jump, follow a local evidence link and confirm Back returns to the immediate local source and then to the original editor.
