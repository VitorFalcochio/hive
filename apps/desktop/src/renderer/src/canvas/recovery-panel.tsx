import { useState } from 'react';
import { ChevronDown, ChevronUp, GitBranch, RefreshCw, Route, Square, Check } from 'lucide-react';
import type { CanvasSnapshot, NexusAutopilotRecovery } from '@hive/core';
import { Mascot } from '../mascot';
import { useTask } from '../ui';

const stateLabel: Partial<Record<NexusAutopilotRecovery['state'], string>> = {
  proposing: 'Procurando outro caminho',
  proposed: 'Aguardando aprovação',
  applying: 'Aplicando',
  exhausted: 'Precisa de você',
  failed: 'Sem sugestão',
};

export const strategyLabel: Record<
  NonNullable<NexusAutopilotRecovery['draft']>['strategy'],
  string
> = {
  replace: 'Refazer de outro jeito',
  split: 'Dividir em passos menores',
  reassign: 'Outro agente ou modelo',
  skip: 'Seguir sem a tarefa',
};

/**
 * Adaptive replanning (Autopilot 2.0): a task failed for good, the tasks that depend on it are
 * waiting and the Queen proposes another path. Nothing changes until someone decides here.
 */
export function RecoveryPanel({ snapshot }: { snapshot: CanvasSnapshot }) {
  const [collapsed, setCollapsed] = useState(false);
  const recoveries = snapshot.recoveries;
  if (!recoveries.length) return null;
  const waiting = recoveries.filter((item) => item.state === 'proposed').length;
  return (
    <section className="nc-recovery" aria-label="Replanejamento adaptativo">
      <header>
        <Route size={14} />
        <strong>Replanejamento</strong>
        <span className="nc-recovery-count">
          {waiting ? `${waiting} aguardando aprovação` : `${recoveries.length} ramo(s) em espera`}
        </span>
        <button
          className="icon-button"
          aria-label={collapsed ? 'Mostrar replanejamento' : 'Recolher replanejamento'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>
      {!collapsed &&
        recoveries.map((recovery) => (
          <RecoveryCard key={recovery.id} recovery={recovery} snapshot={snapshot} />
        ))}
    </section>
  );
}

function RecoveryCard({
  recovery,
  snapshot,
}: {
  recovery: NexusAutopilotRecovery;
  snapshot: CanvasSnapshot;
}) {
  const action = useTask();
  const runId = snapshot.detail.run.id;
  const draft = recovery.draft;
  const agentName = (key: string | null) => {
    if (!key) return 'Delegação automática';
    const agent = draft?.agents.find((item) => item.key === key);
    if (!agent) return key;
    if (agent.source === 'new') return `${agent.name} (novo)`;
    return snapshot.workers.find((worker) => worker.id === agent.workerId)?.name ?? key;
  };
  const busy = action.running || recovery.state === 'applying';
  const invoke = (
    channel:
      | 'canvas.autopilot.recovery.apply'
      | 'canvas.autopilot.recovery.dismiss'
      | 'canvas.autopilot.recovery.retry',
  ) =>
    void action.run(async () => {
      await window.hive.invoke(channel, { runId, recoveryId: recovery.id });
    });
  const dismiss = () => {
    const waiting = recovery.dependents.length
      ? ` As tarefas que esperam (${recovery.dependents.join(', ')}) serão canceladas.`
      : '';
    if (window.confirm(`Encerrar este ramo sem replanejar?${waiting}`))
      invoke('canvas.autopilot.recovery.dismiss');
  };

  return (
    <article className={`nc-recovery-card ${recovery.state}`}>
      <div className="nc-recovery-title">
        <span className={`nc-recovery-state ${recovery.state}`}>
          {stateLabel[recovery.state] ?? recovery.state}
        </span>
        <strong title={recovery.taskKey}>{recovery.taskTitle}</strong>
        {recovery.attempt > 1 && (
          <small title={`Cadeia de ${recovery.rootTaskKey}`}>
            replanejamento {recovery.attempt}
          </small>
        )}
      </div>
      <p className="nc-recovery-error" title={recovery.error}>
        {recovery.error}
      </p>
      {recovery.dependents.length > 0 && (
        <p className="nc-recovery-meta">
          <GitBranch size={11} /> Aguardando: {recovery.dependents.join(', ')}
        </p>
      )}

      {recovery.state === 'proposing' && (
        <div className="nc-recovery-status" role="status">
          <Mascot size={22} mood="working" />
          <span>A Queen está analisando o erro e montando outro caminho…</span>
        </div>
      )}

      {draft && (recovery.state === 'proposed' || recovery.state === 'applying') && (
        <div className="nc-recovery-proposal">
          <p>
            <b>Diagnóstico:</b> {draft.diagnosis}
          </p>
          <p>
            <b>{strategyLabel[draft.strategy]}:</b> {draft.rationale}
          </p>
          {draft.tasks.length > 0 && (
            <ol className="nc-recovery-tasks">
              {draft.tasks.map((task) => (
                <li key={task.key}>
                  <span className="nc-recovery-key">{task.key}</span>
                  <span>
                    <strong>{task.title}</strong>
                    <small>
                      {agentName(task.workerKey)}
                      {task.dependsOn.length > 0 && ` · depois de ${task.dependsOn.join(', ')}`}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {recovery.dependents.length > 0 && (
            <p className="nc-recovery-meta">
              {draft.strategy === 'skip'
                ? `${recovery.dependents.join(', ')} seguem sem a tarefa que falhou.`
                : `${recovery.dependents.join(', ')} passam a esperar ${draft.resumeFrom.join(', ')}.`}
            </p>
          )}
          {draft.warnings.length > 0 && (
            <ul className="nc-recovery-warnings">
              {draft.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ))}
            </ul>
          )}
          {recovery.usage && (
            <p className="nc-recovery-meta">
              {recovery.queen?.name} ·{' '}
              {recovery.usage.promptTokens + recovery.usage.completionTokens} tokens
            </p>
          )}
        </div>
      )}

      {recovery.reason && recovery.state !== 'proposed' && (
        <p className="nc-recovery-reason">{recovery.reason}</p>
      )}
      {recovery.state === 'exhausted' && (
        <p className="nc-recovery-meta">
          Repita a tarefa com o mesmo plano ou encerre o ramo. O Hive não propõe de novo para não
          entrar em ciclo.
        </p>
      )}

      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}

      <div className="nc-recovery-actions">
        {recovery.state === 'proposed' && (
          <button
            className="nc-small"
            disabled={busy}
            onClick={() => invoke('canvas.autopilot.recovery.apply')}
          >
            <Check size={12} /> Aprovar e continuar
          </button>
        )}
        {(recovery.state === 'proposed' || recovery.state === 'failed') && (
          <button
            className="secondary nc-small"
            disabled={busy}
            onClick={() => invoke('canvas.autopilot.recovery.retry')}
          >
            <RefreshCw size={12} />{' '}
            {recovery.state === 'failed' ? 'Tentar sugerir de novo' : 'Outra sugestão'}
          </button>
        )}
        {recovery.state === 'exhausted' && (
          <button
            className="secondary nc-small"
            disabled={busy}
            onClick={() =>
              void action.run(async () => {
                await window.hive.invoke('task.retry', recovery.taskId);
              })
            }
          >
            <RefreshCw size={12} /> Repetir tarefa
          </button>
        )}
        {recovery.state !== 'applying' && (
          <button className="secondary nc-small danger" disabled={busy} onClick={dismiss}>
            <Square size={10} /> Encerrar ramo
          </button>
        )}
      </div>
    </article>
  );
}
