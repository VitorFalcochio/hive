/**
 * Hive Bench command line. Run through `npm run bench` (scripts/bench.mjs), which bundles this
 * file and starts it in Electron so the API key saved in Hive can be read without ever being
 * shown. With HIVE_BENCH_BASE_URL / HIVE_BENCH_API_KEY set, it runs in plain Node instead.
 *
 *   npm run bench -- --models a,b --level 1,2 --tasks id1,id2 --timeout-min 15 --label antes
 *   npm run bench -- --compare latest
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { defaultLimits, type ExecutionLimits, type ProviderKind } from '@hive/core';
import { OpenAICompatibleClient, type ProviderEndpoint } from '@hive/providers';
import { renderReport, solved } from './report';
import { runTask, type BenchResult } from './runner';
import { benchTasks } from './tasks';
import { benchRoot } from './workspace';

// The launcher hands the arguments over in HIVE_BENCH_ARGS: Electron's command line is also
// parsed by Chromium, which chokes on some of them (see scripts/bench.mjs).
const { values: args } = parseArgs({
  args: process.env.HIVE_BENCH_ARGS
    ? (JSON.parse(process.env.HIVE_BENCH_ARGS) as string[])
    : process.argv.slice(2),
  options: {
    models: { type: 'string' },
    tasks: { type: 'string' },
    level: { type: 'string' },
    provider: { type: 'string' },
    'timeout-min': { type: 'string', default: '15' },
    'max-steps': { type: 'string' },
    label: { type: 'string', default: 'rodada' },
    compare: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const repoRoot = path.resolve(benchRoot, '..', '..');
const resultsRoot = path.join(repoRoot, '.local', 'bench');
const dataDir = path.resolve(
  process.env.HIVE_DATA_DIR || path.join(process.env.APPDATA ?? os.homedir(), 'Hive'),
);
const isElectron = !!process.versions.electron;

/** The little of Electron the bench uses; Electron itself is only there at run time. */
interface ElectronLike {
  app: {
    setPath(name: string, value: string): void;
    whenReady(): Promise<void>;
    exit(code: number): void;
  };
  safeStorage: { decryptString(encrypted: Buffer): string };
}
// Loaded synchronously: Hive's paths must be set before anything is awaited, while the app is
// not ready yet. The key store (`Local State`) lives in Hive's session folder.
const electron = isElectron ? (createRequire(import.meta.url)('electron') as ElectronLike) : null;
if (electron) {
  electron.app.setPath('userData', dataDir);
  electron.app.setPath('sessionData', path.join(dataDir, 'session'));
}

// When the launcher is killed (Ctrl+C, a closed terminal), Electron is not taken down with it on
// Windows: the bench watches its launcher and stops on its own.
const launcher = Number(process.env.HIVE_BENCH_PARENT);
if (launcher)
  setInterval(() => {
    try {
      process.kill(launcher, 0);
    } catch {
      console.error('O processo que iniciou o bench terminou; encerrando.');
      if (electron) electron.app.exit(1);
      else process.exit(1);
    }
  }, 2_000).unref();

interface Setup {
  endpoint: ProviderEndpoint;
  models: string[];
  limits: ExecutionLimits;
}

async function fromHive(): Promise<Setup> {
  const db = new DatabaseSync(path.join(dataDir, 'hive.sqlite'), { readOnly: true });
  try {
    const workers = db
      .prepare('SELECT data FROM workers')
      .all()
      .map((row) => JSON.parse(String(row.data)))
      .filter((w) => w.role !== 'queen' && w.providerId && w.modelId);
    const providerId = args.provider ?? workers[0]?.providerId;
    if (!providerId) throw new Error('Nenhum agente configurado no Hive.');
    const providerRow = db.prepare('SELECT data FROM providers WHERE id = ?').get(providerId);
    if (!providerRow) throw new Error(`Provedor não encontrado: ${providerId}`);
    const provider = JSON.parse(String(providerRow.data));
    const secret = db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(providerId);
    let apiKey: string | null = null;
    if (secret) {
      if (!electron)
        throw new Error(
          'A chave salva no Hive só pode ser lida pelo Electron: use npm run bench, ou defina HIVE_BENCH_BASE_URL e HIVE_BENCH_API_KEY.',
        );
      await electron.app.whenReady();
      apiKey = electron.safeStorage.decryptString(Buffer.from(secret.ciphertext as Uint8Array));
    }
    const onProvider = workers.filter((w) => w.providerId === providerId);
    return {
      endpoint: { providerId, kind: provider.kind, baseUrl: provider.baseUrl, apiKey },
      models: [...new Set(onProvider.map((w) => String(w.modelId)))],
      limits: onProvider[0]?.limits ?? defaultLimits,
    };
  } finally {
    db.close();
  }
}

async function setup(): Promise<Setup> {
  if (process.env.HIVE_BENCH_BASE_URL) {
    if (!args.models) throw new Error('Com HIVE_BENCH_BASE_URL, informe --models.');
    return {
      endpoint: {
        providerId: 'bench',
        kind: (process.env.HIVE_BENCH_KIND as ProviderKind) || 'openai',
        baseUrl: process.env.HIVE_BENCH_BASE_URL,
        apiKey: process.env.HIVE_BENCH_API_KEY || null,
      },
      models: [],
      limits: defaultLimits,
    };
  }
  return fromHive();
}

async function previousResults(current: string): Promise<BenchResult[] | undefined> {
  if (!args.compare) return undefined;
  let dir = args.compare;
  if (dir === 'latest') {
    const runs = (await readdir(resultsRoot).catch(() => [] as string[]))
      .filter((name) => name !== current)
      .sort();
    if (!runs.length) return undefined;
    dir = path.join(resultsRoot, runs.at(-1)!);
  }
  const text = await readFile(path.join(dir, 'results.json'), 'utf8').catch(() => null);
  return text ? (JSON.parse(text).results as BenchResult[]) : undefined;
}

async function main() {
  const config = await setup();
  const models = args.models ? args.models.split(',').map((m) => m.trim()) : config.models;
  if (!models.length) throw new Error('Nenhum modelo para testar: use --models.');
  const levels = args.level?.split(',').map(Number);
  const ids = args.tasks?.split(',').map((id) => id.trim());
  const tasks = benchTasks.filter(
    (task) => (!levels || levels.includes(task.level)) && (!ids || ids.includes(task.id)),
  );
  if (!tasks.length) throw new Error('Nenhuma tarefa selecionada.');
  const limits: ExecutionLimits = {
    ...config.limits,
    taskTimeoutMin: Number(args['timeout-min']),
    ...(args['max-steps'] ? { maxSteps: Number(args['max-steps']) } : {}),
  };
  const startedAt = new Date();
  const stamp = startedAt.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const folder = `${stamp}-${args.label}`;
  const outDir = path.join(resultsRoot, folder);
  await mkdir(outDir, { recursive: true });
  const previous = await previousResults(folder);
  const chat = new OpenAICompatibleClient(config.endpoint);
  const limitText = `${limits.maxSteps} passos, ${limits.taskTimeoutMin} min por tarefa`;
  console.log(
    `Hive Bench · ${tasks.length} tarefas × ${models.length} modelo(s) · ${limitText} · ${config.endpoint.baseUrl}`,
  );

  const results: BenchResult[] = [];
  const save = async () => {
    const meta = { label: args.label!, startedAt: startedAt.toISOString(), limits: limitText };
    await writeFile(
      path.join(outDir, 'results.json'),
      JSON.stringify({ ...meta, results }, null, 2),
    );
    await writeFile(path.join(outDir, 'report.md'), renderReport(results, meta, previous));
  };
  for (const model of models) {
    for (const task of tasks) {
      process.stdout.write(`  [${model}] nível ${task.level} · ${task.id} … `);
      const result = await runTask({ task, model, chat, limits, keepWorkdir: args.keep });
      results.push(result);
      await save();
      console.log(
        `${solved(result) ? 'resolvida' : result.passed ? 'fez mas quebrou algo' : 'NÃO resolvida'} · ${result.seconds}s · ${result.modelCalls} chamadas · ${result.failedEdits} edições falhas · espera ${result.retryWaitSeconds}s`,
      );
    }
  }
  console.log(`\nRelatório: ${path.join(outDir, 'report.md')}\n`);
  console.log(await readFile(path.join(outDir, 'report.md'), 'utf8'));
}

main()
  .then(() => {
    if (electron) electron.app.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (electron) electron.app.exit(1);
    else process.exitCode = 1;
  });
