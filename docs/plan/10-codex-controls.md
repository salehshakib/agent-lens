# 10. M3 Codex controls

[← 9](09-chat.md) · [Plan index](README.md) · [11 →](11-models.md)

## Start a new run

Show a native folder picker and a small form with repo folder, multiline prompt, the shared model/effort picker from [§11](11-models.md), a permission selector, and Run in background. Preselect the current local workspace folder when unambiguous and the active Codex profile. Default permission to **Full access** on each new Agent Lens launch. Offer **Workspace write** as a per-run alternative. Validate the directory, reject unsupported filesystem schemes, and bind the command to the selected folder and profile. Allow one explicit submission per launch ID. Keep a failed draft in memory until dismissed or resubmitted.

~~~
+----------------------------------------------+
| Start a Codex run                            |
| Repo    [ D:\projects\dashboard ] [Browse]   |
| Model   [ CLI default          v]            |
| Effort  [ CLI default          v]            |
| Access  [ Full access          v]            |
| Prompt  [                                    |
|          ................................ ]  |
| [ ] Run in background                       |
|                         [Cancel] [Start run] |
+----------------------------------------------+
~~~

The following examples use PowerShell-style legibility and placeholder values. The implementation uses a native executable plus argument array and writes the full UTF-8 prompt to stdin. Quote boundaries in the examples represent one argument. Omit <code>-m</code> or the effort override if the user chose CLI default. The extension captures the JSON stream without needing an output file.

~~~powershell
codex exec --json --color never -C "<REPO>" --dangerously-bypass-approvals-and-sandbox -m gpt-6.2-sol -c 'model_reasoning_effort="medium"' -
~~~

Full access uses the installed CLI's documented long flag and skips Codex sandboxing and approval prompts. Show the selected mode before launch and expose the effective mode when recorded. Workspace write retains the per-run sandbox with non-interactive approval behavior. Enforce VS Code Workspace Trust and honor managed policy. If the selected mode cannot be honored, preserve the draft and explain the conflict. Verify observed runtime permissions on the target CLI before shipping.

~~~powershell
codex exec --json --color never -C "<REPO>" --sandbox workspace-write -c 'approval_policy="never"' -m gpt-6.2-sol -c 'model_reasoning_effort="medium"' -
~~~

Installed help lists the long flag on both fresh and resume. Current external commands with <code>-o &lt;out.md&gt;</code> continue working, with the [§5](05-subagents-and-files.md) marker convention for nesting. Ordinary discovery reads the persisted rollout. If the user opts to run outside a Git repository, expose the locally supported <code>--skip-git-repo-check</code> as an explicit advanced choice. Persist rollouts by leaving <code>--ephemeral</code> unset. Background launches keep full supervision and appear in Background tasks, the sidebar, and the Agent map with the visibility behavior in [§8](08-ui.md). [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference) · [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) · [Configuration keys](https://learn.chatgpt.com/docs/config-file/config-reference)

## Follow up

Compose a prompt and use the shared model/effort picker in the selected thread. Show the last effective model/effort and offer inherit, profile default where verified, or an explicit override according to adapter semantics. Follow up uses the exact thread's owning profile and recorded local working directory after validation. Default to Full access on resume and show the Workspace write and Run in background choices for that turn. Allow Follow up after the latest turn closes and known writer contention clears. Preserve the draft when reopening an unknown or interrupted thread and clarify that the previous result is incomplete. Serialize owned launch and resume requests for the same thread in one extension host. Concurrent hosts and external writers remain subject to Codex's own lock. Offer a manual retry with the preserved draft after lock contention clears.

~~~powershell
codex exec resume --json --dangerously-bypass-approvals-and-sandbox "<THREAD_ID>" -
~~~

Run the child with its process cwd set to the recorded repo. Local <code>codex exec resume --help</code> exposes no <code>-C</code>, <code>--sandbox</code>, or <code>--color</code> on this subcommand. Pass the exact UUID. Only offer resume for eligible top-level threads. Model and effort overrides, if the user chooses them, are <code>-m &lt;MODEL&gt;</code> and <code>-c 'model_reasoning_effort="&lt;EFFORT&gt;"'</code> before the UUID. The Workspace write form below uses config overrides. Verify both mode transitions across resumes, including Workspace write after a previously unrestricted turn, before enabling those paths.

~~~powershell
codex exec resume --json -c 'sandbox_mode="workspace-write"' -c 'approval_policy="never"' "<THREAD_ID>" -
~~~

The installed version also exposes <code>codex queue</code>. Keep the first follow-up flow bound to explicit <code>exec resume</code> and the chosen thread. A queued follow-up during an active run would require a separate interaction and verification of queue semantics. [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference) · [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

## Windows launch and stop

**Find the executable.** Support a user-configured absolute <code>codex.exe</code> and resolve supported local installations with their version checked. For the observed npm installation, find the native executable through the installed package's Windows launcher layout, or start the installed JS launcher with a verified <code>node.exe</code> as a compatibility route. The latter introduces the observed shim-to-native process tree and must be tracked as such. Use argument arrays, <code>shell: false</code>, hidden windows, a minimally scoped process environment, and separately piped stdin/stdout/stderr. Keep prompts out of shell commands, environment variables, and process listings. Node's Windows shell shims require shell handling, so avoid invoking <code>.cmd</code> with interpolated inputs. [Node child processes on Windows](https://nodejs.org/download/release/v22.13.0/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows)

**Owned worker.** Track the process from spawn and bind it to the thread only after identity is established. Prototype a small Windows helper that retains the original native process handle and can isolate the worker and its descendants in a job. Verify job assignment and containment at launch, including the npm shim case if supported. Use a private console or supported Codex interrupt path if the prototype proves that it delivers a graceful cancellation and emits the expected terminal record. On Windows, Node's ordinary <code>ChildProcess.kill('SIGINT')</code> does not promise Unix-style SIGINT handling. Windows console control events have strict console/group requirements, and Ctrl+C broadcast belongs only in a verified private console. Any verified graceful route gets a bounded wait for terminal data and process exit. [Node subprocess termination semantics](https://nodejs.org/download/release/v22.13.0/docs/api/child_process.html#subprocesskillsignal) · [Windows console control events](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent) · [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

**External worker discovery.** Prototype Windows Restart Manager's <code>RmStartSession</code>, <code>RmRegisterResources</code>, and <code>RmGetList</code> against the exact canonical rollout and writer-lock paths, queried separately so associations can be compared. Close the extension's transient file handles before probing. Restart Manager returns apps using a resource, not a guarantee of which app owns a byte-range lock. Validate candidates against process creation time, user, image path, and dedicated <code>codex exec</code> or <code>exec resume</code> identity. A resume candidate can additionally corroborate the exact UUID from arguments. An initial exec usually lacks a UUID in argv, so it needs validated, unambiguous file ownership across both resources. Correlate the native process rather than the npm <code>node.exe</code> parent and identify its descendants only where they can be proven to belong to that worker. Compare app-server/shared-process and child-agent cases. Always release the Restart Manager session with <code>RmEndSession</code>. Use it for discovery only. The plan does not rely on enabling system-wide handle tracking, admin rights, or a third-party handle tool. [Restart Manager registration](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmregisterresources) · [Resource user discovery](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist) · [PID and process creation identity](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ns-restartmanager-rm_unique_process)

**Stop action.** Deliver Stop for verified owned and external Codex workers in M3. Prefer a verified interrupt scoped to the exact live thread/turn on an authorized app-server connection. Probe whether an owned shared host can individually interrupt a child using its thread and turn IDs. If that is unavailable, only a dedicated worker qualifies for OS-level Stop. Re-check live state, profile, session ownership, and process identity immediately before acting. Use a retained handle or open-and-validate one against the verified creation time so PID reuse cannot change the target. A shared process without a verified per-thread action, ambiguous owner, denied query, stale marker, or exited target leaves Stop unavailable with an explanation. Graceful external interrupt is eligible only if the worker's console or protocol can be narrowly targeted and the Windows test proves delivery. For launchers with auto-resume or watchdogs, verify that an explicit Stop prevents a replacement attempt before enabling Stop for that wrapper.

If interruption is unavailable or times out, a separately labeled **Force stop** can be exposed for a verified dedicated worker and scope. Use a contained job for an owned tree. Apply the [§15](15-milestones.md) external force decision and require a proven dedicated target and validated descendant cleanup for external force. Terminate only through a verified process handle or equally strong containment. Prohibit name-based kills, parent-shell kills, PID-only tree kills, and console broadcasts into shared Git Bash. Existing edits may remain and are visible in the timeline. [Codex App Server](https://learn.chatgpt.com/docs/app-server) · [Windows process termination semantics](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)

After the stop request, show Stopping and continue reading available stdout and rollout until the exact turn or dedicated process confirms termination. On timeout or denied access, report that Stop could not be confirmed and keep watching. Preserve locks, history, and worktree state. Never retry termination against a different PID. The denied local CIM query means that external ownership and cancellation still need end-to-end Windows verification. Pass the owned and external acceptance cases in [§15](15-milestones.md) or report the specific release blocker.

## Failure handling

| Condition | Behavior |
| --- | --- |
| CLI missing, unsupported install, version mismatch, or spawn failure | Continue watch-only. Show a short failure and the executable setting. Retain the prompt. |
| No authentication, unsupported model or effort, project trust, managed permission, or Git check failure | Classify exit or known sanitized CLI error. Keep requested values and draft. Offer an explicit correction or retry, without automatically changing permission or invoking login. |
| <code>already has an active writer</code> | Surface Thread in use, retain the draft, and recheck the session's status. Let Codex arbitrate the authoritative lock. Never remove a lock or silently start another thread. [Codex writer-lock source](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/writer_lock.rs) |
| Rate limit, quota, or network failure | Show a concise categorized outcome with a retry time when reliably reported. Avoid scheduling a retry by default because a turn could already have applied edits. |
| JSONL parse/version drift or missing rollout | Preserve valid stdout/discovery evidence and report partial timeline coverage. An owned process can still report exit. An external process with no recorded data cannot be discovered reliably. |
| Wrong cwd, missing repo, or changed session ID | Disable the affected action until the user resolves the repo or identity. Do not silently resume a different session. |
| Extension host reload or another VS Code window | Rediscover the rollout and maintain watch coverage. Control is tied to a verified live process handle or a freshly verified external owner. Never resume or restart a worker just because the UI reopened. |
| Concurrent Stop and natural completion | Reconcile terminal records after the process race. Prefer the natural completed/failed outcome when it won. Show Interrupted for a confirmed stop without a stronger terminal outcome. |

## Codex chat on the same adapter

Start with the verified <code>exec --json</code> and <code>exec resume --json</code> forms. They can feed the shared composer as one invocation per turn, with explicit resume, queued next turns and stdout-to-rollout reconciliation. They provide the granularity the CLI emits. Enable each approval, cancel, attachment, or live steering capability only if that transport supplies it.

Installed Codex 0.170.0 exposes experimental <code>codex app-server --stdio</code> and protocol schema generation commands in help. The documented stdio protocol includes <code>initialize</code>, <code>thread/start</code>, <code>thread/resume</code>, <code>turn/start</code>, <code>turn/steer</code>, <code>turn/interrupt</code>, item/delta notifications, approval/user-input requests, and <code>model/list</code>. Use a dedicated local stdio process for sessions Agent Lens owns where supported. Correlate status, turn IDs and approvals before enabling them. A separate connection does not grant control of a worker launched by another process. Prefer protocol interrupt for an owned turn over OS termination where the test passes. Validate the installed schema, active writers, session persistence, profile auth, and equivalent per-run permission selection before exposing richer chat. Keep <code>exec</code> for modes or controls the app-server route cannot honor. [Codex App Server](https://learn.chatgpt.com/docs/app-server) · [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

---

[← 9](09-chat.md) · [Plan index](README.md) · [11 →](11-models.md)
