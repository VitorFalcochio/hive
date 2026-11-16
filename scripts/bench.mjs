// Hive Bench launcher: bundles packages/bench/src/cli.ts and runs it. In Electron by default, so
// the API key saved in Hive is read in place and never printed; in Node when HIVE_BENCH_BASE_URL
// gives the provider directly. Arguments after `--` go to the bench (see packages/bench/src/cli.ts).
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = path.join(root, '.local', 'bench-build');
await mkdir(outDir, { recursive: true });

const require = createRequire(path.join(root, 'apps/desktop/package.json'));
// Rolldown is Vite's bundler; it is reached through Vite, which the desktop app depends on.
const rolldown = createRequire(require.resolve('vite')).resolve('rolldown');
const { build } = await import(`file:///${rolldown.replace(/\\/g, '/')}`);
await build({
  input: path.join(root, 'packages/bench/src/cli.ts'),
  platform: 'node',
  external: [/^node:/, 'electron'],
  logLevel: 'warn',
  output: { file: path.join(outDir, 'cli.mjs'), format: 'esm', codeSplitting: false },
});

const env = {
  ...process.env,
  HIVE_BENCH_ROOT: path.join(root, 'packages/bench'),
  HIVE_BENCH_PARENT: String(process.pid),
  // Not on Electron's command line: Chromium parses it too, and some combinations (such as
  // `--models a/b:free --label x`) make Electron exit (code 127) before any script runs.
  HIVE_BENCH_ARGS: JSON.stringify(process.argv.slice(2)),
};
delete env.ELECTRON_RUN_AS_NODE;
const direct = !!process.env.HIVE_BENCH_BASE_URL;
const command = direct ? process.execPath : require('electron');
const child = spawn(command, [path.join(outDir, 'cli.mjs')], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
