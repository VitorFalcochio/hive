import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, '.local');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  console.error('O Hive precisa do Node.js 24. Versão atual:', process.version);
  process.exit(1);
}
for (const directory of ['tmp', 'npm-cache', 'electron-cache', 'tools']) {
  await mkdir(path.join(local, directory), { recursive: true });
}
const env = {
  ...process.env,
  TEMP: path.join(local, 'tmp'),
  TMP: path.join(local, 'tmp'),
  TMPDIR: path.join(local, 'tmp'),
  npm_config_cache: path.join(local, 'npm-cache'),
  npm_config_store_dir: path.join(local, 'pnpm-store'),
  ELECTRON_CACHE: path.join(local, 'electron-cache'),
  electron_config_cache: path.join(local, 'electron-cache'),
  HIVE_DATA_DIR: process.env.HIVE_DATA_DIR || path.join(local, 'data'),
};
// Some terminals inherit this from an Electron host. The desktop needs normal Electron mode.
delete env.ELECTRON_RUN_AS_NODE;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

try {
  const pnpm = path.join(local, 'tools/node_modules/pnpm/bin/pnpm.cjs');
  if (
    !(await access(pnpm).then(
      () => true,
      () => false,
    ))
  ) {
    console.log('Preparando o pnpm local...');
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Execute este comando com npm run (por exemplo, npm run setup).');
    const code = await run(process.execPath, [
      npm,
      'install',
      '--prefix',
      path.join(local, 'tools'),
      manifest.packageManager,
      '--no-audit',
      '--no-fund',
    ]);
    if (code !== 0) process.exit(code);
  }
  const args = process.argv.slice(2);
  process.exitCode = await run(process.execPath, [pnpm, ...args]);
  if (process.exitCode === 0 && args[0] === 'install') {
    const require = createRequire(path.join(root, 'apps/desktop/package.json'));
    console.log('Verificando o binário do Electron...');
    process.exitCode = await run(process.execPath, [require.resolve('electron/install.js')]);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
