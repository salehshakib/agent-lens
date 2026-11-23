# 13. Tech stack, layout, and local packaging

[← 12](12-accounts.md) · [Plan index](README.md) · [14 →](14-security.md)

Use strict TypeScript for the Node extension host, adapter contract and typed view messages. Use Node filesystem and process primitives, the VS Code extension API and esbuild with separate Node and browser bundles. Use plain TypeScript, HTML and CSS for the paged session tree, keyed timeline/chat rows, Agent map, composer, quota meters, usage chart and forms. Use VS Code dialogs and notifications where available. Keep the status-line relay dependency-free if feasible. Bring in the Claude Agent SDK only if chosen in M2. Add a standalone, verifiable Windows helper for the M3 Stop capabilities that require Win32 operations. [VS Code bundling with esbuild](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)

| Manifest surface | Planned ID or name |
| --- | --- |
| Extension package ID and display name | <code>agent-lens</code> and <code>Agent Lens</code>. The fully qualified VS Code identifier includes the selected publisher. |
| Activity Bar and views | <code>agentLens.activity</code>, <code>agentLens.sessions</code>, <code>agentLens.quota</code>, <code>agentLens.session</code>, <code>agentLens.usage</code>, <code>agentLens.accounts</code>. Chat is a capability of the session view. |
| Commands | <code>agentLens.openSession</code>, <code>agentLens.showAgentMap</code>, <code>agentLens.showBackgroundTasks</code>, <code>agentLens.showUsage</code>, <code>agentLens.showAccounts</code>, <code>agentLens.chat.new</code>, <code>agentLens.chat.continue</code>, <code>agentLens.run.start</code>, <code>agentLens.run.followUp</code>, <code>agentLens.run.stop</code>, <code>agentLens.accounts.signIn</code>, <code>agentLens.accounts.signOut</code>, <code>agentLens.accounts.switch</code>, and user-invoked Claude limits setup, refresh when verified, and uninstall. Pass adapter, session, lane and profile IDs as validated host parameters. |
| Settings and status bar | Use <code>agentLens.agents</code>, <code>agentLens.notifications</code>, and other <code>agentLens.*</code> keys. Status item IDs use <code>agentLens.status.*</code>, with **Agent Lens** as the product label and adapter-supplied labels for quota. |

Planned project layout after approval

~~~
agent-lens/
  package.json                   manifest, commands, views, settings
  tsconfig.json
  scripts/build.mjs               host and browser bundles
  src/
    extension.ts
    host/
      discovery/                 roots, catalog, watcher, byte tail
      adapters/                  contract, registry and capabilities
        claude-code/             transcript, agent, quota, chat and auth
        codex/                   rollout, index, controls and auth
      sessions/                  lane/turn state and delegation edges
      files/                     recorded file actions and diffs
      usage/                     response ledger, context and quota windows
      chat/                      supervised channels, queue and approvals
      accounts/                  status, profile and official flow routing
      views/                     sidebar, panel, status, notifications
      privacy/                   allowlists, sanitization, safe errors
    shared/                      typed webview messages
    webview/                     session tree, timeline, agent map, tasks, files, usage, chat, accounts
  media/                         local icon and packaged assets
  test/fixtures/                  synthetic transcript, rollout and quota data
  test/                           parser, reducer and integration checks
  native/windows/                 M3 Stop helper if validated
  .vscodeignore
  README.md
  PLAN.md
~~~

Build in the existing <code>agent-lens</code> repository on <code>main</code> after approval, using the initial README as the starting point. The first package targets local Windows VS Code Desktop. Set <code>engines.vscode</code> to the oldest release exercised by the compatibility pass, starting with VS Code 1.147.0. M1 browsing works even if a CLI binary is unavailable. Detect supported binaries and Windows architecture for later controls. Package any architecture-specific M3 helper only when validated. Keep the user-installed official provider CLIs external. The VSIX contains bundles, local media, manifest, and approved bridge/help artifacts. Exclude credentials, account profiles, private data, fixtures, dev dependencies and work-order content. Review the archive and complete the pre-distribution checklist in [§15](15-milestones.md). [Agent Lens repository](https://github.com/salehshakib/agent-lens) · [VSIX packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

Build and install sequence for the implementation phase

~~~powershell
npm run build
npx @vscode/vsce ls
npx @vscode/vsce package
code --install-extension ".\agent-lens-0.1.0.vsix"
~~~

The VS Code Extensions menu's **Install from VSIX…** action is equivalent. Open Agent Lens in the Activity Bar and confirm the detected Claude and Codex log roots. Verify the intended local provider profile before enabling quota alerts. [VS Code packaging and local installation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions)

---

[← 12](12-accounts.md) · [Plan index](README.md) · [14 →](14-security.md)
