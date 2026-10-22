import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronRight,
  Eye,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  allTools,
  beeColorOf,
  beeColors,
  beeColorSchema,
  nextBeeColor,
  rolePresets,
  type BeeColor,
  type RecommendedSetup,
  type ToolName,
  type Worker,
  type WorkerInput,
  type WorkerRole,
} from '@hive/core';
import { hasAccess, useHive } from './context';
import { Dot, PageHeader, Select, useTask } from './ui';
import { AgentBee, Mascot } from './mascot';

const roleOrder: WorkerRole[] = [
  'queen',
  'architect',
  'frontend',
  'backend',
  'qa',
  'reviewer',
  'custom',
];

const roleLabels: Record<WorkerRole, string> = {
  queen: 'Coordenação',
  architect: 'Arquitetura',
  frontend: 'Frontend',
  backend: 'Backend',
  qa: 'Testes',
  reviewer: 'Revisão',
  custom: 'Personalizado',
};

const toolLabels: Record<ToolName, { label: string; detail: string }> = {
  list_dir: { label: 'Listar pastas', detail: 'Vê os arquivos e pastas do projeto.' },
  read_file: { label: 'Ler arquivos', detail: 'Abre o conteúdo dos arquivos.' },
  search: { label: 'Buscar', detail: 'Procura texto em todo o projeto.' },
  write_file: { label: 'Criar arquivos', detail: 'Cria ou sobrescreve arquivos.' },
  replace_in_file: { label: 'Editar arquivos', detail: 'Altera trechos exatos de um arquivo.' },
  run_command: {
    label: 'Rodar comandos',
    detail: 'Executa comandos no terminal; pede aprovação, exceto os liberados abaixo.',
  },
  read_skill_resource: {
    label: 'Ler skills',
    detail: 'Consulta os arquivos de referência das skills do agente.',
  },
};

const sortWorkers = (workers: Worker[]) =>
  [...workers].sort(
    (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.name.localeCompare(b.name),
  );

/** `'new'` is an unsaved agent being created in the drawer. */
type Selection = string | 'new' | null;

export function AgentsPage() {
  const { workers, providers, openModal } = useHive();
  const usable = providers.filter(hasAccess);
  const sorted = sortWorkers(workers);
  const [selected, setSelected] = useState<Selection>(null);
  const current = sorted.find((worker) => worker.id === selected) ?? null;
  const close = () => setSelected(null);

  return (
    <>
      <PageHeader
        eyebrow="Sua equipe"
        title="Agentes"
        description="A Queen distribui as tarefas pela descrição de cada agente. Escolha o provedor na linha; o modelo é testado sozinho."
      >
        <button
          className="secondary"
          disabled={!usable.length}
          onClick={() => openModal({ kind: 'team' })}
        >
          <Sparkles size={15} /> Configurar equipe
        </button>
        <button onClick={() => setSelected('new')}>
          <Plus size={15} /> Novo agente
        </button>
      </PageHeader>
      {!usable.length && (
        <p className="hint">
          Adicione um provedor com chave na aba Provedores para configurar os agentes.
        </p>
      )}
      <div className="agent-table" role="table" aria-label="Agentes">
        <div className="agent-tr agent-th" role="row">
          <span role="columnheader">Função</span>
          <span role="columnheader">Nome</span>
          <span role="columnheader">Provedor</span>
          <span role="columnheader">Modelo</span>
          <span role="columnheader" className="sr-only">
            Editar
          </span>
        </div>
        {sorted.map((worker) => (
          <div
            key={worker.id}
            role="row"
            className={`agent-tr${selected === worker.id ? ' active' : ''}`}
            onClick={(event) => {
              // The provider menu and buttons in the row do their own thing.
              if ((event.target as Element).closest('button, .select-menu')) return;
              setSelected(worker.id);
            }}
          >
            <span role="cell" className="agent-role-cell">
              <Dot tone={worker.modelId ? 'ok' : 'idle'} />
              {roleLabels[worker.role]}
            </span>
            <span role="cell" className="agent-name-cell">
              <AgentBee worker={worker} size={22} />
              <span className="agent-name-text">
                <span>{worker.name}</span>
                <small>{worker.description || 'Sem descrição'}</small>
              </span>
            </span>
            <AgentModel worker={worker} />
            <span role="cell">
              <button
                className="icon-button"
                title="Editar agente"
                aria-label={`Editar ${worker.name}`}
                onClick={() => setSelected(worker.id)}
              >
                <ChevronRight size={15} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {selected === 'new' && <NewAgent onCreated={setSelected} onClose={close} />}
      {current && <AgentDetail key={current.id} worker={current} onClose={close} />}
    </>
  );
}

/** Edits slide in from the right, so the table stays in view behind them. */
function Drawer({
  eyebrow,
  title,
  onClose,
  footer,
  children,
  onSubmit,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
  onSubmit: () => void;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="drawer-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        <div className="drawer-footer">{footer}</div>
      </form>
    </div>
  );
}

function NewAgent({
  onCreated,
  onClose,
}: {
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const { workers, refresh, notify } = useHive();
  const [draft, setDraft] = useState<WorkerInput | null>(null);
  // A custom agent without a pick wears the colour fewest agents wear, chosen when it is created.
  const suggested = nextBeeColor(workers);
  const task = useTask();

  // New agents start from the limits chosen in Configurações.
  useEffect(() => {
    void window.hive.invoke('settings.get').then((settings) =>
      setDraft({
        name: '',
        role: 'custom',
        beeColor: null,
        description: '',
        providerId: null,
        modelId: null,
        skills: [],
        tools: [...rolePresets.custom.tools],
        autoApproveCommands: [],
        systemPrompt: '',
        limits: settings.defaultLimits,
      }),
    );
  }, []);

  if (!draft) return null;
  const patch = (next: Partial<WorkerInput>) => setDraft((value) => value && { ...value, ...next });

  // Picking a base role fills in what that role usually needs; the user can still change it.
  function pickRole(role: string) {
    const preset = rolePresets[role as WorkerRole];
    patch({ role: preset.role, tools: [...preset.tools] });
  }

  return (
    <Drawer
      eyebrow="Novo agente"
      title={draft.name.trim() || 'Sem nome'}
      onClose={onClose}
      onSubmit={() =>
        void task.run(async () => {
          const created = await window.hive.invoke('worker.save', {
            ...draft,
            beeColor: draft.beeColor ?? (draft.role === 'custom' ? suggested : null),
            name: draft.name.trim(),
            description: draft.description.trim(),
          });
          await refresh();
          notify(`Agente "${created.name}" criado. Escolha o provedor na tabela.`);
          onCreated(created.id);
        })
      }
      footer={
        <>
          <span className="drawer-spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" disabled={task.running || !draft.name.trim()}>
            <Plus size={15} /> Criar agente
          </button>
        </>
      }
    >
      <section className="agent-section">
        <h3>Perfil</h3>
        <label>
          Função base
          <Select
            value={draft.role}
            onChange={pickRole}
            options={roleOrder
              .filter((role) => role !== 'queen')
              .map((role) => ({ value: role, label: roleLabels[role] }))}
          />
        </label>
        <BeePicker
          value={draft.beeColor}
          fallback={draft.role === 'custom' ? suggested : beeColorOf({ ...draft, id: '' })}
          onChange={(beeColor) => patch({ beeColor })}
        />
        <ProfileFields value={draft} onChange={patch} />
      </section>
      <ToolsSection tools={draft.tools} commands={draft.autoApproveCommands} onChange={patch} />
      {task.error && (
        <p role="alert" className="form-error">
          {task.error}
        </p>
      )}
    </Drawer>
  );
}

function AgentDetail({ worker, onClose }: { worker: Worker; onClose: () => void }) {
  const { refresh, notify } = useHive();
  const [draft, setDraft] = useState(worker);
  const task = useTask();
  // Model changes save on their own; keep them from showing up as unsaved edits.
  useEffect(
    () =>
      setDraft((value) => ({
        ...value,
        providerId: worker.providerId,
        modelId: worker.modelId,
        updatedAt: worker.updatedAt,
      })),
    [worker],
  );
  const dirty =
    draft.name !== worker.name ||
    draft.beeColor !== worker.beeColor ||
    draft.description !== worker.description ||
    draft.systemPrompt !== worker.systemPrompt ||
    draft.tools.join() !== worker.tools.join() ||
    draft.autoApproveCommands.join('\n') !== worker.autoApproveCommands.join('\n');
  const patch = (next: Partial<Worker>) => setDraft((value) => ({ ...value, ...next }));

  return (
    <Drawer
      eyebrow={roleLabels[worker.role]}
      title={worker.name}
      onClose={onClose}
      onSubmit={() =>
        void task.run(async () => {
          await window.hive.invoke('worker.save', {
            ...draft,
            name: draft.name.trim(),
            description: draft.description.trim(),
          });
          await refresh();
          notify('Agente salvo.');
          onClose();
        })
      }
      footer={
        <>
          {worker.role !== 'queen' && (
            <button
              type="button"
              className="ghost danger"
              disabled={task.running}
              onClick={() => {
                if (!window.confirm(`Remover o agente "${worker.name}"?`)) return;
                void task.run(async () => {
                  await window.hive.invoke('worker.delete', worker.id);
                  await refresh();
                  onClose();
                });
              }}
            >
              <Trash2 size={14} /> Remover
            </button>
          )}
          <span className="drawer-spacer" />
          {dirty && <span className="agent-unsaved">Não salvo</span>}
          <button type="button" className="secondary" onClick={onClose}>
            {dirty ? 'Descartar' : 'Fechar'}
          </button>
          <button type="submit" disabled={task.running || !dirty || !draft.name.trim()}>
            <Check size={15} /> Salvar
          </button>
        </>
      }
    >
      <section className="agent-section">
        <h3>Perfil</h3>
        <BeePicker
          value={draft.beeColor}
          fallback={beeColorOf({ ...draft, beeColor: null })}
          onChange={(beeColor) => patch({ beeColor })}
        />
        <ProfileFields value={draft} onChange={patch} />
      </section>
      <ToolsSection tools={draft.tools} commands={draft.autoApproveCommands} onChange={patch} />
      {task.error && (
        <p role="alert" className="form-error">
          {task.error}
        </p>
      )}
    </Drawer>
  );
}

/** The provider and model cells of a table row: pick a provider and the model follows. */
function AgentModel({ worker }: { worker: Worker }) {
  const { providers, refresh, openModal } = useHive();
  const usable = providers.filter(
    (provider) => hasAccess(provider) || provider.id === worker.providerId,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [setup, setSetup] = useState<RecommendedSetup | null>(null);
  const task = useTask();
  const providerId = pending ?? worker.providerId ?? '';

  function choose(next: string) {
    setSetup(null);
    setPending(next);
    void task.run(async () => {
      try {
        if (!next)
          await window.hive.invoke('worker.save', { ...worker, providerId: null, modelId: null });
        else
          setSetup(
            await window.hive.invoke('worker.autoConfigure', {
              workerId: worker.id,
              providerId: next,
            }),
          );
      } finally {
        await refresh();
        setPending(null);
      }
    });
  }

  const failed = setup && !setup.assignments[0]?.modelId;
  const sees = useSees(worker);
  return (
    <>
      <span role="cell">
        <label className="agent-provider">
          <span className="sr-only">Provedor de {worker.name}</span>
          <Select
            value={providerId}
            disabled={task.running}
            placeholder="Escolher…"
            onChange={choose}
            options={[
              ...(worker.providerId ? [{ value: '', label: 'Nenhum provedor' }] : []),
              ...usable.map((provider) => ({ value: provider.id, label: provider.name })),
            ]}
          />
        </label>
      </span>
      <span role="cell" className="agent-model-cell">
        {task.running ? (
          <span className="progress">Testando…</span>
        ) : (
          <>
            <code className={worker.modelId ? undefined : 'unset'}>
              {worker.modelId ?? 'sem modelo'}
            </code>
            {sees && (
              <span className="vision-badge" title="Este modelo enxerga imagens">
                <Eye size={13} aria-label="Enxerga imagens" />
              </span>
            )}
            {setup && !failed && (
              <span className="success-text">
                <Check size={13} /> testado
              </span>
            )}
          </>
        )}
        <button
          className="icon-button"
          title="Escolher modelo manualmente"
          aria-label={`Escolher modelo de ${worker.name}`}
          disabled={task.running || !worker.providerId}
          onClick={() => openModal({ kind: 'model', worker })}
        >
          <SlidersHorizontal size={14} />
        </button>
        {(failed || task.error) && (
          <span className="agent-model-error" role="alert">
            {task.error ?? 'Nenhum modelo funcionou. Escolha um manualmente.'}
          </span>
        )}
      </span>
    </>
  );
}

/** Whether the agent's model accepts images, from the provider's cached catalog. */
function useSees(worker: Worker): boolean {
  const [sees, setSees] = useState(false);
  const { providerId, modelId } = worker;
  useEffect(() => {
    if (!providerId || !modelId) return setSees(false);
    let active = true;
    void window.hive
      .invoke('provider.models', { providerId, refresh: false })
      .then((models) => {
        if (active)
          setSees(models.find((model) => model.id === modelId)?.capabilities.vision === 'yes');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [providerId, modelId]);
  return sees;
}

/**
 * The agent's bee and the colours it can wear. `fallback` is the colour it wears with no pick
 * (its role's), which "Cor da função" goes back to.
 */
function BeePicker({
  value,
  fallback,
  onChange,
}: {
  value: BeeColor | null;
  fallback: BeeColor;
  onChange: (color: BeeColor | null) => void;
}) {
  const current = value ?? fallback;
  return (
    <div className="bee-picker">
      <span className="bee-picker-preview">
        <Mascot size={44} color={beeColors[current].hex} />
      </span>
      <div className="bee-picker-body">
        <span className="bee-picker-label">
          Cor da abelha · {beeColors[current].label}
          {value === null && <span className="optional"> (da função)</span>}
        </span>
        <div className="bee-swatches" role="radiogroup" aria-label="Cor da abelha">
          {beeColorSchema.options.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={color === current}
              aria-label={beeColors[color].label}
              title={beeColors[color].label}
              className={color === current ? 'bee-swatch selected' : 'bee-swatch'}
              style={{ background: beeColors[color].hex }}
              onClick={() => onChange(color === fallback ? null : color)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

type Profile = Pick<Worker, 'name' | 'description' | 'systemPrompt'>;

function ProfileFields({
  value,
  onChange,
}: {
  value: Profile;
  onChange: (patch: Partial<Profile>) => void;
}) {
  return (
    <>
      <label>
        Nome
        <input
          value={value.name}
          maxLength={60}
          placeholder="Ex.: Especialista em acessibilidade"
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label>
        Descrição
        <span className="field-hint">A Queen lê isto para decidir quais tarefas entregar.</span>
        <textarea
          rows={2}
          maxLength={500}
          value={value.description}
          placeholder="Ex.: Revisa telas e corrige problemas de acessibilidade."
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>
      <label>
        <span>
          Instruções <span className="optional">(opcional)</span>
        </span>
        <span className="field-hint">Como o agente deve trabalhar, como num briefing.</span>
        <textarea
          rows={5}
          maxLength={20_000}
          value={value.systemPrompt}
          onChange={(event) => onChange({ systemPrompt: event.target.value })}
        />
      </label>
    </>
  );
}

function ToolsSection({
  tools,
  commands,
  onChange,
}: {
  tools: ToolName[];
  commands: string[];
  onChange: (patch: { tools?: ToolName[]; autoApproveCommands?: string[] }) => void;
}) {
  const [text, setText] = useState(commands.join('\n'));
  useEffect(() => {
    setText((current) =>
      current
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n') === commands.join('\n')
        ? current
        : commands.join('\n'),
    );
  }, [commands]);

  return (
    <section className="agent-section">
      <h3>Ferramentas</h3>
      <div className="tool-list">
        {allTools.map((tool) => (
          <label key={tool} className="tool-option">
            <input
              type="checkbox"
              checked={tools.includes(tool)}
              onChange={(event) =>
                onChange({
                  tools: event.target.checked
                    ? allTools.filter((name) => name === tool || tools.includes(name))
                    : tools.filter((name) => name !== tool),
                })
              }
            />
            <span>
              {toolLabels[tool].label}
              <small>{toolLabels[tool].detail}</small>
            </span>
          </label>
        ))}
      </div>
      {tools.includes('run_command') && (
        <label>
          <span>
            Comandos liberados <span className="optional">(um por linha)</span>
          </span>
          <span className="field-hint">
            Rodam sem pedir aprovação. Use <code>*</code> no fim para liberar variações, como{' '}
            <code>npm test *</code>.
          </span>
          <textarea
            rows={3}
            className="mono"
            value={text}
            placeholder={'npm test\nnpm run lint *'}
            onChange={(event) => {
              setText(event.target.value);
              onChange({
                autoApproveCommands: event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              });
            }}
          />
        </label>
      )}
    </section>
  );
}
