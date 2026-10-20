import { useState } from 'react';
import {
  Check,
  KeyRound,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { ProviderConfig, RecommendedSetup, Worker } from '@hive/core';
import { hasAccess, useHive } from './context';
import { SetupResult } from './modals';
import { Dot, Empty, PageHeader, Select, runTone, statusLabels, useTask } from './ui';

export function OverviewPage() {
  const { summary, providers, workers, openModal, pickWorkspace, openMission } = useHive();
  const workspace = summary?.workspace ?? null;
  const connected = providers.filter(hasAccess);
  const queen = workers.find((worker) => worker.role === 'queen');
  const missions = summary?.recentMissions ?? [];
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
        : 'Cole a chave de API; testamos na hora.',
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
      done: missions.some((mission) => mission.lastRunStatus === 'awaiting_plan_approval'),
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
  return (
    <>
      <PageHeader
        eyebrow="Central de trabalho"
        title="Vamos construir."
        description="Conecte seu projeto, prepare a equipe e planeje sua próxima missão."
      >
        <button disabled={!workspace} onClick={() => openModal({ kind: 'mission' })}>
          <Plus size={15} /> Nova missão
        </button>
      </PageHeader>
      <section className="card">
        <div className="card-heading">
          <h2>Primeiros passos</h2>
          <span className="muted">
            {steps.filter((step) => step.done).length}/{steps.length}
          </span>
        </div>
        <ol className="steps">
          {steps.map((step) => (
            <li key={step.title} className={step.done ? 'done' : ''}>
              <span className="step-mark">{step.done && <Check size={12} strokeWidth={3} />}</span>
              <div>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </div>
              {step.action}
            </li>
          ))}
        </ol>
        <p className="hint">
          Cada tarefa roda numa cópia isolada do projeto (worktree Git). Nada muda no seu código até
          você revisar e clicar em “Aplicar no projeto”.
        </p>
      </section>
      <section className="card">
        <div className="card-heading">
          <h2>Missões recentes</h2>
          <span className="muted">{workspace?.name ?? 'Sem repositório'}</span>
        </div>
        {missions.length ? (
          <div className="rows">
            {missions.map((mission) => (
              <button key={mission.id} className="row" onClick={() => void openMission(mission.id)}>
                <Dot tone={runTone(mission.lastRunStatus)} />
                <span className="row-title">{mission.title}</span>
                <span className="badge">{statusLabels[mission.lastRunStatus ?? 'draft']}</span>
              </button>
            ))}
          </div>
        ) : (
          <Empty>Suas missões aparecerão aqui.</Empty>
        )}
      </section>
    </>
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
                <Dot tone={testing === provider.id ? 'busy' : tone} />
                <div className="row-main">
                  <span className="row-title">{provider.name}</span>
                  <small>
                    <code>{provider.baseUrl}</code>
                    {provider.lastTest && ` · ${provider.lastTest.message}`}
                  </small>
                </div>
                <span className="badge">
                  {provider.credentialHint ??
                    (provider.kind === 'openai-compatible' ? 'sem chave' : 'falta chave')}
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
                    title="Trocar chave"
                    onClick={() => openModal({ kind: 'key', provider })}
                  >
                    <KeyRound size={14} /> Chave
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
            Nenhum provedor ainda. NVIDIA, OpenAI, Groq, DeepSeek, OpenRouter ou um servidor local.
          </Empty>
        </section>
      )}
    </>
  );
}

const roleOrder: Worker['role'][] = [
  'queen',
  'architect',
  'frontend',
  'backend',
  'qa',
  'reviewer',
  'custom',
];

export function AgentsPage() {
  const { workers, providers, openModal } = useHive();
  const usable = providers.filter(hasAccess);
  return (
    <>
      <PageHeader
        eyebrow="Sua equipe"
        title="Agentes"
        description="Escolha o provedor: o modelo certo para a função é escolhido e testado automaticamente."
      >
        <button disabled={!usable.length} onClick={() => openModal({ kind: 'team' })}>
          <Sparkles size={15} /> Configurar equipe
        </button>
      </PageHeader>
      {!usable.length && (
        <p className="hint">
          Adicione um provedor com chave na aba Provedores para configurar os agentes.
        </p>
      )}
      <div className="agent-grid">
        {[...workers]
          .sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role))
          .map((worker) => (
            <AgentCard key={worker.id} worker={worker} />
          ))}
      </div>
    </>
  );
}

function AgentCard({ worker }: { worker: Worker }) {
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
  return (
    <section className="card agent-card">
      <div className="card-heading">
        <span className="agent-role">{worker.role.toUpperCase()}</span>
        {worker.modelId && !task.running && <Dot tone={setup ? 'ok' : 'idle'} />}
      </div>
      <h2>{worker.name}</h2>
      <p>{worker.description}</p>
      <label>
        Provedor
        <Select
          value={providerId}
          disabled={task.running}
          placeholder="Selecione um provedor"
          onChange={choose}
          options={[
            ...(worker.providerId ? [{ value: '', label: 'Nenhum provedor' }] : []),
            ...usable.map((provider) => ({ value: provider.id, label: provider.name })),
          ]}
        />
      </label>
      <div className="model-line">
        {task.running ? (
          <span className="progress">Escolhendo e testando o modelo…</span>
        ) : (
          <>
            <code>{worker.modelId ?? 'sem modelo'}</code>
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
      </div>
      {failed && setup && <SetupResult setup={setup} />}
      {task.error && (
        <p role="alert" className="form-error">
          {task.error}
        </p>
      )}
    </section>
  );
}

export function SkillsPage() {
  const { skills, refresh, notify, fail } = useHive();
  const task = useTask();
  return (
    <>
      <PageHeader
        eyebrow="Conhecimento"
        title="Skills"
        description="Conecte um catálogo SkillForge para consultar e instalar instruções."
      >
        <button
          disabled={task.running}
          onClick={() =>
            void task.run(async () => {
              await window.hive.invoke('skill.pickCatalog');
              await refresh();
            })
          }
        >
          <Plus size={15} /> Conectar catálogo
        </button>
      </PageHeader>
      {skills.length ? (
        <div className="card rows flush">
          {skills.map((skill) => (
            <div key={`${skill.source}:${skill.name}`} className="row static">
              <div className="row-main">
                <span className="row-title">{skill.name}</span>
                <small>{skill.description}</small>
              </div>
              {skill.installed ? (
                <span className="badge">Instalada</span>
              ) : (
                <button
                  className="ghost"
                  onClick={() =>
                    void window.hive
                      .invoke('skill.install', skill.name)
                      .then(() => {
                        notify(`${skill.name} instalada.`);
                        return refresh();
                      })
                      .catch(fail)
                  }
                >
                  Instalar
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <section className="card">
          <Empty>Nenhuma skill disponível. Conecte uma pasta de catálogo para começar.</Empty>
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
