# M1 implementation checklist

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

   Phase B exposes the host model and Files actions. Historical selection reads eligible sources on demand. Full-history ledger backfill and aggregate retention beyond the in-memory evidence budget remain open. A Claude task ID without an approved recorded path cannot locate its temp output bucket. The disposable Git Bash and native VS Code editor checks remain open.

## Phase C · Views and limits

4. Ship the paged project tree, timeline, Files, Agent map, Background tasks, Usage and quota surfaces. Add the consented Claude relay and reversible chaining. Gate explicit refresh on a verified disposable signed-in probe (§6–8, §14).
   - **4.1** (done) Add view-model builders and the host/webview message protocol: project tree with Live, Today and Earlier (paged by 20) and parent nesting with a cycle guard, session detail, background tasks and usage tables. Validate every webview request on the host with opaque ids. Add a private display mode. Render with the §14 CSP.
   - **4.2** (done) Ship the sidebar: summary, quota gauges, relay card, filters, the paged tree with nested children, "Load more", and the Sources section that replaces the Phase A Sources view.
   - **4.3** (done) Ship the editor-tab panel with Timeline (collapsed reasoning and tool rows, follow and "Jump to latest"), Agent map with detail popover (ordered tools, Open transcript, Stop agent disabled with its reason), Files (Open file, Open recorded diff), Usage (gauges, filters, accessible daily chart and table, models) and Background tasks.
   - **4.4** (done) Add the status bar quota and live-count item and the Usage and Background tasks commands.
   - **4.5** (done) Build the gauge model: latest sample per provider, profile, bucket and window, fresh, stale, expired and missing states, Codex named-bucket rule, profile-scoped samples.
   - **4.6** (done) Build the Claude relay: dependency-free status-line script that stores an allowlisted snapshot atomically and chains the prior command, host-side snapshot reader, relay context and Claude 5h/7d samples.
   - **4.7** (done) Build the reversible install and uninstall that splice only the top-level statusLine member, with ownership state, precedence, duplicate-key, unrecognized-value and concurrent-edit checks. Add modal consent, remembered decline and a remove command. Tested only against temporary profiles.
   - **4.8** (partly done) Refresh limits: the gate and the disabled control with its reason exist. It stays disabled until a signed-in probe records the structured result. No parser is written for the unverified shape.
   - **4.9** (done) Test with synthetic data and temporary directories: gauges, relay core and end-to-end relay spawn, install and uninstall, view models, protocol guards. Build, typecheck and test.
   - **4.10** (not done, open) Manual checks in VS Code: relay on a disposable Claude profile, themes and high contrast, keyboard and focus, screen reader, narrow layouts, the signed-in refresh probe. Quota and completion alerts are not built.

## Phase D · Signals and parent navigation

5. Derive loop, check and context signals, record counts, and expose evidence, filters, settings, parent targets and Back (§4, §6–8).
   - **5.1** (done) `src/host/sessions/signals.ts`. The polling hash is the result text hash and stays in memory only. Unpaired and ambiguous calls break a streak. Add a signal module with validated settings (loop threshold, ignore globs, check patterns, context thresholds). Derive Possible loop streaks per lane from the adapter argument key, with the polling result hash held in memory only and the live or historical state, and keep ambiguous, partial and unpaired calls out of a streak.
   - **5.2** (done) `evaluateChecks` in `signals.ts`, run at the end of `SessionStore.refresh()`. A Claude result without an exit code counts as a passed check when the error flag is absent. Derive Done without checks per root turn tree across Claude subagents, Codex child threads and verified linked Codex runs. Use confirmed applied edits minus the ignore globs, and the three outcomes, for Completed turns only.
   - **5.3** (done) `deriveContext` in `signals.ts`. A sample older than 10 minutes is stale. The compaction epoch is the count of compact rows. Claude status-line levels are shown but not written to the ledger. Derive the context level (Normal, High, Critical) only where a percentage exists, mark Codex levels approximate, clear it after compaction, and compute the compaction epoch history.
   - **5.4** (done) Loop, check and context crossing counts reach the ledger through `store.ts` with stable ids. Feed loops, check outcomes and context crossings into the usage ledger as counts with stable source ids.
   - **5.5** (done) `parentInfo` and `breadcrumb` in `src/host/views/signal-models.ts`. Launch edges are ordered by `parent.at`. Keep resolved parent targets for every lane and linked run, with launch edges sorted newest first and an unresolved reason.
   - **5.6** (done) `src/shared/protocol.ts`, `models.ts`, `data.ts`, `signal-models.ts`. The check marker is a host-synthesized row. Extend the view models and protocol: signal labels on rows, grouped loop rows, the end-of-turn check marker, Signals and Has warnings filters, header signal summary, sidebar warning labels, and parent and breadcrumb data.
   - **5.7** (done, visuals unchecked) `src/webview/panel/timeline.ts`, `agents.ts`, `panel.ts`, `sidebar.ts`, CSS. Rendering is checked by item 5.11 only. Render the signals in the timeline, Agent map, panel header and sidebar with text labels, VS Code tokens only and no motion.
   - **5.8** (partly done) Open parent is in the session header, the Agent map popover, the sidebar row and `agentLens.openParent`. There is no separate control in the timeline lane filter. Webview Back and highlight are in `panel/nav.ts` and need item 5.11. No native webview context menu is used. Add Open parent (header breadcrumb, Agent map popover, timeline lane header, sidebar row action and the `agentLens.openParent` command with no keybinding), the multi-launch menu, the row highlight and focus, and per-panel Back history.
   - **5.9** (done) `package.json` "Agent Lens: Signals" and `src/host/views/alerts.ts`. Alerts are off by default. Add the signal settings group and optional context alerts (off by default, once per session, lane, level and compaction epoch, historical samples suppressed).
   - **5.10** (done) `test/signals.test.ts`, `test/signal-views.test.ts`, `test/protocol.test.ts`. 106 tests pass, typecheck and build are clean. There are no webview unit tests. Test loops, checks, context levels, parent targets, ledger counts, view models and protocol with synthetic data. Build, typecheck and test.
   - **5.11** (not done, open) Manual checks in VS Code: loop and check badges in light, dark and high contrast themes, Open parent focus and Back, keyboard and screen reader, alert toasts.

## Phase E · Profiles and packaging

6. Show verified read-only account status or Unknown, active profile scopes, and observed model and effort. Profile synthetic histories, check external discovery, and inspect the local VSIX (§7, §11–15).

Run build, strict typecheck and offline tests before each phase commit. Keep repository and provider data separate throughout verification.
