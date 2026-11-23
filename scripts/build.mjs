import { build } from 'esbuild';

await Promise.all([
  build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/host/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    logLevel: 'info',
  }),
  // The status-line relay runs outside VS Code as `node relay.js`. It has no dependencies.
  build({
    entryPoints: ['src/relay/relay.ts'],
    outfile: 'dist/relay/relay.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'info',
  }),
  build({
    entryPoints: { sidebar: 'src/webview/sidebar.ts', panel: 'src/webview/panel.ts' },
    outdir: 'dist/webview',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    logLevel: 'info',
  }),
]);
