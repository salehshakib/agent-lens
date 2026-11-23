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
- Startup and auth status, split and oversized frames, transcript copy reconciliation, `/fast`, leading `!`, model/effort, thinking, attachments and background task controls lack native parity evidence. Init command descriptors are inputs for Phase C.
- Recheck the evidence when the installed version, executable resolution, settings scope, profile, or control transport changes.
