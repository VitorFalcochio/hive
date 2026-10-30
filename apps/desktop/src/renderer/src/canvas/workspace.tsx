import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection as FlowConnection,
  type Edge,
  type NodeChange,
} from '@xyflow/react';
import { RefreshCw, Unplug, X } from 'lucide-react';
import type {
  AgentEvent,
  CanvasQueenApplied,
  CanvasQueenRequest,
  CanvasSnapshot,
  CanvasTerminal,
  NexusAutopilotApplyResult,
  TerminalEvent,
} from '@hive/core';
import { queenActionLabel } from '@hive/core';
import { AgentBee } from '../mascot';
import { ExecutionConsole, type ConsoleFocus } from './Console';
import { Inspector, type Selection } from './Inspector';
import { AgentPanel, type AgentTab } from './agent-window';
import {
  AddAgentForm,
  ContextMenu,
  ModelForm,
  NewTaskForm,
  executors,
  type MenuItem,
} from './forms';
import { CanvasViewContext, nodeTypes, type CanvasNode, type CanvasView } from './nodes';
import {
  SIZE,
  agentStatus,
  buildGraph,
  isLive,
  roleLabel,
  taskTone,
  type GraphEdge,
  type Grouping,
  type Tone,
} from './model';
import type { CanvasPrefs } from './prefs';
import type { Connection } from './use-canvas-data';
import { localId, useLayout } from './use-layout';
import { useLiveResult } from './use-live-result';
import { LiveResultPanel } from './live-result-panel';
import {
  CommandRegistry,
  registerCanvasCommands,
  ownsKeyboard,
  type CommandContext,
  type PaletteOperation,
} from './command-registry';
import { CommandPalette } from './command-palette';
import { QueenCommand } from './queen-command';
import { NexusAutopilot } from './nexus-autopilot';
import { useCortex } from './cortex/use-cortex';
import { CortexInspector, type CortexTab } from './cortex/CortexInspector';
import { BLOCK_MIME, BlockLibrary, type BlockKind } from './cortex/BlockLibrary';

export const toneColors: Record<Tone, string> = {
  done: '#4cd6a0',
  running: '#5ccfe6',
  waiting: '#f5b544',
  failed: '#f87185',
  pending: '#62666d',
  muted: '#3a3d42',
};

const NOTE_SIZE = { width: 240, height: 150 };
const FRAME_SIZE = { width: 560, height: 380 };
/** Runs whose plan accepts tasks, dependencies and delegations by hand (see the scheduler). */
const EDITABLE = new Set(['awaiting_plan_approval', 'running', 'review', 'failed', 'cancelled']);

/** Ticks once a second while something runs, so timers move without new data. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const splitId = (id: string): [string, string] => {
  const at = id.indexOf(':');
  return [id.slice(0, at), id.slice(at + 1)];
};

const flowEdge = (edge: GraphEdge, highlight: boolean, dim: boolean): Edge => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  type: edge.kind === 'dependency' ? 'default' : 'smoothstep',
  animated: edge.active,
  className: `nc-edge kind-${edge.kind} tone-${edge.tone}${highlight ? ' highlight' : ''}${dim ? ' dim' : ''}${edge.folded ? ' folded' : ''}`,
  markerEnd:
    edge.kind === 'dependency'
      ? { type: MarkerType.ArrowClosed, width: 16, height: 16, color: toneColors[edge.tone] }
      : undefined,
  zIndex: edge.kind === 'dependency' ? 2 : 1,
});

type Modal =
  | { kind: 'task'; workerId?: string; at?: { x: number; y: number } }
  | { kind: 'agent'; at?: { x: number; y: number } }
  | { kind: 'model'; workerId: string }
  | null;

type Menu = { x: number; y: number; title?: string; items: (MenuItem | 'separator')[] } | null;

/**
 * The hybrid workspace of one run. The execution graph (agents, tasks, dependencies, states)
 * comes from the engine and changes only through its validated calls; the spatial layer (where
 * things sit, sizes, notes, frames, agents placed by hand) is the user's and never reaches the
 * engine. The Queen's plan fills the canvas; what the user moved stays where they put it.
 */
export function Workspace({
  snapshot,
  events,
  connection,
  error,
  prefs,
  onPrefs,
  onReconnect,
  empty,
}: {
  snapshot: CanvasSnapshot;
  events: AgentEvent[];
  connection: Connection;
  error: string;
  prefs: CanvasPrefs;
  onPrefs: (patch: Partial<CanvasPrefs>) => void;
  onReconnect: () => void;
  /** Shown over the canvas while the run has no task yet. */
  empty: React.ReactNode;
}) {
  const flow = useReactFlow();
  const run = snapshot.detail.run;
  const runId = run.id;
  const { result: liveResult, error: resultError } = useLiveResult(runId);
  const [resultOpen, setResultOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [queenCommand, setQueenCommand] = useState<{
    mode: CanvasQueenRequest['mode'];
    instruction?: string;
  } | null>(null);
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  const cortexState = useCortex(runId);
  const [cortexOpen, setCortexOpen] = useState<{ id: string; tab?: CortexTab } | null>(null);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const cortexBlocks = useMemo(
    () => new Map((cortexState.blocks ?? []).map((block) => [block.node.id, block])),
    [cortexState.blocks],
  );
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const grouping: Grouping = prefs.grouping;
  const scope = `${runId}:${grouping}`;
  const layoutApi = useLayout(runId);
  const { layout } = layoutApi;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const tabs = useRef(new Map<string, AgentTab>());
  const live = run.status === 'running' || snapshot.detail.tasks.some(isLive);
  const now = useNow(live);

  const say = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    setNotice({ text, tone });
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === 'error' ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const open = () => setAutopilotOpen(true);
    const blocks = () => setBlocksOpen((current) => !current);
    window.addEventListener('nc:autopilot', open);
    window.addEventListener('nc:blocks', blocks);
    return () => {
      window.removeEventListener('nc:autopilot', open);
      window.removeEventListener('nc:blocks', blocks);
    };
  }, []);
  /** Runs an engine call; its refusal (a cycle, a started task…) is shown, never swallowed. */
  const act = useCallback(
    async (work: () => Promise<unknown>, done?: string) => {
      try {
        await work();
        if (done) say(done);
      } catch (failure) {
        say(failure instanceof Error ? failure.message : String(failure), 'error');
      }
    },
    [say],
  );

  /* ---------------------------------------------------------------- terminals */

  const [terminals, setTerminals] = useState<CanvasTerminal[]>(snapshot.terminals);
  useEffect(() => setTerminals(snapshot.terminals), [snapshot.terminals]);
  const terminalListeners = useRef(new Set<(event: TerminalEvent) => void>());
  useEffect(
    () =>
      window.hive.subscribe((push) => {
        if (push.kind !== 'terminal') return;
        const event = push.event;
        if (event.type === 'state')
          setTerminals((current) =>
            current.map((item) =>
              item.session.id === event.session.id ? { ...item, session: event.session } : item,
            ),
          );
        for (const listener of terminalListeners.current) listener(event);
      }),
    [],
  );
  const subscribeTerminal = useCallback((listener: (event: TerminalEvent) => void) => {
    terminalListeners.current.add(listener);
    return () => {
      terminalListeners.current.delete(listener);
    };
  }, []);
  const openTerminal = useCallback(
    async (workerId: string, kind: 'chat' | 'shell') => {
      const opened = await window.hive.invoke('canvas.terminal.open', {
        runId,
        workerId,
        kind,
        cols: 90,
        rows: 24,
      });
      setTerminals((current) => [
        ...current.filter((t) => t.session.id !== opened.session.id),
        opened,
      ]);
    },
    [runId],
  );
  const stopTerminal = useCallback(async (sessionId: string) => {
    await window.hive.invoke('terminal.stop', sessionId);
  }, []);

  /* ---------------------------------------------------------------- view */

  const pinnedHere = useMemo(() => layout.pinned[grouping] ?? {}, [layout.pinned, grouping]);
  const minimized = useMemo(
    () =>
      new Set(layout.minimized.filter((id) => id.startsWith('agent:')).map((id) => id.slice(6))),
    [layout.minimized],
  );

  const view = useMemo<CanvasView>(() => {
    const tasks = new Map(snapshot.detail.tasks.map((task) => [task.id, task]));
    const workers = new Map(snapshot.workers.map((worker) => [worker.id, worker]));
    const agents = new Map(
      snapshot.workers.map((worker) => [worker.id, agentStatus(worker, snapshot)]),
    );
    const approvals = new Set(
      snapshot.detail.approvals
        .filter((approval) => approval.status === 'pending')
        .map((approval) => approval.taskId),
    );
    const activity: Record<string, string> = {};
    for (const event of events)
      if (event.taskId && event.level !== 'debug' && event.type !== 'model.request')
        activity[event.taskId] = event.message;
    return {
      liveResult,
      resultError,
      openResult: () => setResultOpen(true),
      snapshot,
      grouping,
      tasks,
      workers,
      agents,
      events,
      now,
      activity,
      approvals,
      collapsed,
      toggleGroup: (lane) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(lane)) next.delete(lane);
          else next.add(lane);
          return next;
        }),
      pinned: new Set(
        Object.entries(pinnedHere)
          .filter(([, point]) => point.locked)
          .map(([id]) => id),
      ),
      togglePin: (nodeId) => {
        const node = flow.getNode(nodeId);
        if (!node) return;
        const locked = !pinnedHere[nodeId]?.locked;
        layoutApi.lock(grouping, { [nodeId]: node.position }, locked);
      },
      minimized,
      setMinimized: (workerId, value) => layoutApi.setMinimized(`agent:${workerId}`, value),
      setSize: layoutApi.setSize,
      expanded,
      expand: setExpanded,
      agentTab: (workerId) => tabs.current.get(workerId) ?? 'activity',
      setAgentTab: (workerId, tab) => tabs.current.set(workerId, tab),
      terminalsOf: (workerId) => terminals.filter((item) => item.workerId === workerId),
      openTerminal,
      stopTerminal,
      subscribeTerminal,
      notes: new Map(layout.notes.map((note) => [note.id, note])),
      frames: new Map(layout.frames.map((frame) => [frame.id, frame])),
      updateNote: layoutApi.updateNote,
      updateFrame: layoutApi.updateFrame,
      cortex: cortexBlocks,
      openCortex: (cortexId) => setCortexOpen({ id: cortexId }),
    };
  }, [
    cortexBlocks,
    liveResult,
    resultError,
    snapshot,
    events,
    now,
    grouping,
    collapsed,
    pinnedHere,
    minimized,
    expanded,
    terminals,
    layout.notes,
    layout.frames,
    layoutApi,
    flow,
    openTerminal,
    stopTerminal,
    subscribeTerminal,
  ]);

  /* ---------------------------------------------------------------- layout */

  const cortexGraph = useMemo(
    () =>
      (cortexState.blocks ?? []).map((block) => ({
        id: block.node.id,
        workers: block.node.connections.map((connection) => connection.workerId),
      })),
    [cortexState.blocks],
  );
  const graph = useMemo(
    () =>
      buildGraph(snapshot, {
        grouping,
        collapsed,
        // An agent with access to a Cortex stays on the canvas, so its line is visible.
        extraAgents: [
          ...new Set([...layout.agents, ...cortexGraph.flatMap((block) => block.workers)]),
        ],
        windowSize: (workerId) =>
          minimized.has(workerId) ? null : (layout.sizes[`agent:${workerId}`] ?? SIZE.window),
        cortex: cortexGraph,
      }),
    [snapshot, grouping, collapsed, layout.agents, layout.sizes, minimized, cortexGraph],
  );

  /** Everything on the canvas: the execution graph, then the user's frames and notes. */
  const desired = useMemo(() => {
    const placed: CanvasNode[] = [];
    for (const frame of layout.frames) {
      const size = layout.sizes[frame.id] ?? FRAME_SIZE;
      placed.push({
        id: frame.id,
        type: 'frame',
        position: { x: frame.x, y: frame.y },
        data: { ref: frame.id },
        width: size.width,
        height: size.height,
        zIndex: -1,
        className: 'nc-flow-frame',
      });
    }
    for (const node of graph.nodes) {
      const spot = pinnedHere[node.id];
      placed.push({
        id: node.id,
        type: node.type,
        position: spot ? { x: spot.x, y: spot.y } : node.position,
        parentId: node.parentId,
        extent: node.parentId ? 'parent' : undefined,
        data: { ref: node.ref },
        width: node.type === 'result' ? (layout.sizes[node.id]?.width ?? node.width) : node.width,
        height:
          node.type === 'result' ? (layout.sizes[node.id]?.height ?? node.height) : node.height,
        zIndex: node.type === 'lane' ? 0 : 1,
        className: `nc-flow-${node.type}`,
        // Windows are dragged by their title bar, so text and terminals inside stay usable.
        dragHandle:
          node.type === 'result' ||
          (node.type === 'agent' && grouping === 'workspace' && !minimized.has(node.ref))
            ? '.nc-window-head'
            : undefined,
      });
    }
    for (const note of layout.notes) {
      const size = layout.sizes[note.id] ?? NOTE_SIZE;
      placed.push({
        id: note.id,
        type: 'note',
        position: { x: note.x, y: note.y },
        data: { ref: note.id },
        width: size.width,
        height: size.height,
        zIndex: 2,
        className: 'nc-flow-note',
      });
    }
    return placed;
  }, [graph.nodes, layout.frames, layout.notes, layout.sizes, pinnedHere, grouping, minimized]);

  // Nodes live in state so xyflow keeps their measured size, selection and drag; they are
  // replaced only when where or how big something is changes, never in the middle of a drag.
  const desiredKey = useMemo(
    () =>
      desired
        .map(
          (node) =>
            `${node.id}@${node.parentId ?? ''}:${node.position.x},${node.position.y},${node.width}x${node.height}:${node.dragHandle ?? ''}`,
        )
        .join('|'),
    [desired],
  );
  const desiredRef = useRef(desired);
  desiredRef.current = desired;
  const dragging = useRef(false);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  useEffect(() => {
    if (dragging.current) return;
    setNodes((previous) => {
      const before = new Map(previous.map((node) => [node.id, node]));
      return desiredRef.current.map((node) => {
        const old = before.get(node.id);
        const sameSize = old?.width === node.width && old?.height === node.height;
        return {
          ...node,
          selected: old?.selected ?? false,
          measured: sameSize ? old?.measured : undefined,
        };
      });
    });
  }, [desiredKey]);

  // A run (or view mode) is framed once its nodes exist.
  const framed = useRef('');
  useEffect(() => {
    if (!nodes.length || !layoutApi.ready || framed.current === scope) return;
    framed.current = scope;
    // Windows stay readable: a wide team opens at a legible zoom, the rest is a pan away.
    requestAnimationFrame(
      () => void flow.fitView({ padding: 0.12, duration: 0, maxZoom: 1, minZoom: 0.6 }),
    );
  }, [nodes.length, layoutApi.ready, scope, flow]);

  // "Reorganizar": what was moved goes back to the automatic layout; locked nodes stay.
  useEffect(() => {
    const relayout = () => {
      layoutApi.reset(grouping, false);
      requestAnimationFrame(() => void flow.fitView({ padding: 0.12, duration: 300 }));
    };
    window.addEventListener('nc:relayout', relayout);
    return () => window.removeEventListener('nc:relayout', relayout);
  }, [layoutApi, grouping, flow]);

  /* ---------------------------------------------------------------- edges */

  const selectedNode = selection?.kind === 'node' ? selection.id : null;
  const edges = useMemo(
    () =>
      graph.edges.map((edge) => {
        const touches =
          !!selectedNode && (edge.source === selectedNode || edge.target === selectedNode);
        return flowEdge(
          edge,
          touches || (selection?.kind === 'edge' && selection.id === edge.id),
          !!selectedNode && !touches,
        );
      }),
    [graph.edges, selectedNode, selection],
  );

  /* ---------------------------------------------------------------- selection */

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) =>
      setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  /** `reveal` pans to the node: for picks made in the inspector, not clicks on the canvas. */
  const select = useCallback(
    (next: Selection, reveal = false) => {
      setSelection(next);
      const id = next?.kind === 'node' ? next.id : null;
      setNodes((current) =>
        current.map((node) =>
          node.selected === (node.id === id) ? node : { ...node, selected: node.id === id },
        ),
      );
      if (reveal && id && flow.getNode(id))
        void flow.fitView({ nodes: [{ id }], padding: 0.8, maxZoom: 1.1, duration: 300 });
    },
    [flow],
  );
  useEffect(() => {
    if (!pendingReveal || !nodes.some((node) => node.id === pendingReveal)) return;
    const frame = requestAnimationFrame(() => {
      select({ kind: 'node', id: pendingReveal }, true);
      setPendingReveal(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingReveal, nodes, select]);

  /* ---------------------------------------------------------------- dragging */

  /** Frames carry what lies inside them; worked out when the drag starts. */
  const carried = useRef<{
    frame: { x: number; y: number };
    items: Map<string, { x: number; y: number }>;
  } | null>(null);
  const insideFrame = useCallback(
    (frameId: string) => {
      const frame = flow.getInternalNode(frameId);
      if (!frame) return new Map<string, { x: number; y: number }>();
      const box = {
        x: frame.internals.positionAbsolute.x,
        y: frame.internals.positionAbsolute.y,
        w: frame.measured.width ?? frame.width ?? 0,
        h: frame.measured.height ?? frame.height ?? 0,
      };
      const inside = new Map<string, { x: number; y: number }>();
      for (const node of nodes) {
        if (node.id === frameId || node.parentId || node.type === 'frame') continue;
        const internal = flow.getInternalNode(node.id);
        if (!internal) continue;
        const { x, y } = internal.internals.positionAbsolute;
        const w = internal.measured.width ?? node.width ?? 0;
        const h = internal.measured.height ?? node.height ?? 0;
        if (x >= box.x && y >= box.y && x + w <= box.x + box.w && y + h <= box.y + box.h)
          inside.set(node.id, { ...node.position });
      }
      return inside;
    },
    [flow, nodes],
  );

  const onNodeDragStart = useCallback(
    (_: unknown, node: CanvasNode) => {
      dragging.current = true;
      carried.current =
        node.type === 'frame' ? { frame: { ...node.position }, items: insideFrame(node.id) } : null;
    },
    [insideFrame],
  );
  const onNodeDrag = useCallback((_: unknown, node: CanvasNode) => {
    const carry = carried.current;
    if (!carry || node.type !== 'frame' || !carry.items.size) return;
    const dx = node.position.x - carry.frame.x;
    const dy = node.position.y - carry.frame.y;
    setNodes((current) =>
      current.map((item) => {
        const start = carry.items.get(item.id);
        return start ? { ...item, position: { x: start.x + dx, y: start.y + dy } } : item;
      }),
    );
  }, []);
  const onNodeDragStop = useCallback(
    (_: unknown, node: CanvasNode, dragged: CanvasNode[]) => {
      dragging.current = false;
      const moved: Record<string, { x: number; y: number }> = {};
      for (const item of dragged) moved[item.id] = item.position;
      const carry = carried.current;
      if (carry && node.type === 'frame') {
        const dx = node.position.x - carry.frame.x;
        const dy = node.position.y - carry.frame.y;
        for (const [id, start] of carry.items) moved[id] = { x: start.x + dx, y: start.y + dy };
      }
      carried.current = null;
      layoutApi.place(grouping, moved);
    },
    [layoutApi, grouping],
  );

  /* ---------------------------------------------------------------- connections */

  /**
   * Only lines with a meaning the engine knows: task → task (dependency), agent → task
   * (delegation), agent → Cortex (access to shared memory).
   */
  const validConnection = useCallback(
    (connection: FlowConnection | Edge) => {
      const [from, fromRef] = splitId(connection.source);
      const [to] = splitId(connection.target);
      if (to === 'cortex') return from === 'agent' && view.workers.has(fromRef);
      if (to !== 'task' || connection.source === connection.target) return false;
      if (from === 'task') return true;
      return from === 'agent' && view.workers.get(fromRef)?.role !== 'queen';
    },
    [view.workers],
  );
  const onConnect = useCallback(
    (connection: FlowConnection) => {
      const [from, fromRef] = splitId(connection.source);
      const [toType, toRef] = splitId(connection.target);
      if (toType === 'cortex') {
        const worker = view.workers.get(fromRef);
        const block = cortexBlocks.get(toRef);
        if (!worker || !block) return;
        void act(
          () =>
            window.hive.invoke('cortex.connect', { cortexId: block.node.id, workerId: worker.id }),
          `${worker.name} conectado ao ${block.node.name} com Read e Propose. Ajuste em Conexões no Inspector.`,
        );
        return;
      }
      const target = view.tasks.get(toRef);
      if (!target) return;
      if (from === 'task') {
        const source = view.tasks.get(fromRef);
        if (!source) return;
        if (
          !window.confirm(
            `“${target.title}” vai esperar “${source.title}” terminar. Criar esta dependência?`,
          )
        )
          return;
        void act(
          () =>
            window.hive.invoke('canvas.task.link', {
              taskId: target.id,
              dependsOnTaskId: source.id,
              linked: true,
            }),
          'Dependência criada.',
        );
      } else if (from === 'agent') {
        const worker = view.workers.get(fromRef);
        if (!worker) return;
        if (!window.confirm(`Delegar “${target.title}” para ${worker.name}?`)) return;
        void act(
          () =>
            window.hive.invoke('canvas.task.assign', { taskId: target.id, workerId: worker.id }),
          `Tarefa delegada a ${worker.name}.`,
        );
      }
    },
    [view.tasks, view.workers, act, cortexBlocks],
  );

  /* ---------------------------------------------------------------- canvas items */

  const center = useCallback(() => {
    const box = document.querySelector('.nc-flow')?.getBoundingClientRect();
    return flow.screenToFlowPosition({
      x: (box?.left ?? 0) + (box?.width ?? 800) / 2,
      y: (box?.top ?? 0) + (box?.height ?? 600) / 2,
    });
  }, [flow]);
  const addNote = useCallback(
    (at: { x: number; y: number }) => {
      const id = localId('note');
      layoutApi.addNote({ id, text: '', x: Math.round(at.x), y: Math.round(at.y), tone: 'gold' });
      select({ kind: 'node', id });
    },
    [layoutApi, select],
  );
  const addFrame = useCallback(
    (at: { x: number; y: number }, size = FRAME_SIZE, title = 'Novo grupo') => {
      const id = localId('frame');
      layoutApi.addFrame({ id, title, x: Math.round(at.x), y: Math.round(at.y) });
      layoutApi.setSize(id, size);
    },
    [layoutApi],
  );
  /** A Cortex block of the project, placed where it was dropped (or in view). */
  const addCortex = useCallback(
    (at: { x: number; y: number }) =>
      void act(async () => {
        const created = await window.hive.invoke('cortex.create', { runId });
        layoutApi.place(grouping, {
          [`cortex:${created.node.id}`]: { x: Math.round(at.x), y: Math.round(at.y) },
        });
        await cortexState.reload();
      }, 'Cortex criado. Arraste de um agente até ele para dar acesso à memória.'),
    [act, runId, layoutApi, grouping, cortexState],
  );
  const placeBlock = useCallback(
    (kind: BlockKind, at: { x: number; y: number }) => {
      if (kind === 'note') addNote(at);
      else if (kind === 'frame') addFrame(at);
      else addCortex(at);
    },
    [addNote, addFrame, addCortex],
  );

  /** A frame around the selected nodes (Ctrl+G). */
  const groupSelection = useCallback(() => {
    const picked = nodes.filter((node) => node.selected && !node.parentId && node.type !== 'frame');
    if (!picked.length)
      return say('Selecione o que agrupar (Shift + arrastar ou Ctrl + clique).', 'error');
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of picked) {
      const internal = flow.getInternalNode(node.id);
      if (!internal) continue;
      const { x, y } = internal.internals.positionAbsolute;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + (internal.measured.width ?? 0));
      maxY = Math.max(maxY, y + (internal.measured.height ?? 0));
    }
    addFrame(
      { x: minX - 28, y: minY - 52 },
      { width: maxX - minX + 56, height: maxY - minY + 80 },
      'Equipe',
    );
  }, [nodes, flow, addFrame, say]);
  const removeSelected = useCallback(() => {
    const ids = nodes
      .filter((node) => node.selected && (node.type === 'note' || node.type === 'frame'))
      .map((node) => node.id);
    if (ids.length) layoutApi.remove(ids);
  }, [nodes, layoutApi]);
  const lockSelected = useCallback(() => {
    const picked = nodes.filter(
      (node) => node.selected && node.type !== 'note' && node.type !== 'frame',
    );
    if (!picked.length) return;
    const locked = picked.some((node) => !pinnedHere[node.id]?.locked);
    layoutApi.lock(
      grouping,
      Object.fromEntries(picked.map((node) => [node.id, node.position])),
      locked,
    );
  }, [nodes, pinnedHere, layoutApi, grouping]);

  /* ---------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        ownsKeyboard(event.target)
      )
        return;
      if (modal || paletteOpen || queenCommand || autopilotOpen || resultOpen || cortexOpen) return;
      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        if (expanded) setExpanded(null);
        else select(null);
      } else if (ctrl && key === 'g') {
        event.preventDefault();
        groupSelection();
      } else if (ctrl) return;
      else if (key === 'f') void flow.fitView({ padding: 0.12, duration: 250 });
      else if (key === 'n') addNote(center());
      else if (key === 'p') lockSelected();
      else if (key === 'm') {
        for (const node of nodes)
          if (node.selected && node.type === 'agent')
            layoutApi.setMinimized(node.id, !minimized.has(node.data.ref));
      } else if (event.key === 'Delete' || event.key === 'Backspace') removeSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    paletteOpen,
    queenCommand,
    autopilotOpen,
    resultOpen,
    cortexOpen,
    modal,
    expanded,
    select,
    groupSelection,
    flow,
    addNote,
    center,
    lockSelected,
    nodes,
    layoutApi,
    minimized,
    removeSelected,
  ]);

  /* ---------------------------------------------------------------- context menus */

  const editable = EDITABLE.has(run.status) && !snapshot.planning;
  const notEditable = snapshot.planning
    ? 'A Queen está planejando.'
    : 'Gere o plano da missão antes.';
  const paneItems = (at: { x: number; y: number }): (MenuItem | 'separator')[] => [
    { label: 'Nova nota', hint: 'N', run: () => addNote(at) },
    { label: 'Novo grupo', run: () => addFrame(at) },
    { label: 'Novo Cortex — Shared Memory', run: () => addCortex(at) },
    { label: 'Agrupar seleção', hint: 'Ctrl+G', run: groupSelection },
    'separator',
    {
      label: 'Nova tarefa…',
      disabled: !editable,
      reason: notEditable,
      run: () => setModal({ kind: 'task' }),
    },
    { label: 'Adicionar agente…', run: () => setModal({ kind: 'agent' }) },
    'separator',
    {
      label: 'Reorganizar (mantém os fixados)',
      run: () => window.dispatchEvent(new Event('nc:relayout')),
    },
    {
      label: 'Desafixar tudo e reorganizar',
      run: () => {
        layoutApi.reset(grouping, true);
        requestAnimationFrame(() => void flow.fitView({ padding: 0.12, duration: 300 }));
      },
    },
    { label: 'Ajustar à tela', hint: 'F', run: () => void flow.fitView({ padding: 0.12 }) },
  ];

  const nodeItems = (node: CanvasNode): { title?: string; items: (MenuItem | 'separator')[] } => {
    const lockedHere = !!pinnedHere[node.id]?.locked;
    const pin: MenuItem = {
      label: lockedHere ? 'Desafixar posição' : 'Fixar posição',
      hint: 'P',
      run: () => layoutApi.lock(grouping, { [node.id]: node.position }, !lockedHere),
    };
    if (node.type === 'note') {
      const note = layout.notes.find((item) => item.id === node.id);
      return {
        title: 'Nota',
        items: [
          ...(['gold', 'cyan', 'rose', 'plain'] as const).map((tone) => ({
            label: {
              gold: 'Cor: mel',
              cyan: 'Cor: ciano',
              rose: 'Cor: rosa',
              plain: 'Cor: neutra',
            }[tone],
            disabled: note?.tone === tone,
            run: () => layoutApi.updateNote(node.id, { tone }),
          })),
          'separator',
          {
            label: 'Excluir nota',
            hint: 'Del',
            danger: true,
            run: () => layoutApi.remove([node.id]),
          },
        ],
      };
    }
    if (node.type === 'frame')
      return {
        title: 'Grupo',
        items: [
          {
            label: 'Excluir grupo (mantém o conteúdo)',
            danger: true,
            run: () => layoutApi.remove([node.id]),
          },
        ],
      };
    const [type, ref] = splitId(node.id);
    if (type === 'cortex') {
      const block = cortexBlocks.get(ref);
      if (!block) return { items: [] };
      return {
        title: block.node.name,
        items: [
          {
            label: 'Abrir Cortex Inspector',
            hint: '2× clique',
            run: () => setCortexOpen({ id: ref }),
          },
          {
            label: `Aprovações pendentes (${block.pendingApprovals})`,
            run: () => setCortexOpen({ id: ref, tab: 'approvals' }),
          },
          {
            label: 'Conexões e permissões',
            run: () => setCortexOpen({ id: ref, tab: 'connections' }),
          },
          'separator',
          pin,
          {
            label: 'Remover bloco (mantém as memórias)',
            danger: true,
            run: () => {
              if (
                window.confirm(
                  `Remover “${block.node.name}” do projeto? Os agentes perdem o acesso; as memórias ficam guardadas no banco do Hive.`,
                )
              )
                void act(
                  () => window.hive.invoke('cortex.delete', { cortexId: ref, purge: false }),
                  'Cortex removido.',
                );
            },
          },
        ],
      };
    }
    if (type === 'agent') {
      const worker = view.workers.get(ref);
      if (!worker) return { items: [] };
      const status = view.agents.get(ref);
      const queen = worker.role === 'queen';
      const noModel = !worker.providerId || !worker.modelId;
      const manual = layout.agents.includes(ref) && !status?.tasks.length;
      const openTab = (tab: AgentTab) => {
        tabs.current.set(ref, tab);
        layoutApi.setMinimized(node.id, false);
        if (grouping !== 'workspace') onPrefs({ grouping: 'workspace' });
      };
      return {
        title: worker.name,
        items: [
          ...(queen
            ? []
            : [
                {
                  label: 'Conversar',
                  disabled: noModel,
                  reason: 'Este agente não tem provedor e modelo.',
                  run: () => openTab('chat'),
                },
                { label: 'Terminal', run: () => openTab('shell') },
                {
                  label: minimized.has(ref) ? 'Abrir janela' : 'Minimizar janela',
                  hint: 'M',
                  run: () => layoutApi.setMinimized(node.id, !minimized.has(ref)),
                },
                { label: 'Expandir', run: () => setExpanded(ref) },
                'separator' as const,
                {
                  label: 'Nova tarefa para este agente…',
                  disabled: !editable,
                  reason: notEditable,
                  run: () => setModal({ kind: 'task', workerId: ref }),
                },
              ]),
          { label: 'Trocar modelo…', run: () => setModal({ kind: 'model', workerId: ref }) },
          'separator',
          pin,
          ...(manual
            ? [
                {
                  label: 'Tirar do canvas',
                  danger: true,
                  run: () => layoutApi.removeAgent(ref),
                },
              ]
            : []),
        ],
      };
    }
    if (type === 'task') {
      const task = view.tasks.get(ref);
      if (!task) return { items: [] };
      const open = ['pending', 'blocked', 'failed', 'cancelled'].includes(task.status);
      const others = executors(snapshot.workers).filter((worker) => worker.id !== task.workerId);
      return {
        title: task.title,
        items: [
          ...others.slice(0, 8).map((worker) => ({
            label: `Delegar a ${worker.name}`,
            disabled: !open,
            reason: 'Só tarefas que não começaram ou vão ser repetidas.',
            run: () =>
              void act(
                () =>
                  window.hive.invoke('canvas.task.assign', {
                    taskId: task.id,
                    workerId: worker.id,
                  }),
                `Tarefa delegada a ${worker.name}.`,
              ),
          })),
          'separator',
          ...(isLive(task)
            ? [
                {
                  label: 'Cancelar tarefa',
                  danger: true,
                  run: () => void act(() => window.hive.invoke('task.cancel', task.id)),
                },
              ]
            : []),
          ...(['failed', 'cancelled', 'rejected'].includes(task.status)
            ? [
                {
                  label: 'Tentar novamente',
                  run: () => void act(() => window.hive.invoke('task.retry', task.id)),
                },
              ]
            : []),
          pin,
        ],
      };
    }
    return { items: [pin] };
  };

  const edgeItems = (edge: Edge): (MenuItem | 'separator')[] => {
    const graphEdge = graph.edges.find((item) => item.id === edge.id);
    if (graphEdge?.kind === 'memory') {
      const [, workerId] = splitId(graphEdge.source);
      const [, cortexId] = splitId(graphEdge.target);
      const worker = view.workers.get(workerId);
      return [
        { label: 'Permissões…', run: () => setCortexOpen({ id: cortexId, tab: 'connections' }) },
        {
          label: `Desconectar ${worker?.name ?? 'agente'}`,
          danger: true,
          run: () =>
            void act(
              () => window.hive.invoke('cortex.disconnect', { cortexId, workerId }),
              `${worker?.name ?? 'Agente'} perdeu o acesso ao Cortex.`,
            ),
        },
      ];
    }
    if (!graphEdge || graphEdge.kind !== 'dependency' || graphEdge.folded) return [];
    const [, sourceRef] = splitId(graphEdge.source);
    const [, targetRef] = splitId(graphEdge.target);
    const target = view.tasks.get(targetRef);
    const started = !!target && !['pending', 'blocked'].includes(target.status);
    return [
      {
        label: 'Remover dependência',
        danger: true,
        disabled: started,
        reason: 'A tarefa já começou.',
        run: () =>
          void act(
            () =>
              window.hive.invoke('canvas.task.link', {
                taskId: targetRef,
                dependsOnTaskId: sourceRef,
                linked: false,
              }),
            'Dependência removida.',
          ),
      },
    ];
  };

  /* ---------------------------------------------------------------- console focus */

  const focus = useMemo<ConsoleFocus | null>(() => {
    if (selection?.kind !== 'node') return null;
    const [type, ref] = splitId(selection.id);
    if (type === 'task') {
      const task = view.tasks.get(ref);
      return task ? { taskIds: new Set([task.id]), workerId: null, label: task.key } : null;
    }
    const worker = view.workers.get(ref);
    if (!worker) return null;
    return {
      taskIds: new Set(view.agents.get(ref)?.tasks.map((task) => task.id) ?? []),
      workerId: worker.id,
      label: worker.name,
    };
  }, [selection, view]);

  const onCanvas = useMemo(
    () => new Set(graph.nodes.filter((node) => node.type === 'agent').map((node) => node.ref)),
    [graph.nodes],
  );
  const expandedWorker = expanded ? view.workers.get(expanded) : undefined;

  const reveal = useCallback(
    (nodeId: string) => {
      if (nodeId.startsWith('group:')) onPrefs({ grouping: 'agent' });
      if (nodeId.startsWith('agent:') && grouping === 'none') onPrefs({ grouping: 'workspace' });
      if (nodeId.startsWith('task:')) {
        const task = snapshot.detail.tasks.find((item) => `task:${item.id}` === nodeId);
        const lane = task?.workerId ?? 'unassigned';
        setCollapsed((current) => {
          if (!current.has(lane)) return current;
          const next = new Set(current);
          next.delete(lane);
          return next;
        });
      }
      onPrefs({ inspectorOpen: true });
      setPendingReveal(nodeId);
    },
    [grouping, onPrefs, snapshot.detail.tasks],
  );
  const operations: Record<PaletteOperation, () => void | Promise<void>> = {
    'new-mission': () => {
      window.dispatchEvent(new Event('nc:new-mission'));
    },
    'new-agent': () => setModal({ kind: 'agent', at: center() }),
    'new-task': () =>
      setModal({
        kind: 'task',
        at: center(),
        workerId: selectedNode?.startsWith('agent:') ? selectedNode.slice(6) : undefined,
      }),
    'new-note': () => {
      const at = center();
      addNote({ x: at.x - NOTE_SIZE.width / 2, y: at.y - NOTE_SIZE.height / 2 });
    },
    'new-group': () => {
      const at = center();
      addFrame({ x: at.x - FRAME_SIZE.width / 2, y: at.y - FRAME_SIZE.height / 2 });
    },
    result: () => setResultOpen(true),
    fit: () => {
      void flow.fitView({ padding: 0.12, duration: 250 });
    },
    center: () => {
      const busy = snapshot.detail.tasks.filter(isLive).map((task) => ({ id: `task:${task.id}` }));
      void flow.fitView({
        nodes: busy.length ? busy : undefined,
        padding: 0.3,
        maxZoom: 1.1,
        duration: 250,
      });
    },
    'zoom-in': () => {
      void flow.zoomIn({ duration: 150 });
    },
    'zoom-out': () => {
      void flow.zoomOut({ duration: 150 });
    },
    organize: () => {
      window.dispatchEvent(new Event('nc:relayout'));
    },
    workspace: () => onPrefs({ grouping: 'workspace' }),
    agent: () => onPrefs({ grouping: 'agent' }),
    none: () => onPrefs({ grouping: 'none' }),
    inspect: () => {
      select(null);
      onPrefs({ inspectorOpen: true });
    },
    logs: () => onPrefs({ consoleOpen: true, consoleTab: 'logs' }),
    resume: async () => {
      await window.hive.invoke('run.start', runId);
    },
    pin: lockSelected,
    'group-selection': groupSelection,
    'new-cortex': () => {
      const at = center();
      addCortex({ x: at.x - SIZE.cortex.width / 2, y: at.y - SIZE.cortex.height / 2 });
    },
    blocks: () => setBlocksOpen(true),
  };
  const commandContext: CommandContext = {
    snapshot,
    ready: layoutApi.ready,
    selectedNodeIds: nodes.filter((node) => node.selected).map((node) => node.id),
    pinnableSelection: nodes.some(
      (node) => node.selected && node.type !== 'note' && node.type !== 'frame',
    ),
    groupableSelection: nodes.some(
      (node) => node.selected && !node.parentId && node.type !== 'frame',
    ),
    perform: (operation) => operations[operation](),
    reveal,
    find: () => {},
    ask: (mode, instruction) => setQueenCommand({ mode, instruction }),
    autopilot: () => setAutopilotOpen(true),
  };
  const registry = useMemo(() => {
    const registry = registerCanvasCommands(new CommandRegistry<CommandContext>());
    const add = (
      id: string,
      title: string,
      description: string,
      entity: 'agent' | 'task' | 'block' | 'mission',
      keywords: string[],
      execute: (context: CommandContext) => void,
    ) =>
      registry.register({
        id: `entity:${id}`,
        title,
        description,
        category: 'Workspace',
        icon: entity === 'block' ? 'note' : entity === 'mission' ? 'mission' : entity,
        entity,
        keywords: [id, ...keywords],
        availability: () => true,
        execute,
      });
    const relevantWorkers = new Set([
      ...snapshot.detail.tasks.flatMap((task) => (task.workerId ? [task.workerId] : [])),
      ...layout.agents,
      ...(run.queenWorkerId ? [run.queenWorkerId] : []),
    ]);
    for (const worker of snapshot.workers.filter((worker) => relevantWorkers.has(worker.id)))
      add(
        `agent:${worker.id}`,
        worker.name,
        `Agente · ${roleLabel(worker.role)}`,
        'agent',
        [worker.role, worker.modelId ?? ''],
        (context) => context.reveal(`agent:${worker.id}`),
      );
    for (const task of snapshot.detail.tasks)
      add(
        `task:${task.id}`,
        task.title,
        `Tarefa · ${task.key} · ${task.status}`,
        'task',
        [task.key, task.id],
        (context) => context.reveal(`task:${task.id}`),
      );
    for (const note of layout.notes)
      add(
        note.id,
        note.text.split('\n')[0]?.slice(0, 100) || 'Nota espacial',
        'Nota neste Canvas',
        'block',
        ['nota', note.text.slice(0, 500)],
        (context) => context.reveal(note.id),
      );
    for (const frame of layout.frames)
      add(frame.id, frame.title, 'Grupo neste Canvas', 'block', ['grupo', 'frame'], (context) =>
        context.reveal(frame.id),
      );
    for (const block of cortexState.blocks ?? [])
      registry.register({
        id: `entity:cortex:${block.node.id}`,
        title: block.node.name,
        description: `Cortex · ${block.memories.active} memórias · ${block.pendingApprovals} pendentes`,
        category: 'Cortex',
        icon: 'cortex',
        entity: 'block',
        keywords: ['cortex', 'memória', 'memory', 'aprovações', block.node.id],
        availability: () => true,
        execute: () => setCortexOpen({ id: block.node.id }),
      });
    add(
      `result:${run.missionId}`,
      'Resultado Vivo',
      snapshot.detail.mission.title,
      'block',
      ['resultado', 'relatório'],
      (context) => context.reveal(`result:${run.missionId}`),
    );
    add(
      run.missionId,
      snapshot.detail.mission.title,
      `Missão · ${run.missionId}`,
      'mission',
      [runId, run.missionId],
      (context) => {
        void context.perform('inspect');
      },
    );
    return registry;
  }, [
    snapshot.workers,
    snapshot.detail.tasks,
    snapshot.detail.mission.title,
    layout.notes,
    layout.frames,
    layout.agents,
    run.queenWorkerId,
    run.missionId,
    runId,
    cortexState.blocks,
  ]);
  const queenApplied = async (applied: CanvasQueenApplied) => {
    await layoutApi.reload();
    const labels: string[] = [];
    for (const effect of applied.effects) {
      if (effect.type === 'set_view') onPrefs({ grouping: effect.view });
      else if (effect.type === 'focus_node') reveal(effect.nodeId);
      else if (effect.type === 'organize') operations.organize();
      else if (effect.type === 'open_result') setResultOpen(true);
      else if (effect.type === 'inspect_mission') operations.inspect();
      else if (effect.type === 'open_logs') operations.logs();
      labels.push(queenActionLabel(effect));
    }
    return labels;
  };

  return (
    <CanvasViewContext.Provider value={view}>
      <CommandPalette
        registry={registry}
        context={commandContext}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        blocked={
          !!modal || resultOpen || !!expanded || !!queenCommand || autopilotOpen || !!cortexOpen
        }
        onError={(message) => say(message, 'error')}
      />
      {queenCommand && (
        <QueenCommand
          runId={runId}
          mode={queenCommand.mode}
          instruction={queenCommand.instruction}
          selection={commandContext.selectedNodeIds}
          view={grouping}
          center={center}
          beforeRequest={layoutApi.persist}
          onApplied={queenApplied}
          onClose={() => setQueenCommand(null)}
        />
      )}
      {autopilotOpen && (
        <NexusAutopilot
          snapshot={snapshot}
          beforeRequest={layoutApi.persist}
          onApplied={async (_result: NexusAutopilotApplyResult) => {
            await layoutApi.reload();
            onPrefs({ grouping: 'none' });
            window.dispatchEvent(new Event('nc:relayout'));
          }}
          onClose={() => setAutopilotOpen(false)}
        />
      )}
      <div className={`nc-main${prefs.inspectorOpen ? '' : ' no-inspector'}`}>
        <div className="nc-stage">
          <div className="nc-flow" aria-label="Workspace da missão">
            <ReactFlow<CanvasNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={(_, node) => select({ kind: 'node', id: node.id })}
              onNodeDoubleClick={(_, node) => {
                if (node.type === 'cortex') setCortexOpen({ id: node.data.ref });
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(BLOCK_MIME)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(event) => {
                const kind = event.dataTransfer.getData(BLOCK_MIME) as BlockKind | '';
                if (!kind) return;
                event.preventDefault();
                placeBlock(kind, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
              }}
              onEdgeClick={(_, edge) => setSelection({ kind: 'edge', id: edge.id })}
              onPaneClick={() => {
                select(null);
                setMenu(null);
              }}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              isValidConnection={validConnection}
              onPaneContextMenu={(event) => {
                event.preventDefault();
                const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                setMenu({ x: event.clientX, y: event.clientY, items: paneItems(at) });
              }}
              onNodeContextMenu={(event, node) => {
                event.preventDefault();
                const { title, items } = nodeItems(node);
                if (items.length) setMenu({ x: event.clientX, y: event.clientY, title, items });
              }}
              onEdgeContextMenu={(event, edge) => {
                event.preventDefault();
                const items = edgeItems(edge);
                if (items.length)
                  setMenu({ x: event.clientX, y: event.clientY, title: 'Dependência', items });
              }}
              onSelectionContextMenu={(event) => {
                event.preventDefault();
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  title: 'Seleção',
                  items: [
                    { label: 'Agrupar seleção', hint: 'Ctrl+G', run: groupSelection },
                    { label: 'Fixar / desafixar seleção', hint: 'P', run: lockSelected },
                    {
                      label: 'Excluir notas e grupos',
                      hint: 'Del',
                      danger: true,
                      run: removeSelected,
                    },
                  ],
                });
              }}
              colorMode="dark"
              minZoom={0.1}
              maxZoom={2.2}
              selectionKeyCode="Shift"
              multiSelectionKeyCode="Control"
              deleteKeyCode={null}
              elevateNodesOnSelect={false}
              connectionRadius={28}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                size={1.1}
                color="rgb(255 255 255 / 9%)"
              />
              <MiniMap
                pannable
                zoomable
                className="nc-minimap"
                maskColor="rgb(8 9 10 / 72%)"
                nodeColor={(node) => {
                  const { ref } = (node.data ?? {}) as { ref?: string };
                  if (node.type === 'lane' || node.type === 'frame') return 'rgb(255 255 255 / 4%)';
                  if (node.type === 'note') return 'rgb(245 181 68 / 40%)';
                  if (node.type === 'cortex') return 'rgb(167 139 250 / 70%)';
                  if (node.type === 'agent')
                    return toneColors[view.agents.get(ref ?? '')?.tone ?? 'pending'];
                  const task = view.tasks.get(ref ?? '');
                  return task ? toneColors[taskTone(task)] : toneColors.pending;
                }}
              />
            </ReactFlow>
            {empty}
            {blocksOpen && (
              <BlockLibrary
                onClose={() => setBlocksOpen(false)}
                onPlace={(kind) => {
                  const at = center();
                  const size =
                    kind === 'cortex' ? SIZE.cortex : kind === 'note' ? NOTE_SIZE : FRAME_SIZE;
                  placeBlock(kind, { x: at.x - size.width / 2, y: at.y - size.height / 2 });
                }}
              />
            )}
            {cortexState.error && (
              <div className="nc-banner subtle" role="status">
                Cortex: {cortexState.error}
                <button className="ghost" onClick={() => void cortexState.reload()}>
                  Tentar novamente
                </button>
              </div>
            )}
            {connection === 'disconnected' && (
              <div className="nc-banner" role="alert">
                <Unplug size={13} /> Sem conexão com o motor: mostrando o último estado conhecido.
                {error && <span className="muted-text">{error}</span>}
                <button className="ghost" onClick={onReconnect}>
                  <RefreshCw size={12} /> Reconectar
                </button>
              </div>
            )}
            {layoutApi.saveError && (
              <div className="nc-banner subtle" role="status">
                Layout: {layoutApi.saveError}
                <button
                  className="ghost"
                  onClick={() =>
                    void layoutApi
                      .reload()
                      .catch((error: unknown) =>
                        say(error instanceof Error ? error.message : String(error), 'error'),
                      )
                  }
                >
                  Tentar novamente
                </button>
              </div>
            )}
            <Legend />
            {notice && (
              <div
                className={`nc-notice ${notice.tone}`}
                role={notice.tone === 'error' ? 'alert' : 'status'}
              >
                {notice.text}
              </div>
            )}
          </div>
          <ExecutionConsole
            view={view}
            events={events}
            tab={prefs.consoleTab}
            open={prefs.consoleOpen}
            height={prefs.consoleHeight}
            focus={focus}
            onTab={(consoleTab) => onPrefs({ consoleTab })}
            onToggle={() => onPrefs({ consoleOpen: !prefs.consoleOpen })}
            onResize={(consoleHeight) => onPrefs({ consoleHeight })}
          />
        </div>
        {prefs.inspectorOpen && (
          <aside className="nc-inspector" aria-label="Inspector">
            <Inspector
              view={view}
              selection={selection}
              edges={graph.edges}
              events={events}
              now={now}
              onSelect={(next) => select(next, true)}
            />
          </aside>
        )}
      </div>

      {expandedWorker && (
        <div className="nc-overlay" role="dialog" aria-label={`Janela de ${expandedWorker.name}`}>
          <div className="nc-overlay-window">
            <header className="nc-window-head">
              <AgentBee worker={expandedWorker} size={22} mood="still" />
              <div className="nc-window-title">
                <strong>{expandedWorker.name}</strong>
                <span>
                  {roleLabel(expandedWorker.role)} · {expandedWorker.modelId ?? 'sem modelo'}
                </span>
              </div>
              <button
                className="icon-button"
                aria-label="Voltar ao canvas"
                title="Voltar ao canvas (Esc)"
                onClick={() => setExpanded(null)}
              >
                <X size={15} />
              </button>
            </header>
            <AgentPanel view={view} workerId={expandedWorker.id} />
          </div>
        </div>
      )}

      {cortexOpen && cortexBlocks.get(cortexOpen.id) && (
        <CortexInspector
          key={cortexOpen.id}
          block={cortexBlocks.get(cortexOpen.id)!}
          workers={view.workers}
          initialTab={cortexOpen.tab}
          onClose={() => setCortexOpen(null)}
        />
      )}

      {resultOpen && (
        <LiveResultPanel
          result={liveResult}
          error={resultError}
          snapshot={snapshot}
          onClose={() => setResultOpen(false)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.title}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
      {modal?.kind === 'task' && (
        <NewTaskForm
          snapshot={snapshot}
          defaultWorkerId={modal.workerId}
          onCreated={(taskId) => {
            if (modal.at && grouping !== 'agent')
              layoutApi.place(grouping, {
                [`task:${taskId}`]: {
                  x: modal.at.x - SIZE.task.width / 2,
                  y: modal.at.y - SIZE.task.height / 2,
                },
              });
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'agent' && (
        <AddAgentForm
          snapshot={snapshot}
          onCanvas={onCanvas}
          onClose={() => setModal(null)}
          onAdd={(workerId) => {
            layoutApi.addAgent(workerId);
            if (modal.at) {
              layoutApi.place('workspace', { [`agent:${workerId}`]: modal.at });
              onPrefs({ grouping: 'workspace' });
            }
          }}
        />
      )}
      {modal?.kind === 'model' && view.workers.get(modal.workerId) && (
        <ModelForm worker={view.workers.get(modal.workerId)!} onClose={() => setModal(null)} />
      )}
    </CanvasViewContext.Provider>
  );
}

function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? 'nc-legend open' : 'nc-legend'}>
      <button className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        Legenda e atalhos
      </button>
      {open && (
        <dl>
          <div>
            <dt className="tone-done" />
            <dd>Concluída</dd>
          </div>
          <div>
            <dt className="tone-running" />
            <dd>Executando</dd>
          </div>
          <div>
            <dt className="tone-waiting" />
            <dd>Aguardando você ou o provedor</dd>
          </div>
          <div>
            <dt className="tone-failed" />
            <dd>Falhou ou bloqueada</dd>
          </div>
          <div>
            <dt className="tone-pending" />
            <dd>Na fila</dd>
          </div>
          <div>
            <dt className="line dependency" />
            <dd>Dependência: arraste de uma tarefa para outra</dd>
          </div>
          <div>
            <dt className="line assignment" />
            <dd>Delegação: arraste de um agente para uma tarefa</dd>
          </div>
          <div>
            <dt className="line coordination" />
            <dd>Coordenação da Queen</dd>
          </div>
          <div>
            <dt className="line memory" />
            <dd>Acesso ao Cortex: arraste de um agente para o bloco</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>N</kbd>
            </dt>
            <dd>Nova nota</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>Shift</kbd>
            </dt>
            <dd>Arrastar para selecionar vários</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>Ctrl+G</kbd>
            </dt>
            <dd>Agrupar a seleção</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>P</kbd>
            </dt>
            <dd>Fixar / desafixar</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>M</kbd>
            </dt>
            <dd>Minimizar / abrir janela</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>F</kbd>
            </dt>
            <dd>Ajustar à tela</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>Del</kbd>
            </dt>
            <dd>Excluir notas e grupos</dd>
          </div>
          <div className="keys">
            <dt>
              <kbd>Botão direito</kbd>
            </dt>
            <dd>Ações do item ou do canvas</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
