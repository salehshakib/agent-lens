# 9. M2 Chat

[← 8](08-ui.md) · [Plan index](README.md) · [10 →](10-codex-controls.md)

Chat is the main Agent Lens editor screen. Open a tab, type a prompt, and keep working in the conversation. M2 supports Claude Code through the user’s installed official CLI and saved profile. The same chat uses a shared transcript and composer contract for additional official CLI adapters as they gain verified capabilities. The [runtime design](17-chat-runtime.md) covers ownership, approvals, and the Phase A checks that precede chat implementation. The [M2 implementation plan](m2-implementation.md) defines the rollout.

## Open a conversation

- **New chat** opens a tab with the composer focused. Use the current trusted workspace and active provider/profile when they resolve unambiguously, and offer an inline picker otherwise. A new tab starts as a draft and takes the resulting session identity after the CLI confirms it.
- **One tab, one conversation.** Choosing a session reveals its existing tab or opens a new one. Each tab keeps its draft, queue, expansion state, and scroll position. Closing or switching tabs leaves ownership with the host, so reopening a live conversation restores its transcript and state. Existing tabs stay bound to their project, provider, and profile.
- **`/resume`** is the primary way to find and continue a conversation. It opens an inline history picker for compatible local main sessions from Agent Lens, the official Claude panel, and the terminal. Start with the current project and offer **All projects**. A sidebar row’s **Continue** action opens the same conversation directly. The host resolves the exact session ID, owning profile, and recorded workspace or worktree. If the workspace is missing, the profile is unavailable, or another client still owns the session, show the specific reason and preserve the draft. Offer the official owning surface or a fresh conversation only as an explicit action. [Command catalog](16-slash-commands.md) · [Ownership and resume](17-chat-runtime.md#ownership-and-resume)
- The **All projects** sidebar tree is a secondary way to browse and reopen sessions. The chat header’s **Views** menu opens Timeline, Agent map, Files, Usage, and Background tasks. Read-only sessions open the same transcript. Their composer explains why sending is unavailable and shows an eligible continuation action when available. [Navigation and secondary views](08-ui.md)

~~~text
dashboard / Fix export flow           Claude Code · Personal · Owned [Views]

You
Fix the export flow and verify the download.

Claude
I’ll check how the export response is built.

▸ Read src/export.ts · Done
▾ Edit src/export.ts · Applied
  − return response.body
  + return response.blob()
▸ Todos · 1 of 2 complete
▸ Codex · Verify exports · Running                             [Open run]

Working… (Esc to interrupt) · 1m 07s · 820 output tokens     [Interrupt]
┌────────────────────────────────────────────────────────────────────────┐
│ @src/export.ts                                                        │
│ Include the download error path as well.                              │
└────────────────────────────────────────────────────────────────────────┘
[Attach] [Commands] [Run in background]                     [Queue message]
Opus · High effort · Context 26% · 5h 62% used · 7d 39% used
[Permission mode: Manual] · 1 queued
~~~

## Read the transcript

- **Conversation.** Show user messages, assistant text as it streams, and final responses inline in order. Optional provider-visible thinking summaries fold by default. Drop signatures, encrypted payloads, and internal reasoning. Update provisional rows in place as a block or final response arrives, and reconcile duplicates from the live stream and local transcript.
- **Tools and edits.** Put a call and its result in one folded card with its tool name, safe target, and outcome. Expand for sanitized arguments and output, including duration and exit code when available. For Edit and Write, add a compact inline diff from recorded evidence with a full diff action when available. Label proposed, applied, failed, and unknown changes accurately. For a Write without a recorded prior version, show the available file evidence and explain that the previous content is unavailable. [File evidence](05-subagents-and-files.md) · [Content projection](14-security.md)
- **Todos.** Render recognized to-do or task-list updates as an inline checklist with individual item status and completed count. Update the same checklist as items change. Keep it near the latest related activity and make it available in detailed history. Provider task tools supply the list. Background execution status remains attached to the corresponding run.
- **Delegation.** Fold subagents, delegated shell tasks, and verified linked Codex runs into cards where they started. Show the provider, display name, status, recent activity, and **Open run** action. Expanding a card shows the child’s events in source order and keeps them anchored to the spawning call. Missing link or child history gets an explicit state. [Delegation evidence](05-subagents-and-files.md) · [Codex controls](10-codex-controls.md)
- **Reading and focus.** Use the existing paging, text projection, and limits for long outputs. Auto-follow near the bottom. While the user reads earlier messages, keep their place and show **Jump to latest** with a count. Use keyboard-accessible card controls and visible focus. Announce meaningful state changes without reading every delta or timer tick. Keep full text and recorded diffs accessible after redaction and page large bodies on demand. [Session view behavior](08-ui.md)

## Compose, interrupt, and review

- **Send or queue.** Keep a multiline draft and attachment chips in the composer. Send adds a pending user row and turns it into the confirmed prompt on acknowledgment or a unique transcript match. Keep failed and unconfirmed messages visible with their recovery actions. While a turn runs, **Queue message** adds a local draft that the user can edit or remove. Send queued drafts in order at confirmed turn boundaries, with their chosen settings and attachments visible. After interrupt, errors, ownership changes, or uncertain delivery, pause the queue and preserve the draft. Live steering is a separate verified capability. [Send and recovery](17-chat-runtime.md#ownership-and-resume)
- **Attachments.** Offer workspace files, an editor selection labeled with path and line range, and explicit image paste or screenshot selection. Show removable chips before sending. Validate paths, trust, sensitive locations, content type, size, and adapter support in the host. Use native file mentions or typed attachments where supported. Otherwise display a validated file reference or request explicit inclusion of a selected excerpt.
- **Working status.** While the turn runs show **Working… (Esc to interrupt)** beside elapsed time and the available token count, labeled with its scope. For example, show recorded output tokens for the current turn or show **Tokens pending** until they arrive. Where interruption is unavailable, show the action’s reason and omit its keyboard hint. When a request is pending, show **Waiting for approval** or **Waiting for input** and link to its card.
- **Approval and input.** Show an inline card with the proposed tool, affected files or bounded argument or diff preview, and the decisions the provider supports. Plan review and user questions get their own card and input controls when verified. Bind each action to its live request, including the version of the proposal on screen, so reopening or clicking twice cannot submit another decision. Pending requests for background work are reachable from **Background tasks** and its notification. [Runtime approval checks](17-chat-runtime.md#phase-a-permission-and-control-verification)
- **Interrupt, Stop, and background work.** Interrupt ends the active turn through the verified channel while preserving its conversation. **Stop agent** targets the selected child. **Stop session** targets the owned worker or a verified registered background session. For **Run in background**, attach the requested visibility and execution scope before launch and reconcile it with the confirmed work ID. Work hidden from chat stays accessible in its own background transcript with attention notifications. A foreground delegation folds at its launch. Enabling **Show in main chat** for hidden work also places it there. [Visibility controls](08-ui.md#background-tasks) · [Targeted Stop](17-chat-runtime.md#targeted-claude-stop)

## Commands and shortcuts

Typing `/` as the first non-whitespace character opens the command picker with descriptions and arguments. Submitting a command that opens a tool surface places its card directly in the chat. For example, `/model` can show verified options and the effective model, while `/usage` can show the bound profile’s latest limits. A card can show current data, collect input, or explain an unsupported action. Escape dismisses the picker and preserves the draft. The catalog combines Agent Lens actions with supported CLI commands and skills for the current project. [Command catalog and inline cards](16-slash-commands.md)

| Key | Action in chat |
| --- | --- |
| Enter | Select the active picker entry, or send or queue from the composer. While an input method composes text, Enter commits that text. |
| Shift+Enter | Insert a newline in the composer. |
| Esc | Close the open dialog or menu first. Otherwise interrupt the active turn when the composer has focus and the route is verified. |
| Shift+Tab | Cycle available permission modes from the composer when supported and show the resulting mode. Preserve ordinary backward focus movement elsewhere and provide an accessible permission picker. |
| Up / Down | Navigate open suggestions first. From an eligible composer boundary, recall prompt history without losing the unsent draft. Preserve ordinary caret navigation within multiline drafts. |
| Ctrl+O | Toggle the eligible folded transcript rows while chat has focus. Preserve the editor’s normal file-opening shortcut elsewhere and offer a visible transcript action. |
| `!` at the start of a draft | Enter shell input mode only when the adapter has a verified native route. Show a clear shell indicator and require Send. The result appears inline with native permissions and exit status. |
| `@` | Open the workspace file picker at an eligible mention position. Search safely within the workspace and insert a reference or supported native mention. |

[Claude interactive shortcuts](https://code.claude.com/docs/en/interactive-mode)

## Composer status

Keep **model · effort · context percent · 5h limit · 7d limit** in view. The model and effort reflect the confirmed effective values for this conversation or turn. Show the active permission mode and queued count beside this line or below it when space is tight. Context comes from a verified structured source for this session, such as the Claude status-line relay. Label any last-request estimate and its age. Show a reason when capacity or other data is unavailable. Usage uses recorded counts and keeps cache and reasoning breakdowns from double counting. [Model and effort](11-models.md) · [Context and limits](06-usage-and-limits.md)

Read Claude limits directly from live `rate_limit_event` records. The observed stream stores `five_hour` and `seven_day` under `rate_limit_info.unifiedWindows`. Each window has `utilization` from 0 to 1 and `resetsAt` as epoch seconds. Normalize to percent used and the host’s epoch milliseconds. Separate limits work has a pending decoder in `src/host/limits/claude-probe.ts`. Share its pure decoding logic if available. Chat reads its own open stream independently of the probe. Bind each sample to the channel’s profile and merge each window independently into the shared limits store. Show reset time and sample age on demand. Missing or malformed windows keep their last known sample with its age, or show **Unavailable**. [Stream evidence](17-chat-runtime.md#what-the-cli-and-sdk-expose)

---

[← 8](08-ui.md) · [Plan index](README.md) · [10 →](10-codex-controls.md)
