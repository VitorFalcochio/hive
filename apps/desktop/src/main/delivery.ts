import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type DeliveryRequirement,
  type Requirement,
  type Run,
  type RunDelivery,
  type Task,
} from '@hive/core';
import { integrationSources } from '@hive/orchestrator';
import type { Repositories } from '@hive/persistence';
import { errorMessage, nowIso } from '@hive/shared';
import { git, hiveCommitFlags, linkDependencies, unlinkDependencies } from '@hive/workspace';
import { allowedCheckCommand, installCommand, runCommand } from './flow-engine';

/** How much of a command's output is kept with the verdict. */
const OUTPUT_TAIL = 3_000;
/** At most this many commands run at the gate. */
const MAX_COMMANDS = 3;
const DONE = new Set<Task['status']>(['completed', 'approved']);
const ENDED = new Set<Run['status']>(['review', 'completed', 'failed']);

/** What the plan added to a run beyond its tasks, kept until the run is gone. */
export interface RunPlanExtras {
  requirements: Requirement[];
  verify: string[];
}

export interface DeliveryGateOptions {
  repos: Repositories;
  /** Hive's worktree folder for a project, where the gate makes its temporary checkout. */
  worktreeRoot: (workspaceId: string) => string;
  /** The project's own verification commands found in a folder, when the plan named none. */
  commands: (folder: string) => Promise<string[]>;
  onChange: (runId: string) => void;
  log: (runId: string, message: string, level: 'info' | 'warn') => void;
  notify: (title: string, body: string) => void;
  /** How many screenshots the agents took of the app in the Hive Browser during the run. */
  evidence?: (runId: string) => number;
}

/**
 * Where each requirement stands, from facts only: which tasks cover it, whether they finished,
 * and whether the final check passed on the merged result. It never judges the code itself.
 */
export function assessRequirements(
  requirements: Requirement[],
  tasks: Task[],
  gate: { passed: boolean; detail: string },
): DeliveryRequirement[] {
  const own = tasks.filter((task) => !task.candidateOf);
  return requirements.map((requirement) => {
    const covering = own.filter((task) => task.covers?.includes(requirement.id));
    const listed = covering.map((task) => ({
      key: task.key,
      title: task.title,
      status: task.status,
    }));
    const base = { id: requirement.id, text: requirement.text, tasks: listed };
    if (!covering.length)
      return {
        ...base,
        status: 'uncovered' as const,
        reason: 'Nenhuma tarefa do plano cobriu este requisito.',
      };
    const open = covering.filter((task) => !DONE.has(task.status));
    if (open.length)
      return {
        ...base,
        status: 'pending' as const,
        reason: `Não terminou: ${open
          .map(
            (task) => `“${task.title}” (${task.status === 'failed' ? 'falhou' : 'não concluída'})`,
          )
          .join(', ')}.`,
      };
    const by = covering.map((task) => `“${task.title}”`).join(', ');
    return gate.passed
      ? {
          ...base,
          status: 'met' as const,
          reason: `Entregue por ${by}; a verificação final passou.`,
        }
      : {
          ...base,
          status: 'unverified' as const,
          reason: `${by} terminou, mas ${gate.detail}`,
        };
  });
}

/** The finished work a verdict is about: each finished task's own result commit. */
export function deliveryFingerprint(tasks: Task[]): string {
  return tasks
    .filter((task) => !task.candidateOf && DONE.has(task.status) && task.result?.commit)
    .map((task) => `${task.key}:${task.result!.commit}`)
    .sort()
    .join('|');
}

/**
 * The delivery gate. When a run ends, Hive does what the user would do to trust it: it puts
 * the work of every finished task together as one project, on top of where the run started,
 * installs what it needs and runs the plan's commands on it. Then each requirement gets a
 * status the user can check, and the mission is "verified" only when everything holds.
 */
export class DeliveryGate {
  private readonly checking = new Set<string>();

  constructor(private readonly options: DeliveryGateOptions) {}

  extras(runId: string): RunPlanExtras {
    try {
      const value = JSON.parse(
        this.options.repos.getValue(`runPlan:${runId}`) ?? 'null',
      ) as Partial<RunPlanExtras> | null;
      return { requirements: value?.requirements ?? [], verify: value?.verify ?? [] };
    } catch {
      return { requirements: [], verify: [] };
    }
  }

  saveExtras(runId: string, extras: RunPlanExtras): void {
    this.options.repos.setValue(`runPlan:${runId}`, JSON.stringify(extras));
    // A new plan makes the old verdict meaningless.
    this.options.repos.setValue(`delivery:${runId}`, '');
  }

  get(runId: string): RunDelivery | null {
    try {
      const raw = this.options.repos.getValue(`delivery:${runId}`);
      return raw ? (JSON.parse(raw) as RunDelivery) : null;
    } catch {
      return null;
    }
  }

  /** A run changed: once it ended with new finished work, the gate checks it. */
  onRun(run: Run): void {
    if (!ENDED.has(run.status) || this.checking.has(run.id)) return;
    const tasks = this.options.repos.tasks.list('run_id = ?', run.id);
    const fingerprint = deliveryFingerprint(tasks);
    if (this.get(run.id)?.fingerprint === fingerprint) return;
    this.checking.add(run.id);
    void this.check(run, tasks, fingerprint).finally(() => this.checking.delete(run.id));
  }

  private save(runId: string, delivery: RunDelivery): void {
    this.options.repos.setValue(`delivery:${runId}`, JSON.stringify(delivery));
    this.options.onChange(runId);
  }

  private async check(run: Run, tasks: Task[], fingerprint: string): Promise<void> {
    const { requirements, verify } = this.extras(run.id);
    const started: RunDelivery = {
      status: 'checking',
      at: nowIso(),
      commit: null,
      checks: [],
      problem: null,
      requirements: assessRequirements(requirements, tasks, {
        passed: false,
        detail: 'a verificação final ainda está rodando.',
      }),
      summary: 'Juntando o trabalho da equipe e rodando a verificação final…',
      fingerprint,
    };
    this.save(run.id, started);
    let result: Pick<RunDelivery, 'commit' | 'checks' | 'problem'>;
    try {
      result = await this.verify(run, tasks, verify);
    } catch (error) {
      result = {
        commit: null,
        checks: [],
        problem: `A verificação final não pôde rodar: ${errorMessage(error)}`,
      };
    }
    const failed = result.checks.filter((check) => !check.ok);
    const passed = !result.problem && result.checks.length > 0 && !failed.length;
    const detail = result.problem
      ? `a verificação final não rodou (${result.problem})`
      : failed.length
        ? `a verificação final falhou em ${failed.map((check) => `"${check.command}"`).join(', ')}.`
        : 'não havia comando de verificação.';
    const assessed = assessRequirements(requirements, tasks, { passed, detail });
    const met = assessed.filter((item) => item.status === 'met').length;
    const verified = passed && assessed.every((item) => item.status === 'met');
    const proven = passed
      ? `${result.checks.map((check) => check.command).join(', ')} passou no projeto integrado`
      : result.problem
        ? 'a verificação final não rodou'
        : failed.length
          ? `${failed.map((check) => check.command).join(', ')} falhou no projeto integrado`
          : 'não havia comando de verificação';
    // What the agents saw of the app running, in the Hive Browser.
    const shots = this.options.evidence?.(run.id) ?? 0;
    const seen = shots ? ` Os agentes testaram o app no Hive Browser (${shots} print(s)).` : '';
    const summary = assessed.length
      ? `${met} de ${assessed.length} requisitos entregues e verificados; ${proven}.${seen}`
      : `Sem requisitos no plano; ${proven}.${seen}`;
    const delivery: RunDelivery = {
      status: verified ? 'verified' : 'pending',
      at: nowIso(),
      ...result,
      requirements: assessed,
      summary,
      fingerprint,
    };
    this.save(run.id, delivery);
    this.options.log(
      run.id,
      verified ? `Entrega verificada: ${summary}` : `Entrega com pendências: ${summary}`,
      verified ? 'info' : 'warn',
    );
    const mission = this.options.repos.missions.get(run.missionId);
    this.options.notify(
      verified ? 'Missão pronta e verificada' : 'Missão entregue com pendências',
      `${mission?.title ?? 'Hive'}: ${summary}`,
    );
  }

  /** Merges the finished work on the run's starting commit and runs the commands on it. */
  private async verify(
    run: Run,
    tasks: Task[],
    planned: string[],
  ): Promise<Pick<RunDelivery, 'commit' | 'checks' | 'problem'>> {
    const done = tasks.filter(
      (task) => !task.candidateOf && DONE.has(task.status) && task.result?.commit,
    );
    if (!done.length)
      return { commit: null, checks: [], problem: 'nenhuma tarefa terminou com alterações' };
    const workspace = this.options.repos.workspaces.require(run.workspaceId, 'Projeto');
    const target = path.join(
      this.options.worktreeRoot(workspace.id),
      `delivery-${randomUUID().slice(0, 8)}`,
    );
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await git(workspace.path, ['worktree', 'add', '--detach', target, run.baseCommit], {
        timeoutMs: 180_000,
      });
      // Oldest first; a result already inside another one merges as "already up to date".
      const sources = integrationSources(done, tasks).sort((a, b) =>
        (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''),
      );
      for (const task of sources) {
        const merged = await git(
          target,
          [...hiveCommitFlags, 'merge', '--no-edit', '--no-ff', task.result!.commit!],
          { allowFailure: true, timeoutMs: 120_000 },
        );
        if (merged.code !== 0) {
          const conflicts = (
            await git(target, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
          ).stdout
            .split('\n')
            .filter(Boolean)
            .slice(0, 8);
          return {
            commit: null,
            checks: [],
            problem: `o trabalho de “${task.title}” não se junta com o resto${conflicts.length ? ` (conflito em ${conflicts.join(', ')})` : ''}`,
          };
        }
      }
      const commit = (await git(target, ['rev-parse', 'HEAD'])).stdout.trim();
      const commands = [
        ...new Set([
          ...planned.map((command) => command.trim()).filter(allowedCheckCommand),
          // Without commands from the plan, the integrated project's own ones.
          ...(planned.length ? [] : await this.options.commands(target)),
        ]),
      ].slice(0, MAX_COMMANDS);
      if (!commands.length)
        return { commit, checks: [], problem: 'o projeto não tem comando de build ou teste' };
      await linkDependencies(workspace.path, target);
      const install = await installCommand(target);
      if (install) {
        const installed = await runCommand(install, target);
        if (installed.code !== 0)
          return {
            commit,
            checks: [{ command: install, ok: false, output: installed.output.slice(-OUTPUT_TAIL) }],
            problem: null,
          };
      }
      const checks: RunDelivery['checks'] = [];
      for (const command of commands) {
        const ran = await runCommand(command, target);
        checks.push({ command, ok: ran.code === 0, output: ran.output.slice(-OUTPUT_TAIL) });
      }
      return { commit, checks, problem: null };
    } finally {
      await unlinkDependencies(target);
      await git(workspace.path, ['worktree', 'remove', '--force', target], { allowFailure: true });
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      await git(workspace.path, ['worktree', 'prune'], { allowFailure: true });
    }
  }
}
