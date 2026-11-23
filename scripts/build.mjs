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
  build({
    entryPoints: ['src/webview/sources.ts'],
    outfile: 'dist/webview/sources.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    logLevel: 'info',
  }),
]);
