import { useState } from 'react';
import { Check, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { providerPresets, type ProviderConfig } from '@hive/core';
import { hasAccess, useHive } from './context';
import { Mascot } from './mascot';
import { Dot, Empty, PageHeader, runTone, statusLabels, useTask } from './ui';

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
        leading={<Mascot size={64} mood={summary?.activeTasks.length ? 'working' : 'idle'} />}
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
                    (providerPresets[provider.kind].keyOptional ? 'sem chave' : 'falta chave')}
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
