# M1 implementation checklist

The license and Marketplace icon moved to [M2 Phase J](m2-implementation.md#phase-j--accounts-and-daily-flow-verification) and are recorded as done in M2 through the parallel packaging PR. The release package and the deferred [M1 manual exit checks](15-milestones.md#m1--view-everything) are verified in the same phase.

## Phase A · Extension and sources

1. Initialize the extension (§13–15).
   - **1.1** Add the local Desktop manifest, Activity Bar entry, and machine-scoped source settings.
   - **1.2** Build separate strict TypeScript host and browser bundles. Use the source status view to verify activation, typed messaging and a local-only CSP.
   - **1.3** Run offline tests against synthetic fixtures. Package and inspect the VSIX with a runtime file allowlist.
2. Register and observe the two providers (§2–3, §7, §14).
   - **2.1** Resolve default, environment, saved-profile and observation-only roots. Enforce local paths, profile isolation and an exact source allowlist before reading.
   - **2.2** Catalog Claude main/child transcripts, child metadata and presence markers, and Codex rollouts, advisory index and writer marker metadata.
   - **2.3** Project versioned and legacy records into the shared event contract. Drop private record classes and redact allowlisted text before emission. Extract exact launcher startup evidence from recorded result stdout and document the launcher convention. Link resolution stays in Phase B.
   - **2.4** Implement bounded byte tails, complete-line UTF-8 framing, atomic metadata reads, and generation invalidation on replacement, shrink or detected rewrite.
   - **2.5** Combine scoped file-watch hints with independent polling. Reconcile disappearing/returning roots and files, including appends in old folders. Keep historical payloads lazy.

## Phase B · Session model and files

3. Reduce sessions, lanes, turns, tool results and usage. Resolve spawn and launcher evidence, index file actions, and expose permitted current files and recorded diffs (§4–7, §14).
   - **3.1** Connect the source catalog and generation batches to the host model. Identify projects, sessions and lanes by canonical scope, invalidate replaced evidence, and materialize historical payloads on request.
   - **3.2** Reduce Claude prompt branches and Codex turns in source order. Pair late tool results, reconcile equivalent Codex items, and retain supported lifecycle, model, effort and background work evidence.
   - **3.3** Resolve Claude Agent/Task and Codex child ancestry, including pending and unresolved agents. Preserve spawning rows and reject conflicting and cyclic relationships.
   - **3.4** Verify Claude-to-Codex launches from attributed startup evidence or an exact resume argument, a matching rollout, cwd and launch interval. Keep late, ambiguous and unmatched evidence distinct. Document the external launcher setup.
   - **3.5** Index file evidence and provenance, validate current-file Open, and preview recorded hunks or complete recorded sides with bounded read-only documents.
   - **3.6** Deduplicate token observations, retain their reported scopes, derive available context inputs/fill and record bounded tool outcomes. Support generation-safe signal counts for Phase D.
   - **3.7** Exercise session, link, Files, usage and generation handling with offline synthetic data. Build, typecheck, test and inspect the VSIX.

   Phase B exposes the host model and Files actions. Historical selection reads eligible sources on demand. Full-history ledger backfill and aggregate retention beyond the in-memory evidence budget remain open. A Claude task ID without an approved recorded path cannot locate its temp output bucket. The disposable Git Bash and native VS Code editor checks moved to [M2 Phase J, item 10.6](m2-implementation.md#phase-j--accounts-and-daily-flow-verification).

## Phase C · Views and limits

4. Ship the paged project tree, timeline, Files, Agent map, Background tasks, Usage and quota surfaces. Add the consented Claude relay and reversible chaining. Gate explicit refresh on a verified disposable signed-in probe (§6–8, §14).
   - **4.1** (done) Add view-model builders and the host/webview message protocol: project tree with Live, Today and Earlier (paged by 20) and parent nesting with a cycle guard, session detail, background tasks and usage tables. Validate every webview request on the host with opaque ids. Add a private display mode. Render with the §14 CSP.
   - **4.2** (done) Ship the sidebar: summary, quota gauges, relay card, filters, the paged tree with nested children, "Load more", and the Sources section that replaces the Phase A Sources view.
   - **4.3** (done) Ship the editor-tab panel with Timeline (collapsed reasoning and tool rows, follow and "Jump to latest"), Agent map with detail popover (ordered tools, Open transcript, Stop agent disabled with its reason), Files (Open file, Open recorded diff), Usage (gauges, filters, accessible daily chart and table, models) and Background tasks.
   - **4.4** (done) Add the status bar quota and live-count item and the Usage and Background tasks commands.
   - **4.5** (done) Build the gauge model: latest sample per provider, profile, bucket and window, fresh, stale, expired and missing states, Codex named-bucket rule, profile-scoped samples.
   - **4.6** (done) Build the Claude relay: dependency-free status-line script that stores an allowlisted snapshot atomically and chains the prior command, host-side snapshot reader, relay context and Claude 5h/7d samples.
   - **4.7** (done) Build the reversible install and uninstall that splice only the top-level statusLine member, with ownership state, precedence, duplicate-key, unrecognized-value and concurrent-edit checks. Add modal consent, remembered decline and a remove command. Tested only against temporary profiles.
   - **4.8** (structured verification moved to M2) Refresh limits initially shipped with a disabled control and reason pending a signed-in structured result. The current code gates the local `/usage` text probe on a configured Claude profile and the native CLI. Signed-in VS Code verification and the unverified structured `usage_report` shape are tracked in [M2 Phase E, item 5.5](m2-implementation.md#phase-e--keyboard-and-status-line).
   - **4.9** (done) Test with synthetic data and temporary directories: gauges, relay core and end-to-end relay spawn, install and uninstall, view models, protocol guards. Build, typecheck and test.
   - **4.10** (manual checks moved to M2) Manual checks in VS Code: relay on a disposable Claude profile, themes and high contrast, keyboard and focus, screen reader, narrow layouts, the signed-in refresh probe. See [M2 Phase J, item 10.6](m2-implementation.md#phase-j--accounts-and-daily-flow-verification). Quota and completion alerts are not built.

## Phase D · Signals and parent navigation

5. Derive loop, check and context signals, record counts, and expose evidence, filters, settings, parent targets and Back (§4, §6–8).
   - **5.1** (done) `src/host/sessions/signals.ts`. The polling hash is the result text hash and stays in memory only. Unpaired and ambiguous calls break a streak. Add a signal module with validated settings (loop threshold, ignore globs, check patterns, context thresholds). Derive Possible loop streaks per lane from the adapter argument key, with the polling result hash held in memory only and the live or historical state, and keep ambiguous, partial and unpaired calls out of a streak.
   - **5.2** (done) `evaluateChecks` in `signals.ts`, run at the end of `SessionStore.refresh()`. A Claude result without an exit code counts as a passed check when the error flag is absent. Derive Done without checks per root turn tree across Claude subagents, Codex child threads and verified linked Codex runs. Use confirmed applied edits minus the ignore globs, and the three outcomes, for Completed turns only.
   - **5.3** (done) `deriveContext` in `signals.ts`. A sample older than 10 minutes is stale. The compaction epoch is the count of compact rows. Claude status-line levels are shown but not written to the ledger. Derive the context level (Normal, High, Critical) only where a percentage exists, mark Codex levels approximate, clear it after compaction, and compute the compaction epoch history.
   - **5.4** (done) Loop, check and context crossing counts reach the ledger through `store.ts` with stable ids. Feed loops, check outcomes and context crossings into the usage ledger as counts with stable source ids.
   - **5.5** (done) `parentInfo` and `breadcrumb` in `src/host/views/signal-models.ts`. Launch edges are ordered by `parent.at`. Keep resolved parent targets for every lane and linked run, with launch edges sorted newest first and an unresolved reason.
   - **5.6** (done) `src/shared/protocol.ts`, `models.ts`, `data.ts`, `signal-models.ts`. The check marker is a host-synthesized row. Extend the view models and protocol: signal labels on rows, grouped loop rows, the end-of-turn check marker, Signals and Has warnings filters, header signal summary, sidebar warning labels, and parent and breadcrumb data.
   - **5.7** (done, visuals unchecked) `src/webview/panel/timeline.ts`, `agents.ts`, `panel.ts`, `sidebar.ts`, CSS. Rendering is checked by item 5.11 only. Render the signals in the timeline, Agent map, panel header and sidebar with text labels, VS Code tokens only and no motion.
   - **5.8** (Timeline lane header moved to M2) Open parent is in the session header, the Agent map popover, the sidebar row and `agentLens.openParent`. There is no separate control in the timeline lane filter. Webview Back and highlight are in `panel/nav.ts` and need item 5.11. No native webview context menu is used. The original scope covers Open parent (header breadcrumb, Agent map popover, timeline lane header, sidebar row action and the `agentLens.openParent` command with no keybinding), the multi-launch menu, the row highlight and focus, and per-panel Back history. The Timeline lane header action is tracked in [M2 Phase D, item 4.5](m2-implementation.md#phase-d--chat-transcript-and-live-reconciliation).
   - **5.9** (done) `package.json` "Agent Lens: Signals" and `src/host/views/alerts.ts`. Alerts are off by default. Add the signal settings group and optional context alerts (off by default, once per session, lane, level and compaction epoch, historical samples suppressed).
   - **5.10** (done) `test/signals.test.ts`, `test/signal-views.test.ts`, `test/protocol.test.ts`. 106 tests pass, typecheck and build are clean. There are no webview unit tests. Test loops, checks, context levels, parent targets, ledger counts, view models and protocol with synthetic data. Build, typecheck and test.
   - **5.11** (manual checks moved to M2) Manual checks in VS Code: loop and check badges in light, dark and high contrast themes, Open parent focus and Back, keyboard and screen reader, alert toasts. See [M2 Phase J, item 10.6](m2-implementation.md#phase-j--accounts-and-daily-flow-verification).

## Phase E · Profiles and packaging

6. Show verified read-only account status or Unknown, active profile scopes, and observed model and effort. Profile synthetic histories, check external discovery, and inspect the local VSIX (§7, §11–15).
   Part E1 (accounts, profiles, models) is listed first. Part E2 (profiling, discovery smoke test, VSIX inspection) is tracked by the other agent.
   - **6.1** (E1, done) Account status model: Signed in, Signed out, External configuration, Unknown, with last check and mode. A result is accepted only from a verified probe, and only the allowlisted state, mode and check time are kept. No email, plan or identity field is read or stored (§12).
   - **6.2** (E1, Unknown fallback done, verified probes moved to M2) No probe is run. The plan names `claude auth status --json` and `codex login status`, but neither output shape was ever collected, so both providers show Unknown with the reason. This follows the 4.8 rule: no parser for an unverified shape. See [M2 Phase J, items 10.1 and 10.5](m2-implementation.md#phase-j--accounts-and-daily-flow-verification).
   - **6.3** (E1, done in code, manual check moved to M2 item 10.6) Official status in a terminal: a user-invoked command opens a terminal for the chosen profile (profile home in the terminal environment, none for the default profile), types the official status command without running it and leaves Enter to the user. Gated on Workspace Trust.
   - **6.4** (E1, done) Profile scope model: default and saved profiles per provider with an active marker, the home shown with the user home shortened, per-profile session, live and token counts from the ledger, and sessions from observation-only roots kept as unassigned.
   - **6.5** (E1, done in code, manual check moved to M2 item 10.6) UI: an Accounts section in the sidebar, a profile label on session rows and in the session header, a profile filter in the sidebar, and the `agentLens.showAccounts` and `agentLens.accounts.openStatus` commands. Switch, sign-in and sign-out stay absent (M2, M3).
   - **6.6** (E1, done) Observed model and effort: record the evidence source per turn (recorded response, turn context, thread settings), group each agent's turns by model and effort, show the table next to the session token table, and show effort on each Agent map node. Missing values show Not recorded and are never guessed. The requested selection stays out of M1.
   - **6.7** (E1, done) Tests (`test/accounts*.test.ts`, `test/models*.test.ts`) with synthetic data and no CLI, then build, typecheck and test.
   - **6.8** (E2) Profile large synthetic histories.
   - **6.9** (E2) Smoke-test external discovery.
   - **6.10** (E2) Inspect the local VSIX against the runtime allowlist.
   - **6.11** (moved to M2) Verified status for both providers: record the output of the official status commands on a disposable signed-in profile per CLI, then add parsers. Carry the two-home isolation checks from §12 forward as well. See [M2 Phase J, item 10.5](m2-implementation.md#phase-j--accounts-and-daily-flow-verification).

Run build, strict typecheck and offline tests before each phase commit. Keep repository and provider data separate throughout verification.
