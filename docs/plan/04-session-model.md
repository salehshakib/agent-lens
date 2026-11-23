# 4. Unified session model and live state

[← 3](03-codex-data.md) · [Plan index](README.md) · [5 →](05-subagents-and-files.md)

## Shared identities and attribution

| Entity | Identity and purpose |
| --- | --- |
| Project | Canonical local repo root if verified, otherwise canonical recorded cwd or a stable unresolved key. Keep different worktrees distinct and expose an optional common repository grouping. Label remote or missing paths without treating them as locally openable. |
| Session | <code>(provider, sourceHome, session/thread ID)</code>. Map each approved canonical home to its saved profile. A session carries title, repo/cwd, source, timestamps, identity evidence, active lane summaries, and coverage flags. |
| Lane and turn | Claude main/child lane by session and agent ID, or Codex thread plus parent identity. Each lane owns its turns and request identities. Claude turns follow genuine prompts and explicit branch ancestry. Codex keeps emitted turn IDs. |
| Timeline item and tool run | Stable lane-scoped source identity, timestamp, record order, category, optional sanitized body reference, and result evidence. Tool calls have an explicit call key and pair with results even when the result is written before another related record. |
| Delegation link | External relationship from a Claude lane and Bash call/task to a Codex thread and, when known, its exact turn. Carries confidence, launch role, and observed time. It does not change the provider's canonical session or usage identity. |
| File action and usage sample | Derived observations annotated with provider, project, lane, turn, source evidence and confidence. Keep usage response/snapshot IDs and recorded scope so rollups can be idempotent. |
| Background work | Stable work ID linked to the canonical turn, task, or worker and its optional parent, plus the owning profile, outcome, and timeline visibility preference. Apply visibility when rendering the main chat. The work retains its lifecycle, tool history, and usage identity in every view. |

Build a Claude session catalog using filename/session ID and session root. Merge identity metadata from valid records and use their <code>cwd</code> and <code>gitBranch</code>. When titles are absent, use the first attributable prompt, then a safe <code>lastPrompt</code> fallback and finally a compact session label. Resolve the effective model from <code>assistant.message.model</code> and effort from <code>perTurnEffort</code> or <code>effort</code>. Keep metadata-only rows visible while opening histories lazily. In the transcript, separate a genuine human prompt from a user-shaped tool result, injected reminder, compaction summary, or queue copy. Preserve other branches when present and identify the current branch only when leaf or ancestry evidence supports it.

Claude assistant items may be split into records sharing <code>message.id</code>. Retain each distinct block using <code>uuid</code> and <code>apiBlockIndex</code> where present. Use <code>parentUuid</code> for explicit ancestry, ordering all native records by source offset within each lane. The mixed timeline merges lane timestamps stably and exposes lanes for a precise view. Scope <code>tool_use.id</code> and <code>tool_result.tool_use_id</code> to a session/lane, with an indexed session-wide lookup for explicitly cross-lane references. Never infer a child solely from <code>isSidechain</code>.

## Codex identity, title, repo, model, and usage

- **Thread and agent identity.** Keep a separate identity for each file-backed thread. Build parent-child links from explicit metadata and <code>SubAgentActivity.agent_thread_id</code>. When the child arrives first, show it under an unresolved agent group until the parent appears. Guard against cycles and repeated metadata. Set a child history boundary only after a fixture establishes ordinal semantics for <code>subagent_history_start_ordinal</code>. Use explicit event attribution to avoid presenting copied parent context as fresh child activity. An agent path or nickname is display metadata. A child can share the parent's OS process.
- **Title.** Prefer the newest nonempty, sanitized <code>session_index.thread_name</code>, then the first genuine user prompt's first meaningful line, then a short thread label. For a pasted work order, prefer its first meaningful heading. Keep a generated title stable once selected. Render the source separately as Panel, External CLI, VS Code, or another observed source. A CLI originator by itself cannot prove which orchestrator invoked it.
- **Repo.** Keep <code>session_meta.cwd</code> as the recorded root and show an explicit turn-level <code>cwd</code> change when present. Group by canonical local repo root where it can be resolved safely, otherwise by normalized recorded cwd. Handle drive-letter case, slashes, spaces, missing drives, and linked worktrees. Use local path identity for filtering, so equal folder names on different drives remain distinct. Show a shortened local path and optional branch. Avoid remote URL access.
- **Model and reasoning effort.** Prefer the selected turn's <code>turn_context.model</code> and <code>turn_context.effort</code>. Fall back to applicable <code>thread_settings</code>, then collaboration settings if scoped to that turn. Show requested model and effort as pending until the CLI records effective values. Unknown remains unknown, and one resume can change either value.
- **Tokens.** Usage objects expose <code>input_tokens</code>, <code>cached_input_tokens</code>, <code>cache_write_input_tokens</code>, <code>output_tokens</code>, <code>reasoning_output_tokens</code>, and <code>total_tokens</code> when available. Use the latest <code>turn_token_usage</code> and <code>thread_token_usage</code> for their labeled scopes. Deduplicate per-response <code>usage</code> by thread, turn, and <code>response_id</code>. Never sum cumulative snapshots or add cached and reasoning counts onto the emitted total. The aggregate survey found <code>usage.total_tokens</code> equal to input plus output where present. Fallback <code>event_msg/token_count.info.total_token_usage</code> should be labeled as the reported scope, with <code>last_token_usage</code> labeled Last response. For extension-started runs, use stdout <code>turn.completed.usage</code> as a turn fallback. Preserve unknown fields as unavailable. Parent and child totals stay separately labeled until aggregation semantics are verified.
- **Duration.** Use <code>duration_ms</code> when emitted. For live elapsed time, use validated <code>started_at</code> or the envelope timestamp. Observed lifecycle start integers were epoch seconds. Item timestamps ending in <code>_ms</code> are separate. Fall back to elapsed wall time between recorded boundaries. Pause display updates when the panel is hidden, and label incomplete duration when an end is missing.

## Provider-aware lifecycle

Use a turn state machine plus a separate writer or process state. Key state by <code>(thread_id, turn_id)</code> when possible. Associate ID-less legacy records with an open turn only when unambiguous. Detect each resume as a new turn in the same session.

| UI state | Evidence and precedence |
| --- | --- |
| Starting | A panel-launched process is spawning or connected before its first turn. Show it as a temporary row until stdout or the matching rollout establishes thread identity. |
| Live | A task has started and lacks a terminal record, plus an owned active process, recent relevant record activity, or a correlated writer marker. A marker with no fresh activity is weaker evidence and gets a possible-live/writer-present indicator. Start with a 30-second recent-activity threshold and test against silent long-running commands. A held writer in a shared app can be idle. |
| Completed | A matching <code>task_complete</code> with no error or a correlated stdout <code>turn.completed</code>. A successful process exit without a terminal record gets an explanatory ended status with incomplete history. |
| Failed | <code>task_complete.error</code>, a terminal stdout <code>turn.failed</code>, or a nonzero owned process exit outside an acknowledged Stop. A generic stdout <code>error</code> can be recoverable. A command failure, tool failure, retry, or quota observation by itself leaves the turn active. An explicit terminal failure wins if sources disagree. |
| Interrupted / Aborted | A matching <code>turn_aborted</code>, or a verified operating-system exit after an Agent Lens Stop request when the rollout ends without a terminal record. Show forced termination if used. If a natural completion wins the race, display the natural outcome. |
| Outcome unknown / Recorded | An incomplete historical turn with no writer evidence becomes Outcome unknown. A metadata-only session without a usable lifecycle is Recorded. Reconcile late events and never turn age alone into failure. |

The table above describes Codex. Claude needs a separate reducer with one state for the session being open and another for work in a turn or background lane.

| Claude state | Evidence and precedence |
| --- | --- |
| Active | Fresh attributable prompt, assistant response, open matching tool call, or confirmed running child/task. A fresh local process marker can corroborate running status. Quiet time during a tool does not establish failure. |
| Waiting or idle | A fresh process marker with a supported waiting/idle value or a terminal assistant response while the session remains open. An idle main lane can coexist with running background children. |
| Turn completed | Await the attributed assistant response with a recognized terminal <code>message.stop_reason</code>, resolved relevant synchronous tools, and no stronger error or interruption signal. A <code>tool_use</code> stop reason marks a model step, not completion of the turn. Show background work independently. |
| Child completed or stopped | Observe the child's metadata <code>finished</code>/<code>stoppedByUser</code>, resolved Agent result, or matched terminal task status. A successful initial launch of a background Agent/Bash task leaves the lane active. |
| Failed or interrupted | Use explicit per-lane terminal task status, stop evidence, or a conclusively terminal error. An API error that may retry and a tool error stay row-level until terminal evidence arrives. |
| Recorded or outcome unknown | Incomplete older activity or stale marker, without reliable current evidence. Never terminate, resume, or alert on a guessed live or final state. |

Show a combined root badge if a verified descendant is active and label the main lane separately. Keep idle sessions out of Live when only an idle writer/marker is present. Notify once for observed root turn transitions from live to confirmed completion or failure after activation. Notify once when a tracked background item finishes, including failure or confirmed Stop, with an Open action. Deduplicate this notification against root or child notifications for the same outcome. Suppress historical discovery toasts and ordinary child toasts by default. Allow a scope preference and deduplicate across windows where feasible. Quota alerts use a separate path.

---

[← 3](03-codex-data.md) · [Plan index](README.md) · [5 →](05-subagents-and-files.md)
