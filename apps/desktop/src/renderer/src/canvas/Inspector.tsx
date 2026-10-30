import { useMemo, type ReactNode } from 'react';
import {
  Check,
  ExternalLink,
  FolderGit2,
  GitBranch,
  RotateCcw,
  ShieldQuestion,
  Square,
  X,
} from 'lucide-react';
import { formatCost, looksLikeTestCommand, type AgentEvent, type Task } from '@hive/core';
import { AgentBee } from '../mascot';
import { HoneyJar } from '../honey';
import { Markdown } from '../markdown';
import { statusLabels, useTask } from '../ui';
import type { CanvasView } from './nodes';
import {
  compactNumber,
  formatDuration,
  isBlocked,
  isLive,
  roleLabel,
  taskElapsedMs,
  taskStatusLabels,
  taskTone,
  workerStateLabels,
  type EdgeKind,
  type GraphEdge,
} from './model';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

const edgeMeaning: Record<EdgeKind, { title: string; text: string }> = {
  aggregation: {
    title: 'Agregação de resultados',
    text: 'Conexão informativa com o Resultado Vivo. Não cria dependência nem bloqueia tarefas.',
  },
  dependency: {
    title: 'Dependência',
    text: 'A tarefa de destino só começa depois que a de origem termina com sucesso, e parte do resultado dela.',
  },
  assignment: {
    title: 'Atribuição',
    text: 'O agente de origem é quem executa a tarefa de destino, na própria worktree.',
  },
  coordination: {
    title: 'Coordenação',
    text: 'A Queen planejou este trabalho e o distribuiu no plano da missão.',
  },
  memory: {
    title: 'Acesso ao Cortex',
    text: 'O agente acessa a memória compartilhada do projeto conforme as permissões da conexão. Sem esta linha, ele não lê nem propõe nada. Botão direito: permissões ou desconectar.',
  },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="nc-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="nc-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const unavailable = <span className="muted-text">indisponível</span>;

function EventLines({ events }: { events: AgentEvent[] }) {
  if (!events.length) return <p className="muted-text">Nenhum registro ainda.</p>;
  return (
    <ol className="nc-mini-log">
      {events.map((event) => (
        <li key={event.id} className={`level-${event.level}`}>
          <time>{new Date(event.ts).toLocaleTimeString('pt-BR')}</time>
          <span>{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

const recent = (events: AgentEvent[], keep: (event: AgentEvent) => boolean, count = 14) => {
  const found: AgentEvent[] = [];
  for (let index = events.length - 1; index >= 0 && found.length < count; index--) {
    const event = events[index]!;
    if (event.level !== 'debug' && event.type !== 'model.request' && keep(event)) found.push(event);
  }
  return found.reverse();
};

export function Inspector({
  view,
  selection,
  edges,
  events,
  now,
  onSelect,
}: {
  view: CanvasView;
  selection: Selection;
  edges: GraphEdge[];
  events: AgentEvent[];
  now: number;
  onSelect: (selection: Selection) => void;
}) {
  if (selection?.kind === 'edge') {
    const edge = edges.find((item) => item.id === selection.id);
    if (!edge) return <RunOverview view={view} />;
    const meaning = edgeMeaning[edge.kind];
    return (
      <div className="nc-inspector-body">
        <header className="nc-inspector-head">
          <p className="eyebrow">Conexão</p>
          <h2>{meaning.title}</h2>
        </header>
        <p className="nc-text">{meaning.text}</p>
        {edge.folded && (
          <p className="nc-text muted-text">
            Esta linha resume dependências de um grupo recolhido.
          </p>
        )}
        <dl className="nc-fields">
          <Field label="Origem">
            <NodeLink view={view} id={edge.source} onSelect={onSelect} />
          </Field>
          <Field label="Destino">
            <NodeLink view={view} id={edge.target} onSelect={onSelect} />
          </Field>
        </dl>
      </div>
    );
  }
  if (selection?.kind === 'node') {
    const [type, ref] = splitId(selection.id);
    if (type === 'result')
      return (
        <div className="nc-inspector-body">
          <header className="nc-inspector-head">
            <h2>Resultado Vivo</h2>
          </header>
          <p className="nc-text">{view.liveResult?.summary ?? 'Carregando fatos do motor…'}</p>
          <button className="ghost" onClick={view.openResult}>
            Abrir relatório e Minhas Notas
          </button>
        </div>
      );
    if (type === 'cortex') {
      const block = view.cortex.get(ref);
      if (block)
        return (
          <div className="nc-inspector-body">
            <header className="nc-inspector-head">
              <p className="eyebrow">Cortex · Shared Memory</p>
              <h2>{block.node.name}</h2>
            </header>
            <dl className="nc-fields">
              <Field label="Escopo">Projeto ({view.snapshot.workspace?.name ?? '—'})</Field>
              <Field label="Agentes conectados">
                {block.node.connections
                  .map(
                    (connection) =>
                      view.workers.get(connection.workerId)?.name ?? connection.workerId,
                  )
                  .join(', ') || 'nenhum'}
              </Field>
              <Field label="Memórias vigentes">{block.memories.active}</Field>
              <Field label="Decisões">{block.decisions}</Field>
              <Field label="Aprovações pendentes">{block.pendingApprovals}</Field>
              <Field label="Avisos a entregar">{block.pendingNotifications}</Field>
              <Field label="Busca">
                {block.embedding.degraded ? `local (provedor falhou)` : block.embedding.model}
              </Field>
            </dl>
            <button className="ghost" onClick={() => view.openCortex(ref)}>
              Abrir Cortex Inspector
            </button>
          </div>
        );
    }
    if (type === 'task') {
      const task = view.tasks.get(ref);
      if (task)
        return (
          <TaskInspector view={view} task={task} events={events} now={now} onSelect={onSelect} />
        );
    }
    if (type === 'agent' || type === 'group') {
      if (view.workers.has(ref))
        return (
          <AgentInspector
            view={view}
            workerId={ref}
            events={events}
            now={now}
            onSelect={onSelect}
          />
        );
    }
  }
  return <RunOverview view={view} />;
}

const splitId = (id: string): [string, string] => {
  const at = id.indexOf(':');
  return [id.slice(0, at), id.slice(at + 1)];
};

function NodeLink({
  view,
  id,
  onSelect,
}: {
  view: CanvasView;
  id: string;
  onSelect: (selection: Selection) => void;
}) {
  const [type, ref] = splitId(id);
  const label =
    type === 'task'
      ? view.tasks.get(ref)?.title
      : type === 'cortex'
        ? view.cortex.get(ref)?.node.name
        : (view.workers.get(ref)?.name ?? (type === 'group' ? 'Grupo' : undefined));
  return (
    <button className="link" onClick={() => onSelect({ kind: 'node', id })}>
      {label ?? id}
    </button>
  );
}

function RunOverview({ view }: { view: CanvasView }) {
  const { detail, workspace, queuePosition } = view.snapshot;
  const { run, mission } = detail;
  return (
    <div className="nc-inspector-body">
      <header className="nc-inspector-head">
        <p className="eyebrow">Missão · {workspace?.name ?? 'projeto removido'}</p>
        <h2>{mission.title}</h2>
      </header>
      <p className="nc-text">{mission.objective}</p>
      <dl className="nc-fields">
        <Field label="Estado">{statusLabels[run.status]}</Field>
        <Field label="Branch base">
          <code>{run.baseBranch}</code>
        </Field>
        <Field label="Commit base">
          <code>{run.baseCommit.slice(0, 10)}</code>
        </Field>
        {queuePosition !== null && (
          <Field label="Modo Turno">
            {queuePosition === 0 ? 'Primeira da fila' : `${queuePosition + 1}ª na fila`}
          </Field>
        )}
      </dl>
      {run.error && <p className="form-error">{run.error}</p>}
      {run.planNotes && (
        <Section title="Notas do plano">
          <p className="nc-text">{run.planNotes}</p>
        </Section>
      )}
      <p className="nc-hint">
        Selecione um agente, uma tarefa ou uma conexão para ver os detalhes.
      </p>
    </div>
  );
}

function AgentInspector({
  view,
  workerId,
  events,
  now,
  onSelect,
}: {
  view: CanvasView;
  workerId: string;
  events: AgentEvent[];
  now: number;
  onSelect: (selection: Selection) => void;
}) {
  const worker = view.workers.get(workerId)!;
  const status = view.agents.get(workerId)!;
  const logs = useMemo(
    () => recent(events, (event) => event.workerId === workerId),
    [events, workerId],
  );
  const current = status.current;
  // The branch of what the agent is on now, or of its last task that got one.
  const place = current ?? [...status.tasks].reverse().find((task) => task.branch) ?? null;
  const tokens = status.promptTokens + status.completionTokens;
  // The Queen plans; she runs no task, so branch, worktree and task tokens do not apply to her.
  const executes = status.tasks.length > 0;
  return (
    <div className="nc-inspector-body">
      <header className="nc-inspector-head with-avatar">
        <AgentBee
          worker={worker}
          size={34}
          mood={status.tone === 'running' ? 'working' : 'still'}
        />
        <div>
          <p className="eyebrow">Agente</p>
          <h2>{worker.name}</h2>
        </div>
      </header>
      <dl className="nc-fields">
        <Field label="Função">{roleLabel(worker.role)}</Field>
        <Field label="Provedor">{worker.providerName ?? unavailable}</Field>
        <Field label="Modelo">{worker.modelId ? <code>{worker.modelId}</code> : unavailable}</Field>
        <Field label="Estado">
          <span className={`nc-chip tone-${status.tone}`}>{workerStateLabels[status.state]}</span>
        </Field>
        {!executes && worker.role === 'queen' && (
          <Field label="Plano">
            {view.snapshot.planning
              ? 'em preparação'
              : `${view.snapshot.detail.tasks.length} tarefa(s) planejada(s)`}
          </Field>
        )}
        {executes && (
          <>
            <Field label="Tarefa atual">
              {current ? (
                <button
                  className="link"
                  onClick={() => onSelect({ kind: 'node', id: `task:${current.id}` })}
                >
                  {current.title}
                </button>
              ) : (
                <span className="muted-text">nenhuma</span>
              )}
            </Field>
            {current && (
              <Field label="Tempo na tarefa">{formatDuration(taskElapsedMs(current, now))}</Field>
            )}
            <Field label="Tarefas">
              {status.done}/{status.tasks.length} concluídas
              {status.failed > 0 && (
                <span className="error-text"> · {status.failed} com falha</span>
              )}
            </Field>
            <Field label="Tokens">
              {tokens ? (
                <span title={`${status.promptTokens} entrada · ${status.completionTokens} saída`}>
                  {compactNumber(tokens)}
                </span>
              ) : (
                <span className="muted-text">sem tarefas concluídas</span>
              )}
            </Field>
            <Field label="Custo">
              {!tokens ? '—' : status.costUsd === null ? unavailable : formatCost(status.costUsd)}
            </Field>
            <Field label="Branch">
              {place?.branch ? <code>{place.branch}</code> : unavailable}
            </Field>
            <Field label="Worktree">
              {place?.worktreePath ? (
                <code title={place.worktreePath}>{place.worktreePath}</code>
              ) : (
                <span className="muted-text">
                  {current ? 'preparando' : 'removida ao concluir'}
                </span>
              )}
            </Field>
          </>
        )}
      </dl>
      <Section title="Logs recentes">
        <EventLines events={logs} />
      </Section>
    </div>
  );
}

function TaskInspector({
  view,
  task,
  events,
  now,
  onSelect,
}: {
  view: CanvasView;
  task: Task;
  events: AgentEvent[];
  now: number;
  onSelect: (selection: Selection) => void;
}) {
  const action = useTask();
  const worker = task.workerId ? view.workers.get(task.workerId) : undefined;
  const tone = taskTone(task);
  const usage = view.snapshot.usage[task.id];
  const byKey = useMemo(
    () => new Map([...view.tasks.values()].map((item) => [item.key, item])),
    [view.tasks],
  );
  const dependents = [...view.tasks.values()].filter((item) => item.dependsOn.includes(task.key));
  const approvals = view.snapshot.detail.approvals.filter(
    (approval) => approval.taskId === task.id && approval.status === 'pending',
  );
  const logs = useMemo(
    () => recent(events, (event) => event.taskId === task.id),
    [events, task.id],
  );
  const tests = task.result?.commands.filter((command) => looksLikeTestCommand(command.command));
  const live = isLive(task);
  const waiting = task.status === 'pending' || task.status === 'blocked';
  const retryable = ['failed', 'cancelled', 'rejected'].includes(task.status);
  const runId = view.snapshot.detail.run.id;
  const call = (work: () => Promise<unknown>) => void action.run(async () => void (await work()));

  return (
    <div className="nc-inspector-body">
      <header className="nc-inspector-head">
        <p className="eyebrow">
          Tarefa · <code>{task.key}</code>
        </p>
        <h2>{task.title}</h2>
      </header>
      <div className="nc-actions">
        {live && (
          <button
            className="secondary"
            disabled={action.running}
            onClick={() => call(() => window.hive.invoke('task.cancel', task.id))}
          >
            <Square size={12} /> Cancelar
          </button>
        )}
        {retryable && (
          <button
            className="secondary"
            disabled={action.running}
            onClick={() => call(() => window.hive.invoke('task.retry', task.id))}
          >
            <RotateCcw size={13} /> Tentar novamente
          </button>
        )}
        {waiting && (
          <button
            className={task.boosted ? 'secondary honey-button on' : 'secondary honey-button'}
            disabled={action.running}
            aria-pressed={!!task.boosted}
            title="Mel: fura a fila, dobra os limites e chama o esquadrão completo"
            onClick={() =>
              call(() => window.hive.invoke('task.boost', { id: task.id, boosted: !task.boosted }))
            }
          >
            <HoneyJar size={12} /> {task.boosted ? 'Prioridade com mel' : 'Dar prioridade'}
          </button>
        )}
        {(task.status === 'completed' || task.result?.commit) && (
          <button
            className="secondary"
            onClick={() => call(() => window.hive.invoke('window.showRun', runId))}
            title="Revisar o diff e aplicar no projeto na janela principal"
          >
            <ExternalLink size={13} />{' '}
            {task.status === 'completed' ? 'Revisar no Hive' : 'Ver no Hive'}
          </button>
        )}
      </div>
      {action.error && <p className="form-error">{action.error}</p>}

      {approvals.map((approval) => (
        <div key={approval.id} className="nc-approval" role="alert">
          <p>
            <ShieldQuestion size={13} /> {approval.title}
          </p>
          <pre className="command">
            <span aria-hidden="true">$ </span>
            {approval.detail}
          </pre>
          <div className="nc-actions">
            <button
              className="ghost"
              disabled={action.running}
              onClick={() =>
                call(() =>
                  window.hive.invoke('approval.resolve', {
                    approvalId: approval.id,
                    approve: false,
                    remember: false,
                  }),
                )
              }
            >
              <X size={13} /> Negar
            </button>
            <button
              disabled={action.running}
              onClick={() =>
                call(() =>
                  window.hive.invoke('approval.resolve', {
                    approvalId: approval.id,
                    approve: true,
                    remember: false,
                  }),
                )
              }
            >
              <Check size={13} /> Permitir
            </button>
          </div>
        </div>
      ))}

      <dl className="nc-fields">
        <Field label="Estado">
          <span className={`nc-chip tone-${tone}`}>
            {isBlocked(task) ? 'Bloqueada por dependência' : taskStatusLabels[task.status]}
          </span>
          {live && <span className="muted-text"> · {workerStateLabels[task.workerState]}</span>}
        </Field>
        <Field label="Agente">
          {worker ? (
            <button
              className="link"
              onClick={() => onSelect({ kind: 'node', id: `agent:${worker.id}` })}
            >
              {worker.name}
            </button>
          ) : (
            <span className="muted-text">automático (definido ao executar)</span>
          )}
        </Field>
        <Field label="Tempo">{formatDuration(taskElapsedMs(task, now))}</Field>
        <Field label="Tentativa">
          {task.revision ? `revisão ${task.revision.round}` : task.attempt || '—'}
        </Field>
        <Field label="Tokens">
          {usage ? compactNumber(usage.promptTokens + usage.completionTokens) : '—'}
        </Field>
        <Field label="Custo">
          {!usage ? '—' : usage.costUsd === null ? unavailable : formatCost(usage.costUsd)}
        </Field>
        <Field label="Branch">
          {task.branch ? (
            <code>
              <GitBranch size={11} /> {task.branch}
            </code>
          ) : (
            '—'
          )}
        </Field>
        {task.worktreePath && (
          <Field label="Worktree">
            <code title={task.worktreePath}>
              <FolderGit2 size={11} /> {task.worktreePath}
            </code>
          </Field>
        )}
      </dl>

      <Section title="Descrição">
        <p className="nc-text">{task.description}</p>
        {task.acceptanceCriteria.length > 0 && (
          <ul className="nc-criteria">
            {task.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        )}
      </Section>

      {(task.dependsOn.length > 0 || dependents.length > 0) && (
        <Section title="Dependências">
          <ul className="nc-deps">
            {task.dependsOn.map((key) => {
              const dep = byKey.get(key);
              return (
                <li key={key}>
                  <span className={`nc-dot tone-${dep ? taskTone(dep) : 'failed'}`} />
                  {dep ? (
                    <button
                      className="link"
                      onClick={() => onSelect({ kind: 'node', id: `task:${dep.id}` })}
                    >
                      {dep.title}
                    </button>
                  ) : (
                    <span className="error-text">{key} (não existe no plano)</span>
                  )}
                </li>
              );
            })}
            {dependents.map((item) => (
              <li key={item.id} className="dependent">
                <span className={`nc-dot tone-${taskTone(item)}`} />
                <span className="muted-text">libera</span>
                <button
                  className="link"
                  onClick={() => onSelect({ kind: 'node', id: `task:${item.id}` })}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {task.error && (
        <Section title="Erro">
          <p className="form-error">{task.error}</p>
        </Section>
      )}

      {task.result && (
        <>
          <Section title="Resultado">
            {task.result.summary ? (
              <Markdown source={task.result.summary} className="nc-markdown" />
            ) : (
              <p className="muted-text">Sem resumo.</p>
            )}
          </Section>
          <Section title={`Arquivos alterados (${task.result.filesChanged.length})`}>
            {task.result.filesChanged.length ? (
              <ul className="nc-files">
                {task.result.filesChanged.map((file) => (
                  <li key={file.path}>
                    <span className={`nc-file-status s-${file.status.charAt(0).toLowerCase()}`}>
                      {file.status.charAt(0).toUpperCase()}
                    </span>
                    <code className="truncate">{file.path}</code>
                  </li>
                ))}
                <li className="nc-files-total">
                  <span className="success-text">+{task.result.insertions}</span>{' '}
                  <span className="error-text">−{task.result.deletions}</span>
                </li>
              </ul>
            ) : (
              <p className="muted-text">Nenhum arquivo alterado.</p>
            )}
          </Section>
          <Section title="Testes">
            {tests?.length ? (
              <ul className="nc-tests">
                {tests.map((test, index) => (
                  <li key={index} className={test.exitCode === 0 ? 'pass' : 'fail'}>
                    <span>
                      {test.exitCode === 0
                        ? 'passou'
                        : test.timedOut
                          ? 'tempo esgotado'
                          : `saída ${test.exitCode ?? '?'}`}
                    </span>
                    <code className="truncate">{test.command}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-text">O agente não rodou testes nesta tarefa.</p>
            )}
          </Section>
        </>
      )}

      <Section title="Logs recentes">
        <EventLines events={logs} />
      </Section>
    </div>
  );
}
