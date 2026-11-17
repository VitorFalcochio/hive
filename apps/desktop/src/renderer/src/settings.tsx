import { useState, type ReactNode } from 'react';
import {
  Bot,
  FolderOpen,
  Gauge,
  HardDrive,
  Plug,
  RotateCcw,
  Save,
  Search,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { defaultSettings, type Settings } from '@hive/core';
import { useHive } from './context';
import { McpServersSection } from './mcp';
import { BackupSection, UpdatesSection } from './maintenance';
import { PageHeader, useTask } from './ui';

const approvalChoices: { value: Settings['commandApproval']; label: string; detail: string }[] = [
  {
    value: 'ask',
    label: 'Perguntar sempre',
    detail: 'Todo comando espera você permitir, menos os que você liberou para cada agente.',
  },
  {
    value: 'safe',
    label: 'Liberar comandos que só leem (recomendado)',
    detail:
      'Versões, pacotes instalados, git status/diff/log, listar e buscar arquivos do projeto rodam sozinhos, mesmo encadeados com && ou |. Instalar, apagar, testes e build continuam pedindo.',
  },
  {
    value: 'all',
    label: 'Liberar tudo',
    detail:
      'Nenhum comando pede aprovação. Rápido, mas um agente pode instalar pacotes ou apagar arquivos fora da tarefa sem você ver.',
  },
];

type CategoryId = 'agents' | 'missions' | 'models' | 'integrations' | 'system';

const categories: { id: CategoryId; label: string; detail: string; icon: LucideIcon }[] = [
  { id: 'agents', label: 'Agentes', detail: 'Limites e comandos', icon: Bot },
  { id: 'missions', label: 'Missões', detail: 'Paralelismo e replanejamento', icon: Workflow },
  { id: 'models', label: 'Modelos e consumo', detail: 'Tokens e troca de modelo', icon: Gauge },
  { id: 'integrations', label: 'Integrações', detail: 'MCP e skills', icon: Plug },
  { id: 'system', label: 'Sistema', detail: 'Backup, atualizações, aparência', icon: HardDrive },
];

/** One block of the page: where it lives, what finds it in the search and what it changes. */
interface SettingsBlock {
  id: string;
  category: CategoryId;
  title: string;
  /** Words the search matches besides the title: field names, synonyms. */
  keywords: string;
  /** Settings it edits, to flag its category while unsaved. */
  keys: (keyof Settings)[];
  node: ReactNode;
}

const TAB_KEY = 'hive.settings.tab';
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

function storedTab(): CategoryId {
  try {
    const value = localStorage.getItem(TAB_KEY);
    if (categories.some((category) => category.id === value)) return value as CategoryId;
  } catch {
    // storage unavailable
  }
  return 'agents';
}

// Only settings the app actually uses are listed here. New agents take the limits below as
// their defaults; existing agents keep their own values.
export function SettingsPage({
  settings,
  onSaved,
}: {
  settings: Settings | null;
  onSaved(): Promise<void>;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Ambiente local"
        title="Configurações"
        description="Preferências deste computador. Elas ficam salvas no banco local do Hive."
      />
      {settings ? (
        <SettingsForm settings={settings} onSaved={onSaved} />
      ) : (
        <p className="hint">Carregando configurações…</p>
      )}
    </>
  );
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved(): Promise<void> }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [tab, setTabState] = useState<CategoryId>(storedTab);
  const [query, setQuery] = useState('');
  const { workers, refresh, notify, go } = useHive();
  const setTab = (next: CategoryId) => {
    setTabState(next);
    setQuery('');
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // storage unavailable
    }
  };
  const task = useTask();
  // The shift has its own page and can be switched from the tray, so this form leaves it alone.
  const dirty =
    JSON.stringify({ ...draft, autopilot: null }) !==
    JSON.stringify({ ...settings, autopilot: null });

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setLimit = <K extends keyof Settings['defaultLimits']>(
    key: K,
    value: Settings['defaultLimits'][K],
  ) =>
    setDraft((current) => ({
      ...current,
      defaultLimits: { ...current.defaultLimits, [key]: value },
    }));

  function save() {
    void task.run(async () => {
      const rest: Partial<Settings> = { ...draft };
      delete rest.autopilot;
      await window.hive.invoke('settings.update', rest);
      await onSaved();
    });
  }

  function restoreDefaults() {
    // The catalog folder and the MCP servers are choices the user made, so restoring defaults
    // keeps them.
    setDraft({
      ...defaultSettings,
      skillforgeCatalogPath: draft.skillforgeCatalogPath,
      mcpServers: draft.mcpServers,
      autopilot: draft.autopilot,
    });
  }

  function pickCatalog() {
    void task.run(async () => {
      const updated = await window.hive.invoke('skill.pickCatalog');
      setDraft((current) => ({
        ...current,
        skillforgeCatalogPath: updated.skillforgeCatalogPath,
      }));
      await onSaved();
    });
  }

  function clearCatalog() {
    void task.run(async () => {
      await window.hive.invoke('settings.update', { skillforgeCatalogPath: null });
      setDraft((current) => ({ ...current, skillforgeCatalogPath: null }));
      await onSaved();
    });
  }

  const blocks: SettingsBlock[] = [
    {
      id: 'limits',
      category: 'agents',
      title: 'Limites padrão para agentes novos',
      keywords: 'passos tokens por tarefa tempo limite comando temperatura aplicar a todos',
      keys: ['defaultLimits'],
      node: (
        <>
          <Section
            title="Limites padrão para agentes novos"
            description="Valores iniciais de cada agente criado a partir daqui. Cada agente também tem os seus, na gaveta dele."
          >
            <div className="settings-grid">
              <NumberField
                label="Passos máximos"
                hint="De 1 a 200."
                min={1}
                max={200}
                value={draft.defaultLimits.maxSteps}
                onChange={(value) => setLimit('maxSteps', value)}
              />
              <NumberField
                label="Tokens por tarefa"
                hint="Prompt e resposta juntos."
                min={1_000}
                max={10_000_000}
                step={1_000}
                value={draft.defaultLimits.maxTokens}
                onChange={(value) => setLimit('maxTokens', value)}
              />
              <NumberField
                label="Tempo limite de comando (s)"
                hint="De 5 a 3.600 segundos."
                min={5}
                max={3_600}
                value={draft.defaultLimits.commandTimeoutSec}
                onChange={(value) => setLimit('commandTimeoutSec', value)}
              />
              <NumberField
                label="Tempo limite da tarefa (min)"
                hint="De 1 a 600 minutos."
                min={1}
                max={600}
                value={draft.defaultLimits.taskTimeoutMin}
                onChange={(value) => setLimit('taskTimeoutMin', value)}
              />
              <Field label="Temperatura" hint="De 0 a 2. Vazio usa o padrão do modelo.">
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  placeholder="padrão do modelo"
                  value={draft.defaultLimits.temperature ?? ''}
                  onChange={(event) => {
                    if (event.target.value === '') return setLimit('temperature', null);
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) setLimit('temperature', value);
                  }}
                />
              </Field>
            </div>
            <div className="settings-apply">
              <button
                className="secondary"
                disabled={task.running}
                onClick={() =>
                  void task.run(async () => {
                    // Each agent keeps its own temperature: it is tuned to its model.
                    for (const worker of workers)
                      await window.hive.invoke('worker.save', {
                        ...worker,
                        limits: { ...draft.defaultLimits, temperature: worker.limits.temperature },
                      });
                    await refresh();
                    notify(`Limites aplicados a ${workers.length} agentes.`);
                  })
                }
              >
                Aplicar a todos os agentes
              </button>
              <small>
                Passos, tokens e tempos acima passam a valer para os agentes que já existem.
              </small>
            </div>
          </Section>
        </>
      ),
    },
    {
      id: 'approval',
      category: 'agents',
      title: 'Aprovação de comandos',
      keywords: 'terminal permitir perguntar liberar seguranca shell',
      keys: ['commandApproval'],
      node: (
        <>
          <Section
            title="Aprovação de comandos"
            description="Quando um agente quer rodar um comando no terminal. Os comandos rodam na cópia isolada da tarefa."
          >
            <div className="choice-list" role="radiogroup" aria-label="Aprovação de comandos">
              {approvalChoices.map((choice) => (
                <label key={choice.value} className="choice">
                  <input
                    type="radio"
                    name="command-approval"
                    checked={draft.commandApproval === choice.value}
                    onChange={() => set('commandApproval', choice.value)}
                  />
                  <span>
                    <strong>{choice.label}</strong>
                    <small>{choice.detail}</small>
                  </span>
                </label>
              ))}
            </div>
          </Section>
        </>
      ),
    },
    {
      id: 'parallel',
      category: 'missions',
      title: 'Tarefas em paralelo',
      keywords: 'execucao simultaneas concorrencia worktree',
      keys: ['maxConcurrentTasks'],
      node: (
        <>
          <Section
            title="Tarefas em paralelo"
            description="Quantas tarefas de agentes rodam ao mesmo tempo, somando todas as missões."
          >
            <Field
              label="Tarefas em paralelo"
              hint="Entre 1 e 8. Cada tarefa usa uma worktree própria."
            >
              <input
                type="number"
                min={1}
                max={8}
                value={draft.maxConcurrentTasks}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (event.target.value !== '' && Number.isFinite(value))
                    set('maxConcurrentTasks', value);
                }}
              />
            </Field>
          </Section>
        </>
      ),
    },
    {
      id: 'replanning',
      category: 'missions',
      title: 'Replanejamento adaptativo',
      keywords: 'falha queen sugestoes caminho alternativo',
      keys: ['replanning'],
      node: (
        <>
          <Section
            title="Replanejamento adaptativo"
            description="Quando uma tarefa falha de vez durante a execução, as que dependem dela esperam e a Queen propõe outro caminho no Nexus. Nada muda sem a sua aprovação."
          >
            <label className="settings-check">
              <input
                type="checkbox"
                checked={draft.replanning.enabled}
                onChange={(event) =>
                  set('replanning', { ...draft.replanning, enabled: event.target.checked })
                }
              />
              Propor outro caminho quando uma tarefa falhar
              <span className="hint">
                Desligado, as tarefas que dependem da que falhou são canceladas na hora, como antes.
              </span>
            </label>
            <div className="settings-grid">
              <NumberField
                label="Replanejamentos por tarefa"
                hint="De 1 a 3. Conta a substituta que falhar de novo."
                min={1}
                max={3}
                value={draft.replanning.maxPerTask}
                onChange={(value) => set('replanning', { ...draft.replanning, maxPerTask: value })}
              />
              <NumberField
                label="Sugestões por missão"
                hint="De 1 a 10, aprovadas ou não. Cada uma consome tokens da Queen."
                min={1}
                max={10}
                value={draft.replanning.maxPerRun}
                onChange={(value) => set('replanning', { ...draft.replanning, maxPerRun: value })}
              />
            </div>
          </Section>
        </>
      ),
    },
    {
      id: 'budget',
      category: 'models',
      title: 'Orçamento de tokens',
      keywords: 'diario consumo uso limite gasto provedores chave conta chatgpt',
      keys: ['dailyTokenBudget'],
      node: (
        <>
          <Section
            title="Orçamento de tokens"
            description="Quanto os agentes podem gastar por dia. Aparece na barra lá embaixo e no bloco Tokens do Nexus."
          >
            <NumberField
              label="Orçamento diário de tokens"
              hint="O 100% do bloco Tokens. Use 0 para esconder a barra."
              min={0}
              max={1_000_000_000}
              step={100_000}
              value={draft.dailyTokenBudget}
              onChange={(value) => set('dailyTokenBudget', value)}
            />
            <div className="settings-apply">
              <button className="secondary" onClick={() => go('providers')}>
                <Plug size={13} /> Gerenciar provedores
              </button>
              <small>Chaves, contas (como o ChatGPT) e modelos ficam na página Provedores.</small>
            </div>
          </Section>
        </>
      ),
    },
    {
      id: 'failover',
      category: 'models',
      title: 'Troca automática de modelo',
      keywords: 'failover reserva provedor gratuito free 429 cota',
      keys: ['failover'],
      node: (
        <>
          <Section
            title="Troca automática de modelo"
            description="Quando um modelo esgota (limite 429, cota diária, sem créditos, modelo removido), a tarefa segue na hora em outro modelo ou provedor e volta ao principal quando ele libera."
          >
            <div className="choice-list">
              {(
                [
                  [
                    'enabled',
                    'Trocar de modelo automaticamente',
                    'Desligado, o agente espera o mesmo modelo liberar, como antes.',
                  ],
                  [
                    'automatic',
                    'Usar os outros provedores cadastrados',
                    'Depois das reservas de cada agente, o Hive escolhe modelos dos outros provedores pelo papel do agente.',
                  ],
                  [
                    'freeOnly',
                    'Só modelos gratuitos no pool automático',
                    'Em gateways (Kilo, OpenRouter) só modelos “:free”; provedores sem plano grátis ficam de fora.',
                  ],
                ] as const
              ).map(([key, label, detail]) => (
                <label key={key} className="choice">
                  <input
                    type="checkbox"
                    checked={draft.failover[key]}
                    disabled={key !== 'enabled' && !draft.failover.enabled}
                    onChange={(event) =>
                      set('failover', { ...draft.failover, [key]: event.target.checked })
                    }
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </span>
                </label>
              ))}
            </div>
          </Section>
        </>
      ),
    },
    {
      id: 'mcp',
      category: 'integrations',
      title: 'Servidores MCP',
      keywords: 'mcp ferramentas servidores conectores',
      keys: ['mcpServers'],
      node: (
        <>
          <McpServersSection
            servers={draft.mcpServers}
            onChange={(servers) => set('mcpServers', servers)}
          />
        </>
      ),
    },
    {
      id: 'skills',
      category: 'integrations',
      title: 'Skills',
      keywords: 'skillforge catalogo pasta validar cli',
      keys: ['skillforgeCatalogPath', 'skillforgeCliValidation'],
      node: (
        <>
          <Section title="Skills" description="De onde o Hive carrega o catálogo de skills.">
            <div className="settings-field">
              <span>Catálogo SkillForge</span>
              <div className="settings-path">
                <code title={draft.skillforgeCatalogPath ?? undefined}>
                  {draft.skillforgeCatalogPath ?? 'Nenhuma pasta escolhida'}
                </code>
                <button className="secondary" disabled={task.running} onClick={pickCatalog}>
                  <FolderOpen size={13} /> Escolher pasta
                </button>
                {draft.skillforgeCatalogPath && (
                  <button
                    className="icon-button"
                    title="Remover pasta"
                    aria-label="Remover pasta"
                    disabled={task.running}
                    onClick={clearCatalog}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <small>Pasta com as skills do catálogo.</small>
            </div>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={draft.skillforgeCliValidation}
                onChange={(event) => set('skillforgeCliValidation', event.target.checked)}
              />
              Validar skills com o CLI do SkillForge
            </label>
          </Section>
        </>
      ),
    },
    {
      id: 'backup',
      category: 'system',
      title: 'Backup',
      keywords: 'copia seguranca restaurar banco dados',
      keys: ['backup'],
      node: (
        <>
          <BackupSection value={draft.backup} onChange={(value) => set('backup', value)} />
        </>
      ),
    },
    {
      id: 'updates',
      category: 'system',
      title: 'Atualizações',
      keywords: 'versao update automatica',
      keys: ['updates'],
      node: (
        <>
          <UpdatesSection value={draft.updates} onChange={(value) => set('updates', value)} />
        </>
      ),
    },
    {
      id: 'appearance',
      category: 'system',
      title: 'Aparência',
      keywords: 'animacoes movimento interface tema',
      keys: ['reduceMotion', 'density'],
      node: (
        <>
          <Section title="Aparência" description="Como a interface se comporta.">
            <label className="settings-check">
              <input
                type="checkbox"
                checked={draft.reduceMotion === 'on'}
                onChange={(event) => set('reduceMotion', event.target.checked ? 'on' : 'system')}
              />
              Reduzir animações sempre
              <span className="hint">Por padrão, o Hive segue a preferência do sistema.</span>
            </label>
          </Section>
        </>
      ),
    },
  ];

  const changed = (keys: (keyof Settings)[]) =>
    keys.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(settings[key]));
  const words = normalize(query.trim()).split(/\s+/).filter(Boolean);
  const results = words.length
    ? blocks.filter((block) => {
        const text = normalize(`${block.title} ${block.keywords}`);
        return words.every((word) => text.includes(word));
      })
    : null;
  const shown = results ?? blocks.filter((block) => block.category === tab);
  const current = categories.find((category) => category.id === tab)!;

  return (
    <div className="settings settings-layout">
      <nav className="settings-nav" aria-label="Categorias de configurações">
        <label className="settings-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            placeholder="Buscar configuração…"
            aria-label="Buscar configuração"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {categories.map(({ id, label, detail, icon: Icon }) => {
          const dirtyHere = changed(
            blocks.filter((block) => block.category === id).flatMap((block) => block.keys),
          );
          return (
            <button
              key={id}
              type="button"
              className={`settings-nav-item${!results && tab === id ? ' selected' : ''}`}
              aria-current={!results && tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={16} aria-hidden />
              <span>
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
              {dirtyHere && <i className="settings-nav-dot" title="Alterações não salvas" />}
            </button>
          );
        })}
      </nav>

      <div className="settings-content">
        <header className="settings-content-head">
          {results ? (
            <>
              <strong>Resultados para “{query.trim()}”</strong>
              <small>
                {results.length
                  ? `${results.length} ${results.length === 1 ? 'seção' : 'seções'}`
                  : 'Nada encontrado. Tente outra palavra, como “tokens”, “backup” ou “comandos”.'}
              </small>
            </>
          ) : (
            <>
              <strong>{current.label}</strong>
              <small>{current.detail}</small>
            </>
          )}
        </header>
        {shown.map((block) => (
          <div key={block.id} className="settings-block">
            {results && (
              <span className="settings-block-path">
                {categories.find((category) => category.id === block.category)!.label}
              </span>
            )}
            {block.node}
          </div>
        ))}
        <footer className="settings-savebar">
          <span className={dirty ? 'settings-dirty' : 'settings-dirty clean'}>
            {task.error ? (
              <span role="alert" className="error-text">
                {task.error}
              </span>
            ) : dirty ? (
              'Alterações não salvas'
            ) : (
              'Tudo salvo'
            )}
          </span>
          <button className="secondary" disabled={task.running} onClick={restoreDefaults}>
            <RotateCcw size={13} /> Restaurar padrões
          </button>
          <button disabled={!dirty || task.running} onClick={save}>
            <Save size={13} /> {task.running ? 'Salvando…' : 'Salvar'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="card settings-section">
      <header>
        <strong>{title}</strong>
        <small>{description}</small>
      </header>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (event.target.value !== '' && Number.isFinite(next)) onChange(next);
        }}
      />
    </Field>
  );
}
