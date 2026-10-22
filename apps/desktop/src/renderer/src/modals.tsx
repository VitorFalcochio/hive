import { useEffect, useState, type FormEvent } from 'react';
import { Check, CircleAlert, ExternalLink, Eye, EyeOff, Send } from 'lucide-react';
import {
  providerPresets,
  type ConnectionTest,
  type ModelInfo,
  type ProviderConfig,
  type ProviderKind,
  type AgentEvent,
  type RecommendedSetup,
  type Task,
  type TaskDiff,
  type Worker,
} from '@hive/core';
import { hasAccess, useHive, usableWorkers, type ModalState } from './context';
import { buildComparisonPlan, MAX_CANDIDATES, MIN_CANDIDATES } from './comparison';
import { Modal, Select, useTask, type SelectOption } from './ui';
import { taskDiffTab, useCode } from './code/store';
import { draftKey, loadDraft, saveDraft } from './review';
import { ReviewDiff } from './review-diff';
import { ModelPicker } from './model-picker';
import { AgentBee } from './mascot';

export function ModalHost({ modal }: { modal: ModalState | null }) {
  if (!modal) return null;
  switch (modal.kind) {
    case 'mission':
      return <MissionModal />;
    case 'provider':
      return <ProviderModal />;
    case 'key':
      return <KeyModal provider={modal.provider} />;
    case 'team':
      return <TeamModal initialProviderId={modal.providerId} />;
    case 'model':
      return <ModelModal worker={modal.worker} />;
    case 'diff':
      return <DiffModal task={modal.task} />;
    case 'activity':
      return <ActivityModal task={modal.task} />;
  }
}

function FormError({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="form-error">
      <CircleAlert size={14} /> {error}
    </p>
  ) : null;
}

/** Saves the key (if any), tests the connection and loads the model catalog. */
async function connect(provider: ProviderConfig, key: string) {
  if (key) await window.hive.invoke('provider.setKey', { providerId: provider.id, key });
  const test = await window.hive.invoke('provider.test', provider.id);
  if (!test.ok) throw new Error(`Não foi possível conectar: ${test.message}`);
  return window.hive.invoke('provider.models', { providerId: provider.id, refresh: true });
}

const presets = Object.values(providerPresets);
const kindOptions: SelectOption[] = [
  ...presets.filter((item) => item.free.available),
  ...presets.filter((item) => !item.free.available),
].map((item) => ({
  value: item.kind,
  label: item.label,
  group: item.free.available ? 'Com plano gratuito' : 'Pagos',
  tag: item.free.available ? { label: 'Grátis', tone: 'free' } : { label: 'Pago' },
}));

function ProviderModal() {
  const { closeModal, openModal, refresh, notify, workers } = useHive();
  const [kind, setKind] = useState<ProviderKind>('groq');
  const [name, setName] = useState(providerPresets.groq.label);
  const [url, setUrl] = useState(providerPresets.groq.defaultBaseUrl);
  const [key, setKey] = useState('');
  // Kept after a failed test so retrying updates the same provider instead of duplicating it.
  const [savedId, setSavedId] = useState<string | undefined>();
  const preset = providerPresets[kind];
  const [connected, setConnected] = useState<{ provider: ProviderConfig; models: number } | null>(
    null,
  );
  const task = useTask();
  const keyOptional = !!preset.keyOptional;

  function submit(event: FormEvent) {
    event.preventDefault();
    void task.run(async () => {
      const provider = await window.hive.invoke('provider.save', {
        id: savedId,
        kind,
        name: name.trim(),
        baseUrl: url.trim(),
        enabled: true,
      });
      setSavedId(provider.id);
      try {
        const models = await connect(provider, key.trim());
        setConnected({ provider, models: models.length });
        notify(`${provider.name} conectado · ${models.length} modelos.`);
      } finally {
        await refresh();
      }
    });
  }

  if (connected)
    return (
      <Modal title="Provedor conectado" onClose={closeModal}>
        <div className="success-panel">
          <Check size={18} />
          <div>
            <strong>{connected.provider.name}</strong>
            <p>{connected.models} modelos disponíveis. A chave fica criptografada no Windows.</p>
          </div>
        </div>
        <p className="modal-description">
          Próximo passo: escolher e testar automaticamente um modelo para cada um dos{' '}
          {workers.length} agentes.
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={closeModal}>
            Agora não
          </button>
          <button
            type="button"
            onClick={() => openModal({ kind: 'team', providerId: connected.provider.id })}
          >
            Configurar equipe
          </button>
        </div>
      </Modal>
    );

  return (
    <Modal
      title="Adicionar provedor"
      description="Conectamos, testamos a chave e carregamos os modelos em um passo."
      onClose={closeModal}
    >
      <form onSubmit={submit}>
        <label>
          Tipo
          <Select
            value={kind}
            options={kindOptions}
            onChange={(value) => {
              const next = value as ProviderKind;
              setKind(next);
              setSavedId(undefined);
              setName(providerPresets[next].label);
              setUrl(providerPresets[next].defaultBaseUrl);
            }}
          />
        </label>
        <div className="plan-note">
          <p>{preset.free.summary}</p>
          {kind !== 'openai-compatible' && (
            <button
              type="button"
              className="ghost"
              onClick={() => void window.hive.invoke('app.openExternal', preset.keyUrl)}
            >
              <ExternalLink size={13} /> Criar chave
            </button>
          )}
        </div>
        <label>
          Chave de API{keyOptional && <span className="optional"> · opcional</span>}
          <input
            type="password"
            autoFocus
            autoComplete="off"
            required={!keyOptional}
            maxLength={500}
            value={key}
            placeholder={preset.keyHint}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <details className="advanced">
          <summary>Nome e URL</summary>
          <label>
            Nome
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            URL da API
            <input
              required
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
        </details>
        <FormError error={task.error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={closeModal}>
            Cancelar
          </button>
          <button disabled={task.running}>
            {task.running ? 'Conectando…' : 'Adicionar e testar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KeyModal({ provider }: { provider: ProviderConfig }) {
  const { closeModal, refresh, notify } = useHive();
  const [key, setKey] = useState('');
  const task = useTask();
  return (
    <Modal
      title={`Chave de ${provider.name}`}
      description="A nova chave substitui a anterior e é testada na hora."
      onClose={closeModal}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            try {
              const models = await connect(provider, key.trim());
              notify(`${provider.name} conectado · ${models.length} modelos.`);
              closeModal();
            } finally {
              await refresh();
            }
          });
        }}
      >
        <label>
          Chave de API
          <input
            type="password"
            autoFocus
            required
            autoComplete="off"
            maxLength={500}
            value={key}
            placeholder={providerPresets[provider.kind].keyHint}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <FormError error={task.error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={closeModal}>
            Cancelar
          </button>
          <button disabled={task.running}>{task.running ? 'Testando…' : 'Salvar e testar'}</button>
        </div>
      </form>
    </Modal>
  );
}

function MissionModal() {
  const { closeModal, refresh, setDetail, go, summary, workers, providers } = useHive();
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [compare, setCompare] = useState(false);
  const [queue, setQueue] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const task = useTask();
  const candidates = usableWorkers(workers, providers).filter((worker) => worker.role !== 'queen');

  function toggle(id: string) {
    setPicked((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length < MAX_CANDIDATES
          ? [...current, id]
          : current,
    );
  }

  return (
    <Modal
      title="Nova missão"
      description={
        compare
          ? 'Cada agente escolhido executa o objetivo numa worktree própria. Você aplica a melhor entrega.'
          : `Em ${summary?.workspace?.name ?? 'nenhum repositório'}. A Queen transforma o objetivo em tarefas.`
      }
      onClose={closeModal}
      wide
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            // Checked before the mission exists, so a bad choice leaves nothing behind.
            const plan = compare
              ? buildComparisonPlan(
                  objective,
                  candidates.filter((worker) => picked.includes(worker.id)),
                )
              : null;
            const created = await window.hive.invoke('mission.create', {
              title: title.trim(),
              objective: objective.trim(),
            });
            if (plan) {
              await window.hive.invoke('run.setPlan', { runId: created.runId, plan });
              await window.hive.invoke('run.start', created.runId);
            } else if (queue) {
              await window.hive.invoke('autopilot.enqueue', created.runId);
            }
            setDetail(await window.hive.invoke('run.get', created.runId));
            await refresh();
            go('mission');
            closeModal();
          });
        }}
      >
        <label>
          Título
          <input
            autoFocus
            required
            maxLength={140}
            value={title}
            placeholder="O que vamos construir?"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Objetivo
          <textarea
            required
            maxLength={10000}
            rows={6}
            value={objective}
            placeholder="Descreva o resultado esperado e os critérios de sucesso."
            onChange={(event) => setObjective(event.target.value)}
          />
        </label>
        <fieldset className="mode-choice">
          <legend>Como executar</legend>
          <label className={compare ? 'option-card' : 'option-card selected'}>
            <input type="radio" name="mode" checked={!compare} onChange={() => setCompare(false)} />
            <span>
              <strong>Plano da Queen</strong>
              <small>A Queen divide o objetivo em tarefas para a equipe.</small>
            </span>
          </label>
          <label className={compare ? 'option-card selected' : 'option-card'}>
            <input type="radio" name="mode" checked={compare} onChange={() => setCompare(true)} />
            <span>
              <strong>Comparar agentes</strong>
              <small>Vários agentes fazem a mesma tarefa e você escolhe a melhor.</small>
            </span>
          </label>
        </fieldset>
        {!compare && (
          <label className={queue ? 'option-card wide selected' : 'option-card wide'}>
            <input
              type="checkbox"
              checked={queue}
              onChange={(event) => setQueue(event.target.checked)}
            />
            <span>
              <strong>Colocar na fila do Modo Turno</strong>
              <small>A Queen planeja e os agentes executam sem esperar por você.</small>
            </span>
          </label>
        )}
        {compare && (
          <fieldset className="agent-picks">
            <legend>
              Agentes ({picked.length} de {MAX_CANDIDATES}, mínimo {MIN_CANDIDATES})
            </legend>
            {candidates.length ? (
              candidates.map((worker) => (
                <label key={worker.id} className="choice">
                  <input
                    type="checkbox"
                    checked={picked.includes(worker.id)}
                    onChange={() => toggle(worker.id)}
                  />
                  {worker.name} <code>{worker.modelId}</code>
                </label>
              ))
            ) : (
              <p className="hint">Configure agentes com provedor e modelo na aba Agentes.</p>
            )}
          </fieldset>
        )}
        <FormError error={task.error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={closeModal}>
            Cancelar
          </button>
          <button disabled={task.running || (compare && picked.length < MIN_CANDIDATES)}>
            {task.running ? 'Criando…' : compare ? 'Criar e comparar' : 'Criar missão'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function SetupResult({ setup }: { setup: RecommendedSetup }) {
  return (
    <ul className="setup-result">
      {setup.assignments.map((item) => (
        <li key={item.workerId}>
          <span className={item.modelId ? 'success-text' : 'error-text'}>
            {item.modelId ? <Check size={13} /> : <CircleAlert size={13} />}
          </span>
          <span>{item.workerName}</span>
          <code>{item.modelId ?? 'nenhum modelo respondeu'}</code>
        </li>
      ))}
      {setup.unavailable.map((item) => (
        <li key={item.modelId} className="muted-row">
          <span />
          <span>Ignorado</span>
          <code title={item.message}>{item.modelId}</code>
        </li>
      ))}
    </ul>
  );
}

function TeamModal({ initialProviderId }: { initialProviderId?: string }) {
  const { closeModal, refresh, notify, providers } = useHive();
  const usable = providers.filter(hasAccess);
  const [providerId, setProviderId] = useState(initialProviderId ?? usable[0]?.id ?? '');
  const [setup, setSetup] = useState<RecommendedSetup | null>(null);
  const task = useTask();
  return (
    <Modal
      title="Configurar equipe"
      description="Escolhemos um modelo para cada função (planejamento, código e revisão) e testamos cada um com uma chamada mínima. Leva alguns segundos."
      onClose={closeModal}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (setup) return closeModal();
          void task.run(async () => {
            try {
              const result = await window.hive.invoke('worker.applyRecommended', { providerId });
              setSetup(result);
              const ok = result.assignments.filter((item) => item.modelId).length;
              notify(`${ok} de ${result.assignments.length} agentes configurados.`);
            } finally {
              await refresh();
            }
          });
        }}
      >
        <label>
          Provedor
          <Select
            value={providerId}
            disabled={task.running || !!setup}
            onChange={setProviderId}
            options={usable.map((provider) => ({
              value: provider.id,
              label: provider.name,
              hint: provider.credentialHint ?? undefined,
            }))}
          />
        </label>
        {!usable.length && <p className="form-error">Adicione um provedor com chave primeiro.</p>}
        {task.running && <p className="progress">Testando modelos…</p>}
        {setup && <SetupResult setup={setup} />}
        <FormError error={task.error} />
        <div className="modal-actions">
          {!setup && (
            <button type="button" className="secondary" onClick={closeModal}>
              Cancelar
            </button>
          )}
          <button disabled={task.running || !providerId}>
            {setup ? 'Concluir' : task.running ? 'Configurando…' : 'Configurar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ModelModal({ worker }: { worker: Worker }) {
  const { closeModal, refresh, notify, providers } = useHive();
  const provider = providers.find((item) => item.id === worker.providerId) ?? null;
  const [modelId, setModelId] = useState(worker.modelId ?? '');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const task = useTask();
  const providerId = provider?.id;
  useEffect(() => {
    if (!providerId) return;
    let active = true;
    const load = (refresh: boolean) =>
      window.hive.invoke('provider.models', { providerId, refresh });
    void load(false)
      .then((value) => (value.length ? value : load(true)))
      .then((value) => {
        if (active) setModels(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [providerId]);
  const id = modelId.trim();
  return (
    <Modal
      title={`Modelo de ${worker.name}`}
      description={`Modelos de ${provider?.name ?? 'nenhum provedor'}, grátis primeiro. Teste antes de salvar.`}
      onClose={closeModal}
      wide
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await window.hive.invoke('worker.save', { ...worker, modelId: id || null });
            await refresh();
            notify(`${worker.name} agora usa ${id || 'nenhum modelo'}.`);
            closeModal();
          });
        }}
      >
        <ModelPicker
          models={models}
          value={id}
          onChange={(next) => {
            setModelId(next);
            setTest(null);
          }}
        />
        <VisionHint vision={models.find((model) => model.id === id)?.capabilities.vision} />
        {test && <p className={test.ok ? 'success-text' : 'form-error'}>{test.message}</p>}
        <FormError error={task.error} />
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={task.running || !provider || !id}
            onClick={() =>
              void task.run(async () => {
                setTest(
                  await window.hive.invoke('provider.testModel', {
                    providerId: providerId!,
                    modelId: id,
                  }),
                );
              })
            }
          >
            Testar
          </button>
          <button disabled={task.running}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

/** Whether the agent will see images it opens, as the provider's catalog says. */
function VisionHint({ vision }: { vision: ModelInfo['capabilities']['vision'] | undefined }) {
  if (vision === 'yes')
    return (
      <p className="field-hint vision-hint">
        <Eye size={13} /> Este modelo enxerga imagens: o agente pode olhar prints, mockups e ícones.
      </p>
    );
  if (vision === 'no')
    return (
      <p className="field-hint vision-hint">
        <EyeOff size={13} /> Este modelo não enxerga imagens; o agente só saberá o nome e o tamanho
        delas.
      </p>
    );
  return null;
}

function DiffModal({ task }: { task: Task }) {
  const { closeModal, refresh, setDetail, notify, go } = useHive();
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const openInEditor = (path: string) => {
    useCode.getState().open(taskDiffTab(task.id, task.title, path));
    go('code');
    closeModal();
  };
  const load = useTask();
  const act = useTask();
  useEffect(() => {
    void load.run(async () => setDiff(await window.hive.invoke('task.diff', task.id)));
  }, [task.id, load.run]);
  // Review notes are kept per result, so closing the diff does not lose them.
  const reviewKey = draftKey(task.id, task.result?.commit);
  const [review, setReview] = useState(() => loadDraft(reviewKey));
  const updateReview = (next: typeof review) => {
    setReview(next);
    saveDraft(reviewKey, next);
  };
  const reviewable = task.status === 'completed' && !!task.result?.commit;
  const hasReview = review.comments.length > 0 || review.note.trim().length > 0;
  const finish = async (message: string) => {
    setDetail(await window.hive.invoke('run.get', task.runId));
    await refresh();
    notify(message);
    closeModal();
  };
  return (
    <Modal
      title={`Alterações · ${task.title}`}
      description={
        diff
          ? `${diff.files.length} arquivo(s) · base ${diff.base.slice(0, 8)} · branch ${diff.branch ?? '—'}`
          : 'Carregando…'
      }
      onClose={closeModal}
      size="xl"
    >
      {diff && diff.files.length > 0 && (
        <ul className="diff-files">
          {diff.files.map((file) => (
            <li key={file.path}>
              <span className={`diff-status s-${file.status[0]}`}>{file.status[0]}</span>
              <code>{file.path}</code>
              <button
                className="ghost"
                title="Abrir lado a lado no editor"
                onClick={() => openInEditor(file.path)}
              >
                Abrir no editor
              </button>
              <small>
                <span className="success-text">+{file.insertions}</span>{' '}
                <span className="error-text">−{file.deletions}</span>
              </small>
            </li>
          ))}
        </ul>
      )}
      {diff && reviewable && (
        <p className="review-hint">
          Passe o mouse numa linha e clique no balão para comentar. Os comentários vão juntos para o
          agente, que corrige a partir desta entrega.
        </p>
      )}
      {diff && (
        <ReviewDiff
          patch={diff.patch}
          comments={review.comments}
          editable={reviewable}
          onChange={(comments) => updateReview({ ...review, comments })}
        />
      )}
      {diff?.truncated && <p className="review-empty">O diff foi cortado por ser muito grande.</p>}
      {reviewable && (
        <label className="review-general">
          Observação geral para o agente <span className="optional">(opcional)</span>
          <textarea
            rows={2}
            maxLength={4000}
            value={review.note}
            placeholder="Ex.: mantenha o padrão de nomes do projeto."
            onChange={(event) => updateReview({ ...review, note: event.target.value })}
          />
        </label>
      )}
      <FormError error={load.error || act.error} />
      {task.status === 'completed' && (
        <div className="modal-actions">
          <button
            className="secondary"
            disabled={act.running}
            onClick={() =>
              void act.run(async () => {
                await window.hive.invoke('task.reject', task.id);
                await finish('Alterações descartadas.');
              })
            }
          >
            Descartar
          </button>
          {reviewable && (
            <button
              className="secondary"
              disabled={act.running || !hasReview}
              title={hasReview ? undefined : 'Comente alguma linha ou escreva uma observação'}
              onClick={() =>
                void act.run(async () => {
                  await window.hive.invoke('task.revise', {
                    taskId: task.id,
                    comments: review.comments,
                    note: review.note,
                  });
                  saveDraft(reviewKey, { comments: [], note: '' });
                  await finish('Comentários enviados. O agente está revisando a entrega.');
                })
              }
            >
              <Send size={13} />
              {review.comments.length
                ? `Enviar ${review.comments.length} comentário(s) ao agente`
                : 'Enviar ao agente'}
            </button>
          )}
          <button
            disabled={act.running}
            onClick={() =>
              void act.run(async () => {
                await window.hive.invoke('task.approve', task.id);
                await finish(`"${task.title}" aplicada no projeto.`);
              })
            }
          >
            <Check size={14} /> Aplicar no projeto
          </button>
        </div>
      )}
    </Modal>
  );
}

const hiddenEventTypes = new Set(['model.request']);

function ActivityModal({ task }: { task: Task }) {
  const { closeModal, onEvent, workers } = useHive();
  const worker = workers.find((item) => item.id === task.workerId);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [verbose, setVerbose] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.hive
      .invoke('events.query', { taskId: task.id, limit: 1000 })
      .then((items) => {
        if (alive) setEvents(items);
      })
      .catch(() => undefined);
    const off = onEvent((event) => {
      if (event.taskId === task.id) setEvents((current) => [...current, event].slice(-1000));
    });
    return () => {
      alive = false;
      off();
    };
  }, [task.id, onEvent]);
  const shown = events.filter(
    (event) => verbose || (event.level !== 'debug' && !hiddenEventTypes.has(event.type)),
  );
  return (
    <Modal title={`Atividade · ${task.title}`} onClose={closeModal} size="xl">
      {worker && (
        <p className="activity-agent">
          <AgentBee
            worker={worker}
            size={20}
            mood={task.status === 'running' ? 'working' : 'still'}
          />
          {worker.name}
        </p>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} />
        Mostrar detalhes técnicos
      </label>
      <ol className="activity">
        {shown.map((event) => (
          <li key={event.id} className={`lvl-${event.level}`}>
            <time>{new Date(event.ts).toLocaleTimeString('pt-BR')}</time>
            <span className="type">{event.type}</span>
            <span className="message">{event.message}</span>
          </li>
        ))}
        {!shown.length && <li className="muted-row">Nenhuma atividade registrada.</li>}
      </ol>
    </Modal>
  );
}
