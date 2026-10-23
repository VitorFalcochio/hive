import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Coins,
  FileDiff,
  FileText,
  History,
  Play,
  RotateCcw,
  ShieldQuestion,
  Sparkles,
  Square,
  SquareTerminal,
  Timer,
  X,
} from 'lucide-react';
import {
  soldierPresets,
  soldierRoleSchema,
  type AgentEvent,
  type Approval,
  type SoldierRole,
  type Task,
  type TaskStatus,
  type WorkerState,
} from '@hive/core';
import { useHive } from './context';
import { Dot, Empty, PageHeader, runTone, statusLabels, useTask } from './ui';
import { applyCandidate, discardCandidates, isCandidate, summarizeCandidate } from './comparison';
import { useShift } from './shift';
import { HoneyJar } from './honey';
import { AgentBee, SoldierBee } from './mascot';
import { Markdown } from './markdown';

export const taskLabels: Record<TaskStatus, string> = {
  pending: 'Na fila',
  blocked: 'Bloqueada',
  running: 'Em execução',
  waiting_approval: 'Aguardando você',
  completed: 'Pronta para revisão',
  failed: 'Falhou',
  cancelled: 'Cancelada',
  approved: 'Aplicada',
  rejected: 'Descartada',
};
/** A task waiting on the user or the provider: its bee rests instead of flapping. */
export const isWaiting = (task: Pick<Task, 'status' | 'workerState'>) =>
  task.status === 'waiting_approval' ||
  task.workerState === 'waiting_approval' ||
  task.workerState === 'waiting_provider';

const workerLabels: Partial<Record<WorkerState, string>> = {
  planning: 'Preparando a worktree',
  thinking: 'Pensando',
  coding: 'Programando',
  testing: 'Testando',
  reviewing: 'Revisando',
  waiting_approval: 'Esperando sua aprovação',
  waiting_provider: 'Aguardando o provedor',
};
const activeTaskStatuses = new Set<TaskStatus>([
  'pending',
  'blocked',
  'running',
  'waiting_approval',
]);
const taskTone = (status: TaskStatus) =>
  status === 'running'
    ? 'busy'
    : status === 'waiting_approval'
      ? 'busy'
      : status === 'completed' || status === 'approved'
        ? 'ok'
        : status === 'failed'
          ? 'error'
          : 'idle';

/** Latest user-meaningful message per task, from the live event stream. */
/** Who is at work in each task: the captain's soldiers between their start and end events. */
export type Squads = Record<string, SoldierRole[]>;

export function trackSquad(squads: Squads, event: AgentEvent): Squads {
  const taskId = event.taskId!;
  const current = squads[taskId] ?? [];
  // A new session of the task starts with no soldier out.
  if (event.type === 'session.started')
    return current.length ? { ...squads, [taskId]: [] } : squads;
  const role = soldierRoleSchema.safeParse(event.data?.soldier);
  const phase = event.data?.phase;
  if (!role.success || (phase !== 'start' && phase !== 'end')) return squads;
  const others = current.filter((soldier) => soldier !== role.data);
  return { ...squads, [taskId]: phase === 'start' ? [...others, role.data] : others };
}

function useActivity(runId: string) {
  const { onEvent } = useHive();
  const [latest, setLatest] = useState<Record<string, string>>({});
  const [squads, setSquads] = useState<Squads>({});
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const keep = (event: AgentEvent) =>
      !!event.taskId && event.level !== 'debug' && event.type !== 'model.request';
    void window.hive
      .invoke('events.query', { runId, levels: ['info', 'warn', 'error'], limit: 400 })
      .then((events) => {
        if (!alive) return;
        const next: Record<string, string> = {};
        let squadsNow: Squads = {};
        for (const event of events) {
          if (!keep(event)) continue;
          next[event.taskId!] = event.message;
          squadsNow = trackSquad(squadsNow, event);
        }
        setLatest(next);
        setSquads(squadsNow);
      })
      .catch(() => undefined);
    const off = onEvent((event) => {
      if (event.runId !== runId || !keep(event)) return;
      setLatest((current) => ({ ...current, [event.taskId!]: event.message }));
      setSquads((current) => trackSquad(current, event));
    });
    return () => {
      alive = false;
      off();
    };
  }, [runId, onEvent]);
  return { latest, squads };
}

export function MissionPage() {
  const { detail, setDetail, workers, refresh } = useHive();
  const plan = useTask();
  const action = useTask();
  const { latest: activity, squads } = useActivity(detail?.run.id ?? '');
  const [shift, setShift] = useShift();
  if (!detail) return null;
  const { run, tasks } = detail;
  const candidates = tasks.filter(isCandidate);
  const queen = workers.find((worker) => worker.role === 'queen');
  const planning = plan.running || run.status === 'planning';
  const running = run.status === 'running';
  const pendingApprovals = detail.approvals.filter((item) => item.status === 'pending');
  const canExecute =
    tasks.length > 0 &&
    !running &&
    !planning &&
    ['awaiting_plan_approval', 'failed', 'cancelled', 'review'].includes(run.status) &&
    tasks.some((task) => ['pending', 'blocked', 'failed', 'cancelled'].includes(task.status));
  const reload = async () => {
    setDetail(await window.hive.invoke('run.get', run.id));
    await refresh();
  };
  const queued = shift?.queue.some((item) => item.runId === run.id) ?? false;
  const canQueue = queued || (!running && !planning && run.status !== 'completed');

  function generate() {
    void plan.run(async () => {
      if (!queen?.providerId || !queen.modelId)
        throw new Error('Configure o provedor e o modelo da Queen na aba Agentes.');
      try {
        await window.hive.invoke('run.plan', { runId: run.id, queenWorkerId: queen.id });
      } finally {
        await reload();
      }
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Missão"
        title={detail.mission.title}
        description={detail.mission.objective}
      >
        {running ? (
          <button
            className="secondary"
            disabled={action.running}
            onClick={() =>
              void action.run(async () => {
                await window.hive.invoke('run.cancel', run.id);
                await reload();
              })
            }
          >
            <Square size={13} /> Cancelar execução
          </button>
        ) : (
          <button
            className={tasks.length ? 'secondary' : undefined}
            disabled={planning}
            onClick={generate}
          >
            <Sparkles size={15} />
            {planning
              ? 'A Queen está planejando…'
              : tasks.length
                ? 'Novo plano'
                : 'Gerar plano com a Queen'}
          </button>
        )}
        {canExecute && (
          <button
            disabled={action.running}
            onClick={() =>
              void action.run(async () => {
                setDetail(await window.hive.invoke('run.start', run.id));
                await refresh();
              })
            }
          >
            <Play size={14} />
            {run.status === 'awaiting_plan_approval' ? 'Executar plano' : 'Retomar execução'}
          </button>
        )}
        {canQueue && (
          <button
            className="secondary"
            disabled={action.running}
            title={
              queued
                ? 'Tirar esta missão da fila do Modo Turno'
                : 'O Modo Turno planeja e executa esta missão sem esperar por você'
            }
            onClick={() =>
              void action.run(async () => {
                setShift(
                  await window.hive.invoke(
                    queued ? 'autopilot.dequeue' : 'autopilot.enqueue',
                    run.id,
                  ),
                );
                await reload();
              })
            }
          >
            {queued ? <X size={14} /> : <Timer size={14} />}
            {queued ? 'Tirar do turno' : 'Colocar no turno'}
          </button>
        )}
      </PageHeader>

      <div className="meta-row">
        <span>
          <Dot tone={planning ? 'busy' : runTone(run.status)} />{' '}
          {planning ? 'Planejando' : statusLabels[run.status]}
        </span>
        <span>
          Base <code>{run.baseBranch}</code>
        </span>
        <span>
          Queen <code>{queen?.modelId ?? 'sem modelo'}</code>
        </span>
        {tasks.length > 0 && (
          <span>
            {tasks.filter((task) => task.status === 'approved').length}/{tasks.length} aplicadas
          </span>
        )}
      </div>

      {(plan.error || action.error || (!planning && run.error)) && (
        <p role="alert" className="form-error block">
          {plan.error || action.error || run.error}
        </p>
      )}
      {pendingApprovals.length > 0 && (
        <section className="approval-list" aria-label="Comandos aguardando aprovação">
          {pendingApprovals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} onDone={reload} />
          ))}
          <ApprovalSettingsHint />
        </section>
      )}
      {run.status === 'review' && (
        <p className="hint">
          Execução terminada. Revise as alterações de cada tarefa e aplique as que quiser na branch{' '}
          <code>{run.baseBranch}</code>. Nada foi alterado no seu projeto ainda.
        </p>
      )}
      {!running && run.planNotes && run.status === 'awaiting_plan_approval' && (
        <p className="hint">{run.planNotes}</p>
      )}

      {candidates.length > 0 && <ComparisonPanel candidates={candidates} onDone={reload} />}
      {tasks.length ? (
        <div className="task-list">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              tasks={tasks}
              activity={activity[task.id]}
              soldiers={squads[task.id] ?? []}
              onChange={reload}
            />
          ))}
        </div>
      ) : (
        !planning && (
          <section className="card">
            <Empty>Nenhum plano ainda. Clique em “Gerar plano com a Queen”.</Empty>
          </section>
        )
      )}
    </>
  );
}

function ApprovalCard({ approval, onDone }: { approval: Approval; onDone: () => Promise<void> }) {
  const { workers } = useHive();
  const worker = workers.find((item) => item.id === approval.workerId);
  const task = useTask();
  const answer = (approve: boolean, remember = false) =>
    void task.run(async () => {
      await window.hive.invoke('approval.resolve', {
        approvalId: approval.id,
        approve,
        remember,
      });
      await onDone();
    });
  return (
    <article className="approval-card" role="alert">
      <div className="approval-head">
        {worker ? <AgentBee worker={worker} size={18} mood="idle" /> : <ShieldQuestion size={15} />}
        <span className="approval-title">
          {worker && <strong>{worker.name} · </strong>}
          {approval.title}
        </span>
        <div className="approval-actions">
          <button className="ghost" disabled={task.running} onClick={() => answer(false)}>
            <X size={14} /> Negar
          </button>
          <button
            className="ghost"
            disabled={task.running}
            title="Este agente poderá rodar exatamente este comando sem perguntar de novo"
            onClick={() => answer(true, true)}
          >
            Sempre permitir
          </button>
          <button className="approve" disabled={task.running} onClick={() => answer(true)}>
            <Check size={14} /> Permitir
          </button>
        </div>
      </div>
      <pre className="command">
        <span aria-hidden="true">$ </span>
        {approval.detail}
      </pre>
      {task.error && <p className="form-error">{task.error}</p>}
    </article>
  );
}

/** One line under pending approvals: where to stop being asked about harmless commands. */
function ApprovalSettingsHint() {
  const { go } = useHive();
  return (
    <p className="approval-hint">
      Cansou de aprovar comandos de leitura?{' '}
      <button className="link" onClick={() => go('settings')}>
        Configurar aprovação automática
      </button>
    </p>
  );
}

function TaskCard({
  task,
  tasks,
  activity,
  soldiers,
  onChange,
}: {
  task: Task;
  tasks: Task[];
  activity: string | undefined;
  /** Soldiers the captain has out right now, in the order she called them. */
  soldiers: SoldierRole[];
  onChange: () => Promise<void>;
}) {
  const { workers, openModal } = useHive();
  const action = useTask();
  const worker = workers.find((item) => item.id === task.workerId);
  const live = task.status === 'running' || task.status === 'waiting_approval';
  const out = live ? soldiers : [];
  const call = (work: () => Promise<unknown>) =>
    void action.run(async () => {
      try {
        await work();
      } finally {
        await onChange();
      }
    });
  const waitingOn = task.dependsOn.filter(
    (key) =>
      !['completed', 'approved'].includes(tasks.find((item) => item.key === key)?.status ?? ''),
  );
  const result = task.result;
  // Honey is given before a task starts (or before it is tried again), never mid-run.
  const waiting = task.status === 'pending' || task.status === 'blocked';
  const retryable = ['failed', 'cancelled', 'rejected'].includes(task.status);
  const honey = (boosted: boolean) => window.hive.invoke('task.boost', { id: task.id, boosted });

  return (
    <article className={`card task-card${live ? ' live' : ''}${task.boosted ? ' boosted' : ''}`}>
      <div className="card-heading">
        <div className="task-title">
          <Dot tone={taskTone(task.status)} />
          <h3>{task.title}</h3>
          {task.boosted && (
            <span className="honey-mark">
              <HoneyJar
                size={14}
                label="Com mel: fura a fila, limites dobrados e esquadrão completo"
              />
            </span>
          )}
        </div>
        <span className="badge">{taskLabels[task.status]}</span>
      </div>
      <p>{task.description}</p>
      {task.status === 'pending' || task.status === 'blocked' ? (
        <ul>
          {task.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      ) : null}
      <small className="task-meta">
        {worker && (
          <span className={task.boosted ? 'honey-glow' : undefined}>
            <AgentBee
              worker={worker}
              size={14}
              // While her soldiers fly, the captain waits for their reports.
              mood={live && !isWaiting(task) && !out.length ? 'working' : 'still'}
            />
          </span>
        )}
        {worker?.name ?? 'Agente automático'}
        {worker && out.length > 0 && (
          <span
            className="task-squad"
            aria-label={`Trabalhando: ${out.map((role) => soldierPresets[role].label).join(', ')}`}
          >
            {out.map((role) => (
              <SoldierBee key={role} captain={worker} role={role} working size={13} />
            ))}
          </span>
        )}
        {task.dependsOn.length > 0 && ` · depende de ${task.dependsOn.join(', ')}`}
        {task.revision
          ? ` · revisão ${task.revision.round}`
          : task.attempt > 1 && ` · tentativa ${task.attempt}`}
        {task.status === 'pending' && waitingOn.length > 0 && ' · aguardando dependências'}
      </small>

      {live && (
        <p className="live-line">
          <span className="progress">{workerLabels[task.workerState] ?? 'Trabalhando'}</span>
          {activity && <span className="truncate">{activity}</span>}
        </p>
      )}
      {result && !live && (
        <div className="task-result">
          {result.summary && <ResultSummary text={result.summary} />}
          <div className="result-stats">
            <span className="stat">
              <FileText size={13} />
              {result.filesChanged.length
                ? `${result.filesChanged.length} ${result.filesChanged.length === 1 ? 'arquivo' : 'arquivos'}`
                : 'Nenhum arquivo alterado'}
            </span>
            {result.filesChanged.length > 0 && (
              <span className="stat mono">
                <span className="success-text">+{result.insertions}</span>
                <span className="error-text">−{result.deletions}</span>
              </span>
            )}
            {result.commands.length > 0 && (
              <span className="stat">
                <SquareTerminal size={13} />
                {result.commands.length} {result.commands.length === 1 ? 'comando' : 'comandos'}
              </span>
            )}
            <span className="stat">
              <Coins size={13} />
              {compactNumber(result.usage.promptTokens + result.usage.completionTokens)} tokens
            </span>
          </div>
        </div>
      )}
      {task.error && !live && <p className="form-error">{task.error}</p>}
      {action.error && <p className="form-error">{action.error}</p>}

      <div className="actions">
        {task.status !== 'pending' && (
          <button className="ghost" onClick={() => openModal({ kind: 'activity', task })}>
            <History size={14} /> Atividade
          </button>
        )}
        {result?.commit && (
          <button className="ghost" onClick={() => openModal({ kind: 'diff', task })}>
            <FileDiff size={14} />{' '}
            {task.status === 'completed' ? 'Revisar e comentar' : 'Ver alterações'}
          </button>
        )}
        <span className="spacer" />
        {waiting && (
          <button
            className={task.boosted ? 'secondary honey-button on' : 'ghost honey-button'}
            disabled={action.running}
            aria-pressed={!!task.boosted}
            title={
              task.boosted
                ? 'Tirar o mel desta tarefa'
                : 'Dar mel: fura a fila, dobra os limites e chama o esquadrão completo'
            }
            onClick={() => call(() => honey(!task.boosted))}
          >
            <HoneyJar size={13} /> {task.boosted ? 'Com mel' : 'Mel'}
          </button>
        )}
        {retryable && !task.boosted && (
          <button
            className="ghost honey-button"
            disabled={action.running}
            title="Tenta de novo furando a fila, com limites dobrados e o esquadrão completo"
            onClick={() =>
              call(async () => {
                await honey(true);
                await window.hive.invoke('task.retry', task.id);
              })
            }
          >
            <HoneyJar size={13} /> Tentar com mel
          </button>
        )}
        {live && (
          <button
            className="secondary"
            disabled={action.running}
            onClick={() => call(() => window.hive.invoke('task.cancel', task.id))}
          >
            Cancelar
          </button>
        )}
        {['failed', 'cancelled', 'rejected'].includes(task.status) && (
          <button
            className="secondary"
            disabled={action.running}
            onClick={() => call(() => window.hive.invoke('task.retry', task.id))}
          >
            <RotateCcw size={13} /> Tentar novamente
          </button>
        )}
        {task.status === 'completed' && (
          <>
            <button
              className="secondary"
              disabled={action.running}
              onClick={() => {
                if (window.confirm(`Descartar as alterações de "${task.title}"?`))
                  call(() => window.hive.invoke('task.reject', task.id));
              }}
            >
              Descartar
            </button>
            <button
              disabled={action.running}
              onClick={() => call(() => window.hive.invoke('task.approve', task.id))}
            >
              <Check size={14} /> {result?.commit ? 'Aplicar no projeto' : 'Marcar como feita'}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/** Tokens in the short form the result line has room for: 380,8 mil, 1,2 mi. */
function compactNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

const candidateTones: Partial<Record<TaskStatus, 'busy' | 'ok' | 'error' | 'idle'>> = {
  running: 'busy',
  waiting_approval: 'busy',
  completed: 'ok',
  approved: 'ok',
  failed: 'error',
};

/**
 * An agent's final summary, drawn from its Markdown. Long ones open folded, with a fade and a
 * button to read the rest.
 */
function ResultSummary({ text, compact = false }: { text: string; compact?: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && !open) setLong(element.scrollHeight > element.clientHeight + 4);
  }, [text, open]);
  return (
    <div
      className={`result-summary${compact ? ' compact' : ''}${open ? ' open' : ''}${long && !open ? ' folded' : ''}`}
    >
      <div ref={body} className="result-summary-body">
        <Markdown source={text} />
      </div>
      {(long || open) && (
        <button className="link result-summary-toggle" onClick={() => setOpen(!open)}>
          <ChevronDown size={13} />
          {open ? 'Mostrar menos' : 'Ler resumo completo'}
        </button>
      )}
    </div>
  );
}

function ComparisonPanel({
  candidates,
  onDone,
}: {
  candidates: Task[];
  onDone: () => Promise<void>;
}) {
  const { workers } = useHive();
  const action = useTask();
  const applied = candidates.find((task) => task.status === 'approved');
  const open = candidates.some((task) => !['approved', 'rejected'].includes(task.status));
  const settled = candidates.every((task) => !activeTaskStatuses.has(task.status));
  const run = (work: () => Promise<void>) =>
    void action.run(async () => {
      try {
        await work();
      } finally {
        await onDone();
      }
    });

  return (
    <section className="card comparison">
      <header className="comparison-header">
        <div>
          <strong>Comparação de agentes</strong>
          <small>
            {applied
              ? `Aplicada a entrega de ${workers.find((item) => item.id === applied.workerId)?.name ?? applied.title}.`
              : settled
                ? 'Escolha a melhor entrega para aplicar no projeto.'
                : 'Os agentes estão trabalhando nas próprias worktrees.'}
          </small>
        </div>
        {!applied && open && (
          <button
            className="secondary"
            disabled={action.running}
            onClick={() => run(() => discardCandidates(candidates))}
          >
            <X size={13} /> Descartar todas
          </button>
        )}
      </header>
      <div className="comparison-grid">
        {candidates.map((task) => {
          const worker = workers.find((item) => item.id === task.workerId);
          const summary = summarizeCandidate(task);
          const working = activeTaskStatuses.has(task.status);
          const tone = candidateTones[task.status] ?? 'idle';
          return (
            <article
              key={task.id}
              className={`candidate${task.status === 'approved' ? ' chosen' : ''}${task.status === 'rejected' ? ' dropped' : ''}`}
            >
              <header>
                {worker && (
                  <AgentBee worker={worker} size={26} mood={working ? 'working' : 'still'} />
                )}
                <div className="candidate-who">
                  <strong>{worker?.name ?? task.title}</strong>
                  {worker?.modelId && <small className="mono">{worker.modelId}</small>}
                </div>
                <span className={`candidate-status tone-${tone}`}>
                  {task.status === 'approved' && <Check size={12} />}
                  {taskLabels[task.status]}
                </span>
              </header>
              {summary ? (
                <dl className="candidate-metrics">
                  <div>
                    <dt>Arquivos</dt>
                    <dd>{summary.filesChanged}</dd>
                  </div>
                  <div>
                    <dt>Linhas</dt>
                    <dd>
                      <span className="success-text">+{summary.insertions}</span>
                      <span className="error-text">−{summary.deletions}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Comandos</dt>
                    <dd
                      className={summary.commandsPassed < summary.commandsRun ? 'error-text' : ''}
                    >
                      {summary.commandsRun
                        ? `${summary.commandsPassed}/${summary.commandsRun}`
                        : '—'}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="candidate-waiting">
                  {working ? 'Trabalhando na própria worktree…' : 'Sem resultado.'}
                </p>
              )}
              {task.result?.summary && <ResultSummary text={task.result.summary} compact />}
              {task.error && <p className="error-text candidate-error">{task.error}</p>}
              {!applied && task.status === 'completed' && (
                <button
                  disabled={action.running}
                  onClick={() => run(() => applyCandidate(task, candidates))}
                >
                  <Check size={13} /> Aplicar este
                </button>
              )}
            </article>
          );
        })}
      </div>
      {action.error && (
        <p role="alert" className="form-error block">
          {action.error}
        </p>
      )}
    </section>
  );
}
