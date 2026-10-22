import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Bot,
  Columns2,
  Monitor,
  MoreHorizontal,
  RotateCcw,
  Rows2,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import type { TerminalEvent, TerminalSession, TerminalStatus, Workspace } from '@hive/core';
import { useHive } from './context';
import { Dot } from './ui';
import { TerminalView } from './terminal-view';
import { PreviewPane } from './preview-pane';
import { Mascot } from './mascot';
import {
  closePane,
  findLeaf,
  leaf,
  leaves,
  setRatio,
  splitPane,
  type Leaf,
  type PaneNode,
} from './run-layout';

const MAX_RENDERED_OUTPUT = 1024 * 1024;

/** Coding agents with a command line; they run in the project like in any terminal. */
const agentCommands = [
  { label: 'Claude Code', command: 'claude' },
  { label: 'Codex', command: 'codex' },
  { label: 'Gemini CLI', command: 'gemini' },
  { label: 'OpenCode', command: 'opencode' },
  { label: 'Kilo', command: 'kilo' },
];

const sessionLabel = (session: TerminalSession) =>
  agentCommands.find((agent) => agent.command === session.command)?.label ??
  (session.command || 'Terminal');

const statusLabel: Record<TerminalStatus, string> = {
  running: 'Executando',
  stopping: 'Encerrando',
  exited: 'Concluído',
  failed: 'Falhou',
  stopped: 'Interrompido',
};

function terminalTone(status: TerminalStatus) {
  if (status === 'running' || status === 'stopping') return 'busy' as const;
  if (status === 'exited') return 'ok' as const;
  if (status === 'failed') return 'error' as const;
  return 'idle' as const;
}

function upsert(sessions: TerminalSession[], next: TerminalSession): TerminalSession[] {
  const found = sessions.some((session) => session.id === next.id);
  return found
    ? sessions.map((session) => (session.id === next.id ? next : session))
    : [next, ...sessions];
}

interface Layout {
  tree: PaneNode | null;
  focused: string | null;
  /** The user closed the preview; it is not opened again on its own. */
  previewDismissed: boolean;
}

// Panes outlive the page: leaving Rodar and coming back finds them where they were.
const layouts = new Map<string, Layout>();
const emptyLayout: Layout = { tree: null, focused: null, previewDismissed: false };

type Direction = 'row' | 'column';
/** What a new pane holds: a shell (''), an agent's command line, or the preview. */
type NewPane = { kind: 'terminal'; command: string } | { kind: 'preview' };

export function RunPage() {
  const { summary, onTerminal, fail } = useHive();
  const workspace = summary?.workspace ?? null;
  const workspaceId = workspace?.id ?? '';
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [layout, setLayoutState] = useState<Layout>(() => layouts.get(workspaceId) ?? emptyLayout);
  const [clearSignals, setClearSignals] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ paneId: string; x: number; y: number } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const setLayout = useCallback(
    (update: (current: Layout) => Layout) => {
      setLayoutState((current) => {
        const next = update(current);
        layouts.set(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  const startSession = useCallback(
    async (command: string): Promise<TerminalSession | null> => {
      try {
        const session = await window.hive.invoke('terminal.start', { command });
        // The push event normally arrives first; keep the output it already carried.
        setSessions((current) =>
          current.some((item) => item.id === session.id) ? current : [session, ...current],
        );
        return session;
      } catch (error) {
        fail(error);
        return null;
      }
    },
    [fail],
  );

  /** Opens `content` beside the pane `paneId`, or as the only pane when there is none. */
  const open = useCallback(
    async (content: NewPane, paneId: string | null, direction: Direction = 'row') => {
      let added: Leaf;
      if (content.kind === 'preview') added = leaf({ kind: 'preview' });
      else {
        const session = await startSession(content.command);
        if (!session) return;
        added = leaf({ kind: 'terminal', sessionId: session.id });
      }
      setLayout((current) => ({
        ...current,
        tree:
          current.tree && paneId && findLeaf(current.tree, paneId)
            ? splitPane(current.tree, paneId, direction, added)
            : (current.tree ?? added),
        focused: added.id,
      }));
    },
    [setLayout, startSession],
  );

  // Sessions of this project; panes whose terminal is gone are dropped, and a first visit
  // opens a shell so the page is never empty.
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setLoaded(false);
    setLayoutState(layouts.get(workspaceId) ?? emptyLayout);
    void window.hive
      .invoke('terminal.list')
      .then((result) => {
        if (!alive) return;
        setSessions(result);
        const known = new Set(result.map((session) => session.id));
        let { tree } = layouts.get(workspaceId) ?? emptyLayout;
        for (const pane of leaves(tree))
          if (pane.content.kind === 'terminal' && !known.has(pane.content.sessionId))
            tree = tree && closePane(tree, pane.id);
        const kept = layouts.get(workspaceId) ?? emptyLayout;
        const next = { ...kept, tree };
        layouts.set(workspaceId, next);
        setLayoutState(next);
        setLoaded(true);
        if (!tree) {
          const running = result.find((session) => session.status === 'running');
          if (running) {
            const pane = leaf({ kind: 'terminal', sessionId: running.id });
            setLayout((current) => ({ ...current, tree: pane, focused: pane.id }));
          } else void open({ kind: 'terminal', command: '' }, null);
        }
      })
      .catch((error) => {
        if (alive) fail(error);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, fail, open, setLayout]);

  useEffect(
    () =>
      onTerminal((event: TerminalEvent) => {
        if (event.type === 'started') {
          if (event.session.workspaceId !== workspaceId) return;
          setSessions((current) => upsert(current, event.session));
          return;
        }
        if (event.type === 'state') {
          setSessions((current) =>
            current.some((session) => session.id === event.session.id)
              ? upsert(current, event.session)
              : current,
          );
          return;
        }
        setSessions((current) =>
          current.map((session) =>
            session.id === event.sessionId
              ? {
                  ...session,
                  output: (session.output + event.chunk).slice(-MAX_RENDERED_OUTPUT),
                  previewUrls: event.previewUrls,
                }
              : session,
          ),
        );
      }),
    [onTerminal, workspaceId],
  );

  // A local server showing up in a terminal opens the preview beside it, once.
  const shown = leaves(layout.tree);
  const detected = [...new Set(sessions.flatMap((session) => session.previewUrls))];
  const serving = sessions.find(
    (session) =>
      session.previewUrls.length &&
      shown.some(
        (pane) => pane.content.kind === 'terminal' && pane.content.sessionId === session.id,
      ),
  );
  const hasPreview = shown.some((pane) => pane.content.kind === 'preview');
  useEffect(() => {
    if (!serving || hasPreview || layoutRef.current.previewDismissed) return;
    const pane = leaves(layoutRef.current.tree).find(
      (item) => item.content.kind === 'terminal' && item.content.sessionId === serving.id,
    );
    if (pane) void open({ kind: 'preview' }, pane.id, 'row');
  }, [serving, hasPreview, open]);

  const close = useCallback(
    (paneId: string) => {
      const pane = findLeaf(layoutRef.current.tree, paneId);
      if (!pane) return;
      // Closing a terminal pane ends its process, as in any terminal app.
      if (pane.content.kind === 'terminal') {
        const session = sessions.find(
          (item) => pane.content.kind === 'terminal' && item.id === pane.content.sessionId,
        );
        if (session?.status === 'running')
          void window.hive.invoke('terminal.stop', session.id).catch(() => undefined);
      }
      setLayout((current) => {
        const tree = current.tree && closePane(current.tree, paneId);
        return {
          tree,
          focused: current.focused === paneId ? (leaves(tree)[0]?.id ?? null) : current.focused,
          previewDismissed: current.previewDismissed || pane.content.kind === 'preview',
        };
      });
    },
    [sessions, setLayout],
  );

  // Windows Terminal's shortcuts: Alt+Shift+Plus splits right, Alt+Shift+Minus splits down,
  // Ctrl+Shift+W closes the focused pane. Caught before the terminal sees them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const focused = layoutRef.current.focused;
      if (!focused) return;
      const split =
        event.altKey && event.shiftKey && !event.ctrlKey
          ? ['+', '=', 'Equal'].includes(event.key) || event.code === 'Equal'
            ? 'row'
            : event.key === '-' || event.key === '_' || event.code === 'Minus'
              ? 'column'
              : null
          : null;
      const closing = event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'w';
      if (!split && !closing) return;
      event.preventDefault();
      event.stopPropagation();
      if (split) void open({ kind: 'terminal', command: '' }, focused, split);
      else close(focused);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!workspace) {
    return (
      <section className="run-empty">
        <Mascot size={64} />
        <h1>Rodar projeto</h1>
        <p>Abra um repositório para usar terminais e visualizar o site.</p>
      </section>
    );
  }

  const menuPane = menu ? findLeaf(layout.tree, menu.paneId) : null;
  const menuSession =
    menuPane?.content.kind === 'terminal'
      ? sessions.find(
          (session) =>
            menuPane.content.kind === 'terminal' && session.id === menuPane.content.sessionId,
        )
      : undefined;

  return (
    <section className="run-page panes-page" aria-label="Terminais">
      <h1 className="sr-only">Rodar projeto</h1>
      {layout.tree ? (
        <PaneTree
          node={layout.tree}
          render={(pane) => (
            <Pane
              key={pane.id}
              pane={pane}
              workspace={workspace}
              session={
                pane.content.kind === 'terminal'
                  ? sessions.find(
                      (session) =>
                        pane.content.kind === 'terminal' && session.id === pane.content.sessionId,
                    )
                  : undefined
              }
              detected={detected}
              focused={layout.focused === pane.id}
              clearSignal={
                pane.content.kind === 'terminal' ? (clearSignals[pane.content.sessionId] ?? 0) : 0
              }
              onFocus={() =>
                setLayout((current) =>
                  current.focused === pane.id ? current : { ...current, focused: pane.id },
                )
              }
              onSplit={(direction) =>
                void open({ kind: 'terminal', command: '' }, pane.id, direction)
              }
              onClose={() => close(pane.id)}
              onMenu={(x, y) => setMenu({ paneId: pane.id, x, y })}
            />
          )}
          onResize={(splitId, ratio) =>
            setLayout((current) => ({
              ...current,
              tree: current.tree && setRatio(current.tree, splitId, ratio),
            }))
          }
        />
      ) : (
        loaded && (
          <div className="terminal-placeholder">
            <TerminalSquare size={24} />
            <span>Nenhum painel aberto.</span>
            <button
              className="secondary"
              onClick={() => void open({ kind: 'terminal', command: '' }, null)}
            >
              Novo terminal
            </button>
          </div>
        )
      )}

      {menu && menuPane && (
        <PaneMenu
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
          items={[
            {
              label: 'Dividir à direita',
              hint: 'Alt+Shift++',
              icon: <Columns2 size={14} />,
              run: () => void open({ kind: 'terminal', command: '' }, menuPane.id, 'row'),
            },
            {
              label: 'Dividir abaixo',
              hint: 'Alt+Shift+-',
              icon: <Rows2 size={14} />,
              run: () => void open({ kind: 'terminal', command: '' }, menuPane.id, 'column'),
            },
            {
              label: 'Preview à direita',
              icon: <Monitor size={14} />,
              run: () => void open({ kind: 'preview' }, menuPane.id, 'row'),
            },
            'separator',
            ...agentCommands.map((agent) => ({
              label: `${agent.label} à direita`,
              hint: agent.command,
              icon: <Bot size={14} />,
              run: () =>
                void open({ kind: 'terminal', command: agent.command }, menuPane.id, 'row'),
            })),
            'separator',
            ...(menuSession
              ? [
                  menuSession.status === 'running'
                    ? {
                        label: 'Parar processo',
                        icon: <Square size={13} />,
                        run: () =>
                          void window.hive.invoke('terminal.stop', menuSession.id).catch(fail),
                      }
                    : {
                        label: 'Executar de novo',
                        icon: <RotateCcw size={14} />,
                        run: () => {
                          void startSession(menuSession.command).then((session) => {
                            if (!session) return;
                            setLayout((current) => ({
                              ...current,
                              tree:
                                current.tree &&
                                replaceTerminal(current.tree, menuPane.id, session.id),
                            }));
                          });
                        },
                      },
                  {
                    label: 'Limpar',
                    icon: <Trash2 size={14} />,
                    run: () =>
                      void window.hive
                        .invoke('terminal.clear', menuSession.id)
                        .then(() =>
                          setClearSignals((current) => ({
                            ...current,
                            [menuSession.id]: (current[menuSession.id] ?? 0) + 1,
                          })),
                        )
                        .catch(fail),
                  },
                ]
              : []),
            {
              label: 'Fechar painel',
              hint: 'Ctrl+Shift+W',
              icon: <X size={14} />,
              run: () => close(menuPane.id),
            },
          ]}
        />
      )}
    </section>
  );
}

function replaceTerminal(tree: PaneNode, paneId: string, sessionId: string): PaneNode {
  if (tree.type === 'leaf')
    return tree.id === paneId ? { ...tree, content: { kind: 'terminal', sessionId } } : tree;
  return {
    ...tree,
    first: replaceTerminal(tree.first, paneId, sessionId),
    second: replaceTerminal(tree.second, paneId, sessionId),
  };
}

/** The split tree: each split shares its space between two children, with a drag handle. */
function PaneTree({
  node,
  render,
  onResize,
}: {
  node: PaneNode;
  render: (pane: Leaf) => ReactNode;
  onResize: (splitId: string, ratio: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  if (node.type === 'leaf') return <>{render(node)}</>;

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const element = container.current;
    if (!element || node.type !== 'split') return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const splitId = node.id;
    const row = node.direction === 'row';
    document.body.classList.add(row ? 'resizing-columns' : 'resizing-rows');
    const move = (moveEvent: PointerEvent) =>
      onResize(
        splitId,
        row
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height,
      );
    const end = () => {
      document.body.classList.remove('resizing-columns', 'resizing-rows');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }

  return (
    <div ref={container} className={`pane-split pane-${node.direction}`}>
      <div className="pane-slot" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <PaneTree node={node.first} render={render} onResize={onResize} />
      </div>
      <div
        className="pane-divider"
        role="separator"
        aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
        aria-label="Redimensionar painéis"
        onPointerDown={startDrag}
      />
      <div className="pane-slot grow">
        <PaneTree node={node.second} render={render} onResize={onResize} />
      </div>
    </div>
  );
}

function Pane({
  pane,
  workspace,
  session,
  detected,
  focused,
  clearSignal,
  onFocus,
  onSplit,
  onClose,
  onMenu,
}: {
  pane: Leaf;
  workspace: Workspace;
  session: TerminalSession | undefined;
  detected: string[];
  focused: boolean;
  clearSignal: number;
  onFocus: () => void;
  onSplit: (direction: Direction) => void;
  onClose: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const preview = pane.content.kind === 'preview';
  const title = preview ? 'Preview' : session ? sessionLabel(session) : 'Terminal';
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onMenu(event.clientX, event.clientY);
  };
  return (
    <section
      className={focused ? 'pane focused' : 'pane'}
      aria-label={title}
      onMouseDownCapture={onFocus}
      onContextMenu={openMenu}
    >
      <header className="pane-header">
        <span className="pane-title">
          {preview ? <Monitor size={13} /> : <TerminalSquare size={13} />}
          <strong>{title}</strong>
          {session && (
            <span className="terminal-status">
              <Dot tone={terminalTone(session.status)} /> {statusLabel[session.status]}
            </span>
          )}
        </span>
        <span className="pane-actions">
          <button
            className="icon-button"
            title="Dividir à direita (Alt+Shift++)"
            aria-label="Dividir à direita"
            onClick={() => onSplit('row')}
          >
            <Columns2 size={13} />
          </button>
          <button
            className="icon-button"
            title="Dividir abaixo (Alt+Shift+-)"
            aria-label="Dividir abaixo"
            onClick={() => onSplit('column')}
          >
            <Rows2 size={13} />
          </button>
          <button
            className="icon-button"
            title="Mais opções (ou clique com o botão direito)"
            aria-label="Mais opções do painel"
            onClick={openMenu}
          >
            <MoreHorizontal size={13} />
          </button>
          <button
            className="icon-button"
            title="Fechar painel (Ctrl+Shift+W)"
            aria-label="Fechar painel"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </span>
      </header>
      {preview ? (
        <PreviewPane workspace={workspace} detected={detected} />
      ) : session ? (
        <TerminalView key={session.id} session={session} clearSignal={clearSignal} />
      ) : (
        <div className="terminal-placeholder" role="status">
          Abrindo o terminal…
        </div>
      )}
    </section>
  );
}

type MenuItem = { label: string; hint?: string; icon: ReactNode; run: () => void } | 'separator';

/** The pane's menu, at the pointer; it closes on a choice, a click elsewhere or Escape. */
function PaneMenu({
  x,
  y,
  items,
  onDismiss,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useEffect(() => {
    const element = ref.current;
    if (element) {
      // Kept inside the window when opened near an edge.
      const { width, height } = element.getBoundingClientRect();
      setPosition({
        left: Math.min(x, window.innerWidth - width - 8),
        top: Math.min(y, window.innerHeight - height - 8),
      });
      element.querySelector('button')?.focus();
    }
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [x, y, onDismiss]);
  return (
    <div ref={ref} className="pane-menu" role="menu" style={position}>
      {items.map((item, index) =>
        item === 'separator' ? (
          <hr key={`separator-${index}`} />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            onClick={() => {
              onDismiss();
              item.run();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
