# Agent Lens

A local VS Code extension for observing coding agents. The Activity Bar reports local source coverage. The host models sessions, turns, agent ancestry, file activity and token observations for Claude Code and Codex.

**Build plan:** [docs/plan](docs/plan/README.md)

## Build and install

Use Node 22 and VS Code Desktop 1.147.0 or newer on Windows.

~~~powershell
npm ci
npm run build
npm run typecheck
npm test
npx @vscode/vsce package
code --install-extension .\agent-lens-0.1.0.vsix
~~~

Open **Agent Lens** in the Activity Bar to view local source status. Agent Lens reads the default provider homes from the extension host's `CLAUDE_CONFIG_DIR` and `CODEX_HOME` environment, falling back to `.claude` and `.codex` in the local user home. Additional homes and discovery-only roots belong in local **User** Settings (JSON).

~~~json
{
  "agentLens.agents": {
    "claude-code": {
      "profiles": [
        { "id": "separate", "label": "Separate profile", "home": "X:\\Example\\claude-profile" }
      ]
    },
    "codex": {
      "logRoot": "X:\\Example\\recorded-codex\\sessions"
    }
  }
}
~~~

A profile `home` contains the provider's usual directory layout. A `logRoot` points directly at Claude's `projects` or Codex's `sessions` layout and carries no profile attribution. Set `enabled` to `false` to stop observing a provider. Paths must be absolute and local. Duplicate and overlapping roots are rejected.

## Accounts, profiles and models

The **Accounts** section in the sidebar lists each configured profile with its home folder, session and token counts, and an account state. In this version every account state shows **Unknown**: Agent Lens does not run `claude` or `codex` and never reads credential files, because the output of the official status commands has not been verified. **Open official status in terminal** (also the command **Agent Lens: Open Official Account Status Terminal**) opens a terminal for that profile and types the official status command without running it, so you press Enter yourself. It needs a trusted workspace. Sign-in, sign-out and account switching are not part of this version.

The sidebar profile filter shows only sessions from one profile, and rows name their profile when a provider has more than one. Sessions from a `logRoot` carry no profile and appear as Unassigned. The session Usage tab lists the observed model and effort for each agent, with the evidence it came from. These are values the agent recorded, not the selection that was requested, and a missing value shows as Not recorded.

## Claude-to-Codex launcher convention

When preparing the external `codex-first` launcher for M1 delegation linking, update the fresh and resume launch references in `~/.claude/skills/codex-first/SKILL.md` and `scripts/codex-resume` where used.

1. Keep each Codex worker inside one Claude-tracked background Bash task. Preserve its prompt input, final `-o` report, logs, and actual exit status.
2. Capture the verified thread UUID from the first `thread.started.thread_id` event for a `--json` launch or from the native Codex startup header before the launcher redirects or discards either stream. On resume, require the startup UUID to match the exact requested thread.
3. Print `AGENT_LENS_CODEX_SESSION=<UUID>` on its own line to the tracked Bash task's stdout as soon as the ID is verified, even when full output goes to a different log.

Agent Lens accepts the exact marker, a matching structured startup event from a JSON launch, or a complete native startup header. It can read the beginning of an attributed Claude task output when the transcript records its approved path. It verifies the working directory and launch interval against the corresponding rollout and links a resume to its exact turn. When provenance is missing or conflicting, the Codex thread remains standalone. Verify the marker in a disposable Git Bash launch before relying on nesting in your regular workflow.
