import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  BookOpen,
  Folder,
  FolderOpen,
  FolderPlus,
  Hexagon,
  Info,
  LayoutGrid,
  Plug,
  Plus,
  ShieldQuestion,
  X,
} from 'lucide-react';
import type {
  AgentEvent,
  AppInfo,
  DashboardSummary,
  ProviderConfig,
  RunDetail,
  SkillSummary,
  Worker,
  Workspace,
} from '@hive/core';
import { Hive, hasAccess, message, type HiveContext, type ModalState, type View } from './context';
import { MissionPage } from './mission';
import { ModalHost } from './modals';
import { AboutPage, AgentsPage, OverviewPage, ProvidersPage, SkillsPage } from './pages';
import { Dot, runTone, statusLabels } from './ui';

const navigation: { view: View; label: string; icon: typeof Bot }[] = [
  { view: 'overview', label: 'Visão geral', icon: LayoutGrid },
  { view: 'agents', label: 'Agentes', icon: Bot },
  { view: 'providers', label: 'Provedores', icon: Plug },
  { view: 'skills', label: 'Skills', icon: BookOpen },
];
const viewTitles: Record<View, string> = {
  overview: 'Visão geral',
  mission: 'Missão',
  agents: 'Agentes',
  providers: 'Provedores',
  skills: 'Skills',
  about: 'Sobre',
};

export function App() {
  const [view, setView] = useState<View>('overview');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openRunId = useRef<string | null>(null);
  const eventListeners = useRef(new Set<(event: AgentEvent) => void>());
  useEffect(() => {
    openRunId.current = detail?.run.id ?? null;
  }, [detail]);

  const refresh = useCallback(async () => {
    const [dashboard, spaces, agents, endpoints, library, appInfo] = await Promise.all([
      window.hive.invoke('dashboard.summary'),
      window.hive.invoke('workspace.list'),
      window.hive.invoke('worker.list'),
      window.hive.invoke('provider.list'),
      window.hive.invoke('skill.list'),
      window.hive.invoke('app.info'),
    ]);
    setSummary(dashboard);
    setWorkspaces(spaces);
    setWorkers(agents);
    setProviders(endpoints);
    setSkills(library);
    setInfo(appInfo);
    setReady(true);
    // Keep the open mission in sync with task and approval changes from the scheduler.
    const runId = openRunId.current;
    if (runId) {
      const fresh = await window.hive.invoke('run.get', runId).catch(() => null);
      if (fresh && openRunId.current === runId) setDetail(fresh);
    }
  }, []);
  const onEvent = useCallback((listener: (event: AgentEvent) => void) => {
    eventListeners.current.add(listener);
    return () => {
      eventListeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void refresh().catch((failure) => {
        if (alive) setError(message(failure));
      });
    load();
    // Agents emit many events; they go to listeners, and state reloads at most every 250 ms.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.hive.subscribe((push) => {
      if (!alive) return;
      if (push.kind === 'event') {
        for (const listener of eventListeners.current) listener(push.event);
        return;
      }
      timer ??= setTimeout(() => {
        timer = undefined;
        if (alive) load();
      }, 250);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const context = useMemo<HiveContext>(() => {
    const notify = (text: string) => {
      setError('');
      setNotice(text);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(''), 5000);
    };
    const fail = (failure: unknown) => setError(message(failure));
    return {
      summary,
      workspaces,
      workers,
      providers,
      skills,
      info,
      detail,
      setDetail,
      refresh,
      notify,
      fail,
      openModal: setModal,
      closeModal: () => setModal(null),
      go: setView,
      onEvent,
      async openRun(runId) {
        try {
          setDetail(await window.hive.invoke('run.get', runId));
          setView('mission');
        } catch (failure) {
          fail(failure);
        }
      },
      async openMission(id) {
        try {
          const mission = await window.hive.invoke('mission.get', id);
          const run = mission.runs[0];
          if (!run) return;
          setDetail(await window.hive.invoke('run.get', run.id));
          setView('mission');
        } catch (failure) {
          fail(failure);
        }
      },
      async pickWorkspace() {
        try {
          const workspace = await window.hive.invoke('workspace.pick');
          if (workspace) {
            setDetail(null);
            notify(`Repositório ${workspace.name} aberto.`);
          }
          await refresh();
        } catch (failure) {
          fail(failure);
        }
      },
    };
  }, [summary, workspaces, workers, providers, skills, info, detail, refresh, onEvent]);

  const activeWorkspace = summary?.workspace ?? null;
  const queen = workers.find((worker) => worker.role === 'queen');
  const connected = providers.filter(hasAccess);
  const page = view === 'mission' && !detail ? 'overview' : view;
  const approvals = summary?.pendingApprovals ?? [];
  const activeTasks = summary?.activeTasks.length ?? 0;

  async function activate(workspace: Workspace) {
    if (workspace.id === activeWorkspace?.id) return;
    try {
      setDetail(null);
      await window.hive.invoke('workspace.activate', workspace.id);
      await refresh();
      setView('overview');
    } catch (failure) {
      context.fail(failure);
    }
  }

  return (
    <Hive.Provider value={context}>
      <div className={`app-shell platform-${info?.platform ?? 'unknown'}`}>
        <div className="titlebar">
          <span className="titlebar-brand">
            <Hexagon size={15} strokeWidth={2.4} /> hive
          </span>
          <span className="titlebar-path">
            {activeWorkspace?.name ?? 'sem repositório'}
            <span className="sep">/</span>
            {page === 'mission' && detail ? detail.mission.title : viewTitles[page]}
          </span>
        </div>

        <aside className="sidebar">
          <nav aria-label="Navegação principal">
            {navigation.map(({ view: item, label, icon: Icon }) => (
              <button
                key={item}
                className={page === item ? 'nav-item selected' : 'nav-item'}
                aria-current={page === item ? 'page' : undefined}
                onClick={() => setView(item)}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </nav>

          <div className="sidebar-section">
            <span>Projetos</span>
            <button
              className="icon-button"
              aria-label="Abrir repositório"
              title="Abrir repositório"
              onClick={() => void context.pickWorkspace()}
            >
              <FolderPlus size={14} />
            </button>
          </div>
          <div className="tree">
            {!workspaces.length && (
              <button className="tree-empty" onClick={() => void context.pickWorkspace()}>
                Abrir um repositório Git
              </button>
            )}
            {workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspace?.id;
              const missions = active ? (summary?.recentMissions ?? []) : [];
              return (
                <div key={workspace.id} className={active ? 'tree-group active' : 'tree-group'}>
                  <button className="tree-root" onClick={() => void activate(workspace)}>
                    {active ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span className="truncate">{workspace.name}</span>
                    {active && <span className="count">{missions.length}</span>}
                  </button>
                  {active && (
                    <>
                      {missions.map((mission) => (
                        <button
                          key={mission.id}
                          className={
                            page === 'mission' && detail?.mission.id === mission.id
                              ? 'tree-item selected'
                              : 'tree-item'
                          }
                          onClick={() => void context.openMission(mission.id)}
                        >
                          <Dot tone={runTone(mission.lastRunStatus)} />
                          <span className="tree-text">
                            <span className="truncate">{mission.title}</span>
                            <small>{statusLabels[mission.lastRunStatus ?? 'draft']}</small>
                          </span>
                        </button>
                      ))}
                      <button
                        className="tree-item add"
                        onClick={() => setModal({ kind: 'mission' })}
                      >
                        <Plus size={13} /> Nova missão
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="sidebar-bottom">
            <button
              className={page === 'about' ? 'nav-item selected' : 'nav-item'}
              onClick={() => setView('about')}
            >
              <Info size={15} /> Sobre
            </button>
          </div>
        </aside>

        <main className="content">
          {!ready && !error && <p role="status">Carregando o Hive…</p>}
          {approvals.length > 0 &&
            !(page === 'mission' && approvals.some((a) => a.runId === detail?.run.id)) && (
              <button
                className="approval-banner"
                onClick={() => void context.openRun(approvals[0]!.runId)}
              >
                <ShieldQuestion size={15} />
                {approvals.length === 1
                  ? `${approvals[0]!.title}: ${approvals[0]!.detail}`
                  : `${approvals.length} comandos aguardando sua aprovação`}
                <span className="banner-action">Responder</span>
              </button>
            )}
          <div className="page">
            {page === 'overview' && <OverviewPage />}
            {page === 'mission' && <MissionPage />}
            {page === 'agents' && <AgentsPage />}
            {page === 'providers' && <ProvidersPage />}
            {page === 'skills' && <SkillsPage />}
            {page === 'about' && <AboutPage />}
          </div>
        </main>

        <footer className="statusbar">
          <span>
            <Dot tone={ready ? 'ok' : 'busy'} /> {ready ? 'Local' : 'Iniciando'}
          </span>
          <span>
            {connected.length}/{providers.length} provedores
          </span>
          <span>
            Queen <code>{queen?.modelId ?? 'sem modelo'}</code>
          </span>
          <span className="spacer" />
          {activeTasks > 0 && (
            <span>
              <Dot tone="busy" /> {activeTasks} tarefa(s) em execução
            </span>
          )}
          {approvals.length > 0 && (
            <span className="warn-text">{approvals.length} aprovação(ões) pendente(s)</span>
          )}
          <span>
            {workers.filter((worker) => worker.modelId).length}/{workers.length} agentes
          </span>
          <span>v{info?.version ?? '0.1.0'}</span>
        </footer>

        <div className="toasts">
          {error && (
            <div role="alert" className="toast error">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Fechar aviso"
                onClick={() => setError('')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="toast">
              <span>{notice}</span>
            </div>
          )}
        </div>
        <ModalHost modal={modal} />
      </div>
    </Hive.Provider>
  );
}
