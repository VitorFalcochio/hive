import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Bot, GitBranch, Play, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import type {
  CanvasSnapshot,
  NexusAutopilotApplyResult,
  NexusAutopilotDraft,
  NexusAutopilotPlan,
} from '@hive/core';
import { Modal } from '../ui';

const cloneDraft = (draft: NexusAutopilotDraft): NexusAutopilotDraft =>
  JSON.parse(JSON.stringify(draft)) as NexusAutopilotDraft;
const stateLabel: Record<NexusAutopilotPlan['state'], string> = {
  proposed: 'Pronto para revisão',
  superseded: 'Substituído',
  applied: 'Aplicado',
  started: 'Em execução',
  cancelled: 'Cancelado',
  failed: 'Falha na aplicação',
};

function planLayers(tasks: NexusAutopilotDraft['tasks']) {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const memo = new Map<string, number>();
  const depth = (key: string, trail = new Set<string>()): number => {
    if (memo.has(key)) return memo.get(key)!;
    if (trail.has(key)) return 0;
    const task = byKey.get(key);
    if (!task) return 0;
    const next = new Set(trail).add(key);
    const value = task.dependsOn.length
      ? 1 + Math.max(...task.dependsOn.map((dependency) => depth(dependency, next)))
      : 0;
    memo.set(key, value);
    return value;
  };
  const layers: NexusAutopilotDraft['tasks'][] = [];
  for (const task of tasks) (layers[depth(task.key)] ??= []).push(task);
  return layers;
}

function AutopilotGraph({ plan }: { plan: NexusAutopilotPlan }) {
  const names = new Map(
    plan.draft.agents.map((agent) => [
      agent.key,
      agent.source === 'existing' ? `Agente existente · ${agent.workerId}` : agent.name,
    ]),
  );
  const layers = planLayers(plan.draft.tasks);
  let order = 0;
  return (
    <div className="nc-autopilot-graph" aria-label="Prévia visual do fluxo">
      <div className="nc-autopilot-node queen">
        <Sparkles size={15} /> Queen
      </div>
      {layers.map((layer, layerIndex) => (
        <div className="nc-autopilot-layer" key={`layer:${layerIndex}`}>
          {layer.map((task) => {
            const index = order++;
            return (
              <article
                className="nc-autopilot-node task"
                key={task.key}
                style={{ '--autopilot-order': index } as CSSProperties}
              >
                <span className="nc-autopilot-key">{task.key}</span>
                <strong>{task.title}</strong>
                <small>{task.workerKey ? names.get(task.workerKey) : 'Delegação automática'}</small>
                {task.dependsOn.length > 0 && (
                  <span className="nc-autopilot-links">
                    <GitBranch size={11} /> {task.dependsOn.join(' + ')}
                  </span>
                )}
              </article>
            );
          })}
        </div>
      ))}
      {plan.draft.connectResult && <div className="nc-autopilot-node result">Resultado Vivo</div>}
    </div>
  );
}

export function NexusAutopilot({
  snapshot,
  beforeRequest,
  onApplied,
  onClose,
}: {
  snapshot: CanvasSnapshot;
  beforeRequest: () => Promise<void>;
  onApplied: (result: NexusAutopilotApplyResult) => Promise<void>;
  onClose: () => void;
}) {
  const runId = snapshot.detail.run.id;
  const [instruction, setInstruction] = useState('');
  const [useExistingAgents, setUseExistingAgents] = useState(true);
  const [allowNewAgents, setAllowNewAgents] = useState(true);
  const [plan, setPlan] = useState<NexusAutopilotPlan | null>(null);
  const [versions, setVersions] = useState<NexusAutopilotPlan[]>([]);
  const [draft, setDraft] = useState<NexusAutopilotDraft | null>(null);
  const [changeSummary, setChangeSummary] = useState('Ajuste manual do fluxo.');
  const [queenChange, setQueenChange] = useState('');
  const [busy, setBusy] = useState<'loading' | 'generating' | 'saving' | 'applying' | null>(
    'loading',
  );
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<NexusAutopilotApplyResult | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void window.hive
      .invoke('canvas.autopilot.current', runId)
      .then((plans) => {
        if (!alive.current) return;
        const current = plans.find((item) => item.state === 'proposed') ?? plans[0] ?? null;
        setVersions(plans);
        setPlan(current);
        if (current) {
          setInstruction(current.instruction);
          setUseExistingAgents(current.useExistingAgents);
          setAllowNewAgents(current.allowNewAgents);
        }
      })
      .catch((failure: unknown) => {
        if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (alive.current) setBusy(null);
      });
    return () => {
      alive.current = false;
      void window.hive.invoke('canvas.autopilot.cancel', { runId }).catch(() => undefined);
    };
  }, [runId]);

  const generate = useCallback(
    async (text: string, basePlanId?: string) => {
      if (!text.trim() || busy) return;
      setBusy('generating');
      setError('');
      setReceipt(null);
      try {
        await beforeRequest();
        const created = await window.hive.invoke('canvas.autopilot.propose', {
          runId,
          instruction: text,
          useExistingAgents,
          allowNewAgents,
          ...(basePlanId ? { basePlanId } : {}),
        });
        if (alive.current) {
          setPlan(created);
          setVersions((current) => [
            created,
            ...current
              .filter((item) => item.id !== created.id)
              .map((item) =>
                item.id === created.basedOnPlanId
                  ? { ...item, state: 'superseded' as const }
                  : item,
              ),
          ]);
          setInstruction(created.instruction);
          setDraft(null);
          setQueenChange('');
        }
      } catch (failure) {
        if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [allowNewAgents, beforeRequest, busy, runId, useExistingAgents],
  );

  const saveRevision = async () => {
    if (!plan || !draft || busy || !changeSummary.trim()) return;
    setBusy('saving');
    setError('');
    try {
      const revised = await window.hive.invoke('canvas.autopilot.revise', {
        runId,
        planId: plan.id,
        draft,
        changeSummary,
      });
      setPlan(revised);
      setVersions((current) => [
        revised,
        ...current
          .filter((item) => item.id !== revised.id)
          .map((item) =>
            item.id === revised.basedOnPlanId ? { ...item, state: 'superseded' as const } : item,
          ),
      ]);
      setDraft(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (start: boolean) => {
    if (!plan || plan.state !== 'proposed' || busy) return;
    setBusy('applying');
    setError('');
    try {
      await beforeRequest();
      const applied = await window.hive.invoke('canvas.autopilot.apply', {
        runId,
        planId: plan.id,
        start,
      });
      setPlan(applied.plan);
      setVersions((current) => [
        applied.plan,
        ...current.filter((item) => item.id !== applied.plan.id),
      ]);
      setReceipt(applied);
      await onApplied(applied);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const cancelPlan = async () => {
    if (plan?.state === 'proposed')
      await window.hive.invoke('canvas.autopilot.cancel', { runId, planId: plan.id });
    onClose();
  };

  const editTask = (key: string, patch: Partial<NexusAutopilotDraft['tasks'][number]>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((task) => (task.key === key ? { ...task, ...patch } : task)),
          }
        : current,
    );
  const renameTask = (oldKey: string, nextKey: string) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((task) => ({
              ...task,
              key: task.key === oldKey ? nextKey : task.key,
              dependsOn: task.dependsOn.map((dependency) =>
                dependency === oldKey ? nextKey : dependency,
              ),
            })),
          }
        : current,
    );
  const removeTask = (key: string) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks
              .filter((task) => task.key !== key)
              .map((task) => ({
                ...task,
                dependsOn: task.dependsOn.filter((dependency) => dependency !== key),
              })),
          }
        : current,
    );
  const agentOptions = draft?.agents ?? plan?.draft.agents ?? [];
  const resourceModels = useMemo(
    () =>
      plan?.draft.agents
        .filter((agent) => agent.source === 'new')
        .map((agent) => `${agent.name}: ${agent.providerId}/${agent.modelId}`) ?? [],
    [plan],
  );
  const failedTasks = snapshot.detail.tasks.filter((task) => task.status === 'failed');
  const newFlow = (text = '') => {
    setPlan(null);
    setReceipt(null);
    setDraft(null);
    setError('');
    setInstruction(text);
  };

  return (
    <Modal
      title="Nexus Autopilot"
      description={`${snapshot.workspace?.name ?? 'Projeto'} · ${snapshot.detail.mission.title}`}
      size="xl"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="nc-autopilot" data-keyboard-owner>
        {!plan && (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void generate(instruction);
            }}
          >
            <label>
              Objetivo para a Queen
              <textarea
                autoFocus
                rows={5}
                maxLength={6000}
                value={instruction}
                disabled={!!busy}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Organize uma equipe para desenvolver meu projeto…"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={useExistingAgents}
                disabled={!!busy}
                onChange={(event) => setUseExistingAgents(event.target.checked)}
              />
              Utilizar agentes existentes configurados
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={allowNewAgents}
                disabled={!!busy}
                onChange={(event) => setAllowNewAgents(event.target.checked)}
              />
              Permitir sugestão de novos agentes
            </label>
            <button
              type="submit"
              disabled={!!busy || !instruction.trim() || (!useExistingAgents && !allowNewAgents)}
            >
              <Sparkles size={14} /> {busy === 'generating' ? 'Queen planejando…' : 'Gerar fluxo'}
            </button>
          </form>
        )}

        {busy === 'loading' && <p role="status">Recuperando a versão mais recente…</p>}
        {busy === 'generating' && (
          <div className="nc-autopilot-status" role="status">
            <Bot size={18} />
            <div>
              <strong>Analisando solicitação e contexto real</strong>
              <span>A Queen está gerando agentes, tarefas e dependências estruturadas.</span>
            </div>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {plan && !draft && (
          <>
            <div className="nc-autopilot-heading">
              <div>
                <span className={`nc-autopilot-state ${plan.state}`}>{stateLabel[plan.state]}</span>
                <strong>Versão {plan.version}</strong>
                <small>
                  {plan.queen.name} · {plan.queen.modelId}
                </small>
                {versions.length > 1 && (
                  <select
                    aria-label="Versão do plano"
                    value={plan.id}
                    onChange={(event) => {
                      const selected = versions.find((item) => item.id === event.target.value);
                      if (selected) {
                        setPlan(selected);
                        setDraft(null);
                        setReceipt(null);
                      }
                    }}
                  >
                    {versions.map((item) => (
                      <option value={item.id} key={item.id}>
                        v{item.version} · {stateLabel[item.state]} · {item.changeSummary}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <button
                type="button"
                className="secondary nc-small"
                disabled={!!busy || plan.state !== 'proposed'}
                onClick={() => void generate(plan.instruction, plan.id)}
              >
                <RefreshCw size={12} /> Regenerar
              </button>
              {plan.state !== 'proposed' && (
                <button
                  type="button"
                  className="secondary nc-small"
                  disabled={!!busy}
                  onClick={() => newFlow()}
                >
                  Novo fluxo
                </button>
              )}
              {plan.state !== 'proposed' && failedTasks.length > 0 && (
                <button
                  type="button"
                  className="secondary nc-small"
                  disabled={!!busy}
                  onClick={() =>
                    newFlow(
                      `Analise estas falhas reais e proponha uma recuperação sem repetir indefinidamente: ${failedTasks
                        .map((task) => `${task.key}: ${task.error ?? 'falha sem detalhe'}`)
                        .join('; ')}`,
                    )
                  }
                >
                  Sugerir replanejamento
                </button>
              )}
            </div>
            <section className="nc-autopilot-summary">
              <h3>Resumo</h3>
              <p>{plan.draft.objective}</p>
              <div className="nc-autopilot-metrics">
                <span>{plan.draft.agents.length} agentes no plano</span>
                <span>{plan.draft.tasks.length} novas tarefas</span>
                <span>
                  {plan.draft.tasks.reduce((total, task) => total + task.dependsOn.length, 0)}{' '}
                  dependências
                </span>
                <span>
                  {plan.draft.connectResult
                    ? 'Resultado Vivo conectado'
                    : 'Sem conexão ao resultado'}
                </span>
              </div>
            </section>
            <AutopilotGraph plan={plan} />
            <section className="nc-autopilot-review-grid">
              <div>
                <h3>Alterações</h3>
                <ul>
                  {plan.draft.agents.map((agent) => (
                    <li key={agent.key}>
                      {agent.source === 'new' ? 'Criar' : 'Usar'} agente {agent.key}
                    </li>
                  ))}
                  <li>Criar {plan.draft.tasks.length} tarefa(s) pelo motor real</li>
                  {(plan.draft.cortexAccess ?? []).map((access) => (
                    <li key={`${access.cortexId}:${access.agentKey}`}>
                      Conectar {access.agentKey} ao Cortex ({access.permissions.join(' + ')}) —
                      conexões existentes não mudam
                    </li>
                  ))}
                  <li>Preservar nós e posições existentes</li>
                </ul>
              </div>
              <div>
                <h3>Recursos</h3>
                <ul>
                  <li>Concorrência configurada no Hive</li>
                  {resourceModels.map((model) => (
                    <li key={model}>{model}</li>
                  ))}
                  <li>
                    Consumo do planejamento:{' '}
                    {plan.usage
                      ? `${plan.usage.promptTokens + plan.usage.completionTokens} tokens`
                      : 'não informado pelo provedor'}
                  </li>
                  <li>Estimativa da execução indisponível sem dados confiáveis</li>
                </ul>
              </div>
            </section>
            {(plan.draft.approvalSteps.length > 0 || plan.draft.warnings.length > 0) && (
              <section className="nc-autopilot-warnings">
                <h3>Aprovações e avisos</h3>
                <ul>
                  {[...plan.draft.approvalSteps, ...plan.draft.warnings].map((line, index) => (
                    <li key={`${index}:${line}`}>{line}</li>
                  ))}
                </ul>
              </section>
            )}
            {plan.state === 'proposed' && (
              <section className="nc-autopilot-change">
                <label>
                  Pedir alteração incremental à Queen
                  <input
                    value={queenChange}
                    maxLength={6000}
                    placeholder="Adicione uma revisão de segurança antes do QA"
                    onChange={(event) => setQueenChange(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={!!busy || !queenChange.trim()}
                  onClick={() => void generate(queenChange, plan.id)}
                >
                  Solicitar alteração
                </button>
              </section>
            )}
          </>
        )}

        {draft && plan && (
          <section className="nc-autopilot-editor" aria-label="Editor do plano Autopilot">
            <label>
              Objetivo
              <textarea
                rows={3}
                value={draft.objective}
                onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.connectResult} readOnly disabled />
              Acompanhamento conectado ao Resultado Vivo da missão
            </label>
            {draft.tasks.map((task) => (
              <article className="nc-autopilot-task-editor" key={task.key}>
                <div className="nc-autopilot-task-title">
                  <input
                    aria-label="Chave da tarefa"
                    value={task.key}
                    onChange={(event) => renameTask(task.key, event.target.value)}
                  />
                  <button
                    type="button"
                    className="icon-button danger"
                    title="Remover tarefa"
                    onClick={() => removeTask(task.key)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <input
                  aria-label="Título da tarefa"
                  value={task.title}
                  onChange={(event) => editTask(task.key, { title: event.target.value })}
                />
                <textarea
                  aria-label="Descrição da tarefa"
                  rows={2}
                  value={task.description}
                  onChange={(event) => editTask(task.key, { description: event.target.value })}
                />
                <div className="nc-autopilot-task-row">
                  <label>
                    Agente
                    <select
                      value={task.workerKey ?? ''}
                      onChange={(event) =>
                        editTask(task.key, { workerKey: event.target.value || null })
                      }
                    >
                      <option value="">Delegação automática</option>
                      {agentOptions.map((agent) => (
                        <option value={agent.key} key={agent.key}>
                          {agent.key}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Dependências (chaves)
                    <input
                      value={task.dependsOn.join(', ')}
                      onChange={(event) =>
                        editTask(task.key, {
                          dependsOn: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  Critérios de aceitação (um por linha)
                  <textarea
                    rows={2}
                    value={task.acceptanceCriteria.join('\n')}
                    onChange={(event) =>
                      editTask(task.key, {
                        acceptanceCriteria: event.target.value
                          .split('\n')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </article>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const key = `task-${draft.tasks.length + 1}`;
                setDraft({
                  ...draft,
                  tasks: [
                    ...draft.tasks,
                    {
                      key,
                      title: 'Nova tarefa',
                      description: 'Descreva o resultado esperado.',
                      workerKey: agentOptions[0]?.key ?? null,
                      dependsOn: [],
                      acceptanceCriteria: ['Definir critério verificável.'],
                    },
                  ],
                });
              }}
            >
              Adicionar tarefa
            </button>
            <label>
              Motivo da alteração
              <input
                value={changeSummary}
                maxLength={500}
                onChange={(event) => setChangeSummary(event.target.value)}
              />
            </label>
          </section>
        )}

        {receipt && (
          <section className="nc-autopilot-receipt" role="status">
            <strong>
              {receipt.started ? 'Fluxo aplicado e missão iniciada' : 'Fluxo aplicado'}
            </strong>
            <span>
              {receipt.createdAgents} agente(s) e {receipt.createdTasks} tarefa(s) registrados.
            </span>
          </section>
        )}

        <div className="modal-actions nc-autopilot-actions">
          <button
            type="button"
            className="secondary"
            disabled={!!busy}
            onClick={() => void cancelPlan()}
          >
            {plan?.state === 'proposed' ? 'Cancelar plano' : 'Fechar'}
          </button>
          {plan?.state === 'proposed' && !draft && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={!!busy}
                onClick={() => setDraft(cloneDraft(plan.draft))}
              >
                Editar plano
              </button>
              <button type="button" disabled={!!busy} onClick={() => void apply(false)}>
                {busy === 'applying' ? 'Aplicando…' : 'Aplicar fluxo'}
              </button>
              <button type="button" disabled={!!busy} onClick={() => void apply(true)}>
                <Play size={12} /> Aplicar e iniciar
              </button>
            </>
          )}
          {draft && (
            <>
              <button type="button" className="secondary" onClick={() => setDraft(null)}>
                Voltar à prévia
              </button>
              <button
                type="button"
                disabled={!!busy || !changeSummary.trim() || draft.tasks.length === 0}
                onClick={() => void saveRevision()}
              >
                {busy === 'saving' ? 'Validando…' : 'Salvar nova versão'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
