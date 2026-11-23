# 1. Goal and scope

[Plan index](README.md) · [2 →](02-claude-code-data.md)

Agent Lens is a local VS Code extension for chatting with coding agents and inspecting their work from the same conversation. M2 opens directly into Chat, with one tab per conversation. The user sends a prompt from the composer and types `/` to open session history, inspect work without leaving chat, or change supported settings. M1's All projects tree and detailed views remain available for cross-project browsing and evidence inspection. The daily workflow covers prompts, permissions, model choices and account controls. Claude Code and Codex are the first two adapters behind one normalized event model. Agent Lens is intended for distribution. Each user signs in to their own accounts through their installed official provider CLIs. [Chat design](09-chat.md) · [Slash-command catalog](16-slash-commands.md)

- While Claude Code is working, I want to read its messages and open compact tool results, diffs and subagent details in the conversation.
- While Claude Code delegates a job to Codex through Git Bash, I want to follow the Codex run in the same panel, including Codex's own child agents.
- From a file in the session, I want to identify which agent read or changed it, open the current file, and see the historical change when a patch was recorded.
- Across repos and days, I want to compare local Claude and Codex usage and see how close each provider's account is to resetting or reaching a limit.
- I want to open Agent Lens and chat directly, use `/resume` to continue the exact conversation, send messages and attachments, and handle permission requests with the Claude Code configuration and workflows I already rely on.
- I want to choose the model and reasoning effort for Claude and Codex, see what each turn actually used, and instantly switch between my saved, isolated profiles for each provider.
- I want to read full recorded content with secrets masked, run chat turns or tasks in the background, and decide which background work appears in my main chat.
- I want to inspect each agent and stop a specific running agent where the target and control route are verified. I also want to start and resume Codex from the same interface.

The product and display name are **Agent Lens**. The implementation target is <code>D:\Documents\Dev\Saleh Shakib\personal\agent-lens</code>, branch <code>main</code>, with an initial <code>README.md</code>. The initial platform is local Windows 11 with VS Code Desktop. **M1** delivered cross-project viewing for Claude Code and Codex. **M2** adds the chat-first workflow, Claude controls, and conversation-scoped Codex launch and observation. **M3** adds independent Codex control and chat where supported. **M4** adds Gemini CLI through the common adapter contract. [Agent Lens repository](https://github.com/salehshakib/agent-lens)

---

[Plan index](README.md) · [2 →](02-claude-code-data.md)
