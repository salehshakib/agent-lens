# M2 Agent Lens chat drill-down plan

Plan only · `m2/agent-drilldown` · baseline `5b64bea`

## Checklist from the user's request

1. [ ] Continue Agent Lens using Codex.
2. [ ] Use `interface-design` to design the chat interface.
3. [ ] Make each delegation block open that agent's recorded prompt, tool calls with input and output, messages, and final result, following the click-to-inspect behavior described for the Claude Code VS Code extension.
4. [ ] From the main Claude chat, open a linked Codex run and drill into each of its Codex subagents, including the two siblings in the example.
5. [ ] From the main Claude chat, open a Claude subagent and drill into each of its own subagents, including the two siblings in the example.
6. [ ] Repeat the same interaction at deeper verified levels and navigate back up to the spawning block.
7. [ ] Open the agent view as a popup inside the extension, like the Claude Code extension, not as a separate tab or a pane that replaces the chat.

## interface-design findings applied

**Intent.** A developer working in a VS Code split has delegated part of a coding task. They need to check what an agent received, ran and reported, then return to the same point in the conversation. The root should scan like a work log. The selected agent should read like a transcript, with inputs and outputs one disclosure away.

- **Domain.** Spawning tool call, agent lane, rollout, exact launch turn, sibling thread, recorded result, and return to the parent row.
- **Color world.** The VS Code editor canvas, foreground text, description text, command block background, focus outline, and warning/error accents already carry meaning in the workbench. Reuse those roles across both providers.
- **Signature.** A delegation block at the exact spawning row leads to a transcript whose breadcrumb and Back retain that launch occurrence. The signature appears in the group aligned to its spawn, the same block for direct children, the launch-specific breadcrumb, the return focus on that block, and the pending row staying in place as verified evidence arrives.
- **Defaults considered.** An inline stack would compress the transcript with every level. A separate tab would spread one reading path across editors. A permanent tree and transcript split would spend scarce width on navigation. A pane that replaces the chat body hides the conversation the user came from. Use one modal popup inside the chat webview, opened over the conversation like the Claude Code extension, with the direct children in context and the active path above it. The chat stays mounted underneath, so its draft, scroll and focus are intact on close.

| Principle | Application |
| --- | --- |
| One focal point per view | In root chat, keep the conversation primary and align the delegation action directly beneath its spawning row. In the popup, give the selected agent name the strongest heading and its activity the full reading width. Put provider, elapsed time and secondary evidence below or beside the name. Style the current breadcrumb segment as the location and ancestors as links. |
| Workbench density and deliberate rhythm | Use a 4 px spacing unit. Allow 4 px between related labels, 8 px between adjacent controls, 12 px popup padding at narrow widths and 16 px in wider splits. Use 16 px between activity groups. Give primary delegation rows a full-width hit area with a 44 px minimum height, and give Back and breadcrumb controls distinct, nonoverlapping hit areas of at least 40 px. At narrow widths, wrap status and time below the agent name and keep the activation affordance aligned to the trailing edge. |
| Weight before size | Reuse the VS Code UI font and size for messages. Set the popup heading to about 1.2 times that size with weight 600, and use weight 600 at the base size for the agent name in the block. Set event labels and provider metadata at the base size with supporting color or weight so they remain legible. Use the configured editor font for commands, input and output. Use tabular numerals for elapsed time so updates keep their alignment. |
| Borders-only depth, one elevated layer | Keep the chat on `--vscode-editor-background` and use one quiet boundary for the delegation row and tool disclosures via the existing `--chat-border` alias of VS Code border tokens. The popup is the only elevated surface: `--vscode-editorWidget-background`, a `--vscode-editorWidget-border` (or `--vscode-contrastBorder` in high contrast) edge and `--vscode-widget-shadow`, over a backdrop that dims the chat with a translucent overlay (solid border, no dimming reliance, in high contrast). Use the code block surface for expanded output. Use a compact ancestor disclosure in the layout flow if deep ancestry needs to collapse. |
| Semantic tokens | Reuse `--vscode-foreground` and `--vscode-descriptionForeground` for primary and supporting text, `--vscode-textLink-foreground` for interactive ancestor labels, `--vscode-list-hoverBackground` for row hover, and `--vscode-focusBorder` and `--vscode-contrastBorder` for focus and visible edges. Keep state text next to the existing badge tones for warning, error and success. Check text contrast and focus in both high-contrast variants as well as light and dark. Use bundled assets, VS Code theme variables and the existing CSP. |
| Native controls and complete states | Reuse the existing DOM `button` and `badge` helpers and native `details` for tool and ancestor disclosures. Give the primary row visible default, hover, pressed and keyboard-focus states. Show a concise reason in place when navigation is unavailable. Distinguish loading, empty activity, unavailable source, partial capture and private display with text, preserving the header and return path. Publish meaningful status changes through the existing polite live region. |
| Fast repeated navigation | Open and return immediately, with focus restoration and an optional existing theme highlight at the launch row. Keep live rows in place as they update. Respect reduced motion for focus, disclosure and scroll behavior. |

## Chat design

Use a **read-only agent popup inside the chat webview** (user decision, 25 November 2026: "agent view kintu extension er moddei pop up open hobe like claude code extension"). Selecting the compact delegation block at the spawning row opens the child's full activity in a modal popup over the conversation in one click, the way the Claude Code extension opens a subagent. The chat, composer and draft stay mounted underneath and are not re-rendered. Drilling into a grandchild replaces the popup content in place; it never stacks a second popup. Keep Agent Lens's existing chat-card styling and VS Code conventions.

- **Popup frame.** A native `<dialog>` opened with `showModal()` (or an equivalent `role="dialog"` with `aria-modal="true"` and `aria-labelledby` on the agent heading). Size: up to 960 px wide and 85% of the webview height, centered; at narrow widths (under 600 px) it fills the webview with an 8 px margin. Header row: Back, breadcrumb, then a Close button (`×`, labelled "Close agent view") at the trailing edge. The body scrolls; the header stays fixed.
- **Open, close and focus.** Opening moves focus to the agent heading and traps Tab inside the popup. Close, Escape, or a click on the backdrop closes the whole popup and returns focus to the delegation block that opened it, with the chat's scroll position unchanged. Escape closes an open menu inside the popup first, then the popup, and never interrupts the turn while the popup is open (consistent with the Phase E rule that Esc dismisses menus or dialogs first).
- **Live.** The popup keeps updating while the child runs. A new event for the open agent does not move the chat underneath. [UI contract](08-ui.md) · [Chat contract](09-chat.md) · [Phase D](m2-phase-d-report.md)

- Reuse the Phase D folded group at the launching tool row. Its primary surface is a native button with provider, safe name, text status, and observed elapsed time. Include a short recent activity label when eligible. Show a chevron when there is a verified route. Keep secondary actions as separate controls in the group details or popup header. Preserve **Open transcript**, **Files**, **Agent map**, and **Launch evidence**, with the raw transcript action subject to its existing private-mode check. Label secondary views by their actual scope and route Launch evidence to the exact spawning lane and row.
- In the popup, put the breadcrumb and **Back** above a heading with the child name, provider and status. Display eligible prompts, commentary and agent messages, tool calls and results, and the recorded final in source order. Keep prompt and message text readable. Use a disclosure per tool for allowlisted input, captured output, duration, exit code, and recorded diff when present. Keep a summary on each disclosure. Distinguish stdout and stderr when separately attributable. Label a terminal result when the evidence identifies one. Show **Final result not recorded** when history has ended with no verified final text.
- Show each direct child at its own spawning row with the same action, including when the parent is itself a Codex child or Claude subagent. A row for a verified spawn can open even when its transcript is still pending, with the popup explaining what has arrived. Offer **Load earlier activity** for retained older rows and an expansion or next page for retained long output. Mark capture loss separately from content still available to load.
- Breadcrumbs represent the exact path taken, including the Claude Bash launch for a resumed Codex turn. Use an accessible ordered breadcrumb with click-to-jump ancestors and a current-location marker. Inside the popup, Back pops one level and shows the parent agent with its launch block for the child scrolled into view, folds restored and focused. At the first level, Back closes the popup (same as Close). The root crumb (**Main Claude**) closes the popup and focuses the launch block in the chat. An ancestor jump pops to that ancestor inside the popup and restores the originating block there. If that block disappeared, focus the ancestor heading and report that the evidence changed. Keep per-level scroll, folds, unread count and focus as view state. Keep the root draft and active turn with the existing conversation. Use the existing Open parent action for Timeline or a separate recorded session. It already offers multiple launches when there is no chosen path. [Parent navigation](08-ui.md#parent-navigation) · [Phase F controls](m2-phase-f-report.md)
- Follow the currently viewed activity only while the reader is near the bottom. While they read earlier rows, preserve the anchor and show **Jump to latest (N new)**. Update the mounted row and its status as records arrive. Preserve links, open disclosures and focus through updates. Announce material changes such as transcript arrival or completion through the existing polite live region. Keep a single popup body viewport with a wrapping breadcrumb and labels, prose wrapping within the editor, and wrapping or local scroll inside long code/output disclosures. On deeper paths, a labeled ancestor menu can hold middle crumbs while the root, current location and Back stay reachable.
- Keep the popup read-only. Parent activity and the existing approval surface remain reachable by closing the popup. If an approval request arrives for the conversation while the popup is open, show a non-modal notice inside the popup header ("Approval waiting in chat") with a button that closes the popup and focuses the approval card. Child inspection introduces no launch or control route. Escape closes the popup as described above; use the visible Back button to step up one level. [Chat keyboard contract](09-chat.md) · [Phase F controls](m2-phase-f-report.md)

### Display states

| Evidence | What the user sees |
| --- | --- |
| Verified edge and readable activity | Actionable block and the scoped transcript. Display **Running**, **Completed**, **Failed**, **Stopped** or **Outcome unknown** only as supported by the observed state. |
| Verified spawn with a missing or delayed child file | Show **Waiting for transcript** while observation or a bounded read is pending, or **Transcript unavailable** when unavailable. Show safe launch evidence and any separately verified result. Keep the block in place when the child arrives. |
| Readable source with an empty activity scope | Show **No activity recorded yet** for an active child or **No activity recorded** for a finished scope. Keep the child header and Back available. |
| Launch identity unresolved, ambiguous, or conflicting | Show **Launch unresolved** beside the observed launch or a scoped unresolved notice when only the lane is known. Explain the safe reason. Keep independently observed transcripts available through their existing session or lane route. |
| Source missing, removed, disabled, or access revoked | Replace the popup body with **Source unavailable**, keep Back and Close reachable, and clear cached evidence from that source. |
| Partial source or truncated payload | Keep available rows, label **History partial**, **Output truncated**, or **Input/Output not recorded** at the relevant location. Display **Load earlier activity** or **Show more output** only if eligible data is available through that route. |
| Private display | Render neutral provider and agent labels, verified structural links, and status when allowed. Show **Activity hidden in private display** for suppressed content. Suppress free-form names, prompts, command text, payloads, diffs, sensitive paths, and disallowed actions before posting view data. Clear previously rendered and cached child content on toggle. |

### ASCII mockups

Illustrative labels and activity. Each bracketed delegation is a direct drill-down action. Every agent view below is the content of the one popup; both sibling slots use the same popup and behavior.

```text
Popup over the chat (clicked "Reviewer / Claude")
+-------------------------------------------------------------+
| Export review (dimmed)                              [Views] |
|  +-------------------------------------------------------+  |
|  | [<]  Main Claude > Reviewer                       [x] |  |
|  |-------------------------------------------------------|  |
|  | Reviewer / Claude                          Running    |  |
|  | Prompt   Review the export changes.                   |  |
|  | > Read / src/export.ts                     Completed  |  |
|  | ...                                                   |  |
|  +-------------------------------------------------------+  |
| [Message Claude (dimmed, draft kept)                  Send] |
+-------------------------------------------------------------+
```

```text
Main Claude chat
+-----------------------------------------------------------+
| Export review                                      [Views]|
| You     Review the export changes.                        |
| Claude  I'll inspect the changes and delegate the checks. |
| > Bash / Launch Codex                                     |
|   +-- [Export checks / Codex       Running  00:32  >]     |
| > Agent / Review changes                                  |
|   +-- [Reviewer / Claude          Running  00:24  >]      |
| [Message Claude                                      Send]|
+-----------------------------------------------------------+
```

```text
Linked Codex run
+-----------------------------------------------------------+
| [Back]  [Main Claude] > Codex / Export checks         [x] |
| Export checks / Codex                         Running     |
| Prompt   Verify the exports.                              |
| > Command / git diff --stat                  Completed    |
| > Subagent started / Tests                                |
|   +-- [Codex subagent 1 / Tests       Running      >]     |
| > Subagent started / API                                  |
|   +-- [Codex subagent 2 / API         Completed    >]     |
| [Launch evidence] [Files] [Agent map]                     |
+-----------------------------------------------------------+

Either Codex child
+-----------------------------------------------------------+
| [Back]  [Main Claude] > [Codex] > Codex subagent 1    [x] |
| Tests / Codex                                 Completed   |
| Prompt       Check export tests.                          |
| v Command    npm test / exit 0                            |
|   Input      npm test                                     |
|   Output     Export checks passed                         |
| Agent message  Test check complete.                       |
| Final result   Export checks passed.                      |
+-----------------------------------------------------------+
  Codex subagent 2 opens here with its own API activity.
```

```text
Claude subagent
+-----------------------------------------------------------+
| [Back]  [Main Claude] > Claude / Reviewer             [x] |
| Reviewer / Claude                              Running    |
| Prompt   Review the export changes.                       |
| > Read / src/export.ts                       Completed    |
| > Agent / Verify schema                                   |
|   +-- [Claude subagent 1 / Schema     Completed   >]      |
| > Agent / Check errors                                    |
|   +-- [Claude subagent 2 / Errors     Running     >]      |
| [Launch evidence] [Files] [Agent map]                     |
+-----------------------------------------------------------+

Either nested Claude child
+-----------------------------------------------------------+
| [Back]  [Main Claude] > [Reviewer] > Claude subagent 1 [x]|
| Schema / Claude                                Completed  |
| Prompt       Verify the schema.                           |
| v Read       src/schema.ts / Completed                    |
|   Input      path and recorded line range                 |
|   Output     recorded excerpts                            |
| Message      The export matches the schema.               |
| Final result   No schema changes needed.                  |
+-----------------------------------------------------------+
  Claude subagent 2 opens here with its own error review.
```

## Data available and host changes

### 1. Main Claude chat and the spawning row

**Today.** `LensData.chat` projects recorded history through `buildDetail` and `projectTranscript`. The latter reads the main lane only and currently puts off-main agents whose edge points elsewhere into the unresolved placement path. `buildDetail` trims the merged timeline to 1,500 rows and represents external children once per canonical session. `openTranscript` in `src/extension.ts` opens the raw registered source in a VS Code editor and checks private display. [Phase D report](m2-phase-d-report.md) · [Session model](04-session-model.md)

**Change.** In `src/host/views/chat-transcript.ts` and `src/host/views/models.ts`, reuse the current fold placement and render only direct edges of the selected parent scope. Match the exact parent session, lane and row, with the parent turn where applicable. Keep an unresolved item beside its observed launch only when it belongs to that lane. For scopes where the spawn row was omitted or is still loading, expose the eligible older page or a scoped unavailable reason. Key a run block by verified launch row and edge, with a stable placeholder key reused on an exact late match. Keep the existing root reconciliation in `src/host/chat/reconcile.ts` and preserve the current Files, Agent map and Launch evidence routes as secondary shortcuts.

### 2. Claude subagent and nested Claude subagents

**Today.** `src/host/discovery/catalog.ts` discovers `<session>/subagents/agent-*.jsonl` and `.meta.json` in a flat directory under the owning Claude session. `src/host/adapters/claude-code/records.ts` normalizes child rows and reads companion `toolUseId`, `spawnDepth` and outcome. `claudeChildren` in `src/host/sessions/ancestry.ts` can find a verified Agent/Task spawn across all lanes in the same project bucket. It checks exact unique identity, matching result `agentId` where present, cycles and recorded depth. A pending Agent lane can exist without a transcript. The repo has real direct launch samples and tests for late, ambiguous and cyclic ancestry, plus parsing `spawnDepth: 2`. A successful nested Claude tree through the VS Code Chat UI remains unverified. [Claude data evidence](02-claude-code-data.md) · [Delegation model](05-subagents-and-files.md)

**Change.** Project the selected lane in the same session and recursively expose its direct `lane.parent` matches, using the existing reducer and paired rows. A child user message may provide the prompt. In `src/host/adapters/claude-code/tools.ts`, the Agent/Task `input.prompt` currently contributes to the argument hash only. Add a bounded redacted display field from a verified spawn when needed, labeled **Delegated prompt** if separate from the child's recorded prompt. Prefer one prompt when both records identify the same content. Use exact terminal response evidence in `src/host/sessions/turns.ts` or an attributable terminal Agent/Task result for Final. When only the latter is available, label it **Result reported to parent**. `src/host/adapters/claude-code/stream.ts` skips parent-scoped frames in the current chat path, so use watched approved log and metadata updates for child activity. A child that has emitted no qualifying record stays pending. [Claude data evidence](02-claude-code-data.md) · [Phase F runtime evidence](m2-phase-f-report.md)

### 3. Claude launch to a linked Codex run

**Today.** `src/host/adapters/claude-code/launcher.ts`, `src/host/sessions/launch-command.ts`, and `src/host/sessions/delegation.ts` verify recognized Bash/exec launch shapes and startup identity from the exact `AGENT_LENS_CODEX_SESSION` marker, structured `thread.started` or a strict native startup header. An unambiguous exact resume UUID is eligible with one corroborating new turn. The join requires an approved Codex profile, a matching working directory and launch interval, and one attributable turn. When provenance conflicts, the run remains standalone. Task-output prefix reads are bounded and tied to the owning Claude task. `SessionStore` retains each `DelegationLink` with its origin row and destination turn. `src/host/chat/codex-launch.ts` already projects per-launch targets for `/codex follow` and routes to Timeline through `src/extension.ts`. The repo tests separate fresh/resume matching and late arrival. The live `codex-first` Git Bash marker workflow through to nested children has no checked-in end-to-end evidence. [Launcher convention](../../README.md) · [Delegation model](05-subagents-and-files.md) · [M2 compatibility](m2-compatibility.md)

**Change.** Reuse each exact `DelegationLink` from `src/host/sessions/store.ts` to open the destination Codex lane **and linked turn**. Keep the launch origin separate from the child target. Generate one card per launch occurrence, even when the same rollout is resumed, and scope the header, rows, final result and direct child spawns to that turn. Keep one canonical Codex session and leave usage accounting at its existing scope. Present current rollout prompts, commentary, tool output and `final_answer` or exact `task_complete.last_agent_message` fallback as available. Use task prefixes for launch verification and the rollout for transcript content. A prompt held only by the launcher or a final report held only in an external `-o` file stays unavailable in this path. [Codex data evidence](03-codex-data.md) · [Security and privacy](14-security.md)

### 4. Codex child threads and deeper Codex descendants

**Today.** `src/host/adapters/codex/records.ts` parses direct or nested parent thread metadata and `SubAgentActivity` with `started`, `interacted` and `completed` records. `codexChildren` in `src/host/sessions/ancestry.ts` checks source-home scope, exact started record, single parent and cycles. One exact start with no child rollout creates a pending lane. Metadata alone can identify a parent thread but lacks an exact spawn-row target. The legacy `spawn_agent` call flag and its generic result currently supply no verified child edge. Rollouts can provide eligible prompt, commentary, `agent_message` text, tools and finals. Agent-message sender/recipient and the `inter_agent_communication_metadata` body have no display projection. `historyStartOrdinal` is parsed yet unused for history attribution. Current tests cover direct linkage, late rollouts and home isolation. The requested linked Codex run with two children remains unverified in Chat. [Codex data evidence](03-codex-data.md) · [Session model](04-session-model.md)

**Change.** Project the child reference from its verified `started` row in the selected Codex parent scope and open the child rollout's owning lane. For launch-scoped parents, include only spawns attributed to that exact parent turn. Repeat the same edge resolution for deeper Codex children. Give plain `agent_message` text its own event label and use participant labels only with verified identities. Apply exact reducer attribution wherever available. Treat inherited or unattributed child history as incomplete for this view until a scrubbed record proves the boundary. Require a corroborated result shape before adding a legacy spawn-link parser or showing a spawn input that the adapter currently discards. [Codex data evidence](03-codex-data.md) · [Security and privacy](14-security.md)

### Shared transcript, loading and validation

1. **Host projection.** In `src/host/sessions/items.ts` and `src/host/sessions/types.ts`, retain only narrow, sanitized input fields and explicit result provenance from the provider adapters where available. Reuse `pairCalls`, normalized row IDs and recorded diffs. Generic tool arguments and opaque MCP bodies stay excluded. The popup may show safe tool input and paired output that the current 40-entry, 240-character Chat preview omits. Keep unmatched results separate while exact identity is unresolved. In `src/host/views/chat-transcript.ts`, `src/host/views/models.ts` and `src/host/views/signal-models.ts`, filter canonical lane/turn rows before applying page limits, preserve source order, and build private-safe labels for cards, rows and breadcrumbs. Only retained eligible data can be paged. Report reader and retention limits separately from view paging. [Security and privacy](14-security.md)
2. **Read and refresh.** Use `src/host/sessions/store.ts` and the existing bounded `src/host/discovery/reader.ts` path when selecting an approved recorded child. `SessionStore.materialize` currently tracks one selected history request and can read Claude's marker-identified candidate Codex root. Recursive hydration and targeted lookup for every task-prefix-only historical link remain gaps. Resolve an exact catalog candidate through existing verified evidence, then add a bounded read for only the selected destination. If proof for an older launch remains unavailable, show that state. Integrate with the serialized materialization in `src/extension.ts` and preserve conversation ownership and access to the visible root and path within the existing memory budgets. Let observer batches and coalesced `PanelView` refresh update the open popup and its parent summary. Child update latency depends on local append, flush and observation. Direct child streaming parity remains unverified for both providers.
3. **Navigation contract.** In `src/shared/protocol.ts`, add typed requests and view data for entering an offered child, stepping back or to a breadcrumb ancestor, and paging selected activity. Store the validated path per editor in `src/host/views/panel.ts` and project it through `src/host/views/data.ts`. Use opaque host-issued references tied to the current editor, parent scope and exact launch row. Revalidate source, account/profile scope, edge and current private mode before and after asynchronous reads. Keep navigation revisions with responses, discard stale loads, and reject cycles with a visited scope set. Preserve the existing Timeline `goto`/Open parent route and cross-editor Back behavior. [Security and privacy](14-security.md)
4. **Privacy boundary.** Reuse `src/host/privacy/projection.ts`, known-schema allowlists and approved-root checks for every level. Redact before paging or sending body content, strip terminal controls, and render through text nodes. Private mode omits derived agent titles and other free-form content from the child view and the delegation metadata it uses. Invalidate superseded models and clear the visible and parked reader content, including expanded tools and output caches, when privacy or source access changes. Persist only opaque navigation and anchors. Keep spill-file, launcher log and shell path data outside the new reader unless an existing, independently verified and redacted action already covers it. [Security and privacy](14-security.md)

## Implementation ownership after plan approval

The lead defines the shared view and edge contract first. The three workers can then implement against it in parallel with disjoint ownership.

| Owner | Files |
| --- | --- |
| A · evidence and scoped history | `src/host/adapters/types.ts`, `src/host/adapters/claude-code/records.ts`, `src/host/adapters/claude-code/tools.ts`, `src/host/adapters/codex/records.ts`, `src/host/adapters/codex/tools.ts`, `src/host/sessions/ancestry.ts`, `src/host/sessions/items.ts`, `src/host/sessions/types.ts`, `src/host/sessions/turns.ts`, `src/host/sessions/store.ts` |
| B · transcript projection | `src/host/views/chat-transcript.ts`, `src/host/views/models.ts`, `src/host/views/signal-models.ts`, `src/host/privacy/projection.ts` |
| C · cards, agent popup and navigation | new `src/webview/panel/agent-popup.ts` (dialog frame, focus trap, Escape/backdrop close, breadcrumb, Back, popup body), `src/webview/panel.ts`, `src/webview/panel/chat.ts`, `src/webview/panel/chat-cards.ts`, `src/webview/panel/chat-keys.ts` (Escape priority while the popup is open), `src/webview/panel/nav.ts`, `src/webview/panel/state.ts`, `media/chat.css` |
| Lead · contract and integration | `src/shared/protocol.ts`, `src/host/views/data.ts`, `src/host/views/panel.ts`, `src/extension.ts`, and `src/host/chat/codex-launch.ts` if shared per-launch target projection is needed. Own cross-layer wiring, evidence review, manual acceptance and the final gates. |

Coordinator ownership update: The lead also owns `src/host/chat/session.ts` and `src/host/chat/reconcile.ts` if needed for live delegation placement and earlier root pages.

## Verification plan

Run `npm run typecheck`, `npm test`, and `npm run build` after implementation. Use the existing `test/claude-reader.test.ts`, `test/codex-reader.test.ts`, `test/session-model.test.ts`, `test/delegation.test.ts`, `test/chat-transcript.test.ts`, `test/chat-reconcile.test.ts`, `test/lane-parent.test.ts`, `test/signal-views.test.ts`, and `test/protocol.test.ts` for automated regression coverage. Use manual VS Code replay and disposable provider runs for the new end-to-end paths. [Phase D verification](m2-phase-d-report.md) · [Phase F verification](m2-phase-f-report.md)

| Manual VS Code check | Pass condition |
| --- | --- |
| Main Claude → `codex-first` → Codex children 1 and 2 | In a disposable approved profile and repo, verify the exact Git Bash startup marker and rollout association, then open the run and both children from their spawning blocks. Compare displayed prompts, tool input/output, messages and finals against scrubbed eligible records. |
| Main Claude → Claude reviewer → Claude children 1 and 2 | Confirm the nested spawn identities and each child's activity in an approved disposable profile. Verify that siblings appear only under their actual parent, and that navigating back twice restores the launch blocks, scroll and keyboard focus. Repeat deeper if the provider records another verified level. If nested spawning is unavailable in the installed configuration, record the native limitation and verify the graph and UI with disposable, scrubbed replay of known record shapes. |
| Two launches into one Codex thread | Open each fresh/resume card in turn. Each shows its own linked turn, result, and attributable child spawns. Toolbar Launch evidence lands on the exact Bash row and drill-down Back uses that occurrence. Standalone browsing and usage show one canonical thread. |
| Live and delayed observation | Open a child before the rollout or transcript is readable. Append prompt, tools and outcome incrementally. Verify the pending card keeps its position and the open popup updates in place. Check follow at the bottom, new-event count while scrolled, collapse state, root draft preservation, and quick sibling selection while a load is in progress. |
| Missing, conflicting and private evidence | Exercise metadata-only, legacy or ambiguous spawn, wrong home, source removal and failed/missing final records. Verify the scoped status and no mislinked child. Toggle private mode while an output is open and while a read is pending. Inspect webview messages and DOM for stale body text, paths, raw payloads and actions that should be hidden. |
| Long history and output | Use mixed lanes with more than 1,500 events and a tool run beyond Phase D's preview limits. Confirm bounded older-page and output expansion, no duplicate rows on rewrite or reconciliation, stable anchors, and explicit gaps when the source or retention limit has discarded data. |
| Agent popup | Clicking a delegation block opens the popup over the chat; the chat, draft and scroll are unchanged underneath. Drilling into a child replaces the popup content (no second popup). Tab stays inside the popup. Escape, Close and backdrop click close it and focus the launch block; Escape does not interrupt a running turn while the popup is open. Back at the first level closes it. An approval arriving while it is open shows the "Approval waiting in chat" notice. At narrow widths the popup fills the webview with an 8 px margin. |
| Keyboard, layout and themes | Verify Tab/Shift+Tab, Enter/Space, breadcrumb and Back focus, screen-reader headings and polite status updates. Check a narrow split near 375 px and a full-width editor in light, dark, high-contrast dark and high-contrast light. Confirm reduced motion, readable code overflow, visible focus and at least 4.5:1 normal text contrast. Check long labels wrap without crowding the status, adjacent hit areas stay separate, and the selected agent heading leads visually. |
| Existing surfaces | Confirm root Chat, Timeline lanes, Open parent, Files, Agent map, Launch evidence and `/codex follow` still work. Confirm normal approval/interrupt authorization and root draft behavior when returning from the reader. |

## Questions for the user

None. The popup was decided by the user (25 November 2026); its read-only behavior is an implementation recommendation. Missing or unverified provider evidence is recorded above for verification.
