import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  Check,
  CircleAlert,
  CornerDownLeft,
  Crown,
  ExternalLink,
  Eye,
  EyeOff,
  FolderGit2,
  Repeat,
  Send,
  Split,
} from 'lucide-react';
import {
  providerPresets,
  selectablePresets,
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
import { hasAccess, useHive, usableWorkers, type MissionMode, type ModalState } from './context';
import { buildComparisonPlan, MAX_CANDIDATES, MIN_CANDIDATES } from './comparison';
import { Modal, Select, useTask } from './ui';
import { ProviderLogo, providerColor } from './provider-logo';
import { taskDiffTab, useCode } from './code/store';
import { draftKey, loadDraft, saveDraft } from './review';
import { ReviewDiff } from './review-diff';
import { ModelPicker } from './model-picker';
import { AgentBee } from './mascot';

/** OpenAI's page where the user sees and caps what Hive spends of the ChatGPT plan. */
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export function ModalHost({ modal }: { modal: ModalState | null }) {
  if (!modal) return null;
  switch (modal.kind) {
    case 'mission':
      return <MissionModal objective={modal.objective} mode={modal.mode} />;
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

/**
 * Saves the key (if any) — or, for ChatGPT, runs the browser sign-in — then tests the connection
 * and loads the model catalog.
 */
async function connect(provider: ProviderConfig, key: string) {
  if (providerPresets[provider.kind].signIn === 'chatgpt')
    await window.hive.invoke('provider.chatgptSignIn', provider.id);
  else if (key) await window.hive.invoke('provider.setKey', { providerId: provider.id, key });
  const test = await window.hive.invoke('provider.test', provider.id);
  if (!test.ok) throw new Error(`Não foi possível conectar: ${test.message}`);
  return window.hive.invoke('provider.models', { providerId: provider.id, refresh: true });
}

const presets = selectablePresets;
/** The provider choices of the add-provider modal: free plans first, then paid ones. */
const kindGroups = [
  { title: 'Com plano gratuito', items: presets.filter((item) => item.free.available) },
  { title: 'Pagos', items: presets.filter((item) => !item.free.available) },
];

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
  const signIn = preset.signIn === 'chatgpt';

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
            <p>
              {connected.models} modelos disponíveis.{' '}
              {providerPresets[connected.provider.kind].signIn
                ? 'Usando o plano do ChatGPT: os pedidos dos agentes contam no limite do seu plano, sem cobrança à parte. O acesso fica criptografado no Windows.'
                : 'A chave fica criptografada no Windows.'}
            </p>
          </div>
        </div>
        {providerPresets[connected.provider.kind].signIn && (
          <button
            type="button"
            className="ghost"
            onClick={() => void window.hive.invoke('app.openExternal', CHATGPT_USAGE_URL)}
          >
            <ExternalLink size={13} /> Gerenciar uso
          </button>
        )}
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
      description="Escolha de onde vêm os modelos. Conectamos, testamos e carregamos o catálogo em um passo."
      onClose={closeModal}
      wide
      className="provider-modal"
    >
      <form onSubmit={submit}>
        {kindGroups.map((group) => (
          <div key={group.title} className="provider-pick-group">
            <div className="provider-pick-label" id={`pick-${group.title}`}>
              {group.title}
            </div>
            <div
              className="provider-pick-grid"
              role="radiogroup"
              aria-labelledby={`pick-${group.title}`}
            >
              {group.items.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === item.kind}
                  aria-label={`${item.label}, ${item.free.available ? 'Grátis' : 'Pago'}`}
                  className={kind === item.kind ? 'provider-pick selected' : 'provider-pick'}
                  style={{ '--brand': providerColor(item.kind) } as CSSProperties}
                  onClick={() => {
                    if (item.kind === kind) return;
                    setKind(item.kind);
                    setSavedId(undefined);
                    setName(item.label);
                    setUrl(item.defaultBaseUrl);
                  }}
                >
                  <span className="provider-pick-logo">
                    <ProviderLogo kind={item.kind} size={20} />
                  </span>
                  <span className="provider-pick-name">{item.label}</span>
                  {kind === item.kind && (
                    <span className="provider-pick-check" aria-hidden>
                      <Check size={11} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div
          className="provider-detail"
          style={{ '--brand': providerColor(kind) } as CSSProperties}
        >
          <div className="provider-detail-head">
            <span className="provider-pick-logo large">
              <ProviderLogo kind={kind} size={24} />
            </span>
            <div>
              <strong>{preset.label}</strong>
              <span className={preset.free.available ? 'provider-tag free' : 'provider-tag'}>
                {preset.free.available ? 'Grátis' : 'Pago'}
              </span>
            </div>
            {kind !== 'openai-compatible' && (
              <button
                type="button"
                className="ghost"
                onClick={() => void window.hive.invoke('app.openExternal', preset.keyUrl)}
              >
                <ExternalLink size={13} /> {signIn ? 'Gerenciar uso' : 'Criar chave'}
              </button>
            )}
          </div>
          <p>{preset.free.summary}</p>
        </div>
        {signIn ? (
          <p className="modal-description">
            O navegador abre na página da OpenAI. Entre com a sua conta e autorize o Hive a usar o
            seu plano; depois volte para cá.
          </p>
        ) : (
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
        )}
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
            {task.running
              ? signIn
                ? 'Aguardando o navegador…'
                : 'Conectando…'
              : signIn
                ? 'Continuar com o ChatGPT'
                : 'Adicionar e testar'}
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
  if (providerPresets[provider.kind].signIn === 'chatgpt')
    return <ChatGPTAccountModal provider={provider} />;
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

/** Sign in, switch accounts or sign out of a ChatGPT provider. */
function ChatGPTAccountModal({ provider }: { provider: ProviderConfig }) {
  const { closeModal, refresh, notify } = useHive();
  const task = useTask();
  const signedIn = provider.hasCredential;
  return (
    <Modal
      title={`Conta de ${provider.name}`}
      description={
        signedIn
          ? `Conectado como ${provider.credentialHint?.replace(/^ChatGPT · /, '') ?? 'sua conta'}. Os pedidos usam o seu plano do ChatGPT.`
          : 'Entre com a sua conta do ChatGPT para os agentes usarem o seu plano.'
      }
      onClose={closeModal}
    >
      <FormError error={task.error} />
      <div className="modal-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => void window.hive.invoke('app.openExternal', CHATGPT_USAGE_URL)}
        >
          <ExternalLink size={13} /> Gerenciar uso
        </button>
        {signedIn && (
          <button
            type="button"
            className="secondary"
            disabled={task.running}
            onClick={() =>
              void task.run(async () => {
                try {
                  await window.hive.invoke('provider.clearKey', provider.id);
                  notify(`Saiu de ${provider.name}.`);
                  closeModal();
                } finally {
                  await refresh();
                }
              })
            }
          >
            Sair
          </button>
        )}
        <button
          type="button"
          disabled={task.running}
          onClick={() =>
            void task.run(async () => {
              try {
                const models = await connect(provider, '');
                notify(`${provider.name} conectado · ${models.length} modelos.`);
                closeModal();
              } finally {
                await refresh();
              }
            })
          }
        >
          {task.running ? 'Aguardando o navegador…' : 'Continuar com o ChatGPT'}
        </button>
      </div>
    </Modal>
  );
}

/** A title from the first line of an objective typed on the home screen. */
function titleFrom(objective: string | undefined): string {
  const line = objective?.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** How a new mission runs, as the cards in the mission modal show it. */
const missionModes: { id: MissionMode; icon: typeof Crown; title: string; text: string }[] = [
  {
    id: 'plan',
    icon: Crown,
    title: 'Plano da Queen',
    text: 'A Queen divide o objetivo em tarefas e você acompanha cada passo.',
  },
  {
    id: 'queue',
    icon: Repeat,
    title: 'Modo Turno',
    text: 'Entra na fila: a Queen planeja e a equipe executa sem esperar por você.',
  },
  {
    id: 'compare',
    icon: Split,
    title: 'Comparar agentes',
    text: 'Vários agentes fazem a mesma tarefa e você aplica a melhor entrega.',
  },
];

function MissionModal(initial: { objective?: string; mode?: MissionMode }) {
  const { closeModal, refresh, setDetail, go, summary, workers, providers } = useHive();
  const [title, setTitle] = useState(() => titleFrom(initial.objective));
  const [objective, setObjective] = useState(initial.objective ?? '');
  const [mode, setMode] = useState<MissionMode>(initial.mode ?? 'plan');
  const [picked, setPicked] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const task = useTask();
  const compare = mode === 'compare';
  const candidates = usableWorkers(workers, providers).filter((worker) => worker.role !== 'queen');
  const queen = workers.find((worker) => worker.role === 'queen');
  const blocked = task.running || (compare && picked.length < MIN_CANDIDATES);

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
    <Modal title="Nova missão" onClose={closeModal} wide className="mission-modal">
      <form
        ref={formRef}
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
            } else if (mode === 'queue') {
              await window.hive.invoke('autopilot.enqueue', created.runId);
            }
            setDetail(await window.hive.invoke('run.get', created.runId));
            await refresh();
            go('mission');
            closeModal();
          });
        }}
      >
        <div className="mission-context">
          <span className="home-chip">
            <FolderGit2 size={12} />
            <span className="truncate">{summary?.workspace?.name ?? 'Nenhum projeto'}</span>
          </span>
          {!compare && (
            <span className="home-chip">
              <span className={queen?.modelId ? 'home-chip-dot' : 'home-chip-dot off'} />
              <span className="truncate">{queen?.modelId ?? 'Queen sem modelo'}</span>
            </span>
          )}
        </div>

        <div className="mission-compose">
          <input
            autoFocus
            required
            aria-label="Título"
            className="mission-title"
            maxLength={140}
            value={title}
            placeholder="O que vamos construir?"
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="mission-objective">
            <span aria-hidden>›</span>
            <textarea
              required
              aria-label="Objetivo"
              maxLength={10000}
              rows={5}
              value={objective}
              placeholder="Descreva o resultado esperado e como saber que ficou pronto."
              onChange={(event) => setObjective(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  if (!blocked) formRef.current?.requestSubmit();
                }
              }}
            />
          </div>
          <div className="mission-compose-foot">
            <span>
              <kbd>Ctrl</kbd> <kbd>Enter</kbd> cria a missão
            </span>
            <span>{objective.length.toLocaleString('pt-BR')} / 10.000</span>
          </div>
        </div>

        <div className="mission-section-label" id="mission-mode-label">
          Como executar
        </div>
        <div className="mission-modes" role="radiogroup" aria-labelledby="mission-mode-label">
          {missionModes.map(({ id, icon: Icon, title: name, text }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={mode === id ? 'mission-mode selected' : 'mission-mode'}
              onClick={() => setMode(id)}
            >
              <span className="mission-mode-icon">
                <Icon size={15} />
              </span>
              <strong>{name}</strong>
              <small>{text}</small>
            </button>
          ))}
        </div>

        {compare && (
          <div className="mission-picks">
            <div className="mission-section-label">
              Agentes
              <span>
                {picked.length} de {MAX_CANDIDATES} · mínimo {MIN_CANDIDATES}
              </span>
            </div>
            {candidates.length ? (
              <div className="mission-pick-grid">
                {candidates.map((worker) => {
                  const on = picked.includes(worker.id);
                  return (
                    <button
                      key={worker.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className={on ? 'mission-pick selected' : 'mission-pick'}
                      onClick={() => toggle(worker.id)}
                    >
                      <AgentBee worker={worker} size={20} />
                      <span>
                        <strong>{worker.name}</strong>
                        <code>{worker.modelId}</code>
                      </span>
                      <span className="mission-pick-check">{on && <Check size={12} />}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="hint">Configure agentes com provedor e modelo na aba Agentes.</p>
            )}
          </div>
        )}

        <FormError error={task.error} />
        <div className="modal-actions mission-actions">
          <button type="button" className="secondary" onClick={closeModal}>
            Cancelar
          </button>
          <button className="mission-submit" disabled={blocked}>
            {task.running ? 'Criando…' : compare ? 'Criar e comparar' : 'Criar missão'}
            {!task.running && <CornerDownLeft size={14} />}
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
  const { run: runLoad } = load;
  useEffect(() => {
    void runLoad(async () => setDiff(await window.hive.invoke('task.diff', task.id)));
  }, [task.id, runLoad]);
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
