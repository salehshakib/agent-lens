# 15. Milestones, checklist, and verification

[← 14](14-security.md) · [Plan index](README.md)

## M1 — View everything

1. Initialize the extension in the existing Agent Lens repo after approval. Set up the manifest namespace, strict TypeScript, esbuild and synthetic fixtures.
2. Build the adapter registry, version-aware Claude and Codex source adapters, settings per adapter, bounded byte tail, file generation detection, and polling reconciliation.
3. Implement the project/session/lane/turn reducers, tool and result pairing, ancestry, Claude-to-Codex launcher marker and nesting, and the Files activity index, including safe Open and historical diffs.
4. Ship the All projects tree with Live, Today, and scrolling Earlier groups. Add the unified redacted timeline, Files, read-only Agent map with detail popover, observed Background tasks, Usage, and quota/status surfaces for tokens, context fill, and limits. Show the default Claude 5h/7d gauges. Check the single-command refresh candidate, then ship the consented one-click chaining relay and uninstall.
5. Add read-only Accounts status for verified probes, saved-home profile scoping and Unknown states. Render actual observed model and effort next to session usage. Profile large histories, smoke-test external discovery, and package a clean local VSIX.

**Exit criteria.** Browse activity across projects, scroll into earlier history, and observe a live Claude turn, a running subagent, and a marked external Codex worker nested under its launcher. Verify live Agent map detail, ordered tool calls, Open transcript, full eligible redacted content, file provenance, and a recorded diff. Verify exact/unmatched links, stale/missing sources, restart and missed-watch recovery, and token deduplication. Show both providers' tokens, context fill, and profile-scoped limits with reset and unavailable states. On a disposable Claude profile, verify one-click relay install, unchanged prior status-line output, both windows, and uninstall restoring the prior value. Record the signed-in structured refresh result and enable Refresh limits only on a passing result. Install the VSIX in a clean VS Code profile.

## M2 — Chat with Claude Code

1. Validate the installed official CLI as the product chat route. Evaluate SDK capabilities with authorized disposable auth for approval, user input, context, session persistence, and scoped Windows cancellation if needed.
2. Enable <code>chat</code>, <code>modelSelect</code> and available <code>auth</code> actions for Claude. Build New chat, exact Continue from any compatible local sidebar session, the streamed composer and queue, effective model/effort and context usage. Bind updates to existing session and child lanes. Add Run in background for Claude turns and tasks, both Show in main chat toggles, and task status and completion notifications.
3. Add provider-visible thinking, permission/tool approval/denial, interactive user input, turn interruption, and targeted Stop agent for owned Claude background subagents/tasks. Validate foreground child behavior and external/registered-session states in [§9](09-chat.md). Preserve native user/project/local/managed settings and run existing <code>CLAUDE.md</code>, memory, skills, hooks, tools, MCP and auto mode through the provider.
4. Add files, selections, pasted screenshots and <code>@</code>-mentions, plus supported slash commands and skills. Deliver official sign-in/out per isolated Claude home and instant switching of verified, saved profiles. Add the model/effort picker and Fast mode when verified.
5. Verify new and historical sessions, simultaneous external owners, queue ordering and cancellation. Exercise the user's actual daily flow and address parity gaps before declaring the milestone complete.

**Exit criteria.** From Agent Lens, open an existing terminal/panel Claude session and start a new one. Verify exact Continue after the previous writer releases it, streamed replies and visible thinking, queue delivery, real permission acceptance and denial, and separate turn interruption. Run a Claude turn and task in the background, keep their events out of main chat by default, open them from status surfaces, toggle each into the timeline, and receive a single finish notification. Stop one verified owned background subagent or task while its parent and sibling continue. Verify the Stop reason on an ordinary external VS Code Claude session and test any exact registered background-session route independently. Attach a file, editor selection and pasted screenshot, use an <code>@</code>-mention, and pass the parity fixtures below. Verify independent official login/logout and instant active-profile switching with two disposable homes. Report any essential native parity or targeted Stop gap before closing M2.

## M3 — Codex control and chat

1. Add Codex Start and exact Follow up via the supported CLI, owned stdout/process supervision, Run in background and error recovery. Enable the shared model/effort picker, isolated homes, official per-profile account actions and instant switching. Use Full access by default on fresh and resume with Workspace write as the per-run choice.
2. Deliver Stop for verified owned and external Windows Codex workers through the Agent map and eligible run surfaces. Correlate exact rollout and lock identity, test shared processes, process identity races, descendant cleanup, watchdog/retry behavior, and permission denial. Enable each graceful or force mode only for its verified scope and applicable policy.
3. Feed one-turn <code>exec</code>/<code>resume</code> into the shared chat UI if it satisfies core interaction. Test app-server stdio for richer deltas, exact resume, explicit request approval, interrupt, <code>model/list</code> and account status. Turn on each capability only after versioned verification.

**Exit criteria.** Start and resume the exact Codex thread under its owning profile. Verify actual Full access defaults and Workspace write selection in both directions across fresh and resumed turns. Toggle a background run into main chat and verify scoped accounting and a single finish notification. Complete official login/logout/switch across two disposable homes and test writer contention. Stop a verified owned and a verified dedicated external worker without affecting another run, and verify controls for shared, stale, ambiguous, or denied cases. If either Stop path fails validation, report the specific blocker before closing M3. If chat is feasible, reuse the composer and timeline with no Codex-specific renderer. Otherwise document the exact protocol gaps while preserving the delivered controls.

## M4 — Gemini CLI

1. Verify Gemini CLI's documented Windows home and project chat paths, on-disk schema, auth scope, discovery, and optional control surfaces against the supported installed version.
2. Implement the Gemini CLI registry entry, discovery, watch, record parsing, usage, and capability descriptor from [§7](07-architecture.md). Enable custom roots and profile settings, then add optional capabilities where a supported interface passes verification.
3. Exercise synthetic and disposable session data through the generic tree, timeline, Files, Usage and any verified controls. Verify disable/re-enable and that existing agents continue to operate.

**Exit criteria.** Discover and show a recorded Gemini CLI session and observe an append or rewrite on Windows through the common registry and UI. Verify project/profile attribution, eligible tool and file data, recorded tokens, and precise capability states. Demonstrate compatibility with Claude Code and Codex and report any unsupported Gemini surfaces.

## Testing approach for implementation

- **Synthetic fixtures and adapter unit tests.** Cover the observed variants for both providers, future fields, dropped request/credential records, UTF-8 and CRLF boundaries, partial EOF/JSON, line caps, malformed records, duplicate replay, rewrites, and large compactions. Include Claude sidechains, detach/resume, out-of-order child metadata, exact and ambiguous spawning/tool results, persisted text spills and file-history deltas. Keep fixture identities, paths, prompts, and secret-shaped values synthetic.
- **Lifecycle, attribution, and Files tests.** Cover outputs before calls, repeated identical commands, compacted transcripts, multi-turn resume, task scheduling versus completion, terminal and recoverable errors, writer/marker staleness, and absent child logs. Verify Claude task ID plus Codex UUID, JSON header, resume turn, redirected or missing header, delayed match, cross-repo roots, and competing tasks. Check path canonicalization, rename, missing preimage, proposed/failed patch, shell-only mentions, sensitive paths, and preferring valid recorded diffs.
- **Usage tests.** Cover multi-block Claude responses, parent/child aggregation, copied usage records, Codex exact and fallback cumulative scopes, missing/unknown fields, repeated response IDs, token breakdowns, and daily timezone attribution across resumes. Test Codex slot reversal, null info or quota, bucket separation, missing access, relay concurrency, independent Claude windows, structured refresh fallback, stale samples, profile/account switches, and one warning per threshold and reset.
- **Integration tests.** Simulate incremental writers and watcher errors, day rollover, stale markers, late index updates, rotation, multiple repos and old-session resume. Verify minimum path access and a bounded polling cadence. Use fake chat/SDK streams for ack, queue ordering, stale approval, mixed live/file copies, model changes, cancellation, and session ownership in M2. Use fake CLI/app-server for args, stderr and errors, resume and active writers in M3. Validate catalog filtering, nested efforts, auth result allowlisting, account change invalidation, and the M4 fixture adapter. Keep repeatable tests offline.
- **Windows and VS Code manual checks.** After implementation authorization, use disposable repos/sessions/profiles for real CLI tests. Follow the workflow and auth/stop acceptance criteria for each milestone, preserving the user's real configuration. Test keyboard navigation, narrow layouts, themes, long-session scroll, missing sources, CSP, trust, and clean-profile VSIX installation.

## M2 parity fixtures

Use the user's real daily workflow as the acceptance reference. Run write-capable checks in authorized disposable repos/profiles with equivalent configuration and safe data.

- Start Claude subagents, inspect live cards and ordered tool calls in the Agent map, open an individual transcript, and stop a single eligible subagent.
- Invoke <code>codex-first</code> through Claude with a background Codex worker. Validate the launcher marker and nested map status, then open or reveal the worker in main chat.
- Invoke Claude Docs and artifact skills, including their tool calls and outputs in the correct agent transcript.
- Exercise Auto mode, a native allow/deny or approval path, <code>CLAUDE.md</code>, memory, hooks, and the user's MCP servers.
- Use <code>/effort</code>, <code>/fast</code>, and <code>/model</code>. Verify the effective setting for the next eligible turn. Paste a screenshot directly into the composer and verify its attachment reaches Claude.

## Pre-distribution checklist

- Review current Anthropic and OpenAI terms and documentation for the exact distributed local workflow, unmodified user-installed CLI binaries, provider authorization, and provider names/branding. Record the result before distributing the VSIX. Resolve any terms blocker before release. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) · [Terms for using Codex](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- Verify new users can sign in to their own Claude and Codex accounts in the official CLI flows, switch their independently signed-in homes, and finish the supported smoke flow. Inspect the VSIX for credentials, private data, fixture content, and bundled provider binaries.

## Decisions

| Question | Decision |
| --- | --- |
| Q1. Sidebar default | All projects, grouped by project and Live / Today / Earlier, with older rows loaded on scroll. |
| Q2. Claude limits | M1 shows both windows by default. Ask once and install the chaining relay in one click with uninstall. Validate the single-command structured <code>/usage</code> candidate and use it for explicit refresh if verified. |
| Q3. Claude-to-Codex link | Use the <code>codex-first</code> startup marker convention to nest each verified run under its launching Claude session and lane. |
| Q4. Main chat content | Full eligible content with secrets masked by default. Run in background keeps selected turns, tasks and Codex runs out of main chat, with separate status, open and finish notification. Show in main chat is available per item and session. |
| Q5. Usage display | Tokens, context fill and limits only. |
| Q6. Distribution and sign-in | Distribute Agent Lens with the native CLI route. Each user signs in to their own Claude and Codex accounts through the official CLIs. Terms review is a release checklist item. |
| Q7. Parity | Use the user's daily workflows listed in M2 parity fixtures. |
| Q8. Accounts | Save separate <code>CLAUDE_CONFIG_DIR</code> and <code>CODEX_HOME</code> profiles, show the active one per adapter, and support instant switching with native sign-in/out and verified state isolation. |
| Q9. Codex launch permission | Full access by default on Agent Lens fresh runs and resumes, with Workspace write available per run. |
| Q10. Next adapter | Gemini CLI in M4. |
| Agent map and Stop | Provide a map and agent detail popover with Open transcript and Stop agent. M2 delivers targeted Stop for eligible owned Claude subagents/tasks. M3 delivers verified owned and external Codex worker Stop. Enable the action per target and explain unavailable cases. |

## Open question

- For a verified dedicated external Codex worker that offers no graceful route, should M3 expose the separately labeled Force stop action after its identity and descendant-cleanup checks pass?

---

[← 14](14-security.md) · [Plan index](README.md)
