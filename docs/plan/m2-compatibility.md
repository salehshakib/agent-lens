# M2 compatibility record

[M2 implementation](m2-implementation.md) · [Plan index](README.md)

The coordinator ran the Phase A harness on Windows with the installed Claude Code 2.1.330 native executable, a disposable repository and 24 Haiku turns. `lib.mjs` located the npm `claude.cmd` on PATH and resolved its adjacent package's `bin/claude.exe`. The harness spawned it directly with an argument array and a cwd containing spaces. `mcp-bridge.mjs` implemented the stdio permission tool. The full `scrubbed/REPORT.md`, JSONL and scenario summaries remain in the coordinator's temporary `m2-spike` directory outside the repository.

| Capability | Windows result | Scrubbed fixture |
| --- | --- | --- |
| Bidirectional input and output, replay, partials, per-turn usage | Observed with `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages`. Stdin stayed open between turns. Unicode reached the model and returned in deltas. | `stream-basic.jsonl` and `stream-basic.summary.json` |
| New session and history continuity | `--session-id <uuid>` allocated the requested ID. Closing the first worker and using `--resume <id>` kept the ID and prior context. | `resume.jsonl` and `resume.summary.json` |
| Interrupt | The active turn received a matching control success receipt and a provider interruption record. The worker exited with code 1 after stdin was closed following the interrupt, an expected shutdown in this sequence. | `interrupt.jsonl` and `interrupt.summary.json` |
| Host permission prompts | `--permission-prompts host --permission-prompt-tool mcp__bridge__approve` reached the stdio MCP server. Allow applied the disposable edit. Deny and delay past `MCP_TOOL_TIMEOUT` left the file unchanged. The model saw the denial. | `permission-host.jsonl`, `permission-host.summary.json`, `bridge-A.jsonl`, `bridge-B.jsonl`, `bridge-C.jsonl` |
| Native command discovery and passthrough | Init exposed 55 slash commands and 19 skills. Sending `/compact` produced compacting status and a compact boundary. `\/usage in the README` reached the model as plain text. | `commands.jsonl` and `commands.summary.json` |
| Rate-limit sampling | One `rate_limit_event` was observed in the first turn of each sampled session. The stream contained five-hour and seven-day windows. Retain the latest eligible sample across turns and keep the separate M1 limits refresh probe as the fallback. | `stream-basic.jsonl`, `commands.jsonl`, `permission-host.jsonl` |

## Selected scrubbed frames

Fields below are excerpted. IDs correlate only within their scenario. New chat allocates an exact UUID in the launch arguments and sends an empty session ID on the first input, matching the fixture. Subsequent input uses the confirmed session ID.

```jsonl
{"type":"user","uuid":"4f414d32-0000-4000-8000-000000000381","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"Reply with exactly this text: Phase A café ☕"}}
{"type":"system","subtype":"init","session_id":"4f414d32-0000-4000-8000-000000000383"}
{"type":"user","uuid":"4f414d32-0000-4000-8000-000000000381","session_id":"4f414d32-0000-4000-8000-000000000383","isReplay":true}
{"type":"stream_event","session_id":"4f414d32-0000-4000-8000-000000000383","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Phase A café ☕"}}}
{"type":"result","subtype":"success","session_id":"4f414d32-0000-4000-8000-000000000383","usage":{"input_tokens":2,"output_tokens":10,"cache_creation_input_tokens":2592,"cache_read_input_tokens":649}}
```

```jsonl
{"type":"control_request","request_id":"4f414d32-0000-4000-8000-000000000061","request":{"subtype":"interrupt"}}
{"type":"control_response","response":{"subtype":"success","request_id":"4f414d32-0000-4000-8000-000000000061"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null}
```

```jsonl
{"jsonrpc":"2.0","id":1003,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Edit","input":{"file_path":"<SANDBOX>/permission-host repo/notes.txt"},"tool_use_id":"toolu_synthetic_001"}}}
{"jsonrpc":"2.0","id":1003,"result":{"content":[{"type":"text","text":"{\"behavior\":\"allow\"}"}]}}
```

## Open coverage

- The disposable `CLAUDE.md` marker was absent from the reply with `--setting-sources project,local`. Instruction loading remains unconfirmed. Production chat uses normal setting sources and native tools. User/project/local/managed policy precedence, memory, hooks, custom skills, plugins, and ordinary MCP parity need dedicated checks.
- Host approval transport was demonstrated for the disposable edit. Full request binding, duplicate or stale decisions, disconnect, native Auto and allow/deny precedence, plan approval and user input still need verification. Phase B uses `--permission-prompts none`, leaving native preapproved actions to the user's settings.
- Auth status, split and oversized frames, transcript copy reconciliation, leading `!`, thinking, attachments and background task controls remain open in the Phase A record. The Phase C follow-up below supplies the additional command and settings evidence.
- Recheck the evidence when the installed version, executable resolution, settings scope, profile, or control transport changes.

## Phase C Windows follow-up

The orchestrator supplied scrubbed results from the native Windows Claude Code 2.1.330 executable. The worker used `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-prompts none`. Each user envelope supplied a UUID, the session ID, a null parent tool ID and a user message with string content. The route stays scoped to the approved executable, project, profile and owned channel.

| Route | Scrubbed observation | Phase C behavior |
| --- | --- | --- |
| Init and input lifecycle | Init reappeared before each turn. It reported the resolved model, permission mode, 90 command names, 54 skill names, four terminal-only names, Fast status/reason, per-turn effort availability and ultrathink availability. Capabilities included `interrupt_receipt_v1`, `msg_lifecycle_v1` and `get_usage_detached_v1`. The frame reported version 2.1.330 and no effort value. The exact input UUID appeared in queued, started and completed lifecycle frames and in replay. | Check the reported and executable versions, session and cwd. Bind acknowledgments to the current input UUID. Hold uncorrelated terminal results until the matching lifecycle completion supplies the turn boundary. |
| Advertised native command or skill | An advertised `/humanizer:humanizer` invocation was replayed with the command name and arguments and produced a normal model turn that applied the skill. | Send the original spelling and arguments through the verified idle channel. Reserve local catalog names and route terminal-only names separately. |
| Compact | Bare `/compact` emitted compacting status, successful status and a manual compact boundary with 48,036 pre-tokens and 6,556 post-tokens. The provider then emitted a summary, replayed local command output and a zero-turn result. | Show the before and after counts. The post-compaction count becomes the main-lane context measurement until fresher scoped evidence arrives. Compact instructions remain gated. |
| Model | A UUID-bound `set_model` request for `sonnet` resolved to `claude-sonnet-5-5`. The next init and assistant model reported the new value, including on exact resumed sessions. Text `/model haiku` produced a synthetic success reply while the next turn still used Sonnet. | Use the control request. Show the requested choice, provider resolution and next reported effective model separately. |
| Startup and effort | A fresh `--model haiku --effort low` and exact resume with `--model haiku --effort medium` reported the resolved Haiku model. Neither echoed the effort. Live `/effort high` replayed the command and argument and returned a zero-turn acknowledgment. | Pass validated startup choices as typed arguments. Send validated effort at an idle boundary and retain the acknowledged request. Effective effort stays unavailable in this stream. |
| Fast | Init reported `off` and `extra_usage_disabled`. Bare `/fast` returned an unavailable diagnostic and a zero-turn result. | Display reported state and the account restriction. Send the diagnostic only in the observed disabled state. On/off transitions and diagnostic behavior in other account states remain gated. |
| Limit hit | The exhausted five-hour window emitted synthetic assistant text followed by an error result carrying the reset time. | Display one error row with the reset text. |
| Terminal handoff | Installed help verified the interactive exact resume form `claude --resume <session-id>`. The observed terminal-only list was `doctor`, `color`, `focus` and `reload-plugins`. | After the Phase B released-writer check, prepare the exact quoted command in a scoped VS Code terminal and leave Enter to the user. The original draft stays in Agent Lens. |

No connected Codex launch evidence was supplied. Connected Start stays gated. Exact observed Codex launches remain available through Follow.

## To-do tool availability (Phase D)

A live stream-json chat probe against Claude Code 2.1.330 asked the model to find and use a to-do tool. The model searched for TodoWrite and for TaskCreate, TaskUpdate, TaskList and TaskGet, and none of them exist in this CLI build. No recorded transcript on the test machine contains a to-do tool call either. The CLI exposes no structured to-do tool in stream-json chat, so Phase D builds no to-do checklist projection. `/tasks` keeps showing background tasks only. Re-check when a later CLI version records a to-do payload.

## Permission mode control (Phase E)

Claude Code 2.1.330, stream-json with the chat flags. The orchestrator's live probe, scrubbed:

- `control_request` with `request.subtype: "set_permission_mode"` and `mode: "plan"` returned `control_response` `success` with `response.mode: "plan"`. The CLI then emitted `system/status` with `status: null` and `permissionMode: "plan"`. `acceptEdits` behaved the same.
- An invalid mode returned `control_response` `error` with `error_code: "invalid_mode"` and a message listing `acceptEdits, auto, bypassPermissions, default, dontAsk, plan`.
- It ran with no model call and worked before the first user turn.
- Agent Lens cycles only `default, acceptEdits, plan, auto`. It never sends `bypassPermissions` or `dontAsk`, gates on `supportsClaudeCodeVersion` and an initialized owned channel, and shows only the mode the CLI reports (init, the response mode, or a status frame). Because the stream reads init inside the first turn, the control is offered once the channel is initialized and idle.

## Phase F live evidence: permission bridge (Claude Code 2.1.330, native Windows executable)

Probe flags: `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-mode default --permission-prompt-tool stdio`, without `--permission-prompts none`, with `--setting-sources project` so user allow rules did not pre-approve. In real chats the user's own settings, hooks and Auto decide first, and only undecided calls reach the bridge.

| Item | Evidence | Use |
| --- | --- | --- |
| Request | The CLI writes `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name","display_name","input","description","permission_suggestions","blocked_path"?,"tool_use_id"}}` to stdout and the turn blocks until the host answers. `tool_use_id` equals the assistant `tool_use` block id. | Parse strictly; bind the card to the tool row by `tool_use_id`. |
| Allow | Host writes `{"type":"control_response","response":{"subtype":"success","request_id":"<same>","response":{"behavior":"allow","updatedInput":<original input>}}}`. The tool ran, a normal `tool_result` followed, and the turn continued. | Always send the original input unchanged. |
| Deny | Same envelope with `{"behavior":"deny","message":"<text>"}`. The `tool_result` content was the message, the model continued, `is_error` was false. | Default for timeout, close, interrupt and owner change. |
| Not verified | Applying `permission_suggestions` (persistent rules, `setMode`), changing `updatedInput`, behavior on no answer (timeout), and a reply after an interrupt. | Persistent rules are not offered. Timeout and interrupt use Agent Lens's own deny path. Stop agent and Stop session stay disabled because no control subtype for them is verified. |

Verified earlier in this file: `interrupt` (`interrupt_receipt_v1`), `set_permission_mode`, `set_model`.
