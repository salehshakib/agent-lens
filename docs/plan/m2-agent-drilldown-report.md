# M2 agent drill-down report

1. **Interface design (plan item 2)**
   1. Apply the approved interface design to the spawning block and popup using VS Code theme tokens and native controls.
2. **Delegation and recorded activity (plan item 3)**
   1. Retain verified launch identity, safe prompt and tool evidence, and attributable terminal results.
   2. Project prompt, commentary, messages, paired tool activity and final in source order. Page retained history and output and distinguish capture loss.
   3. Preserve raw transcript, Files, Agent map and exact Launch evidence actions with scope and privacy checks.
3. **Linked Codex runs (plan item 4)**
   1. Open one card per verified Bash launch, scoped to the linked Codex turn with its own result and spawns.
   2. Replay a linked run with two independently selectable Codex children. Keep the canonical session and usage behavior.
4. **Nested Claude agents (plan item 5)**
   1. Place Claude children at their verified parent-lane spawning rows. Reuse the pending block when the transcript arrives.
   2. Replay a Claude subagent with two independently selectable nested children.
5. **Deeper navigation and privacy (plan item 6)**
   1. Validate per-editor path, references, source, profile and revision before and after bounded reads. Reject cycles and discard stale results.
   2. Restore launch focus, scroll and folds through Back and ancestor navigation. Keep existing cross-editor navigation.
   3. Clear visible and cached activity when source access or private display changes.
6. **In-extension popup (plan item 7)**
   1. Use one read-only modal over the mounted chat. Preserve the draft and root scroll. Support focus trapping, Escape, Close, backdrop and approval return.
   2. Keep status and live activity current with conditional follow and a new-event count.
7. **Verification**
   1. Run provider replay, transcript, navigation, privacy and popup contract checks with the existing test setup.
   2. Run `npm run typecheck`, `npm test` and `npm run build` offline.
   3. Record the manual VS Code and disposable CLI checks for the coordinator.

## File ownership

| Owner | Implemented areas |
| --- | --- |
| A | Provider adapters, session ancestry and tool rows, terminal evidence, and scoped history reads. |
| B | Root and child transcript projections, view models, Timeline focus, and privacy projection. |
| C | Delegation controls, popup, webview routing, and chat styles. |
| Lead | Shared protocol, host data and panel wiring, extension integration, `src/host/chat/session.ts`, `src/host/chat/reconcile.ts`, replay fixtures, tests, and report. |

## Status

| Checklist item | Status | Evidence |
| --- | --- | --- |
| 1.1 Approved interface design (plan item 2) | Done | Native delegation control, workbench theme tokens and responsive modal. `src/webview/panel/chat-cards.ts:136`, `media/chat.css:317`, `media/chat.css:486`. VS Code theme and assistive technology checks remain live. |
| 2.1 Safe evidence and terminal attribution (plan item 3) | Done | The adapter bounds and redacts delegated prompts. Only verified ancestry promotes them. The reducer attributes final responses and exact results reported to the parent. `src/host/adapters/claude-code/tools.ts:135`, `src/host/sessions/ancestry.ts:26`, `src/host/sessions/ancestry.ts:82`, `src/host/sessions/turns.ts:42`. |
| 2.2 Scoped transcript and paging (plan item 3) | Done | Scope filters precede paging. Prompt, commentary, messages, paired input and output, diffs, status, and final evidence use source order. Capture gaps and remaining retained data have distinct states. `src/host/views/chat-transcript.ts:279`, `src/host/views/chat-transcript.ts:354`, `test/chat-transcript.test.ts:229`. |
| 2.3 Scoped secondary actions (plan item 3) | Done | Raw transcript checks privacy and access. Files and Agent map name their destination scope. Exact Launch evidence opens a bounded Timeline window around the spawning row when needed. `src/extension.ts:799`, `src/host/views/chat-transcript.ts:176`, `src/host/views/models.ts:391`. |
| 3.1 One card per linked Codex turn (plan item 4) | Done | Separate exact fresh and resume occurrences preserve the canonical rollout. Prompts, finals and direct children are scoped to the linked turn. `src/host/views/chat-transcript.ts:86`, `test/chat-transcript.test.ts:170`. |
| 3.2 Linked Codex run and two children replay (plan item 4) | Done | Two siblings and an additional descendant open independently. The disposable Git Bash and Codex CLI path needs live verification. `test/fixtures/agent-drilldown.ts:64`, `test/chat-transcript.test.ts:170`. |
| 4.1 Exact Claude child placement and stable pending blocks (plan item 5) | Done | A verified pending block keeps the spawning row and edge identity when the transcript arrives. Live root tool rows receive late verified delegations through exact call keys, with unmatched evidence shown as a scoped notice. `src/host/sessions/ancestry.ts:82`, `src/host/chat/reconcile.ts:29`, `src/host/chat/session.ts:467`. |
| 4.2 Claude agent and two nested children replay (plan item 5) | Done | The replay covers separate prompts, terminal evidence, bounded tool output, a verified legacy Task, a missing final, and private display. Native nested spawning needs a live check. `test/fixtures/agent-drilldown.ts:9`, `test/chat-transcript.test.ts:124`. |
| 5.1 Validated path, revision and bounded reads (plan item 6) | Done | The editor validates issued references and the exact path, rejects visited scopes, rechecks access before and after a serialized read, and ignores stale selections. `src/host/views/data.ts:214`, `src/host/views/panel.ts:406`, `src/host/views/panel.ts:452`, `test/session-model.test.ts:284`. |
| 5.2 Back, breadcrumb, focus and scroll (plan item 6) | Done | Back and ancestor navigation restore the exact spawning block and disclosure state. Existing Timeline navigation uses its existing focus and cross-editor Back route. `src/webview/panel/agent-popup.ts:146`, `src/webview/panel/chat.ts:190`, `test/fixtures/agent-popup-replay.ts:89`. |
| 5.3 Clear content on privacy or access change (plan item 6) | Done | The host invalidates grants and paging and quarantines retired source rows. The webview clears visible and parked evidence and discards stale models. `src/host/sessions/store.ts:295`, `src/host/views/panel.ts:322`, `src/webview/panel.ts:129`, `src/webview/panel/agent-popup.ts:437`. |
| 6.1 Single read-only popup and approval return (plan item 7) | Done | A native dialog remains above the mounted chat as the reader goes deeper. Close, Escape, backdrop and approval return preserve the intended focus. `src/webview/panel/agent-popup.ts:416`, `src/webview/panel/agent-popup.ts:504`, `test/protocol.test.ts:108`. |
| 6.2 Live updates, follow and unread count (plan item 7) | Done | The selected transcript is prioritized for observation. Appends preserve the viewport and disclosure state, with conditional follow and an unread count. Live CLI latency needs verification. `src/extension.ts:347`, `src/webview/panel/agent-popup.ts:146`, `test/fixtures/agent-popup-replay.ts:160`. |
| 7.1 Offline provider, scope, protocol and DOM replay | Done | Both provider trees, live root placement, source removal, private display, and the native popup were exercised. `test/chat-reconcile.test.ts:108`, `test/chat-transcript.test.ts:124`, `test/session-model.test.ts:284`, `test/protocol.test.ts:73`, `test/protocol.test.ts:108`. |
| 7.2 Offline typecheck, test and build | Done | All three gates passed. The browser replay ran in the full test suite. |
| 7.3 Coordinator acceptance | Needs live check | The full VS Code and disposable provider checks are listed below. |
| Coordinator update and version | Done | Explicit earlier requests admit only recorded rows before the exact frozen anchor. Privacy resets the conversation's earlier grants. `src/host/chat/session.ts:458`, `test/chat-reconcile.test.ts:145`, `package.json:7`. |

## Implementation decisions and limits

- The live join uses a verified recorded edge and exactly one matching live call. Existing recorded rows keep the frozen snapshot behavior. The webview receives an opaque tool row ID and an editor-issued delegation reference.
- The popup pages 100 eligible rows at a time and expands retained tool output in 4,000-character increments. Root chat retains its 1,500-row page size. The host distinguishes stored data from reader and retention gaps.
- For older task-prefix-only Codex launches, the existing resolver can link a recorded rollout after its turn becomes available. An unmaterialized rollout that cannot be established through the existing resolver stays **Launch unresolved**. Inherited Codex child records also remain excluded unless ownership is attributable. [Bounded materialization](../../src/host/sessions/store.ts#L262) · [Scoped edge and child projection](../../src/host/views/chat-transcript.ts#L86)
- The DOM test uses an installed Playwright module via `AGENT_LENS_PLAYWRIGHT` and a local Chromium channel via `AGENT_LENS_PLAYWRIGHT_CHANNEL`. Both were set for the full gate below. No dependency installation or provider runs were needed.
- A worker ran a read-only `git diff --check` after resume. No Git write actions were run. The sandbox blocked recursive removal of the temporary browser replay directory under ignored `dist/m2-popup-replay`.
- Phase G did not start.

## Offline checks

### `npm run typecheck`

Exit code 0.

```text
> agent-lens@0.1.6 typecheck
> tsc --noEmit
```

### `npm test`

Exit code 0.

```text
  ...
# Subtest: the user home and a generic secret in the manifest are caught too
ok 238 - the user home and a generic secret in the manifest are caught too
  ---
  duration_ms: 2.424
  ...
# Subtest: manifest consistency: main, icons and dependencies
ok 239 - manifest consistency: main, icons and dependencies
  ---
  duration_ms: 4.0621
  ...
# Subtest: corrupt archives and oversized contents are reported, not thrown
ok 240 - corrupt archives and oversized contents are reported, not thrown
  ---
  duration_ms: 1.1045
  ...
# Subtest: the files vsce would package today pass the inspector
ok 241 - the files vsce would package today pass the inspector
  ---
  duration_ms: 3891.9233
  ...
1..241
# tests 241
# suites 0
# pass 241
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5049.8541
```

### `npm run build`

Exit code 0.

```text
> agent-lens@0.1.6 build
> node scripts/build.mjs


  dist\relay\relay.js  5.3kb

Done in 13ms

  dist\webview\panel.js    129.7kb
  dist\webview\sidebar.js   18.8kb

Done in 15ms

  dist\host\extension.js  570.4kb

Done in 38ms
```

## Coordinator live checks

All checks below need live verification. Use disposable approved profiles and scrubbed replay where provider configuration does not support nested spawning.

1. Launch `codex-first` from the main Claude chat in Git Bash. Verify the exact startup marker and linked rollout, then open both Codex children and compare their displayed prompt, tool input and output, messages and final with eligible records.
2. Open a Claude subagent and both of its nested children. Verify sibling scope, another verified level where available, Back and ancestor navigation, scroll and focus restoration.
3. Fresh-launch and resume one Codex thread. Verify each Bash card opens its own turn, final and child starts, Launch evidence targets the exact row, and standalone browsing and usage still show one canonical thread.
4. Open a verified child before its transcript appears. Append evidence incrementally and check stable placement, live updates, follow, unread count, open disclosures, root draft and rapid sibling selection during a read.
5. Exercise metadata-only, legacy, conflicting and wrong-home evidence, source removal and missing finals. Toggle private display during an open disclosure and a queued read. Inspect messages and DOM for stale content and disallowed actions.
6. Replay mixed lanes with more than 1,500 events and long tool output. Verify paging, retained history and capture gaps, stable scroll anchors and no duplicate rows after a rewrite.
7. Verify that one modal stays over the mounted chat through nested navigation. Exercise focus trapping, Escape, Close, backdrop dismissal, first-level Back and the approval notice. Confirm Escape leaves the active turn running.
8. Check keyboard and screen-reader behavior, polite updates, reduced motion, code overflow, wrapping and hit area separation near 375 px and at full width. Verify the 8 px margin in narrow splits, visible focus and 4.5:1 normal text contrast in light, dark and both high-contrast themes.
9. Smoke-test root Chat, Timeline, Open parent, Files, Agent map, Launch evidence, `/codex follow`, approval and interrupt authorization, and the composer draft after closing the popup.
