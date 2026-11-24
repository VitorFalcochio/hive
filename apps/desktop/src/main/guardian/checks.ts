import type {
  AgentEvent,
  AgentHeartbeat,
  GuardianActionKind,
  HealthStatus,
  IncidentSeverity,
  ResourceUsage,
  Task,
} from '@hive/core';

/** A running task with no sign of life for this long is reported as without progress. */
export const SILENT_WARN_MS = 10 * 60_000;
/** …and as stuck after this long. */
export const SILENT_FAIL_MS = 25 * 60_000;
/** The same tool call this many times in a row is an unproductive loop. */
export const LOOP_REPEATS = 6;

/** A problem a check found, before it becomes (or refreshes) an incident. */
export interface IncidentDraft {
  key: string;
  severity: IncidentSeverity;
  component: string;
  title: string;
  detail: string;
  runId?: string | null;
  taskId?: string | null;
  action?: GuardianActionKind | null;
}

/** What one check concluded: the component's status and the problems behind it. */
export interface CheckOutcome {
  status: HealthStatus;
  detail: string;
  incidents: IncidentDraft[];
}

export const worst = (statuses: HealthStatus[]): HealthStatus =>
  statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok';

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * Heartbeat of the agents at work: when each running task last logged anything. Quiet is not
 * stuck while the task waits for the user's approval; it is when it runs and says nothing.
 * Repeating the same tool call over and over is reported as a loop.
 */
export function checkAgents(input: {
  now: number;
  tasks: Task[];
  workers: Map<string, { name: string }>;
  /** The task's latest events, oldest first. */
  recent: Map<string, AgentEvent[]>;
}): CheckOutcome & { agents: AgentHeartbeat[] } {
  const { now, workers, recent } = input;
  const active = input.tasks.filter(
    (task) => !task.candidateOf && ['running', 'waiting_approval'].includes(task.status),
  );
  const incidents: IncidentDraft[] = [];
  const agents = active.map((task): AgentHeartbeat => {
    const events = recent.get(task.id) ?? [];
    const last = events.at(-1)?.ts ?? task.startedAt;
    const silentMs = last ? Math.max(0, now - Date.parse(last)) : 0;
    const waiting = task.status === 'waiting_approval';
    const status: HealthStatus = waiting
      ? 'ok'
      : silentMs >= SILENT_FAIL_MS
        ? 'fail'
        : silentMs >= SILENT_WARN_MS
          ? 'warn'
          : 'ok';
    const workerName = (task.workerId && workers.get(task.workerId)?.name) || 'Agente';
    if (status !== 'ok')
      incidents.push({
        key: `silent:${task.id}`,
        severity: status === 'fail' ? 'critical' : 'warning',
        component: 'agents',
        title: `“${task.title}” sem progresso há ${minutes(silentMs)} min`,
        detail: `${workerName} não registrou nenhuma ação desde ${last ?? 'o início'}. Pode estar esperando um provedor lento ou travado.`,
        runId: task.runId,
        taskId: task.id,
        action: 'cancel-task',
      });
    const calls = events
      .filter((event) => event.type === 'tool.call')
      .map((event) => event.message);
    const tail = calls.slice(-LOOP_REPEATS);
    if (tail.length === LOOP_REPEATS && tail.every((call) => call === tail[0]))
      incidents.push({
        key: `loop:${task.id}`,
        severity: 'warning',
        component: 'agents',
        title: `“${task.title}” repete a mesma ação`,
        detail: `${workerName} chamou “${tail[0]!.slice(0, 120)}” ${LOOP_REPEATS} vezes seguidas sem avançar.`,
        runId: task.runId,
        taskId: task.id,
        action: 'cancel-task',
      });
    return {
      taskId: task.id,
      runId: task.runId,
      taskTitle: task.title,
      workerId: task.workerId,
      workerName,
      state: waiting ? 'Aguardando sua aprovação' : task.workerState,
      lastSignal: last ?? null,
      silentMs,
      status,
    };
  });
  const status = worst([
    ...agents.map((agent) => agent.status),
    ...(incidents.some((incident) => incident.key.startsWith('loop:')) ? ['warn' as const] : []),
  ]);
  return {
    status,
    detail: !agents.length
      ? 'Nenhum agente trabalhando agora.'
      : status === 'ok'
        ? `${agents.length} agente(s) trabalhando, todos dando sinal de vida.`
        : `${incidents.length} problema(s) entre ${agents.length} agente(s) trabalhando.`,
    incidents,
    agents,
  };
}

/** Recently failed tasks the user can send back to the queue from the Guardian. */
export function checkFailedTasks(tasks: Task[], now: number): CheckOutcome {
  const day = 24 * 60 * 60_000;
  const failed = tasks.filter(
    (task) =>
      !task.candidateOf &&
      task.status === 'failed' &&
      task.finishedAt &&
      now - Date.parse(task.finishedAt) < day,
  );
  return {
    status: failed.length ? 'warn' : 'ok',
    detail: failed.length
      ? `${failed.length} tarefa(s) falharam nas últimas 24 horas.`
      : 'Nenhuma tarefa falhou nas últimas 24 horas.',
    incidents: failed.map((task) => ({
      key: `failed:${task.id}`,
      severity: 'warning' as const,
      component: 'tasks',
      title: `“${task.title}” falhou`,
      detail: task.error?.slice(0, 400) ?? 'Sem descrição do erro.',
      runId: task.runId,
      taskId: task.id,
      action: 'retry-task' as const,
    })),
  };
}

const PROVIDER_TROUBLE =
  /provider error|limite de uso|cota|rate limit|\b429\b|\b413\b|não respondeu|fora do ar|sem créditos|chave recusada|request too large/i;

/**
 * Providers: models resting after a failure (Hive's circuit breakers, see RouteHealth) and the
 * provider errors of the last minutes.
 */
export function checkProviders(input: {
  now: number;
  resting: { key: string; untilMs: number }[];
  /** Recent warnings and errors of the run log. */
  events: AgentEvent[];
  windowMs?: number;
}): CheckOutcome {
  const windowMs = input.windowMs ?? 15 * 60_000;
  const errors = input.events.filter(
    (event) =>
      input.now - Date.parse(event.ts) < windowMs &&
      ['warn', 'error'].includes(event.level) &&
      PROVIDER_TROUBLE.test(event.message),
  );
  const resting = input.resting.map((route) => {
    const [provider, model] = route.key.split('\u0000');
    return `${provider}/${model} (volta em ${minutes(route.untilMs)} min)`;
  });
  const incidents: IncidentDraft[] = [];
  if (resting.length)
    incidents.push({
      key: 'providers:resting',
      severity: 'info',
      component: 'providers',
      title: `${resting.length} modelo(s) descansando depois de falhar`,
      detail: `O Hive desviou deles por enquanto (proteção contra repetir a falha): ${resting.join(', ')}.`,
      action: 'reset-providers',
    });
  if (errors.length >= 5)
    incidents.push({
      key: 'providers:errors',
      severity: errors.length >= 20 ? 'critical' : 'warning',
      component: 'providers',
      title: `${errors.length} erros de provedor nos últimos ${minutes(windowMs)} min`,
      detail: `Último: ${errors.at(-1)!.message.slice(0, 300)}`,
    });
  return {
    status: errors.length >= 20 ? 'fail' : errors.length >= 5 || resting.length ? 'warn' : 'ok',
    detail: [
      resting.length ? `${resting.length} modelo(s) descansando.` : 'Nenhum modelo descansando.',
      `${errors.length} erro(s) de provedor nos últimos ${minutes(windowMs)} min.`,
    ].join(' '),
    incidents,
  };
}

/**
 * The windows: a page that stopped answering or crashed recently, as the window watcher logged
 * it (see windows.ts). It comes back to ok once the page answers again.
 */
export function checkRenderer(input: {
  now: number;
  /** Renderer lines of the log, oldest first. */
  lines: { at: string; level: string; text: string }[];
  windowMs?: number;
}): CheckOutcome {
  const windowMs = input.windowMs ?? 10 * 60_000;
  const recent = input.lines.filter((line) => input.now - Date.parse(line.at) < windowMs);
  const last = recent.at(-1);
  const frozen = !!last && /não responde/.test(last.text);
  const crashes = recent.filter((line) => /processo da interface terminou/.test(line.text));
  const incidents: IncidentDraft[] = [];
  if (frozen)
    incidents.push({
      key: 'renderer:frozen',
      severity: 'critical',
      component: 'renderer',
      title: 'Uma janela do Hive não está respondendo',
      detail: `${last!.text} As missões continuam no processo principal.`,
      action: 'reload-windows',
    });
  if (crashes.length)
    incidents.push({
      key: 'renderer:crash',
      severity: 'warning',
      component: 'renderer',
      title: `A interface caiu ${crashes.length} vez(es) nos últimos ${minutes(windowMs)} min`,
      detail: crashes.at(-1)!.text,
    });
  return {
    status: frozen ? 'fail' : crashes.length ? 'warn' : 'ok',
    detail: frozen
      ? 'Uma janela não está respondendo.'
      : crashes.length
        ? 'A interface caiu e voltou recentemente.'
        : 'As janelas estão respondendo.',
    incidents,
  };
}

/** CPU, memory and disk of Hive and the computer. */
export function checkResources(usage: ResourceUsage): CheckOutcome {
  const incidents: IncidentDraft[] = [];
  const freeShare = usage.systemTotalMb ? usage.systemFreeMb / usage.systemTotalMb : 1;
  if (freeShare < 0.05)
    incidents.push({
      key: 'resources:memory',
      severity: 'critical',
      component: 'resources',
      title: 'O computador está quase sem memória',
      detail: `Livre: ${usage.systemFreeMb} MB de ${usage.systemTotalMb} MB. O Hive usa ${usage.memoryMb} MB.`,
    });
  if (usage.memoryMb > 3_000)
    incidents.push({
      key: 'resources:hive-memory',
      severity: 'warning',
      component: 'resources',
      title: `O Hive está usando ${usage.memoryMb} MB de memória`,
      detail: 'Fechar janelas do Workspace ou terminais parados libera memória.',
      action: 'reload-windows',
    });
  if (usage.diskFreeMb !== null && usage.diskFreeMb < 2_000)
    incidents.push({
      key: 'resources:disk',
      severity: usage.diskFreeMb < 500 ? 'critical' : 'warning',
      component: 'resources',
      title: `Pouco espaço em disco: ${usage.diskFreeMb} MB livres`,
      detail:
        'Cada agente trabalha numa cópia do projeto; sem espaço, as tarefas falham ao criá-las.',
      action: 'prune-worktrees',
    });
  return {
    status: incidents.some((item) => item.severity === 'critical')
      ? 'fail'
      : incidents.length
        ? 'warn'
        : 'ok',
    detail: `Hive: ${Math.round(usage.cpuPercent)}% de CPU e ${usage.memoryMb} MB de memória. Livre no computador: ${usage.systemFreeMb} MB${usage.diskFreeMb !== null ? `; em disco: ${usage.diskFreeMb} MB` : ''}.`,
    incidents,
  };
}
