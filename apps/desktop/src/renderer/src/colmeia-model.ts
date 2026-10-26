import {
  soldierRoleSchema,
  workerStateSchema,
  type AgentEvent,
  type SoldierRole,
  type WorkerState,
} from '@hive/core';

/** Five rings around the centre; a mission touching more files keeps the first ones shown. */
export const MAX_CELLS = 91;
const MAX_FEED = 40;

/** One file the agents touched: a hexagon of the comb that fills with honey as it is edited. */
export interface CombCell {
  path: string;
  /** Its place in the spiral, fixed when first touched so the comb only ever grows. */
  slot: number;
  reads: number;
  writes: number;
  /** When it was last written, for the fresh-honey animation. */
  writtenAt: number;
  /** The task that last wrote it, to open its diff; null for terminal agents. */
  taskId: string | null;
  runId: string | null;
}

/** A bee at work: an agent on a task or in a terminal, or one of her soldiers. */
export interface BeeTrack {
  key: string;
  workerId: string | null;
  soldier: SoldierRole | null;
  /** Key of the captain a soldier flies out of. */
  captain: string | null;
  taskId: string | null;
  runId: string | null;
  /** Set for agents answering in a terminal: the request, shortened. */
  chatTitle: string | null;
  state: WorkerState;
  /** What she is doing now, ready to show: "Editando src/app.ts". */
  doing: string;
  /** The file she is on; null keeps her at the entrance. */
  target: string | null;
  /** The last command failed. */
  alert: boolean;
  /** A soldier that reported back; she flies home and is dropped. */
  done: boolean;
  at: number;
}

export interface FeedItem {
  id: string;
  at: number;
  /** Kept with the item: the bee may be gone by the time it is read. */
  workerId: string | null;
  soldier: SoldierRole | null;
  text: string;
  tone: 'info' | 'ok' | 'warn';
}

export interface CombState {
  cells: Record<string, CombCell>;
  /** Paths in the order they were first touched (their slot). */
  order: string[];
  bees: Record<string, BeeTrack>;
  /** Newest first. */
  feed: FeedItem[];
  tokens: number;
}

export const emptyComb: CombState = { cells: {}, order: [], bees: {}, feed: [], tokens: 0 };

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** The bee an event belongs to: its task or terminal chat, plus the soldier if it was one. */
export function beeKeyOf(event: AgentEvent): string | null {
  const base = event.taskId ?? str(event.data?.chat);
  if (!base) return null;
  const soldier = str(event.data?.soldier);
  return soldier ? `${base}/${soldier}` : base;
}

const FILE_TOOLS = new Set(['read_file', 'write_file', 'replace_in_file']);

/** How a tool call reads on a bee, in Portuguese like the rest of the interface. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const arg = (key: string) => str(args[key]) ?? '';
  switch (tool) {
    case 'read_file':
      return `Lendo ${arg('path')}`;
    case 'write_file':
      return `Escrevendo ${arg('path')}`;
    case 'replace_in_file':
      return `Editando ${arg('path')}`;
    case 'list_dir':
      return `Olhando a pasta ${arg('path') || '.'}`;
    case 'search':
      return `Buscando "${arg('query')}"`;
    case 'run_command':
      return `$ ${arg('command')}`;
    case 'read_skill_resource':
      return `Consultando a skill ${arg('skill')}`;
    case 'web_fetch':
      return `Lendo ${arg('url')}`;
    case 'view_page':
      return `Olhando ${arg('url')}`;
    case 'call_soldiers':
      return 'Convocando soldadas';
    case 'finish':
      return 'Entregando';
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      return mcp ? `MCP ${mcp[1]} · ${mcp[2]}` : tool;
    }
  }
}

function soldierOf(event: AgentEvent): SoldierRole | null {
  const parsed = soldierRoleSchema.safeParse(event.data?.soldier);
  return parsed.success ? parsed.data : null;
}

function withBee(state: CombState, event: AgentEvent, key: string, at: number): BeeTrack {
  const existing = state.bees[key];
  if (existing) return { ...existing, at, done: false };
  const soldier = soldierOf(event);
  const base = event.taskId ?? str(event.data?.chat);
  return {
    key,
    workerId: event.workerId,
    soldier,
    captain: soldier ? base : null,
    taskId: event.taskId,
    runId: event.runId,
    chatTitle: str(event.data?.title),
    state: 'thinking',
    doing: 'Pensando',
    target: null,
    alert: false,
    done: false,
    at,
  };
}

function touch(
  state: CombState,
  path: string,
  patch: (cell: CombCell) => Partial<CombCell>,
): Pick<CombState, 'cells' | 'order'> {
  const existing = state.cells[path];
  if (!existing && state.order.length >= MAX_CELLS) return state;
  const cell: CombCell = existing ?? {
    path,
    slot: state.order.length,
    reads: 0,
    writes: 0,
    writtenAt: 0,
    taskId: null,
    runId: null,
  };
  return {
    cells: { ...state.cells, [path]: { ...cell, ...patch(cell) } },
    order: existing ? state.order : [...state.order, path],
  };
}

function feed(
  state: CombState,
  event: AgentEvent,
  text: string,
  tone: FeedItem['tone'],
): FeedItem[] {
  const item: FeedItem = {
    id: event.id,
    at: Date.parse(event.ts),
    workerId: event.workerId,
    soldier: soldierOf(event),
    text,
    tone,
  };
  return [item, ...state.feed].slice(0, MAX_FEED);
}

/** Folds one agent event into the comb. Events that say nothing visible return the same state. */
export function reduceComb(state: CombState, event: AgentEvent): CombState {
  const key = beeKeyOf(event);
  if (!key) return state;
  const at = Date.parse(event.ts) || Date.now();
  const data = event.data ?? {};
  const bee = withBee(state, event, key, at);
  const put = (next: Partial<BeeTrack>, rest: Partial<CombState> = {}): CombState => ({
    ...state,
    ...rest,
    bees: { ...state.bees, [key]: { ...bee, ...next } },
  });

  switch (event.type) {
    case 'session.started':
      return put({ state: 'thinking', doing: 'Começando' });
    case 'worker.state': {
      const parsed = workerStateSchema.safeParse(data.state);
      if (!parsed.success) return state;
      const waiting =
        parsed.data === 'waiting_approval'
          ? 'Esperando sua aprovação'
          : parsed.data === 'waiting_provider'
            ? 'Esperando o provedor'
            : null;
      return put({ state: parsed.data, ...(waiting ? { doing: waiting } : {}) });
    }
    case 'tool.call': {
      const tool = str(data.tool);
      if (!tool) return state;
      const args = (data.args ?? {}) as Record<string, unknown>;
      const path = str(args.path);
      const doing = describeCall(tool, args);
      if (FILE_TOOLS.has(tool) && path) {
        const file = normalizePath(path);
        const cells = touch(state, file, (cell) =>
          tool === 'read_file' ? { reads: cell.reads + 1 } : {},
        );
        return put({ doing, target: file, alert: false }, cells);
      }
      if (tool === 'call_soldiers')
        return put(
          { doing: event.message || doing },
          {
            feed: feed(state, event, event.message || doing, 'info'),
          },
        );
      return put({ doing });
    }
    case 'file.changed': {
      const path = str(data.path);
      if (!path) return state;
      const file = normalizePath(path);
      const cells = touch(state, file, (cell) => ({
        writes: cell.writes + 1,
        writtenAt: at,
        taskId: event.taskId,
        runId: event.runId,
      }));
      const verb = data.action === 'created' ? 'criou' : 'editou';
      return put({ target: file }, { ...cells, feed: feed(state, event, `${verb} ${file}`, 'ok') });
    }
    case 'command.finished': {
      const command = str(data.command) ?? event.message;
      const failed = typeof data.exitCode === 'number' && data.exitCode !== 0;
      const timedOut = data.timedOut === true;
      const tone = failed || timedOut ? 'warn' : 'ok';
      const result = timedOut
        ? 'estourou o tempo'
        : failed
          ? `saiu com ${String(data.exitCode)}`
          : 'ok';
      return put(
        { alert: tone === 'warn' },
        { feed: feed(state, event, `$ ${command} · ${result}`, tone) },
      );
    }
    case 'model.response': {
      const usage = data.usage as { promptTokens?: number; completionTokens?: number } | null;
      const spent = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
      return spent ? { ...state, tokens: state.tokens + spent } : state;
    }
    case 'info': {
      // Soldiers announce when they start and when they report back.
      if (!bee.soldier) return state;
      if (data.phase === 'end')
        return put({ done: true, target: null, doing: 'Voltou com o relatório' });
      if (data.phase === 'start') return put({ doing: 'Saindo para a missão' });
      return state;
    }
    default:
      return state;
  }
}

/** Removes soldiers that reported back and bees whose task or chat is no longer running. */
export function pruneBees(state: CombState, alive: Set<string>): CombState {
  const bees: Record<string, BeeTrack> = {};
  for (const [key, bee] of Object.entries(state.bees)) {
    const base = bee.captain ?? key;
    if (alive.has(base) && !bee.done) bees[key] = bee;
  }
  return Object.keys(bees).length === Object.keys(state.bees).length ? state : { ...state, bees };
}

/* ------------------------------------------------------------------ Hexagon geometry */

/** Axial coordinates of the first `count` cells of a hexagonal spiral from the centre. */
export function spiral(count: number): { q: number; r: number }[] {
  const cells = [{ q: 0, r: 0 }];
  const directions = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ] as const;
  for (let ring = 1; cells.length < count; ring++) {
    let q = -ring;
    let r = ring;
    for (const [dq, dr] of directions)
      for (let step = 0; step < ring && cells.length < count; step++) {
        cells.push({ q, r });
        q += dq;
        r += dr;
      }
  }
  return cells.slice(0, count);
}

/** Centre of a pointy-top hexagon of the given radius. */
export function hexCenter({ q, r }: { q: number; r: number }, radius: number) {
  return { x: radius * Math.sqrt(3) * (q + r / 2), y: radius * 1.5 * r };
}

export function hexPoints(cx: number, cy: number, radius: number): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 30);
    return `${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`;
  }).join(' ');
}

/** How full of honey a cell is: the first edit shows, five or more fill it. */
export function honeyLevel(cell: Pick<CombCell, 'writes'>): number {
  return cell.writes ? Math.min(1, 0.25 + cell.writes * 0.15) : 0;
}
