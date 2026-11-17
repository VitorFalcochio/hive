import { useEffect, useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  Check,
  Crown,
  FolderOpen,
  Gauge,
  KeyRound,
  Network,
  Plug,
  Plus,
  RefreshCw,
  SendHorizontal,
  Trash2,
  Users,
} from 'lucide-react';
import { beeColors, providerPresets, type ProviderConfig } from '@hive/core';
import { hasAccess, useHive, type MissionMode } from './context';
import { HoneyJar } from './honey';
import { Mascot } from './mascot';
import { ProviderLogo, providerColor } from './provider-logo';
import { Dot, Empty, PageHeader, Select, runTone, statusLabels, type SelectOption } from './ui';

const greetingFor = (hour: number) =>
  hour < 5 ? 'Boa noite' : hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const sinceFormat = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

/** "há 5 min", "ontem": how long since a project was last opened. */
function since(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (Math.abs(minutes) < 60) return sinceFormat.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return sinceFormat.format(hours, 'hour');
  return sinceFormat.format(Math.round(hours / 24), 'day');
}

const modeOptions: SelectOption[] = [
  { value: 'plan', label: 'Plano da Queen', hint: 'a Queen divide em tarefas' },
  { value: 'queue', label: 'Turno (fila)', hint: 'roda na fila do turno' },
  { value: 'compare', label: 'Comparar agentes', hint: 'vários fazem, você escolhe' },
];

/** A stable colour per project, from the bee palette. */
function projectColor(name: string): string {
  const colors = Object.values(beeColors).map((color) => color.hex);
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function OverviewPage() {
  const { summary, providers, workers, workspaces, openModal, pickWorkspace, openMission, go } =
    useHive();
  const { openWorkspace } = useHive();
  const now = useClock();
  const [objective, setObjective] = useState('');
  const [mode, setMode] = useState<MissionMode>('plan');
  const workspace = summary?.workspace ?? null;
  const connected = providers.filter(hasAccess);
  const queen = workers.find((worker) => worker.role === 'queen');
  const missions = summary?.recentMissions ?? [];
  const today = summary?.today;
  const used = today ? today.promptTokens + today.completionTokens : 0;
  const percent = today?.budget ? Math.min(100, Math.round((used / today.budget) * 100)) : null;
  const active = summary?.activeTasks.length ?? 0;
  const steps = [
    {
      title: 'Abra um repositório Git',
      detail: workspace ? workspace.name : 'Pasta com Git e pelo menos um commit.',
      done: !!workspace,
      action: (
        <button className="secondary" onClick={() => void pickWorkspace()}>
          {workspace ? 'Trocar' : 'Abrir repositório'}
        </button>
      ),
    },
    {
      title: 'Conecte um provedor de IA',
      detail: connected.length
        ? connected.map((provider) => provider.name).join(', ')
        : 'Uma chave de API ou a sua conta do ChatGPT; testamos na hora.',
      done: connected.length > 0,
      action: (
        <button className="secondary" onClick={() => openModal({ kind: 'provider' })}>
          Adicionar provedor
        </button>
      ),
    },
    {
      title: 'Configure a equipe',
      detail: queen?.modelId ? `Queen: ${queen.modelId}` : 'Um modelo testado para cada agente.',
      done: !!queen?.modelId,
      action: (
        <button
          className="secondary"
          disabled={!connected.length}
          onClick={() => openModal({ kind: 'team' })}
        >
          Configurar equipe
        </button>
      ),
    },
    {
      title: 'Crie uma missão e gere o plano',
      detail: missions.length
        ? `${missions.length} missão(ões) neste projeto.`
        : 'A Queen divide o objetivo em tarefas.',
      done: missions.length > 0,
      action: (
        <button
          className="secondary"
          disabled={!workspace}
          onClick={() => openModal({ kind: 'mission' })}
        >
          Nova missão
        </button>
      ),
    },
  ];
  const pending = steps.filter((step) => !step.done).length;
  const send = () => {
    if (!workspace || !objective.trim()) return;
    openModal({ kind: 'mission', objective: objective.trim(), mode });
    setObjective('');
  };

  return (
    <div className="home">
      <header className="home-hero">
        <Mascot size={52} mood={active ? 'working' : 'idle'} />
        <h1>{greetingFor(now.getHours())}.</h1>
        <p>
          {dateFormat.format(now).replace('.', '')} · {timeFormat.format(now)}
          {active > 0 &&
            ` · ${active} ${active === 1 ? 'agente trabalhando' : 'agentes trabalhando'}`}
        </p>
      </header>

      <form
        className="home-prompt"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="home-prompt-bar" aria-hidden>
          <i />
          <i />
          <i />
          <span>hive@{workspace?.name ?? 'sem-projeto'}:~</span>
        </div>
        <div className="home-prompt-input">
          <span aria-hidden>›</span>
          <textarea
            rows={2}
            maxLength={10000}
            value={objective}
            disabled={!workspace}
            aria-label="O que você quer construir?"
            placeholder={
              workspace ? 'O que você quer construir?' : 'Abra um projeto para começar uma missão.'
            }
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>
        <div className="home-prompt-foot">
          <button
            type="button"
            className="home-chip"
            title="Trocar de projeto"
            onClick={() => void pickWorkspace()}
          >
            <FolderOpen size={13} />
            <span className="truncate">{workspace?.name ?? 'Abrir projeto'}</span>
          </button>
          <button
            type="button"
            className="home-chip"
            title="Modelos dos agentes"
            onClick={() => go('agents')}
          >
            <Crown size={13} />
            <span className="truncate">{queen?.modelId ?? 'Queen sem modelo'}</span>
          </button>
          <div className="home-chip-select">
            <span className="home-chip-dot" aria-hidden />
            <Select
              size="sm"
              className="home-chip-trigger"
              ariaLabel="Modo da missão"
              value={mode}
              options={modeOptions}
              onChange={(value) => setMode(value as MissionMode)}
            />
          </div>
          <button
            className="home-send"
            aria-label="Criar missão"
            title="Criar missão (Enter)"
            disabled={!workspace || !objective.trim()}
          >
            <SendHorizontal size={15} />
          </button>
        </div>
      </form>

      <nav className="home-quick" aria-label="Atalhos">
        <button type="button" disabled={!workspace} onClick={() => openModal({ kind: 'mission' })}>
          <Plus size={14} /> Nova missão
        </button>
        <button type="button" onClick={() => void pickWorkspace()}>
          <FolderOpen size={14} /> Abrir projeto
        </button>
        <button type="button" onClick={() => void window.hive.invoke('window.openCanvas')}>
          <Network size={14} /> Abrir Workspace
        </button>
      </nav>

      {pending > 0 && (
        <section className="home-section">
          <h2 className="home-label">
            Primeiros passos{' '}
            <span>
              {steps.length - pending}/{steps.length}
            </span>
          </h2>
          <div className="home-card">
            <ol className="steps">
              {steps.map((step) => (
                <li key={step.title} className={step.done ? 'done' : ''}>
                  <span className="step-mark">
                    {step.done && <Check size={12} strokeWidth={3} />}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.detail}</small>
                  </div>
                  {step.action}
                </li>
              ))}
            </ol>
            <p className="hint">
              Cada tarefa roda numa cópia isolada do projeto (worktree Git). Nada muda no seu código
              até você revisar e clicar em “Aplicar no projeto”.
            </p>
          </div>
        </section>
      )}

      {workspaces.length > 0 && (
        <section className="home-section">
          <h2 className="home-label">
            Projetos <span>{workspaces.length}</span>
          </h2>
          <div className="home-projects">
            {workspaces.slice(0, 6).map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === workspace?.id ? 'home-project current' : 'home-project'}
                onClick={() => void openWorkspace(item)}
              >
                <span
                  className="home-project-mark"
                  style={{ '--mark': projectColor(item.name) } as CSSProperties}
                >
                  {item.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="home-project-text">
                  <strong className="truncate">{item.name}</strong>
                  <small className="truncate">
                    {item.id === workspace?.id
                      ? 'aberto agora'
                      : since(item.lastOpenedAt, now.getTime())}
                  </small>
                </span>
                <ArrowRight size={14} className="home-project-go" />
              </button>
            ))}
          </div>
        </section>
      )}

      {missions.length > 0 && (
        <section className="home-section">
          <h2 className="home-label">
            Missões recentes <span>{workspace?.name}</span>
          </h2>
          <div className="home-card rows">
            {missions.slice(0, 6).map((mission) => (
              <button key={mission.id} className="row" onClick={() => void openMission(mission.id)}>
                <Dot tone={runTone(mission.lastRunStatus)} />
                <span className="row-title">{mission.title}</span>
                <span className="badge">{statusLabels[mission.lastRunStatus ?? 'draft']}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="home-section">
        <h2 className="home-label">Uso e atividade</h2>
        <div className="home-stats">
          <article className="home-stat">
            <header>
              <Gauge size={14} /> Tokens hoje
              {active > 0 && <span className="home-live">ao vivo</span>}
            </header>
            <strong>{percent === null ? compact.format(used) : `${percent}%`}</strong>
            <div className="home-meter" aria-hidden>
              <span style={{ width: `${percent ?? 0}%` }} />
            </div>
            <small>
              {today?.budget
                ? `${compact.format(used)} de ${compact.format(today.budget)} do orçamento`
                : 'Sem orçamento diário definido'}
            </small>
          </article>
          <article className="home-stat">
            <header>
              <Plug size={14} /> Provedores
            </header>
            <strong>
              {connected.length}
              <span>/{providers.length}</span>
            </strong>
            <ul className="home-providers">
              {providers.slice(0, 3).map((provider) => (
                <li key={provider.id}>
                  <Dot
                    tone={
                      !hasAccess(provider)
                        ? 'idle'
                        : provider.lastTest?.ok === false
                          ? 'error'
                          : 'ok'
                    }
                  />
                  <span className="truncate">{provider.name}</span>
                </li>
              ))}
              {!providers.length && <li className="muted">Nenhum provedor ainda</li>}
            </ul>
          </article>
          <article className="home-stat">
            <header>
              <Users size={14} /> Equipe
            </header>
            <strong>
              {active}
              <span> {active === 1 ? 'tarefa ativa' : 'tarefas ativas'}</span>
            </strong>
            <small>
              {workers.length} agentes · <HoneyJar size={11} /> {summary?.honey?.today ?? 0} mel
              hoje
            </small>
            <button type="button" className="home-stat-link" onClick={() => go('agents')}>
              Ver agentes <ArrowRight size={12} />
            </button>
          </article>
        </div>
      </section>
    </div>
  );
}

export function ProvidersPage() {
  const { providers, workers, openModal, refresh, notify, fail } = useHive();
  const [testing, setTesting] = useState<string | null>(null);
  async function test(provider: ProviderConfig) {
    setTesting(provider.id);
    try {
      const result = await window.hive.invoke('provider.test', provider.id);
      if (result.ok) notify(`${provider.name}: ${result.message}`);
      else fail(new Error(result.message));
    } catch (error) {
      fail(error);
    } finally {
      setTesting(null);
      await refresh();
    }
  }
  async function remove(provider: ProviderConfig) {
    const users = workers.filter((worker) => worker.providerId === provider.id).length;
    const warning = users ? `\n\n${users} agente(s) usam este provedor e ficarão sem modelo.` : '';
    if (!window.confirm(`Remover o provedor "${provider.name}"?${warning}`)) return;
    try {
      await window.hive.invoke('provider.delete', provider.id);
      await refresh();
    } catch (error) {
      fail(error);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="Conexões"
        title="Provedores de IA"
        description="As chaves são criptografadas pelo sistema operacional."
      >
        <button onClick={() => openModal({ kind: 'provider' })}>
          <Plus size={15} /> Adicionar provedor
        </button>
      </PageHeader>
      {providers.length ? (
        <div className="card rows flush">
          {providers.map((provider) => {
            const tone = !hasAccess(provider)
              ? 'idle'
              : provider.lastTest
                ? provider.lastTest.ok
                  ? 'ok'
                  : 'error'
                : 'idle';
            return (
              <div className="row static" key={provider.id}>
                <span
                  className="provider-tile"
                  style={{ '--brand': providerColor(provider.kind) } as CSSProperties}
                  title={providerPresets[provider.kind].label}
                >
                  <ProviderLogo kind={provider.kind} size={20} />
                  <Dot tone={testing === provider.id ? 'busy' : tone} />
                </span>
                <div className="row-main">
                  <span className="row-title">{provider.name}</span>
                  <small>
                    <code>{provider.baseUrl}</code>
                    {provider.lastTest && ` · ${provider.lastTest.message}`}
                  </small>
                </div>
                <span className="badge">
                  {provider.credentialHint ??
                    (providerPresets[provider.kind].signIn
                      ? 'falta entrar'
                      : providerPresets[provider.kind].keyOptional
                        ? 'sem chave'
                        : 'falta chave')}
                </span>
                <div className="row-actions">
                  <button
                    className="ghost"
                    title="Testar conexão"
                    disabled={testing !== null}
                    onClick={() => void test(provider)}
                  >
                    <RefreshCw size={14} /> Testar
                  </button>
                  <button
                    className="ghost"
                    title={
                      providerPresets[provider.kind].signIn ? 'Conta do ChatGPT' : 'Trocar chave'
                    }
                    onClick={() => openModal({ kind: 'key', provider })}
                  >
                    <KeyRound size={14} />{' '}
                    {providerPresets[provider.kind].signIn ? 'Conta' : 'Chave'}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remover ${provider.name}`}
                    title="Remover"
                    onClick={() => void remove(provider)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <section className="card">
          <Empty
            action={
              <button onClick={() => openModal({ kind: 'provider' })}>
                <Plus size={15} /> Adicionar provedor
              </button>
            }
          >
            Nenhum provedor ainda. Sua assinatura do ChatGPT, NVIDIA, Groq, DeepSeek, OpenRouter ou
            um servidor local.
          </Empty>
        </section>
      )}
    </>
  );
}

export function AboutPage() {
  const { info } = useHive();
  return (
    <>
      <PageHeader
        eyebrow="Ambiente local"
        title="Sobre o Hive"
        description="Um workspace desktop para coordenar agentes de desenvolvimento."
      />
      <section className="card">
        <dl>
          <dt>Versão</dt>
          <dd>{info?.version}</dd>
          <dt>Electron / Node</dt>
          <dd>
            {info?.electron} / {info?.node}
          </dd>
          <dt>Dados locais</dt>
          <dd>
            <code>{info?.dataDir}</code>
          </dd>
          <dt>Armazenamento de chaves</dt>
          <dd>{info?.secretStorage.available ? 'Disponível' : 'Indisponível'}</dd>
        </dl>
        <p className="hint">
          O banco SQLite e as skills instaladas permanecem nesta pasta entre as sessões.
        </p>
      </section>
    </>
  );
}
