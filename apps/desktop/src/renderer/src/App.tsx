import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  BookOpen,
  ChevronDown,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  Hexagon,
  Info,
  Settings as SettingsIcon,
  LayoutGrid,
  Plug,
  Plus,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Timer,
  X,
} from 'lucide-react';
import type {
  AgentEvent,
  AppInfo,
  DashboardSummary,
  ProviderConfig,
  RunDetail,
  SkillSummary,
  TerminalEvent,
  Settings,
  Worker,
  Workspace,
} from '@hive/core';
import { Hive, hasAccess, message, type HiveContext, type ModalState, type View } from './context';
import { MissionPage } from './mission';
import { RunPage } from './run';
import { hasUnsavedChanges, projectHasUnsavedChanges, useCode } from './code/store';
import { ProjectTabs } from './project-tabs';
import { SettingsPage } from './settings';
import { ShiftPage } from './shift';
import { SearchPage } from './search';
import { MissionCards, type SidebarMission } from './mission-cards';

// Monaco is large; it loads the first time the code view opens.
const CodeView = lazy(() => import('./code/CodeView'));
import { ModalHost } from './modals';
import { SplashScreen } from './splash';
import { AgentsPage } from './agents';
import { Mascot } from './mascot';
import { TokenMeter } from './token-meter';
import { AboutPage, OverviewPage, ProvidersPage, SkillsPage } from './pages';
import { Dot } from './ui';

const navigation: { view: View; label: string; icon: typeof Bot }[] = [
  { view: 'overview', label: 'Visão geral', icon: LayoutGrid },
  { view: 'search', label: 'Buscar', icon: Search },
  { view: 'code', label: 'Código', icon: Code2 },
  { view: 'run', label: 'Rodar', icon: SquareTerminal },
  { view: 'shift', label: 'Modo Turno', icon: Timer },
  { view: 'agents', label: 'Agentes', icon: Bot },
  { view: 'providers', label: 'Provedores', icon: Plug },
  { view: 'skills', label: 'Skills', icon: BookOpen },
];
const viewTitles: Record<View, string> = {
  overview: 'Visão geral',
  search: 'Buscar',
  mission: 'Missão',
  code: 'Código',
  run: 'Rodar projeto',
  shift: 'Modo Turno',
  agents: 'Agentes',
  providers: 'Provedores',
  skills: 'Skills',
  about: 'Sobre',
  settings: 'Configurações',
};

export function App() {
  const [view, setView] = useState<View>('overview');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tabs, setTabs] = useState<Workspace[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [missionsByProject, setMissionsByProject] = useState<Record<string, SidebarMission[]>>({});
  // Projects whose mission list the user collapsed; every project starts expanded.
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  // Project in front; file events from other projects are ignored.
  const focusedId = useRef<string | null>(null);
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
  const fileListeners = useRef(new Set<(paths: string[]) => void>());
  const terminalListeners = useRef(new Set<(event: TerminalEvent) => void>());
  // The "reduce animations" setting is applied as a class, so every animation can be turned off at once.
  useEffect(() => {
    document.documentElement.classList.toggle('motion-reduce', settings?.reduceMotion === 'on');
  }, [settings?.reduceMotion]);
  useEffect(() => {
    openRunId.current = detail?.run.id ?? null;
  }, [detail]);

  const refresh = useCallback(async () => {
    const [dashboard, spaces, agents, endpoints, library, appInfo, openTabs, appSettings] =
      await Promise.all([
        window.hive.invoke('dashboard.summary'),
        window.hive.invoke('workspace.list'),
        window.hive.invoke('worker.list'),
        window.hive.invoke('provider.list'),
        window.hive.invoke('skill.list'),
        window.hive.invoke('app.info'),
        window.hive.invoke('workspace.tabs'),
        window.hive.invoke('settings.get'),
      ]);
    // Every known project lists its own missions in the sidebar.
    const lists = await Promise.all(
      spaces.map(async (space) => {
        const list = await window.hive
          .invoke('mission.list', { workspaceId: space.id })
          .catch(() => []);
        return [space.id, list] as const;
      }),
    );
    setMissionsByProject(Object.fromEntries(lists));
    setSummary(dashboard);
    setTabs(openTabs);
    setSettings(appSettings);
    const nextFocus = dashboard.workspace?.id ?? null;
    focusedId.current = nextFocus;
    // Each project keeps its own editor state; the documents of the new one are checked on disk.
    if (useCode.getState().project !== nextFocus) {
      useCode.getState().switchTo(nextFocus);
      void import('./code/monaco').then(({ syncFromDisk, openPaths }) => syncFromDisk(openPaths()));
    }
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
  const onFiles = useCallback((listener: (paths: string[]) => void) => {
    fileListeners.current.add(listener);
    return () => {
      fileListeners.current.delete(listener);
    };
  }, []);
  // Closing the window with unsaved editor files asks first (see will-prevent-unload in main).
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  const onEvent = useCallback((listener: (event: AgentEvent) => void) => {
    eventListeners.current.add(listener);
    return () => {
      eventListeners.current.delete(listener);
    };
  }, []);
  const onTerminal = useCallback((listener: (event: TerminalEvent) => void) => {
    terminalListeners.current.add(listener);
    return () => {
      terminalListeners.current.delete(listener);
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
      if (push.kind === 'files') {
        if (push.workspaceId !== focusedId.current) return;
        for (const listener of fileListeners.current) listener(push.paths);
        return;
      }
      if (push.kind === 'terminal') {
        for (const listener of terminalListeners.current) listener(push.event);
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
      onFiles,
      onTerminal,
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
          const picked = await window.hive.invoke('workspace.pick');
          if (picked?.status === 'needs-init') {
            const create = window.confirm(
              `"${picked.name}" não é um repositório Git.\n\nO Hive vai criar um repositório local nessa pasta e registrar os arquivos atuais num commit inicial. Nada é enviado para a internet.\n\nContinuar?`,
            );
            if (!create) return;
            const workspace = await window.hive.invoke('workspace.initialize', {
              path: picked.path,
            });
            setDetail(null);
            notify(`Repositório ${workspace.name} criado e aberto.`);
          } else if (picked?.status === 'opened') {
            setDetail(null);
            notify(`Repositório ${picked.workspace.name} aberto.`);
          }
          await refresh();
        } catch (failure) {
          fail(failure);
        }
      },
    };
  }, [
    summary,
    workspaces,
    workers,
    providers,
    skills,
    info,
    detail,
    refresh,
    onEvent,
    onFiles,
    onTerminal,
  ]);

  const activeWorkspace = summary?.workspace ?? null;
  const queen = workers.find((worker) => worker.role === 'queen');
  const connected = providers.filter(hasAccess);
  const page = view === 'mission' && !detail ? 'overview' : view;
  const approvals = summary?.pendingApprovals ?? [];
  // The editor stays mounted after its first visit, so tabs and the tree survive navigation.
  const [codeVisited, setCodeVisited] = useState(false);
  if (page === 'code' && !codeVisited) setCodeVisited(true);
  const activeTasks = summary?.activeTasks.length ?? 0;

  // Ctrl+Shift+F searches the whole project from anywhere, as in VS Code.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setView('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  /** Opens a mission; a mission of another project brings that project to the front first. */
  async function openProjectMission(workspace: Workspace, id: string) {
    if (workspace.id !== activeWorkspace?.id) await activate(workspace);
    await context.openMission(id);
  }

  async function pinMission(id: string, pinned: boolean) {
    try {
      await window.hive.invoke('mission.pin', { id, pinned });
      await refresh();
    } catch (failure) {
      context.fail(failure);
    }
  }

  async function closeProject(workspace: Workspace) {
    if (projectHasUnsavedChanges(workspace.id)) {
      context.fail(
        new Error(`Salve ou descarte as alterações de ${workspace.name} antes de fechar a aba.`),
      );
      return;
    }
    try {
      if (workspace.id === activeWorkspace?.id) setDetail(null);
      await window.hive.invoke('workspace.close', workspace.id);
      await refresh();
      const { disposeProjectDocs } = await import('./code/monaco');
      disposeProjectDocs(workspace.id);
      useCode.getState().dropProject(workspace.id);
    } catch (failure) {
      context.fail(failure);
    }
  }

  if (!ready && !error) return <SplashScreen />;

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

        <ProjectTabs
          tabs={tabs}
          activeId={activeWorkspace?.id ?? null}
          onActivate={(workspace) => void activate(workspace)}
          onClose={(workspace) => void closeProject(workspace)}
          onOpen={() => void context.pickWorkspace()}
        />
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
              const open = !collapsedProjects.includes(workspace.id);
              const missions = missionsByProject[workspace.id] ?? [];
              return (
                <div key={workspace.id} className={active ? 'tree-group active' : 'tree-group'}>
                  {/* One row: a click opens another project with its missions shown, and on
                      the open project it shows or hides the missions. */}
                  <button
                    className="tree-root"
                    aria-expanded={open}
                    title={open && active ? 'Recolher missões' : 'Abrir projeto e missões'}
                    onClick={() => {
                      const collapse = active && open;
                      setCollapsedProjects((current) =>
                        collapse
                          ? [...current, workspace.id]
                          : current.filter((id) => id !== workspace.id),
                      );
                      if (!active) void activate(workspace);
                    }}
                  >
                    <ChevronDown size={13} className={open ? 'chevron open' : 'chevron'} />
                    {active ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span className="truncate">{workspace.name}</span>
                    <span className="count">{missions.length}</span>
                  </button>
                  {open && (
                    <div className="tree-missions">
                      <MissionCards
                        missions={missions}
                        selectedId={
                          active && page === 'mission' ? (detail?.mission.id ?? null) : null
                        }
                        onOpen={(id) => void openProjectMission(workspace, id)}
                        onPin={(id, pinned) => void pinMission(id, pinned)}
                      />
                      {active && (
                        <button
                          className="tree-item add"
                          onClick={() => setModal({ kind: 'mission' })}
                        >
                          <Plus size={13} /> Nova missão
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="sidebar-bottom">
            <button
              className={page === 'settings' ? 'nav-item selected' : 'nav-item'}
              onClick={() => setView('settings')}
            >
              <SettingsIcon size={15} /> Configurações
            </button>
            <button
              className={page === 'about' ? 'nav-item selected' : 'nav-item'}
              onClick={() => setView('about')}
            >
              <Info size={15} /> Sobre
            </button>
          </div>
        </aside>

        <main
          className={
            page === 'code' ? 'content code-mode' : page === 'run' ? 'content run-mode' : 'content'
          }
        >
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
          {codeVisited && (
            <div className="code-host" hidden={page !== 'code'}>
              <Suspense fallback={<p role="status">Carregando o editor…</p>}>
                <CodeView />
              </Suspense>
            </div>
          )}
          <div className={page === 'run' ? 'page page-full' : 'page'} hidden={page === 'code'}>
            {page === 'overview' && <OverviewPage />}
            {page === 'search' && <SearchPage key={activeWorkspace?.id ?? 'none'} />}
            {page === 'mission' && <MissionPage />}
            {page === 'run' && <RunPage key={activeWorkspace?.id ?? 'none'} />}
            {page === 'agents' && <AgentsPage />}
            {page === 'providers' && <ProvidersPage />}
            {page === 'skills' && <SkillsPage />}
            {page === 'about' && <AboutPage />}
            {page === 'settings' && <SettingsPage settings={settings} onSaved={refresh} />}
            {page === 'shift' && <ShiftPage settings={settings} onSaved={refresh} />}
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
              <Mascot size={18} mood="working" /> {activeTasks} tarefa(s) em execução
            </span>
          )}
          {approvals.length > 0 && (
            <span className="warn-text">{approvals.length} aprovação(ões) pendente(s)</span>
          )}
          {summary?.today && <TokenMeter usage={summary.today} />}
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
