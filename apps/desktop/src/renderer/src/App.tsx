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
  SlidersHorizontal,
  LayoutGrid,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Timer,
  X,
  ShieldCheck,
  Globe,
} from 'lucide-react';
import type {
  AgentEvent,
  AppInfo,
  HivePush,
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
import { isWaiting, MissionPage } from './mission';
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
import { SplashScreen, useSplash } from './splash';
import { AgentsPage } from './agents';
import { AgentChatPage, chatAgents } from './agent-chat';
import { AgentBee } from './mascot';
import { TokenMeter } from './token-meter';
import { HoneyMeter } from './honey';
import { AboutPage, OverviewPage, ProvidersPage } from './pages';
import { HiveField } from './home-field';
import { SkillsPage } from './skills';
import { GuardianPage } from './guardian';
import { BrowserPage } from './browser';
import { Dot } from './ui';

const navigation: { view: View; label: string; icon: typeof Bot }[] = [
  { view: 'overview', label: 'Visão geral', icon: LayoutGrid },
  { view: 'search', label: 'Buscar', icon: Search },
  { view: 'code', label: 'Código', icon: Code2 },
  { view: 'run', label: 'Terminal', icon: SquareTerminal },
  { view: 'shift', label: 'Modo Turno', icon: Timer },
  // 'agents' is drawn on its own, as the Agentes accordion, between these two.
  { view: 'providers', label: 'Provedores', icon: Plug },
  { view: 'skills', label: 'Skills', icon: BookOpen },
  { view: 'browser', label: 'Navegador', icon: Globe },
  { view: 'guardian', label: 'Guardian', icon: ShieldCheck },
];
/** A sidebar layout choice remembered on this machine; storage may be unavailable. */
function useRemembered(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const remember = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // Only a convenience: the next visit starts expanded.
      }
    },
    [key],
  );
  return [value, remember];
}

const viewTitles: Record<View, string> = {
  overview: 'Visão geral',
  search: 'Buscar',
  mission: 'Missão',
  code: 'Código',
  run: 'Terminal',
  shift: 'Modo Turno',
  agents: 'Agentes',
  agentChat: 'Agentes',
  providers: 'Provedores',
  skills: 'Skills',
  guardian: 'Guardian',
  browser: 'Navegador',
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
  // The whole sidebar shrinks to an icon rail; the menu alone can shrink to one row of icons.
  const [railed, setRailed] = useRemembered('hive.sidebar.railed');
  const [menuCompact, setMenuCompact] = useRemembered('hive.sidebar.menuCompact');
  // The Agentes accordion starts open; closing it is remembered on this machine.
  const [agentsClosed, setAgentsClosed] = useRemembered('hive.sidebar.agentsClosed');
  // The agent whose Direct Agent Chat is open (view 'agentChat').
  const [chatWorkerId, setChatWorkerId] = useState<string | null>(null);
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
  const splash = useSplash(!ready && !error);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openRunId = useRef<string | null>(null);
  // Set below; the push listener reaches it to open a run asked for from the Nexus.
  const navigateTo = useRef<(runId: string) => void>(() => undefined);
  /** The latest `activate`, so the memoised context can switch projects. */
  const activateRef = useRef<(workspace: Workspace) => Promise<void>>(async () => undefined);
  // Where each project tab was left, so switching back returns there instead of the overview.
  const lastPlace = useRef(new Map<string, { view: View; runId: string | null }>());
  const eventListeners = useRef(new Set<(event: AgentEvent) => void>());
  const fileListeners = useRef(new Set<(paths: string[]) => void>());
  const terminalListeners = useRef(new Set<(event: TerminalEvent) => void>());
  const agentChatListeners = useRef(
    new Set<(push: Extract<HivePush, { kind: 'agentChat' }>) => void>(),
  );
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
  const onAgentChat = useCallback(
    (listener: (push: Extract<HivePush, { kind: 'agentChat' }>) => void) => {
      agentChatListeners.current.add(listener);
      return () => {
        agentChatListeners.current.delete(listener);
      };
    },
    [],
  );

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
      // A chat reply's progress goes to the open chat only; it never reloads the app.
      if (push.kind === 'agentChat') {
        for (const listener of agentChatListeners.current) listener(push);
        return;
      }
      if (push.kind === 'navigate') {
        if ('page' in push) {
          setView('providers');
          setModal({ kind: 'provider' });
        } else navigateTo.current(push.runId);
        return;
      }
      // Download progress is frequent; the settings page listens for it on its own.
      if (push.kind === 'update') return;
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
      openWorkspace: (workspace) => activateRef.current(workspace),
      onEvent,
      onFiles,
      onTerminal,
      onAgentChat,
      openAgentChat(workerId) {
        setChatWorkerId(workerId);
        setView('agentChat');
      },
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
    onAgentChat,
  ]);

  const activeWorkspace = summary?.workspace ?? null;
  const queen = workers.find((worker) => worker.role === 'queen');
  const connected = providers.filter(hasAccess);
  const chatWorker =
    view === 'agentChat' ? (workers.find((worker) => worker.id === chatWorkerId) ?? null) : null;
  // A removed agent's chat falls back to the team page.
  const page =
    view === 'mission' && !detail
      ? 'overview'
      : view === 'agentChat' && !chatWorker && ready
        ? 'agents'
        : view;
  const team = useMemo(() => chatAgents(workers), [workers]);
  const sidebarIcons = railed || menuCompact;
  const approvals = summary?.pendingApprovals ?? [];
  // The editor stays mounted after its first visit, so tabs and the tree survive navigation.
  const [codeVisited, setCodeVisited] = useState(false);
  if (page === 'code' && !codeVisited) setCodeVisited(true);

  // Ctrl+Shift+F searches the whole project from anywhere and Ctrl+B shows or hides the
  // sidebar, as in VS Code.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === 'f') {
        event.preventDefault();
        setView('search');
      } else if (!event.shiftKey && key === 'b') {
        event.preventDefault();
        setRailed(!railed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [railed, setRailed]);

  async function activate(workspace: Workspace) {
    if (workspace.id === activeWorkspace?.id) return;
    try {
      // Each tab comes back where it was left: the same screen, the same mission open.
      if (activeWorkspace)
        lastPlace.current.set(activeWorkspace.id, { view, runId: detail?.run.id ?? null });
      const place = lastPlace.current.get(workspace.id);
      setDetail(null);
      await window.hive.invoke('workspace.activate', workspace.id);
      await refresh();
      if (place?.view === 'mission' && place.runId) {
        // A run deleted in the meantime falls back to the overview.
        const run = await window.hive.invoke('run.get', place.runId).catch(() => null);
        setDetail(run);
        setView(run ? 'mission' : 'overview');
      } else setView(place?.view ?? 'overview');
    } catch (failure) {
      context.fail(failure);
    }
  }
  activateRef.current = activate;

  /** Opens a mission; a mission of another project brings that project to the front first. */
  async function openProjectMission(workspace: Workspace, id: string) {
    if (workspace.id !== activeWorkspace?.id) await activate(workspace);
    await context.openMission(id);
  }

  /** A run picked in the Nexus: its project comes to the front, then the mission opens. */
  navigateTo.current = (runId) =>
    void (async () => {
      try {
        const run = await window.hive.invoke('run.get', runId);
        const workspace = workspaces.find((item) => item.id === run.run.workspaceId);
        if (workspace && workspace.id !== activeWorkspace?.id) await activate(workspace);
        await context.openRun(runId);
      } catch (failure) {
        context.fail(failure);
      }
    })();

  async function openCanvas() {
    try {
      await window.hive.invoke('window.openCanvas');
    } catch (failure) {
      context.fail(failure);
    }
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
      lastPlace.current.delete(workspace.id);
      await window.hive.invoke('workspace.close', workspace.id);
      await refresh();
      const { disposeProjectDocs } = await import('./code/monaco');
      disposeProjectDocs(workspace.id);
      useCode.getState().dropProject(workspace.id);
    } catch (failure) {
      context.fail(failure);
    }
  }

  // The splash keeps its place (second child) as the app appears under it, so its animation
  // carries on while it fades instead of starting over.
  if (splash === 'on')
    return (
      <>
        {null}
        <SplashScreen />
      </>
    );

  return (
    <>
      <Hive.Provider value={context}>
        <div
          className={`app-shell platform-${info?.platform ?? 'unknown'}${railed ? ' sidebar-railed' : ''}`}
        >
          <div className="titlebar">
            <span className="titlebar-brand">
              <Hexagon size={15} strokeWidth={2.4} /> hive
              <button
                className="icon-button sidebar-toggle"
                aria-label={railed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
                title={`${railed ? 'Expandir' : 'Recolher'} barra lateral (Ctrl+B)`}
                onClick={() => setRailed(!railed)}
              >
                {railed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
              </button>
            </span>
            <span className="titlebar-path">
              {activeWorkspace?.name ?? 'sem repositório'}
              <span className="sep">/</span>
              {page === 'mission' && detail ? detail.mission.title : viewTitles[page]}
              {page === 'agentChat' && chatWorker && (
                <>
                  <span className="sep">/</span>
                  {chatWorker.name}
                </>
              )}
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
            <button
              className="sidebar-section sidebar-section-toggle"
              aria-expanded={!menuCompact}
              title={menuCompact ? 'Expandir menu' : 'Recolher menu em ícones'}
              onClick={() => setMenuCompact(!menuCompact)}
            >
              <span>Menu</span>
              <ChevronDown size={13} className={menuCompact ? 'chevron' : 'chevron open'} />
            </button>
            <nav aria-label="Navegação principal" className={menuCompact ? 'compact' : undefined}>
              {navigation.slice(0, 5).map(({ view: item, label, icon: Icon }) => (
                <button
                  key={item}
                  className={page === item ? 'nav-item selected' : 'nav-item'}
                  aria-current={page === item ? 'page' : undefined}
                  aria-label={label}
                  title={railed || menuCompact ? label : undefined}
                  onClick={() => setView(item)}
                >
                  <Icon size={15} /> <span className="nav-label">{label}</span>
                </button>
              ))}
              {/* Agentes: managing the team, and a direct chat with each agent. As icons only,
                it opens the team page. */}
              <button
                className={
                  (page === 'agents' || page === 'agentChat') && (agentsClosed || sidebarIcons)
                    ? 'nav-item selected'
                    : 'nav-item'
                }
                aria-expanded={sidebarIcons ? undefined : !agentsClosed}
                aria-label="Agentes"
                title={
                  sidebarIcons ? 'Agentes' : agentsClosed ? 'Mostrar agentes' : 'Recolher agentes'
                }
                onClick={() => (sidebarIcons ? setView('agents') : setAgentsClosed(!agentsClosed))}
              >
                <Bot size={15} /> <span className="nav-label">Agentes</span>
                <ChevronDown
                  size={13}
                  className={agentsClosed ? 'nav-chevron chevron' : 'nav-chevron chevron open'}
                />
              </button>
              {!sidebarIcons && !agentsClosed && (
                <div className="nav-sub" role="group" aria-label="Agentes">
                  <button
                    className={page === 'agents' ? 'nav-subitem selected' : 'nav-subitem'}
                    aria-current={page === 'agents' ? 'page' : undefined}
                    onClick={() => setView('agents')}
                  >
                    <SlidersHorizontal size={13} />
                    <span className="truncate">Gerenciar agentes</span>
                  </button>
                  <span className="nav-sub-title">Chat com agentes</span>
                  {team.map((worker) => {
                    const selected = page === 'agentChat' && chatWorker?.id === worker.id;
                    return (
                      <button
                        key={worker.id}
                        className={selected ? 'nav-subitem selected' : 'nav-subitem'}
                        aria-current={selected ? 'page' : undefined}
                        title={worker.description || worker.name}
                        onClick={() => context.openAgentChat(worker.id)}
                      >
                        <AgentBee worker={worker} size={14} />
                        <span className="truncate">{worker.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {navigation.slice(5).map(({ view: item, label, icon: Icon }) => (
                <button
                  key={item}
                  className={page === item ? 'nav-item selected' : 'nav-item'}
                  aria-current={page === item ? 'page' : undefined}
                  aria-label={label}
                  title={railed || menuCompact ? label : undefined}
                  onClick={() => setView(item)}
                >
                  <Icon size={15} /> <span className="nav-label">{label}</span>
                </button>
              ))}
              {/* Not a page: it opens its own window, which stays open beside this one. */}
              <button
                className="nav-item"
                aria-label="Workspace"
                title={
                  railed || menuCompact
                    ? 'Workspace (abre em outra janela)'
                    : 'Abre em outra janela'
                }
                onClick={() => void openCanvas()}
              >
                <Network size={15} /> <span className="nav-label">Workspace</span>
              </button>
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
                      title={
                        railed
                          ? workspace.name
                          : open && active
                            ? 'Recolher missões'
                            : 'Abrir projeto e missões'
                      }
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
                    {open && !railed && (
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
                title={railed ? 'Configurações' : undefined}
                onClick={() => setView('settings')}
              >
                <SettingsIcon size={15} /> <span className="nav-label">Configurações</span>
              </button>
              <button
                className={page === 'about' ? 'nav-item selected' : 'nav-item'}
                title={railed ? 'Sobre' : undefined}
                onClick={() => setView('about')}
              >
                <Info size={15} /> <span className="nav-label">Sobre</span>
              </button>
            </div>
          </aside>

          <main
            className={
              page === 'code'
                ? 'content code-mode'
                : page === 'run' || page === 'agentChat'
                  ? 'content run-mode'
                  : page === 'overview'
                    ? 'content home-mode'
                    : page === 'mission'
                      ? 'content cover-mode'
                      : page === 'shift'
                        ? 'content shift-mode'
                        : 'content'
            }
          >
            {page === 'overview' && <HiveField key="home" />}
            {page === 'mission' && detail && <HiveField key="cover" variant="cover" />}
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
            <div
              className={page === 'run' || page === 'agentChat' ? 'page page-full' : 'page'}
              hidden={page === 'code'}
            >
              {page === 'overview' && <OverviewPage />}
              {page === 'search' && <SearchPage key={activeWorkspace?.id ?? 'none'} />}
              {page === 'mission' && <MissionPage />}
              {page === 'run' && <RunPage key={activeWorkspace?.id ?? 'none'} />}
              {page === 'agents' && <AgentsPage />}
              {page === 'agentChat' && chatWorker && activeWorkspace && (
                <AgentChatPage
                  key={`${activeWorkspace.id}:${chatWorker.id}`}
                  workspace={activeWorkspace}
                  worker={chatWorker}
                />
              )}
              {page === 'agentChat' && !activeWorkspace && ready && (
                <div className="page">
                  <p className="muted">Abra um projeto para conversar com os agentes.</p>
                </div>
              )}
              {page === 'providers' && <ProvidersPage />}
              {page === 'skills' && <SkillsPage />}
              {page === 'guardian' && <GuardianPage />}
              {page === 'browser' && <BrowserPage />}
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
            <BusyBees
              tasks={summary?.activeTasks ?? []}
              chats={summary?.activeChats ?? []}
              planning={summary?.recentRuns.find((run) => run.status === 'planning') ?? null}
              workers={workers}
              onOpenRun={(runId) => void context.openRun(runId)}
              onOpenTerminal={() => setView('run')}
              onOpenChat={(workerId) => context.openAgentChat(workerId)}
            />
            {approvals.length > 0 && (
              <span className="warn-text">{approvals.length} aprovação(ões) pendente(s)</span>
            )}
            {summary?.honey && <HoneyMeter honey={summary.honey} />}
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
      {splash === 'leaving' && <SplashScreen leaving />}
    </>
  );
}

/**
 * The agents at work, one bee each, flapping in its own colour: the Queen while she plans, every
 * agent with a running task, and those answering in a terminal. A click opens where they work.
 */
function BusyBees({
  tasks,
  chats,
  planning,
  workers,
  onOpenRun,
  onOpenTerminal,
  onOpenChat,
}: {
  tasks: DashboardSummary['activeTasks'];
  chats: DashboardSummary['activeChats'];
  planning: DashboardSummary['recentRuns'][number] | null;
  workers: Worker[];
  onOpenRun: (runId: string) => void;
  onOpenTerminal: () => void;
  onOpenChat: (workerId: string) => void;
}) {
  const queen = workers.find((worker) => worker.role === 'queen');
  const busy = new Map<string, { worker: Worker; titles: string[]; working: boolean }>();
  const add = (workerId: string | null, title: string, waiting: boolean) => {
    const worker = workers.find((item) => item.id === workerId);
    if (!worker) return;
    const entry = busy.get(worker.id) ?? { worker, titles: [], working: false };
    entry.titles.push(waiting ? `${title} (aguardando)` : title);
    entry.working ||= !waiting;
    busy.set(worker.id, entry);
  };
  for (const task of tasks) add(task.workerId, task.title, isWaiting(task));
  for (const chat of chats)
    add(
      chat.workerId,
      chat.direct ? `em conversa: ${chat.title}` : `no terminal: ${chat.title}`,
      isWaiting({ status: 'running', workerState: chat.state }),
    );
  const runId = tasks[0]?.runId ?? planning?.id;
  const direct = chats.find((chat) => chat.direct) ?? null;
  if (!runId && !chats.length) return null;
  const parts = [
    tasks.length ? `${tasks.length} tarefa(s) em execução` : '',
    chats.some((chat) => !chat.direct)
      ? `${chats.filter((chat) => !chat.direct).length} no terminal`
      : '',
    chats.some((chat) => chat.direct)
      ? `${chats.filter((chat) => chat.direct).length} em conversa`
      : '',
  ].filter(Boolean);
  const label = parts.length
    ? parts.join(' · ')
    : `Queen planejando ${planning?.missionTitle ?? ''}`.trim();
  return (
    <button
      className="busy-bees"
      title={runId ? 'Abrir execução' : direct ? 'Abrir a conversa' : 'Abrir os terminais'}
      onClick={() =>
        runId ? onOpenRun(runId) : direct ? onOpenChat(direct.workerId) : onOpenTerminal()
      }
    >
      <span className="busy-bees-swarm">
        {planning && queen && !busy.has(queen.id) && (
          <span title={`${queen.name}: planejando`}>
            <AgentBee worker={queen} size={16} mood="working" />
          </span>
        )}
        {[...busy.values()].map(({ worker, titles, working }) => (
          <span key={worker.id} title={`${worker.name}: ${titles.join(', ')}`}>
            <AgentBee worker={worker} size={16} mood={working ? 'working' : 'still'} />
          </span>
        ))}
      </span>
      {label}
    </button>
  );
}
