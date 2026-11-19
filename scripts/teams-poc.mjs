// Hive Teams proof of concept launcher (T8): bundles packages/bench/src/teams-poc.ts and runs it
// in Electron, so the keys saved in Hive's development data (.local/data) are read in place and
// never printed. It refuses to start while another Electron runs: the Hive app and this run must
// not refresh the same ChatGPT sign-in at once.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform === 'win32') {
  const running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], {
    encoding: 'utf8',
  });
  if (/electron\.exe/i.test(running)) {
    console.error('Feche o Hive (e qualquer Electron aberto) antes da prova de conceito.');
    process.exit(1);
  }
}
const outDir = path.join(root, '.local', 'bench-build');
await mkdir(outDir, { recursive: true });

const require = createRequire(path.join(root, 'apps/desktop/package.json'));
const rolldown = createRequire(require.resolve('vite')).resolve('rolldown');
const { build } = await import(`file:///${rolldown.replace(/\\/g, '/')}`);
await build({
  input: path.join(root, 'packages/bench/src/teams-poc.ts'),
  platform: 'node',
  external: [/^node:/, 'electron'],
  logLevel: 'warn',
  output: { file: path.join(outDir, 'teams-poc.mjs'), format: 'esm', codeSplitting: false },
});

// `--resume` continues the latest paused run (or `--resume <folder>` a given one).
const at = process.argv.indexOf('--resume');
let resume = '';
if (at !== -1) {
  const { readdir } = await import('node:fs/promises');
  const runs = path.join(root, '.local', 'teams-poc');
  const named = process.argv[at + 1];
  const latest = (await readdir(runs).catch(() => [])).sort().at(-1);
  resume =
    named && !named.startsWith('-') ? path.resolve(named) : latest ? path.join(runs, latest) : '';
  if (!resume) {
    console.error('Nenhuma rodada para retomar em .local/teams-poc.');
    process.exit(1);
  }
}

const env = {
  ...process.env,
  ...(resume ? { HIVE_POC_RESUME: resume } : {}),
  HIVE_BENCH_ROOT: path.join(root, 'packages/bench'),
  HIVE_BENCH_PARENT: String(process.pid),
  HIVE_DATA_DIR: process.env.HIVE_DATA_DIR || path.join(root, '.local', 'data'),
  HIVE_NODE: process.execPath,
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(outDir, 'teams-poc.mjs')], {
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
