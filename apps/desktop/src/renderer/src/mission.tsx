import { useEffect, useState } from 'react';
import {
  Check,
  FileDiff,
  History,
  Play,
  RotateCcw,
  ShieldQuestion,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type { AgentEvent, Approval, Task, TaskStatus, WorkerState } from '@hive/core';
import { useHive } from './context';
import { Dot, Empty, PageHeader, runTone, statusLabels, useTask } from './ui';

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
const workerLabels: Partial<Record<WorkerState, string>> = {
  planning: 'Preparando a worktree',
  thinking: 'Pensando',
  coding: 'Programando',
  testing: 'Testando',
  reviewing: 'Revisando',
  waiting_approval: 'Esperando sua aprovação',
};
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
function useActivity(runId: string) {
  const { onEvent } = useHive();
  const [latest, setLatest] = useState<Record<string, string>>({});
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
        for (const event of events) if (keep(event)) next[event.taskId!] = event.message;
        setLatest(next);
      })
      .catch(() => undefined);
    const off = onEvent((event) => {
      if (event.runId === runId && keep(event))
        setLatest((current) => ({ ...current, [event.taskId!]: event.message }));
    });
    return () => {
      alive = false;
      off();
    };
  }, [runId, onEvent]);
  return latest;
}

export function MissionPage() {
  const { detail, setDetail, workers, refresh } = useHive();
  const plan = useTask();
  const action = useTask();
  const activity = useActivity(detail?.run.id ?? '');
  if (!detail) return null;
  const { run, tasks } = detail;
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
      {pendingApprovals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onDone={reload} />
      ))}
      {run.status === 'review' && (
        <p className="hint">
          Execução terminada. Revise as alterações de cada tarefa e aplique as que quiser na branch{' '}
          <code>{run.baseBranch}</code>. Nada foi alterado no seu projeto ainda.
        </p>
      )}
      {!running && run.planNotes && run.status === 'awaiting_plan_approval' && (
        <p className="hint">{run.planNotes}</p>
      )}

      {tasks.length ? (
        <div className="task-list">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              tasks={tasks}
              activity={activity[task.id]}
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
    <section className="card approval-card" role="alert">
      <div className="approval-head">
        <ShieldQuestion size={16} />
        <strong>{approval.title}</strong>
      </div>
      <pre className="command">{approval.detail}</pre>
      {task.error && <p className="form-error">{task.error}</p>}
      <div className="actions">
        <button className="secondary" disabled={task.running} onClick={() => answer(false)}>
          <X size={14} /> Negar
        </button>
        <button
          className="secondary"
          disabled={task.running}
          title="Este agente poderá rodar exatamente este comando sem perguntar de novo"
          onClick={() => answer(true, true)}
        >
          Sempre permitir
        </button>
        <button disabled={task.running} onClick={() => answer(true)}>
          <Check size={14} /> Permitir
        </button>
      </div>
    </section>
  );
}

function TaskCard({
  task,
  tasks,
  activity,
  onChange,
}: {
  task: Task;
  tasks: Task[];
  activity: string | undefined;
  onChange: () => Promise<void>;
}) {
  const { workers, openModal } = useHive();
  const action = useTask();
  const worker = workers.find((item) => item.id === task.workerId);
  const live = task.status === 'running' || task.status === 'waiting_approval';
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

  return (
    <article className={live ? 'card task-card live' : 'card task-card'}>
      <div className="card-heading">
        <div className="task-title">
          <Dot tone={taskTone(task.status)} />
          <h3>{task.title}</h3>
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
        {worker?.name ?? 'Agente automático'}
        {task.dependsOn.length > 0 && ` · depende de ${task.dependsOn.join(', ')}`}
        {task.attempt > 1 && ` · tentativa ${task.attempt}`}
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
          {result.summary && <p className="summary">{result.summary}</p>}
          <small>
            {result.filesChanged.length
              ? `${result.filesChanged.length} arquivo(s) · +${result.insertions} −${result.deletions}`
              : 'Nenhum arquivo alterado'}
            {result.commands.length > 0 && ` · ${result.commands.length} comando(s)`}
            {` · ${(result.usage.promptTokens + result.usage.completionTokens).toLocaleString('pt-BR')} tokens`}
          </small>
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
            <FileDiff size={14} /> Ver alterações
          </button>
        )}
        <span className="spacer" />
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
