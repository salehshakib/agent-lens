# 1. Goal and scope

[Plan index](README.md) · [2 →](02-claude-code-data.md)

Agent Lens is a local VS Code extension for chatting with coding agents and watching them work in the same interface. It will replace the user's daily workflow in the official Claude Code VS Code panel, including prompts, permissions, model choices, and account controls. Claude Code and Codex are the first two adapters. M1 shows both providers across all projects, including Claude conversations, individual agents, files, external Codex runs, tokens, context fill, and limits. The Agent map links each marked Codex launch to the Claude session and lane that started it. Agent Lens is intended for distribution. Each user signs in to their own accounts through their installed official provider CLIs.

- While Claude Code is working, I want to read its messages and see the commands and edits from the main session and each subagent.
- While Claude Code delegates a job to Codex through Git Bash, I want to follow the Codex run in the same panel, including Codex's own child agents.
- From a file in the session, I want to identify which agent read or changed it, open the current file, and see the historical change when a patch was recorded.
- Across repos and days, I want to compare local Claude and Codex usage and see how close each provider's account is to resetting or reaching a limit.
- I want to start or continue a Claude conversation from the sidebar, send messages and attachments, handle permission requests, and use the Claude Code configuration and workflows I already rely on.
- I want to choose the model and reasoning effort for Claude and Codex, see what each turn actually used, and instantly switch between my saved, isolated profiles for each provider.
- I want to read full recorded content with secrets masked, run chat turns or tasks in the background, and decide which background work appears in my main chat.
- I want to inspect each agent and stop a specific running agent where the target and control route are verified. I also want to start and resume Codex from the same interface.

The product and display name are **Agent Lens**. The implementation target is <code>D:\Documents\Dev\Saleh Shakib\personal\agent-lens</code>, branch <code>main</code>, with an initial <code>README.md</code>. The initial platform is local Windows 11 with VS Code Desktop. **M1** is viewing, **M2** is Claude Code chat, agent Stop, and account control, **M3** is Codex control and chat where supported, and **M4** adds Gemini CLI through the common adapter contract. [Agent Lens repository](https://github.com/salehshakib/agent-lens)

---

[Plan index](README.md) · [2 →](02-claude-code-data.md)
