import os from 'node:os';
import {
  type GuardianAction,
  type GuardianIncident,
  type GuardianLogLine,
  type GuardianSnapshot,
  type HealthCheck,
  type HealthStatus,
  type RecoveryRecord,
  type ResourceUsage,
  type Task,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { HiveError, errorMessage, newId, nowIso, secretRedactor } from '@hive/shared';
import { gitPreflight } from '@hive/workspace';
import {
  checkAgents,
  checkFailedTasks,
  checkProviders,
  checkRenderer,
  checkResources,
  worst,
  type CheckOutcome,
  type IncidentDraft,
} from './checks';

const TICK_MS = 30_000;
const MAX_INCIDENTS = 200;
const MAX_RECOVERIES = 100;
const MAX_LOGS = 400;
const INCIDENTS_KEY = 'guardian:incidents';
const RECOVERIES_KEY = 'guardian:recoveries';

export interface GuardianOptions {
  repos: Repositories;
  now?: () => number;
  /** Models resting after a failure (Hive's circuit breakers), and how to clear them. */
  routes: { resting: () => { key: string; untilMs: number }[]; reset: () => number };
  scheduler: {
    retry: (taskId: string) => unknown;
    cancelTask: (taskId: string) => unknown;
    leftoverWorktrees: () => Promise<{ workspaceId: string; path: string; dirty: boolean }[]>;
    pruneWorktrees: () => Promise<{ removed: number; kept: number }>;
  };
  /** CPU, memory and disk of Hive and the computer. */
  resources: () => Promise<ResourceUsage>;
  backup: () => Promise<{ name: string }>;
  reloadWindows: () => number;
  /** Saves a text file where the user picks; null when cancelled. */
  save: (defaultName: string, content: string) => Promise<string | null>;
  onChange: () => void;
}

/**
 * Hive Guardian: watches the hive from the main process, with no model involved. Every 30 s it
 * checks each component, turns what is wrong into incidents (one per problem while it lasts,
 * resolved once the check passes again) and offers recoveries the user starts. The automatic
 * recoveries Hive already has (resuming interrupted runs, retries with backoff, provider
 * failover) keep doing their job; the Guardian shows what they leave for a person.
 */
export class Guardian {
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<GuardianSnapshot> | null = null;
  private checks: HealthCheck[] = [];
  private agents: GuardianSnapshot['agents'] = [];
  private resourceUsage: ResourceUsage | null = null;
  private checkedAt: string | null = null;
  private readonly logs: GuardianLogLine[] = [];

  constructor(private readonly options: GuardianOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    this.timer ??= setInterval(() => void this.diagnose().catch(() => undefined), TICK_MS);
    // The first look shortly after start, once the windows and the scheduler are up.
    this.first ??= setTimeout(() => void this.diagnose().catch(() => undefined), 5_000);
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.first);
    this.timer = undefined;
    this.first = undefined;
  }

  /** A line of the main log, kept for the technical view and the renderer check. */
  record(line: GuardianLogLine): void {
    this.logs.push(line);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  snapshot(): GuardianSnapshot {
    const incidents = this.incidents();
    const open = incidents.filter((incident) => !incident.resolvedAt);
    return {
      status: worst([
        ...this.checks.map((check) => check.status),
        ...open.map((incident): HealthStatus =>
          incident.severity === 'critical'
            ? 'fail'
            : incident.severity === 'warning'
              ? 'warn'
              : 'ok',
        ),
      ]),
      checkedAt: this.checkedAt,
      checks: this.checks,
      agents: this.agents,
      resources: this.resourceUsage,
      incidents,
      recoveries: this.recoveries(),
      logs: [...this.logs].slice(-200),
    };
  }

  /** Runs every check now; a call while one runs waits for it instead of starting another. */
  diagnose(): Promise<GuardianSnapshot> {
    this.running ??= this.runChecks().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runChecks(): Promise<GuardianSnapshot> {
    const { repos } = this.options;
    const now = this.now();
    const drafts: IncidentDraft[] = [];
    const checks: HealthCheck[] = [];
    const measure = async (
      id: string,
      name: string,
      check: () => Promise<CheckOutcome> | CheckOutcome,
    ) => {
      const started = Date.now();
      let outcome: CheckOutcome;
      try {
        outcome = await check();
      } catch (error) {
        // A check that breaks is itself a finding, never a reason to stop the others.
        outcome = {
          status: 'fail',
          detail: `A checagem falhou: ${errorMessage(error)}`,
          incidents: [
            {
              key: `check:${id}`,
              severity: 'warning',
              component: id,
              title: `Não foi possível checar: ${name}`,
              detail: errorMessage(error),
            },
          ],
        };
      }
      drafts.push(...outcome.incidents);
      checks.push({
        id,
        name,
        status: outcome.status,
        detail: outcome.detail,
        checkedAt: nowIso(),
        durationMs: Date.now() - started,
      });
    };

    await measure('database', 'Banco de dados', () => {
      const started = Date.now();
      repos.getValue('guardian:ping');
      const ms = Date.now() - started;
      return {
        status: ms > 2_000 ? 'warn' : 'ok',
        detail: `Respondeu em ${ms} ms.`,
        incidents:
          ms > 2_000
            ? [
                {
                  key: 'database:slow',
                  severity: 'warning',
                  component: 'database',
                  title: 'O banco de dados está lento',
                  detail: `Uma leitura simples levou ${ms} ms.`,
                  action: 'backup',
                },
              ]
            : [],
      };
    });

    const runs = repos.runs.list();
    const active = runs.filter((run) => ['planning', 'running'].includes(run.status));
    await measure('git', 'Git e projetos', async () => {
      const busy = new Set(active.map((run) => run.workspaceId));
      const workspaces = repos.workspaces
        .list()
        .sort((a, b) => Number(busy.has(b.id)) - Number(busy.has(a.id)))
        .slice(0, 8);
      const incidents: IncidentDraft[] = [];
      for (const workspace of workspaces) {
        const problem = await gitPreflight(workspace.path);
        if (problem)
          incidents.push({
            key: `git:${workspace.id}`,
            severity: busy.has(workspace.id) ? 'critical' : 'warning',
            component: 'git',
            title: `${workspace.name}: o Git não está pronto`,
            detail: problem,
          });
      }
      return {
        status: incidents.some((item) => item.severity === 'critical')
          ? 'fail'
          : incidents.length
            ? 'warn'
            : 'ok',
        detail: incidents.length
          ? `${incidents.length} de ${workspaces.length} projeto(s) com problema no Git.`
          : `${workspaces.length} projeto(s) com Git pronto.`,
        incidents,
      };
    });

    await measure('worktrees', 'Cópias dos agentes (worktrees)', async () => {
      const leftovers = await this.options.scheduler.leftoverWorktrees();
      const dirty = leftovers.filter((item) => item.dirty);
      const loose = leftovers.length - dirty.length;
      const incidents: IncidentDraft[] = [];
      if (loose)
        incidents.push({
          key: 'worktrees:leftover',
          severity: 'info',
          component: 'worktrees',
          title: `${loose} cópia(s) de tarefas que não existem mais`,
          detail: 'Sobras de execuções interrompidas, sem alterações pendentes; ocupam disco.',
          action: 'prune-worktrees',
        });
      if (dirty.length)
        incidents.push({
          key: 'worktrees:dirty',
          severity: 'warning',
          component: 'worktrees',
          title: `${dirty.length} cópia(s) solta(s) com alterações não salvas`,
          detail: `Nenhuma tarefa é dona delas e o Hive não as apaga. Confira e copie o que quiser guardar: ${dirty
            .map((item) => item.path)
            .slice(0, 5)
            .join(', ')}`,
        });
      return {
        status: dirty.length ? 'warn' : 'ok',
        detail: leftovers.length
          ? `${leftovers.length} cópia(s) sem tarefa (${dirty.length} com alterações).`
          : 'Nenhuma cópia sobrando.',
        incidents,
      };
    });

    const tasks = repos.tasks.list();
    await measure('agents', 'Agentes trabalhando', () => {
      const working = tasks.filter((task) => ['running', 'waiting_approval'].includes(task.status));
      const recent = new Map(
        working.map((task) => [task.id, repos.queryEvents({ taskId: task.id, limit: 12 })]),
      );
      const workers = new Map(repos.workers.list().map((worker) => [worker.id, worker]));
      const outcome = checkAgents({ now, tasks: working, workers, recent });
      this.agents = outcome.agents;
      return outcome;
    });

    await measure('tasks', 'Tarefas', () => checkFailedTasks(tasks, now));

    await measure('providers', 'Provedores', () =>
      checkProviders({
        now,
        resting: this.options.routes.resting(),
        events: repos.queryEvents({ levels: ['warn', 'error'], limit: 300 }),
      }),
    );

    await measure('renderer', 'Interface (janelas)', () =>
      checkRenderer({ now, lines: this.logs.filter((line) => line.scope === 'renderer') }),
    );

    await measure('process', 'Processo principal', () => {
      const failures = this.logs.filter(
        (line) =>
          ['uncaught', 'unhandled-rejection'].includes(line.scope) &&
          now - Date.parse(line.at) < 10 * 60_000,
      );
      return {
        status: failures.length ? 'warn' : 'ok',
        detail: failures.length
          ? `${failures.length} erro(s) sem tratamento nos últimos 10 min.`
          : `Rodando há ${Math.round(process.uptime() / 60)} min, sem erros sem tratamento.`,
        incidents: failures.length
          ? [
              {
                key: 'process:uncaught',
                severity: 'warning',
                component: 'process',
                title: 'Erro sem tratamento no processo principal',
                detail: failures.at(-1)!.text.slice(0, 500),
              },
            ]
          : [],
      };
    });

    await measure('resources', 'Recursos (CPU, memória, disco)', async () => {
      const usage = await this.options.resources();
      this.resourceUsage = usage;
      return checkResources(usage);
    });

    this.checks = checks;
    this.checkedAt = nowIso();
    this.reconcile(drafts, new Set(checks.map((check) => check.id)));
    this.options.onChange();
    return this.snapshot();
  }

  /**
   * Opens incidents for new problems, refreshes the ones still there and resolves those whose
   * check now passes. One problem stays one incident however many checks see it.
   */
  private reconcile(drafts: IncidentDraft[], checked: Set<string>): void {
    const at = nowIso();
    const incidents = this.incidents();
    const seen = new Set<string>();
    for (const draft of drafts) {
      seen.add(draft.key);
      const open = incidents.find((item) => item.key === draft.key && !item.resolvedAt);
      if (open) Object.assign(open, { ...this.fields(draft), lastSeenAt: at });
      else
        incidents.unshift({
          id: newId('incident'),
          ...this.fields(draft),
          openedAt: at,
          lastSeenAt: at,
          resolvedAt: null,
        });
    }
    for (const incident of incidents)
      if (!incident.resolvedAt && !seen.has(incident.key) && checked.has(incident.component))
        incident.resolvedAt = at;
    // Open ones first, then the newest resolved, within the limit.
    const kept = [
      ...incidents.filter((item) => !item.resolvedAt),
      ...incidents.filter((item) => item.resolvedAt),
    ].slice(0, MAX_INCIDENTS);
    this.options.repos.setValue(INCIDENTS_KEY, JSON.stringify(kept));
  }

  private fields(draft: IncidentDraft) {
    return {
      key: draft.key,
      severity: draft.severity,
      component: draft.component,
      title: draft.title,
      detail: draft.detail,
      runId: draft.runId ?? null,
      taskId: draft.taskId ?? null,
      action: draft.action ?? null,
    };
  }

  private incidents(): GuardianIncident[] {
    return this.read<GuardianIncident>(INCIDENTS_KEY);
  }

  private recoveries(): RecoveryRecord[] {
    return this.read<RecoveryRecord>(RECOVERIES_KEY);
  }

  private read<T>(key: string): T[] {
    try {
      const value: unknown = JSON.parse(this.options.repos.getValue(key) ?? '[]');
      return Array.isArray(value) ? (value as T[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Runs a recovery the user asked for, through the same calls the app uses elsewhere, and keeps
   * a record of it whatever happens. Each is safe to repeat: retrying a task already back in the
   * queue, or pruning with nothing left over, changes nothing.
   */
  async recover(action: GuardianAction): Promise<RecoveryRecord> {
    const { scheduler } = this.options;
    const target = action.target ?? null;
    const task = (): Task => {
      if (!target) throw new HiveError('VALIDATION', 'Diga qual tarefa.');
      return this.options.repos.tasks.require(target, 'Tarefa');
    };
    let detail: string;
    let ok = true;
    try {
      switch (action.action) {
        case 'retry-task': {
          const current = task();
          if (current.status !== 'failed') {
            detail = `“${current.title}” não está mais falhada (${current.status}); nada a fazer.`;
            break;
          }
          scheduler.retry(current.id);
          detail = `“${current.title}” voltou para a fila.`;
          break;
        }
        case 'cancel-task': {
          const current = task();
          if (!['running', 'waiting_approval', 'pending'].includes(current.status)) {
            detail = `“${current.title}” já não está rodando (${current.status}); nada a fazer.`;
            break;
          }
          scheduler.cancelTask(current.id);
          detail = `“${current.title}” foi cancelada. O que ela já tinha salvo continua no branch dela; use Repetir para tentar de novo.`;
          break;
        }
        case 'prune-worktrees': {
          const { removed, kept } = await scheduler.pruneWorktrees();
          detail = `${removed} cópia(s) sobrando removida(s)${kept ? `; ${kept} com alterações não salvas foram mantidas` : ''}.`;
          break;
        }
        case 'reset-providers': {
          const cleared = this.options.routes.reset();
          detail = cleared
            ? `${cleared} modelo(s) liberado(s) para tentar de novo agora.`
            : 'Nenhum modelo estava descansando.';
          break;
        }
        case 'backup': {
          const made = await this.options.backup();
          detail = `Cópia de segurança criada: ${made.name}.`;
          break;
        }
        case 'reload-windows': {
          const count = this.options.reloadWindows();
          detail = `${count} janela(s) recarregada(s). As missões seguiram no processo principal.`;
          break;
        }
      }
    } catch (error) {
      ok = false;
      detail = errorMessage(error);
    }
    const record: RecoveryRecord = {
      id: newId('recovery'),
      action: action.action,
      target,
      at: nowIso(),
      ok,
      detail: detail!,
    };
    this.options.repos.setValue(
      RECOVERIES_KEY,
      JSON.stringify([record, ...this.recoveries()].slice(0, MAX_RECOVERIES)),
    );
    // What it fixed shows at once, not at the next tick.
    void this.diagnose().catch(() => undefined);
    return record;
  }

  /** The report as Markdown, with credentials, tokens and personal paths removed. */
  report(): string {
    const snapshot = this.snapshot();
    const label = { ok: 'OK', warn: 'Atenção', fail: 'Falha' } as const;
    const lines = [
      '# Relatório do Hive Guardian',
      '',
      `Gerado em ${nowIso()}. Estado geral: **${label[snapshot.status]}**.`,
      `Sistema: ${process.platform} ${os.release()}, Node ${process.versions.node}${process.versions.electron ? `, Electron ${process.versions.electron}` : ''}.`,
      '',
      '## Componentes',
      ...snapshot.checks.map(
        (check) =>
          `- **${check.name}**: ${label[check.status]}. ${check.detail} (${check.durationMs} ms)`,
      ),
      '',
      '## Agentes trabalhando',
      ...(snapshot.agents.length
        ? snapshot.agents.map(
            (agent) =>
              `- ${agent.workerName} em “${agent.taskTitle}”: ${agent.state}, último sinal há ${Math.round(agent.silentMs / 1000)} s.`,
          )
        : ['- Nenhum.']),
      '',
      '## Recursos',
      snapshot.resources
        ? `CPU ${Math.round(snapshot.resources.cpuPercent)}%, memória ${snapshot.resources.memoryMb} MB, livre no computador ${snapshot.resources.systemFreeMb} MB${snapshot.resources.diskFreeMb !== null ? `, disco livre ${snapshot.resources.diskFreeMb} MB` : ''}.`
        : 'Ainda não medido.',
      '',
      '## Incidentes',
      ...(snapshot.incidents.length
        ? snapshot.incidents
            .slice(0, 50)
            .map(
              (incident) =>
                `- [${incident.resolvedAt ? 'resolvido' : incident.severity}] ${incident.title} — ${incident.detail} (aberto ${incident.openedAt}${incident.resolvedAt ? `, resolvido ${incident.resolvedAt}` : ''})`,
            )
        : ['- Nenhum.']),
      '',
      '## Recuperações',
      ...(snapshot.recoveries.length
        ? snapshot.recoveries
            .slice(0, 30)
            .map(
              (item) =>
                `- ${item.at} ${item.action}: ${item.ok ? 'ok' : 'falhou'} — ${item.detail}`,
            )
        : ['- Nenhuma.']),
      '',
      '## Log técnico (recente)',
      '```',
      ...snapshot.logs
        .slice(-150)
        .map((line) => `${line.at} ${line.level.toUpperCase()} [${line.scope}] ${line.text}`),
      '```',
    ];
    return redactReport(lines.join('\n'));
  }

  async export(): Promise<string | null> {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return this.options.save(`hive-guardian-${stamp}.md`, this.report());
  }
}

/**
 * Removes what a shared report must not carry: keys and tokens (the same redactor as the log)
 * and the user's home folder and account name, which say who they are.
 */
export function redactReport(text: string, home = os.homedir(), user = safeUser()): string {
  let out = secretRedactor.redact(text);
  for (const value of [home, home.replace(/\\/g, '/')])
    if (value.length > 3) out = out.split(value).join('~');
  if (user && user.length > 2)
    out = out.replace(new RegExp(`\\b${escape(user)}\\b`, 'gi'), '<usuário>');
  return out;
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
