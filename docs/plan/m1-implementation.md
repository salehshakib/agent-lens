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

## Phase C · Views and limits

4. Ship the paged project tree, timeline, Files, Agent map, Background tasks, Usage and quota surfaces. Add the consented Claude relay and reversible chaining. Gate explicit refresh on a verified disposable signed-in probe (§6–8, §14).

## Phase D · Signals and parent navigation

5. Derive loop, check and context signals, record counts, and expose evidence, filters, settings, parent targets and Back (§4, §6–8).

## Phase E · Profiles and packaging

6. Show verified read-only account status or Unknown, active profile scopes, and observed model and effort. Profile synthetic histories, check external discovery, and inspect the local VSIX (§7, §11–15).

Run build, strict typecheck and offline tests before each phase commit. Keep repository and provider data separate throughout verification.
