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

## Phase E · Profiles and packaging

6. Show verified read-only account status or Unknown, active profile scopes, and observed model and effort. Profile synthetic histories, check external discovery, and inspect the local VSIX (§7, §11–15).

Run build, strict typecheck and offline tests before each phase commit. Keep repository and provider data separate throughout verification.
