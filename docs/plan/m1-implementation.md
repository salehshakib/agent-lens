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

## Phase D · Signals and parent navigation

5. Derive loop, check and context signals, record counts, and expose evidence, filters, settings, parent targets and Back (§4, §6–8).

## Phase E · Profiles and packaging

6. Show verified read-only account status or Unknown, active profile scopes, and observed model and effort. Profile synthetic histories, check external discovery, and inspect the local VSIX (§7, §11–15).

Run build, strict typecheck and offline tests before each phase commit. Keep repository and provider data separate throughout verification.
