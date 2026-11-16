import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/bench, wherever this module ends up (source or bundle) — overridable for bundles. */
export const benchRoot = process.env.HIVE_BENCH_ROOT
  ? path.resolve(process.env.HIVE_BENCH_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fixtureDir = () => path.join(benchRoot, 'fixture');
const checkFile = (taskId: string) => path.join(benchRoot, 'checks', `${taskId}.check.ts`);
export const solutionDir = (taskId: string) => path.join(benchRoot, 'solutions', taskId);
/** The hidden check's name inside the work copy; the agent never sees it. */
const HIDDEN = 'zz-bench.test.ts';

export interface ProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let output = '';
    const collect = (chunk: Buffer) => {
      if (output.length < 20_000) output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(error), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

const git = (cwd: string, ...args: string[]) =>
  run('git', ['-c', 'user.name=Hive Bench', '-c', 'user.email=bench@hive.local', ...args], cwd);

/** A fresh, committed copy of the fixture in a temporary folder. */
export async function prepareWorkdir(taskId: string, base = os.tmpdir()): Promise<string> {
  const parent = path.join(base, 'hive-bench');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, `${taskId}-`));
  await cp(fixtureDir(), dir, { recursive: true });
  await git(dir, 'init', '-q');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

export async function applySolution(taskId: string, dir: string): Promise<void> {
  await cp(solutionDir(taskId), dir, { recursive: true });
}

export interface Grade {
  /** The hidden check passed: the task was done. */
  passed: boolean;
  /** The fixture's original tests still pass: nothing else broke. */
  noRegressions: boolean;
  output: string;
}

/**
 * Grades a work copy. The fixture's own tests are restored first (the agent may have changed
 * them) and run alongside the hidden check; tests the agent added are not part of the grade.
 */
export async function grade(taskId: string, dir: string): Promise<Grade> {
  const testDir = path.join(dir, 'test');
  await mkdir(testDir, { recursive: true });
  const originals = (await readdir(path.join(fixtureDir(), 'test'))).filter((name) =>
    name.endsWith('.test.ts'),
  );
  for (const name of originals)
    await cp(path.join(fixtureDir(), 'test', name), path.join(testDir, name));
  await cp(checkFile(taskId), path.join(testDir, HIDDEN));
  const node = process.env.HIVE_BENCH_NODE || 'node';
  const hidden = await run(node, ['--test', `test/${HIDDEN}`], dir);
  const visible = await run(node, ['--test', ...originals.map((name) => `test/${name}`)], dir);
  await rm(path.join(testDir, HIDDEN), { force: true });
  return {
    passed: hidden.code === 0,
    noRegressions: visible.code === 0,
    output: `${hidden.output}\n${visible.output}`.slice(-4_000),
  };
}

/** Files the agent changed, added or removed, relative to the fixture commit. */
export async function changedFiles(dir: string): Promise<string[]> {
  await git(dir, 'add', '-A');
  const diff = await git(dir, 'diff', '--cached', '--name-only', 'HEAD');
  return diff.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
