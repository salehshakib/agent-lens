# M2 Phase C work report

The Windows follow-up supplied the Claude Code 2.1.330 command and settings evidence used below. Typecheck, build and all 177 tests passed for the updated extension. The implementation was verified here with deterministic fixtures. Extension Development Host confirmation of the new UI and terminal handoff is still pending. [Scrubbed compatibility record](m2-compatibility.md#phase-c-windows-follow-up)

## Follow-up checklist

1. **Done.** Advertised commands and skills retain their original spelling and arguments on a verified idle channel. Reserved and terminal-only names use their own routes. Bare `/compact` shows the measured before and after token counts and updates the owning session's Context card. **Not done:** compact instructions lacked supporting evidence. [Dispatch](../../src/host/chat/commands.ts#L202), [lifecycle](../../src/host/adapters/claude-code/stream.ts#L338), [compact frames](../../src/host/adapters/claude-code/stream.ts#L351), [card and context](../../src/host/views/chat-cards.ts#L86)
2. **Done.** Terminal-only entries expose an explicit idle-owner release and exact resume handoff. The action rechecks the original workspace, approved profile, native executable, exact ID and writer absence. It types the PowerShell-quoted command into an official terminal without pressing Enter. A manual launch can still race with a writer opened after preparation. The transcript and original draft stay in Agent Lens. [Handoff gate](../../src/host/chat/commands.ts#L66), [release and claim](../../src/host/chat/session.ts#L269), [terminal preparation](../../src/extension.ts#L427)
3. **Done.** Model uses the typed `set_model` control. The card distinguishes the request, provider resolution and next reported model. Effort uses validated text at an idle boundary and records the acknowledgment as requested effort. Validated explicit choices are passed on fresh starts and exact resumes. Default omits the flag on the next start or resume. **Not done:** live reset to Default and measured effective effort were not demonstrated. [Pickers](../../src/host/adapters/claude-code/chat-settings.ts#L56), [session settings](../../src/host/chat/session.ts#L216), [typed request and startup args](../../src/host/adapters/claude-code/chat.ts#L155)
4. **Done for the verified Fast diagnostic.** The card shows init's reported speed and disabled reason. Bare `/fast` runs only on the observed disabled profile state and displays the provider reply. **Not done:** Fast on/off transitions or diagnostic behavior on other account states were not demonstrated. [Fast gate](../../src/host/adapters/claude-code/chat-settings.ts#L33), [dispatch](../../src/extension.ts#L809)
5. **Done.** Connected `/codex start` stays gated because the follow-up supplied no scoped launch and rollout-binding evidence. [Start gate](../../src/host/chat/codex-launch.ts#L16)
6. **Done.** Recorded the scrubbed follow-up and updated this report and the plan checklist below. [Compatibility record](m2-compatibility.md#phase-c-windows-follow-up)
7. **Done.** Added deterministic coverage for repeated init, UUID-bound lifecycle acknowledgment, typed model control, startup settings, compaction and the Context card, effort/Fast responses, a single limit error row and terminal gating/quoting. [Stream and session fixtures](../../test/chat-live-routes.test.ts#L41), [terminal gate](../../test/chat-commands.test.ts#L148), [compact/context projections](../../test/chat-cards.test.ts#L85)
8. **Done.** Typecheck, 177 tests and build exited 0. The first full run had 176 passes and one failure because the new test looked for compact counts in the card message. The test now checks the visible detail row.

## Phase C plan checklist

1. **3.1 · Done within the verified scope.**
   1. **Done.** Filterable slash menu with scope, accessible listbox autocomplete and unavailable reasons. [Slash menu](../../src/webview/panel/slash.ts#L32)
   2. **Done.** Local grammar, literal-text escape, opaque actions, stale action checks and submission deduplication. [Grammar](../../src/host/chat/commands.ts#L202), [host validation](../../src/extension.ts#L664)
   3. **Done.** Inspection commands run alongside active work and retain local rows. [Local dispatch](../../src/extension.ts#L784)
   4. **Done.** Native commands, skills and terminal-only entries use versioned, scoped initialization. [Init](../../src/host/adapters/claude-code/stream.ts#L286), [catalog](../../src/host/chat/commands.ts#L86)
   5. **Done.** Verified idle native passthrough and terminal result correlation. [Follow-up item 1](#follow-up-checklist)
   6. **Done.** Official terminal handoff after release with session, profile and draft preserved. [Follow-up item 2](#follow-up-checklist)
   7. **Done** for bare Compact and context-reset evidence. **Not done** for optional compact instructions. [Follow-up item 1](#follow-up-checklist)
2. **3.2 · Done** for M1 cards.
   1. **Done.** Usage and Context use scoped projections and state freshness. [Usage and Context](../../src/host/views/data.ts#L82)
   2. **Done.** Agents, Files and Diff show M1 activity and evidence actions. [Inspection cards](../../src/host/views/chat-cards.ts)
   3. **Done.** Tasks shows background work. Structured to-dos are scheduled for Phase D. [Inspection cards](../../src/host/views/chat-cards.ts)
   4. **Done.** Status and Help show capability and owner information. Cards use the existing secondary views and evidence routing. [Card assembly](../../src/extension.ts#L517)
   5. **Done.** Clear opens a separate fresh tab and keeps the draft and work reachable through Resume. [Clear dispatch](../../src/extension.ts#L784)
3. **3.3 · Done within the verified scope.**
   1. **Done.** Resume uses the current project, All projects and the exact Phase B continuation checks. [Host integration](../../src/extension.ts)
   2. **Done.** Model and Effort pickers apply at the verified boundaries. [Follow-up item 3](#follow-up-checklist)
   3. **Done** for the Fast diagnostic. **Not done** for Fast transitions. [Follow-up item 4](#follow-up-checklist)
   4. **Done.** Login, Logout, Profile and Stop retain the later-phase gates. [Catalog](../../src/host/chat/commands.ts#L9)
4. **3.4 · Done** for exact M1-linked Follow, including external `codex-first` evidence. **Not done** for connected Start or new launch attribution. [Follow projection](../../src/host/chat/codex-launch.ts#L24), [Follow-up item 5](#follow-up-checklist)
5. **Phase gate.** **Done** for the supplied provider evidence and the automated gates. **Not done here** for VS Code verification of the new UI and scoped terminal handoff. [Manual smoke checks](#manual-smoke-checks)

## Follow-up files changed

- A · `src/host/chat/commands.ts`, `src/host/adapters/claude-code/chat-settings.ts`, `test/chat-commands.test.ts`.
- B · `src/host/views/chat-cards.ts`, `test/chat-cards.test.ts`.
- C · `src/webview/panel/chat-cards.ts`, `src/webview/panel/slash.ts`.
- Coordinator · `src/shared/protocol.ts`, `src/host/chat/types.ts`, `src/host/chat/session.ts`, `src/host/adapters/claude-code/chat.ts`, `src/host/adapters/claude-code/stream.ts`, `src/host/views/data.ts`, `src/extension.ts`, `src/webview/panel/chat.ts`, `media/chat.css`, `test/chat-live-routes.test.ts`, `docs/plan/m2-compatibility.md` and this report.

## Exact output tails

### npm run typecheck

```text
> agent-lens@0.1.1 typecheck
> tsc --noEmit
```

### npm test

```text
# Subtest: the files vsce would package today pass the inspector
ok 177 - the files vsce would package today pass the inspector
  ---
  duration_ms: 2552.2035
  ...
1..177
# tests 177
# suites 0
# pass 177
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3085.4911
```

### npm run build

```text
> agent-lens@0.1.1 build
> node scripts/build.mjs


  dist\relay\relay.js  5.3kb

Done in 13ms

  dist\webview\panel.js    86.2kb
  dist\webview\sidebar.js  18.5kb

Done in 18ms

  dist\host\extension.js  470.5kb

Done in 37ms
```

## Manual smoke checks

1. Launch the updated extension in a disposable trusted Windows workspace with Claude Code 2.1.330 and the approved test profile. Verify `/help` lists native skills and the separate terminal-only entries after the first turn. From an idle chat, run `/humanizer:humanizer` with disposable text. Try it during a separate turn and verify that the draft remains available. Repeat bare `/compact` and inspect the measured before/after counts and new Context card. Verify the command result announcement with a screen reader if available.
2. In a fresh tab stage model and effort before the first prompt. Repeat before an exact resume. In an initialized idle tab apply Sonnet and high effort. Compare the requested model, provider resolution and next reported model. Compare requested effort after acknowledgment and confirm the card does not present it as reported effort. With an exhausted 5h window, check for a single error with the provider reset text.
3. On a profile showing Fast Off and extra usage disabled, run bare `/fast` and confirm the diagnostic appears in its card. Try `/fast on` and `/fast off` and confirm the reason is shown without a change.
4. Run `/doctor` while Agent Lens owns the conversation. Verify that active turns block release, then explicitly release the idle owner. Check that an external live writer blocks the prepared resume action. After the writer exits, verify the terminal opens at the original cwd, uses the approved provider home and has the exact resume command typed with the cursor waiting for Enter. Confirm the original draft is still present. Connected `/codex start` should continue to show its gated result.

