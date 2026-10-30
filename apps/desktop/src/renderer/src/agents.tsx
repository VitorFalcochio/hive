import { useEffect, useState } from 'react';
import { Check, ChevronRight, Eye, Plus, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import {
  allTools,
  beeColorOf,
  beeColors,
  beeColorSchema,
  compareByPrice,
  isFreeModel,
  nextBeeColor,
  rolePresets,
  soldierPresets,
  squadOf,
  type BeeColor,
  type RecommendedSetup,
  type Soldier,
  type SoldierRole,
  type ToolName,
  type Worker,
  type WorkerInput,
  type WorkerRole,
} from '@hive/core';
import { hasAccess, useHive } from './context';
import { Dot, Drawer, PageHeader, Select, useTask } from './ui';
import { AgentBee, Mascot, SoldierBee } from './mascot';
import { NumberField } from './settings';
import { AgentMcpSection } from './mcp';
import { FailoverSection } from './model-failover';

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
  web_fetch: {
    label: 'Ler a web',
    detail: 'Abre páginas e APIs da internet, como documentação. Só leitura (GET).',
  },
  view_page: {
    label: 'Ver páginas locais',
    detail: 'Tira print do app rodando em localhost e lê os erros do console.',
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
            <SquadLine worker={worker} />
          </div>
        ))}
      </div>
      {selected === 'new' && <NewAgent onCreated={setSelected} onClose={close} />}
      {current && <AgentDetail key={current.id} worker={current} onClose={close} />}
    </>
  );
}

/** The captain's soldiers, in a line under its row. */
function SquadLine({ worker }: { worker: Worker }) {
  const squad = squadOf(worker);
  if (!squad.length) return null;
  const enabled = squad.filter((soldier) => soldier.enabled).length;
  const status =
    enabled === squad.length
      ? 'Esquadrão pronto'
      : enabled
        ? `${enabled} de ${squad.length} soldadas ligadas`
        : 'Esquadrão desligado';
  return (
    <span role="cell" className="agent-squad" aria-label={`Esquadrão de ${worker.name}`}>
      <span className="agent-squad-bees">
        {squad.map((soldier) => (
          <SoldierBee
            key={soldier.role}
            captain={worker}
            role={soldier.role}
            enabled={soldier.enabled}
            size={19}
          />
        ))}
      </span>
      <small>{status}</small>
    </span>
  );
}

function NewAgent({
  onCreated,
  onClose,
}: {
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const { workers, skills, refresh, notify } = useHive();
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
        squad: [],
        description: '',
        providerId: null,
        modelId: null,
        skills: [],
        tools: [...rolePresets.custom.tools],
        autoApproveCommands: [],
        mcpServers: [],
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
    const available = new Set(
      skills.filter((skill) => skill.source === 'local').map((s) => s.name),
    );
    patch({
      role: preset.role,
      tools: [...preset.tools],
      skills: preset.skills.filter((name) => available.has(name)),
    });
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
      <SkillsSection value={draft.skills} onChange={(next) => patch({ skills: next })} />
      <ToolsSection tools={draft.tools} commands={draft.autoApproveCommands} onChange={patch} />
      <AgentMcpSection
        value={draft.mcpServers ?? []}
        onChange={(next) => patch({ mcpServers: next })}
      />
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
    draft.skills.join() !== worker.skills.join() ||
    JSON.stringify(draft.limits) !== JSON.stringify(worker.limits) ||
    JSON.stringify(draft.squad) !== JSON.stringify(worker.squad) ||
    JSON.stringify(draft.fallbacks ?? []) !== JSON.stringify(worker.fallbacks ?? []) ||
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
      <FailoverSection
        worker={worker}
        value={draft.fallbacks ?? []}
        onChange={(fallbacks) => patch({ fallbacks })}
      />
      {worker.role !== 'queen' && (
        <SquadSection captain={draft} onChange={(squad) => patch({ squad })} />
      )}
      <SkillsSection value={draft.skills} onChange={(next) => patch({ skills: next })} />
      <ToolsSection tools={draft.tools} commands={draft.autoApproveCommands} onChange={patch} />
      <AgentMcpSection
        value={draft.mcpServers ?? []}
        onChange={(next) => patch({ mcpServers: next })}
      />
      <LimitsSection value={draft.limits} onChange={(limits) => patch({ limits })} />
      {task.error && (
        <p role="alert" className="form-error">
          {task.error}
        </p>
      )}
    </Drawer>
  );
}

const CAPTAIN_MODEL = '';

/** Switch soldiers on and off and, if wanted, give one a free model of its own. */
function SquadSection({
  captain,
  onChange,
}: {
  captain: Worker;
  onChange: (squad: Soldier[]) => void;
}) {
  const [free, setFree] = useState<string[]>([]);
  const { providerId } = captain;
  useEffect(() => {
    if (!providerId) return setFree([]);
    let active = true;
    void window.hive
      .invoke('provider.models', { providerId, refresh: false })
      .then((models) => {
        if (active)
          setFree(
            models
              .filter((model) => isFreeModel(model))
              .sort(compareByPrice)
              .map((model) => model.id),
          );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [providerId]);

  const squad = squadOf(captain);
  // Soldiers back at the defaults are dropped, so only real choices are stored.
  const update = (role: SoldierRole, next: Partial<Soldier>) =>
    onChange(
      squad
        .map((soldier) => (soldier.role === role ? { ...soldier, ...next } : soldier))
        .filter((soldier) => !soldier.enabled || soldier.modelId),
    );

  return (
    <section className="agent-section">
      <h3>Esquadrão</h3>
      <p className="field-hint">
        {captain.name} é a capitã: escolhe qual soldada trabalha em cada momento. Elas trocam
        resumos curtos entre si, então gastam poucos tokens.
      </p>
      <div className="squad-list">
        {squad.map((soldier) => (
          <div key={soldier.role} className={`squad-soldier${soldier.enabled ? '' : ' off'}`}>
            <label className="tool-option">
              <input
                type="checkbox"
                checked={soldier.enabled}
                onChange={(event) => update(soldier.role, { enabled: event.target.checked })}
              />
              <SoldierBee
                captain={captain}
                role={soldier.role}
                enabled={soldier.enabled}
                size={22}
              />
              <span>
                {soldierPresets[soldier.role].label}
                <small>{soldierPresets[soldier.role].detail}</small>
              </span>
            </label>
            <label className="squad-model">
              <span className="sr-only">Modelo da {soldierPresets[soldier.role].label}</span>
              <Select
                value={soldier.modelId ?? CAPTAIN_MODEL}
                disabled={!soldier.enabled || !providerId}
                onChange={(modelId) => update(soldier.role, { modelId: modelId || null })}
                options={[
                  { value: CAPTAIN_MODEL, label: 'Modelo da capitã' },
                  ...[...new Set([...(soldier.modelId ? [soldier.modelId] : []), ...free])].map(
                    (id) => ({ value: id, label: id }),
                  ),
                ]}
              />
            </label>
          </div>
        ))}
      </div>
    </section>
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

/** The skills in Hive's library, switched on and off for this agent. */
function SkillsSection({
  value,
  onChange,
}: {
  value: string[];
  onChange: (skills: string[]) => void;
}) {
  const { skills } = useHive();
  const library = skills.filter((skill) => skill.source === 'local');
  // A skill the agent has but the library lost still shows, so it can be taken off.
  const missing = value.filter((name) => !library.some((skill) => skill.name === name));
  return (
    <section className="agent-section">
      <h3>Skills</h3>
      {library.length || missing.length ? (
        <div className="tool-list skill-options">
          {library.map((skill) => (
            <label key={skill.name} className="tool-option">
              <input
                type="checkbox"
                checked={value.includes(skill.name)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, skill.name]
                      : value.filter((name) => name !== skill.name),
                  )
                }
              />
              <span>
                {skill.name}
                <small title={skill.description}>{skill.description}</small>
              </span>
            </label>
          ))}
          {missing.map((name) => (
            <label key={name} className="tool-option">
              <input
                type="checkbox"
                checked
                onChange={() => onChange(value.filter((skill) => skill !== name))}
              />
              <span>
                {name}
                <small>Não está mais na biblioteca.</small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="field-hint">Nenhuma skill na biblioteca. Crie ou instale na aba Skills.</p>
      )}
    </section>
  );
}

/** How far one task of this agent may go before Hive stops it. */
function LimitsSection({
  value,
  onChange,
}: {
  value: Worker['limits'];
  onChange: (limits: Worker['limits']) => void;
}) {
  const set = <K extends keyof Worker['limits']>(key: K, next: Worker['limits'][K]) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="agent-section">
      <h3>Limites por tarefa</h3>
      <div className="settings-grid">
        <NumberField
          label="Tokens"
          hint="Prompt e resposta juntos, até 10 milhões."
          min={1_000}
          max={10_000_000}
          step={100_000}
          value={value.maxTokens}
          onChange={(next) => set('maxTokens', next)}
        />
        <NumberField
          label="Passos"
          hint="De 1 a 200."
          min={1}
          max={200}
          value={value.maxSteps}
          onChange={(next) => set('maxSteps', next)}
        />
        <NumberField
          label="Tempo da tarefa (min)"
          hint="De 1 a 600 minutos."
          min={1}
          max={600}
          value={value.taskTimeoutMin}
          onChange={(next) => set('taskTimeoutMin', next)}
        />
        <NumberField
          label="Tempo de comando (s)"
          hint="De 5 a 3.600 segundos."
          min={5}
          max={3_600}
          value={value.commandTimeoutSec}
          onChange={(next) => set('commandTimeoutSec', next)}
        />
      </div>
    </section>
  );
}
