import {
  dependencyLayers,
  looksLikeTestCommand,
  rolePresets,
  type AgentEvent,
  type CanvasSnapshot,
  type CanvasWorker,
  type Task,
  type WorkerState,
} from '@hive/core';

/**
 * The Nexus model: what each node means and where it goes, worked out from a snapshot of
 * the run (the scheduler's own records) and its events. Nothing here is invented: a value the
 * engine does not record is left out, not estimated.
 */

/** State colours: green done, cyan running, amber waiting, red failed or blocked, grey pending. */
export type Tone = 'done' | 'running' | 'waiting' | 'failed' | 'pending' | 'muted';

/** Prefix the scheduler gives tasks skipped because a dependency did not succeed. */
const BLOCKED = 'Dependência não concluída';

export const isBlocked = (task: Task) =>
  task.status === 'cancelled' && !!task.error?.startsWith(BLOCKED);

export function taskTone(task: Task): Tone {
  switch (task.status) {
    case 'completed':
    case 'approved':
      return 'done';
    case 'running':
      return task.workerState === 'waiting_provider' || task.workerState === 'waiting_approval'
        ? 'waiting'
        : 'running';
    case 'waiting_approval':
      return 'waiting';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'cancelled':
      return isBlocked(task) ? 'failed' : 'muted';
    default:
      return 'pending';
  }
}

export const taskStatusLabels: Record<Task['status'], string> = {
  pending: 'Na fila',
  blocked: 'Bloqueada',
  running: 'Em execução',
  waiting_approval: 'Aguardando você',
  completed: 'Pronta para revisão',
  failed: 'Falhou',
  cancelled: 'Cancelada',
  approved: 'Aplicada',
  rejected: 'Descartada',
};

export const workerStateLabels: Record<WorkerState, string> = {
  idle: 'Parado',
  planning: 'Planejando',
  thinking: 'Pensando',
  coding: 'Programando',
  testing: 'Testando',
  reviewing: 'Revisando',
  waiting_approval: 'Aguardando você',
  waiting_provider: 'Aguardando o provedor',
  completed: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

const LIVE = new Set<Task['status']>(['running', 'waiting_approval']);
const DONE = new Set<Task['status']>(['completed', 'approved']);
export const isLive = (task: Task) => LIVE.has(task.status);

export function roleLabel(role: CanvasWorker['role']): string {
  return rolePresets[role].label;
}

/** What one agent is doing on this run, derived from its tasks. */
export interface AgentStatus {
  state: WorkerState;
  tone: Tone;
  /** The task it is on now, if any. */
  current: Task | null;
  tasks: Task[];
  done: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  /** Null when any finished task has no known price. */
  costUsd: number | null;
}

export function agentStatus(worker: CanvasWorker, snapshot: CanvasSnapshot): AgentStatus {
  const { tasks, run } = snapshot.detail;
  const mine = sortTasks(tasks.filter((task) => task.workerId === worker.id));
  const current = mine.find(isLive) ?? null;
  const done = mine.filter((task) => DONE.has(task.status)).length;
  const failed = mine.filter((task) => taskTone(task) === 'failed').length;
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd: number | null = 0;
  for (const task of mine) {
    const usage = snapshot.usage[task.id];
    if (!usage) continue;
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    costUsd = costUsd === null || usage.costUsd === null ? null : costUsd + usage.costUsd;
  }
  let state: WorkerState;
  if (worker.role === 'queen' && run.queenWorkerId === worker.id && !mine.length)
    state = snapshot.planning ? 'planning' : tasks.length ? 'completed' : 'idle';
  else if (current) state = current.workerState;
  else if (mine.length && done === mine.length) state = 'completed';
  else if (failed) state = 'failed';
  else state = 'idle';
  const tone: Tone =
    state === 'waiting_approval' || state === 'waiting_provider'
      ? 'waiting'
      : state === 'completed'
        ? 'done'
        : state === 'failed'
          ? 'failed'
          : state === 'idle' || state === 'cancelled'
            ? 'pending'
            : 'running';
  return {
    state,
    tone,
    current,
    tasks: mine,
    done,
    failed,
    promptTokens,
    completionTokens,
    costUsd,
  };
}

/** The repository lists tasks by last update; the canvas needs an order that does not jump. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key),
  );
}

/* ------------------------------------------------------------------ graph */

/**
 * How the execution graph is laid out: `workspace` gives each agent a live window with its tasks
 * underneath; `agent` puts each agent's tasks in a lane; `none` shows only the task flow.
 */
export type Grouping = 'workspace' | 'agent' | 'none';
export type EdgeKind = 'dependency' | 'assignment' | 'coordination' | 'aggregation' | 'memory';

export interface GraphNode {
  id: string;
  type: 'agent' | 'task' | 'lane' | 'note' | 'frame' | 'result' | 'cortex';
  position: { x: number; y: number };
  parentId?: string;
  width: number;
  height: number;
  /** Ids the node stands for: a task, a worker, or a lane (worker id or `unassigned`). */
  ref: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  tone: Tone;
  /** Work flows along it right now: the source is done and the target is running. */
  active: boolean;
  /** Stands for edges into a collapsed group. */
  folded: boolean;
}

export const SIZE = {
  task: { width: 248, height: 86 },
  agent: { width: 220, height: 74 },
  cortex: { width: 300, height: 158 },
  /** An agent's window on the workspace, before the user resizes it. */
  window: { width: 520, height: 400 },
  columnGap: 76,
  rowGap: 16,
  lanePad: 18,
  laneHeader: 30,
  laneGap: 22,
};

export const nodeId = {
  task: (id: string) => `task:${id}`,
  agent: (id: string) => `agent:${id}`,
  group: (id: string) => `group:${id}`,
  cortex: (id: string) => `cortex:${id}`,
};
export const UNASSIGNED = 'unassigned';

const roleOrder: CanvasWorker['role'][] = [
  'architect',
  'backend',
  'frontend',
  'custom',
  'qa',
  'reviewer',
  'queen',
];

export interface GraphOptions {
  grouping: Grouping;
  /** Lanes folded down to their agent. */
  collapsed: ReadonlySet<string>;
  /** Agents put on the canvas by hand; they show even without a task in the plan. */
  extraAgents?: readonly string[];
  /** Size of an agent's window in the workspace view; null when it is shown as a card. */
  windowSize?: (workerId: string) => { width: number; height: number } | null;
  /** Cortex blocks of the project, with the agents connected to each. */
  cortex?: readonly { id: string; workers: readonly string[] }[];
}

/**
 * Lays the run out left to right: the Queen first, then the tasks in dependency columns. Grouped
 * by agent, each agent gets a lane and its tasks stay in it; otherwise tasks are ordered within
 * their column next to the tasks they depend on, which keeps crossing lines down.
 */
export function buildGraph(
  snapshot: CanvasSnapshot,
  options: GraphOptions,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const tasks = sortTasks(snapshot.detail.tasks);
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const layerOf = new Map<string, number>();
  dependencyLayers(tasks).forEach((layer, index) => {
    for (const key of layer) layerOf.set(key, index);
  });
  const columns = Math.max(1, ...[...layerOf.values()].map((layer) => layer + 1));
  const workers = new Map(snapshot.workers.map((worker) => [worker.id, worker]));
  const queen = snapshot.detail.run.queenWorkerId
    ? (workers.get(snapshot.detail.run.queenWorkerId) ?? null)
    : null;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const extras = (options.extraAgents ?? []).filter(
    (id) => workers.has(id) && id !== queen?.id && !tasks.some((task) => task.workerId === id),
  );
  /** Where an edge to a task actually lands: the task, or its agent when the lane is folded. */
  const visible = new Map<string, string>();
  const columnX = (layer: number, origin: number) =>
    origin + layer * (SIZE.task.width + SIZE.columnGap);
  const queenNode = queen ? nodeId.agent(queen.id) : null;
  const left = queen ? SIZE.agent.width + SIZE.columnGap * 1.4 : 0;

  if (options.grouping === 'workspace') {
    // One column per agent: its window on top, its tasks underneath, columns in flow order.
    const columnsOf = new Map<string, Task[]>();
    for (const task of tasks) {
      const column = task.workerId && workers.has(task.workerId) ? task.workerId : UNASSIGNED;
      columnsOf.set(column, [...(columnsOf.get(column) ?? []), task]);
    }
    for (const id of extras) columnsOf.set(id, []);
    const firstLayer = (list: Task[]) =>
      list.length ? Math.min(...list.map((t) => layerOf.get(t.key) ?? 0)) : Infinity;
    const rank = (column: string) => {
      const role = workers.get(column)?.role;
      return role ? roleOrder.indexOf(role) : roleOrder.length;
    };
    const order = [...columnsOf.entries()].sort(
      ([a, listA], [b, listB]) =>
        firstLayer(listA) - firstLayer(listB) || rank(a) - rank(b) || a.localeCompare(b),
    );
    let x = left;
    let bottom = 0;
    for (const [column, list] of order) {
      const worker = workers.get(column);
      const size = worker ? (options.windowSize?.(column) ?? null) : null;
      const head = worker ? (size ?? SIZE.agent) : null;
      const width = Math.max(SIZE.task.width, head?.width ?? 0);
      let y = 0;
      if (worker && head) {
        const agent = nodeId.agent(column);
        nodes.push({
          id: agent,
          type: 'agent',
          position: { x, y: 0 },
          width: head.width,
          height: head.height,
          ref: column,
        });
        if (queenNode) edges.push(edge(queenNode, agent, 'coordination', 'pending'));
        y = head.height + SIZE.columnGap * 0.6;
      }
      for (const task of [...list].sort(
        (a, b) => (layerOf.get(a.key) ?? 0) - (layerOf.get(b.key) ?? 0),
      )) {
        const id = nodeId.task(task.id);
        visible.set(task.key, id);
        nodes.push({
          id,
          type: 'task',
          position: { x, y },
          width: SIZE.task.width,
          height: SIZE.task.height,
          ref: task.id,
        });
        if (worker) edges.push(edge(nodeId.agent(column), id, 'assignment', taskTone(task)));
        else if (queenNode) edges.push(edge(queenNode, id, 'coordination', 'pending'));
        y += SIZE.task.height + SIZE.rowGap;
      }
      bottom = Math.max(bottom, y);
      x += width + SIZE.columnGap;
    }
    if (queen && queenNode)
      nodes.unshift({
        id: queenNode,
        type: 'agent',
        position: { x: 0, y: Math.max(0, Math.min(bottom, SIZE.window.height) / 2 - 37) },
        width: SIZE.agent.width,
        height: SIZE.agent.height,
        ref: queen.id,
      });
  } else if (options.grouping === 'agent') {
    const lanes = new Map<string, Task[]>();
    for (const task of tasks) {
      const lane = task.workerId && workers.has(task.workerId) ? task.workerId : UNASSIGNED;
      lanes.set(lane, [...(lanes.get(lane) ?? []), task]);
    }
    for (const id of extras) lanes.set(id, []);
    const firstLayer = (list: Task[]) =>
      list.length ? Math.min(...list.map((t) => layerOf.get(t.key) ?? 0)) : Infinity;
    const rank = (lane: string) => {
      const role = workers.get(lane)?.role;
      return role ? roleOrder.indexOf(role) : roleOrder.length;
    };
    const order = [...lanes.entries()].sort(
      ([a, listA], [b, listB]) =>
        firstLayer(listA) - firstLayer(listB) || rank(a) - rank(b) || a.localeCompare(b),
    );
    const innerLeft = SIZE.lanePad + SIZE.agent.width + SIZE.columnGap;
    const laneWidth =
      innerLeft + columns * (SIZE.task.width + SIZE.columnGap) - SIZE.columnGap + SIZE.lanePad;
    let y = 0;
    for (const [lane, list] of order) {
      const group = nodeId.group(lane);
      const folded = options.collapsed.has(lane);
      const perColumn = new Map<number, number>();
      for (const task of list) {
        const layer = layerOf.get(task.key) ?? 0;
        perColumn.set(layer, (perColumn.get(layer) ?? 0) + 1);
      }
      const rows = Math.max(1, ...perColumn.values());
      const body = folded
        ? SIZE.agent.height
        : Math.max(SIZE.agent.height, rows * (SIZE.task.height + SIZE.rowGap) - SIZE.rowGap);
      const height = SIZE.laneHeader + body + SIZE.lanePad;
      nodes.push({
        id: group,
        type: 'lane',
        position: { x: left, y },
        width: laneWidth,
        height,
        ref: lane,
      });
      const agent = workers.has(lane) ? nodeId.agent(lane) : null;
      if (agent) {
        nodes.push({
          id: agent,
          type: 'agent',
          parentId: group,
          position: {
            x: SIZE.lanePad,
            y: SIZE.laneHeader + (body - SIZE.agent.height) / 2,
          },
          width: SIZE.agent.width,
          height: SIZE.agent.height,
          ref: lane,
        });
        if (queenNode && lane !== queen?.id)
          edges.push(edge(queenNode, agent, 'coordination', 'pending'));
      }
      const slot = new Map<number, number>();
      for (const task of list) {
        const id = nodeId.task(task.id);
        if (folded) {
          visible.set(task.key, agent ?? group);
          continue;
        }
        visible.set(task.key, id);
        const layer = layerOf.get(task.key) ?? 0;
        const row = slot.get(layer) ?? 0;
        slot.set(layer, row + 1);
        nodes.push({
          id,
          type: 'task',
          parentId: group,
          position: {
            x: columnX(layer, innerLeft),
            y: SIZE.laneHeader + row * (SIZE.task.height + SIZE.rowGap),
          },
          width: SIZE.task.width,
          height: SIZE.task.height,
          ref: task.id,
        });
        if (agent) edges.push(edge(agent, id, 'assignment', taskTone(task)));
        else if (queenNode) edges.push(edge(queenNode, id, 'coordination', 'pending'));
      }
      y += height + SIZE.laneGap;
    }
    if (queen && queenNode)
      nodes.unshift({
        id: queenNode,
        type: 'agent',
        position: { x: 0, y: Math.max(0, (y - SIZE.laneGap - SIZE.agent.height) / 2) },
        width: SIZE.agent.width,
        height: SIZE.agent.height,
        ref: queen.id,
      });
  } else {
    // Columns by dependency layer; within one, tasks sit near the average row of their deps.
    const rowOf = new Map<string, number>();
    const columnsList: Task[][] = Array.from({ length: columns }, () => []);
    for (const task of tasks) columnsList[layerOf.get(task.key) ?? 0]!.push(task);
    columnsList.forEach((column, layer) => {
      const weight = (task: Task) => {
        const rows = task.dependsOn.map((dep) => rowOf.get(dep)).filter((row) => row !== undefined);
        return rows.length ? rows.reduce((sum, row) => sum + row, 0) / rows.length : -1;
      };
      if (layer > 0) column.sort((a, b) => weight(a) - weight(b));
      column.forEach((task, row) => {
        rowOf.set(task.key, row);
        const id = nodeId.task(task.id);
        visible.set(task.key, id);
        nodes.push({
          id,
          type: 'task',
          position: { x: columnX(layer, left), y: row * (SIZE.task.height + SIZE.rowGap * 2) },
          width: SIZE.task.width,
          height: SIZE.task.height,
          ref: task.id,
        });
        if (queenNode && !task.dependsOn.some((dep) => byKey.has(dep)))
          edges.push(edge(queenNode, id, 'coordination', 'pending'));
      });
    });
    const tallest = Math.max(1, ...columnsList.map((column) => column.length));
    if (queen && queenNode)
      nodes.unshift({
        id: queenNode,
        type: 'agent',
        position: {
          x: 0,
          y: Math.max(
            0,
            (tallest * (SIZE.task.height + SIZE.rowGap * 2) - SIZE.rowGap * 2) / 2 -
              SIZE.agent.height / 2,
          ),
        },
        width: SIZE.agent.width,
        height: SIZE.agent.height,
        ref: queen.id,
      });
  }

  // Dependencies, folded onto the agent when a lane is collapsed; repeats and loops dropped.
  const seen = new Set<string>();
  for (const task of tasks) {
    const target = visible.get(task.key);
    if (!target) continue;
    for (const dep of task.dependsOn) {
      const from = byKey.get(dep);
      const source = from && visible.get(dep);
      if (!from || !source || source === target) continue;
      const key = `${source}->${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tone = taskTone(from);
      const folded = source !== nodeId.task(from.id) || target !== nodeId.task(task.id);
      edges.push({
        ...edge(
          source,
          target,
          'dependency',
          tone === 'done' || tone === 'failed' ? tone : 'pending',
        ),
        active: tone === 'done' && isLive(task),
        folded,
      });
    }
  }
  const resultId = `result:${snapshot.detail.run.missionId}`;
  const right = Math.max(
    0,
    ...nodes.filter((node) => !node.parentId).map((node) => node.position.x + node.width),
  );
  nodes.push({
    id: resultId,
    type: 'result',
    position: { x: right + SIZE.columnGap, y: 0 },
    width: 320,
    height: 228,
    ref: snapshot.detail.run.missionId,
  });
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependedOn = new Set(tasks.flatMap((task) => task.dependsOn));
  const terminalTasks = nodes.filter(
    (node) => node.type === 'task' && !dependedOn.has(tasksById.get(node.ref)?.key ?? node.ref),
  );
  const sources =
    options.grouping === 'none'
      ? terminalTasks
      : [
          ...nodes.filter((node) => node.type === 'agent' && node.id !== queenNode),
          ...(options.grouping === 'agent'
            ? nodes.filter((node) => node.type === 'lane' && node.ref === UNASSIGNED)
            : terminalTasks.filter(
                (node) => !workers.has(tasksById.get(node.ref)?.workerId ?? ''),
              )),
        ];
  for (const source of sources) edges.push(edge(source.id, resultId, 'aggregation', 'muted'));

  // Shared memory sits under the team; a line from an agent is its access, drawn by the user.
  const bottom = Math.max(
    0,
    ...nodes.filter((node) => !node.parentId).map((node) => node.position.y + node.height),
  );
  const agentNodes = new Map(
    nodes.filter((node) => node.type === 'agent').map((node) => [node.ref, node.id]),
  );
  (options.cortex ?? []).forEach((block, index) => {
    const id = nodeId.cortex(block.id);
    nodes.push({
      id,
      type: 'cortex',
      position: {
        x: left + index * (SIZE.cortex.width + SIZE.columnGap),
        y: bottom + SIZE.columnGap * 1.2,
      },
      width: SIZE.cortex.width,
      height: SIZE.cortex.height,
      ref: block.id,
    });
    for (const workerId of block.workers) {
      const agent = agentNodes.get(workerId);
      if (agent) edges.push(edge(agent, id, 'memory', 'running'));
    }
  });
  return { nodes, edges };
}

function edge(source: string, target: string, kind: EdgeKind, tone: Tone): GraphEdge {
  return {
    id: `${kind}:${source}->${target}`,
    source,
    target,
    kind,
    tone,
    active: false,
    folded: false,
  };
}

/* ------------------------------------------------------------------ run figures */

/** From the first task that started to the end of the run (or now, while it runs). */
export function runElapsedMs(snapshot: CanvasSnapshot, now: number): number | null {
  const starts = snapshot.detail.tasks
    .map((task) => task.startedAt)
    .filter((value): value is string => !!value)
    .map((value) => Date.parse(value));
  if (!starts.length) return null;
  const { run } = snapshot.detail;
  const ends = snapshot.detail.tasks
    .map((task) => task.finishedAt)
    .filter((value): value is string => !!value)
    .map((value) => Date.parse(value));
  const live = run.status === 'running' || snapshot.detail.tasks.some(isLive);
  const end = live
    ? now
    : run.finishedAt
      ? Date.parse(run.finishedAt)
      : ends.length
        ? Math.max(...ends)
        : now;
  return Math.max(0, end - Math.min(...starts));
}

export function taskElapsedMs(task: Task, now: number): number | null {
  if (!task.startedAt) return null;
  const end = task.finishedAt && !isLive(task) ? Date.parse(task.finishedAt) : now;
  return Math.max(0, end - Date.parse(task.startedAt));
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

/** Agents at work now: those on a live task, and the Queen while she plans. */
export function activeAgents(snapshot: CanvasSnapshot): number {
  const busy = new Set(
    snapshot.detail.tasks.filter(isLive).map((task) => task.workerId ?? `task:${task.id}`),
  );
  if (snapshot.planning && snapshot.detail.run.queenWorkerId)
    busy.add(snapshot.detail.run.queenWorkerId);
  return busy.size;
}

/* ------------------------------------------------------------------ console */

export interface TestRun {
  id: string;
  taskId: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  output: string;
  /** From the task's recorded result, or seen live while the task still runs. */
  source: 'result' | 'live';
}

/**
 * Test-like commands the agents ran: from each finished task's result, and from the live
 * stream for tasks that have not reported yet.
 */
export function testRuns(tasks: Task[], events: AgentEvent[]): TestRun[] {
  const runs: TestRun[] = [];
  const reported = new Set<string>();
  for (const task of sortTasks(tasks)) {
    if (!task.result || isLive(task)) continue;
    reported.add(task.id);
    task.result.commands.forEach((command, index) => {
      if (!looksLikeTestCommand(command.command)) return;
      runs.push({
        id: `${task.id}:${index}`,
        taskId: task.id,
        command: command.command,
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        durationMs: command.durationMs,
        output: command.outputTail,
        source: 'result',
      });
    });
  }
  for (const event of events) {
    if (event.type !== 'command.finished' || !event.taskId || reported.has(event.taskId)) continue;
    const command = typeof event.data?.command === 'string' ? event.data.command : '';
    if (!command || !looksLikeTestCommand(command)) continue;
    runs.push({
      id: event.id,
      taskId: event.taskId,
      command,
      exitCode: typeof event.data?.exitCode === 'number' ? event.data.exitCode : null,
      timedOut: event.data?.timedOut === true,
      durationMs: typeof event.data?.durationMs === 'number' ? event.data.durationMs : null,
      output: typeof event.data?.outputTail === 'string' ? event.data.outputTail : '',
      source: 'live',
    });
  }
  return runs;
}

export interface ChangedFile {
  path: string;
  status: string;
  taskId: string;
  /** Committed in the task's result, or only seen being written in its worktree so far. */
  source: 'result' | 'live';
}

export function changedFiles(tasks: Task[], events: AgentEvent[]): ChangedFile[] {
  const files: ChangedFile[] = [];
  const reported = new Set<string>();
  for (const task of sortTasks(tasks)) {
    if (!task.result || isLive(task)) continue;
    reported.add(task.id);
    for (const file of task.result.filesChanged)
      files.push({ path: file.path, status: file.status, taskId: task.id, source: 'result' });
  }
  const live = new Map<string, ChangedFile>();
  for (const event of events) {
    if (event.type !== 'file.changed' || !event.taskId || reported.has(event.taskId)) continue;
    const path = typeof event.data?.path === 'string' ? event.data.path : null;
    if (!path) continue;
    const action = typeof event.data?.action === 'string' ? event.data.action : 'modified';
    const key = `${event.taskId}:${path}`;
    const status = live.get(key)?.status === 'created' ? 'created' : action;
    live.set(key, { path, status, taskId: event.taskId, source: 'live' });
  }
  return [...files, ...live.values()];
}

export interface TerminalEntry {
  id: string;
  taskId: string | null;
  workerId: string | null;
  command: string;
  /** Null while the command is still running. */
  exitCode: number | null;
  finished: boolean;
  timedOut: boolean;
  durationMs: number | null;
  output: string;
  ts: string;
}

/** The commands agents ran, paired start to finish, as a terminal would show them. */
export function terminalEntries(events: AgentEvent[]): TerminalEntry[] {
  const entries: TerminalEntry[] = [];
  const open = new Map<string, TerminalEntry>();
  for (const event of events) {
    const command = typeof event.data?.command === 'string' ? event.data.command : null;
    if (!command) continue;
    const key = `${event.taskId}:${command}`;
    if (event.type === 'command.started') {
      const entry: TerminalEntry = {
        id: event.id,
        taskId: event.taskId,
        workerId: event.workerId,
        command,
        exitCode: null,
        finished: false,
        timedOut: false,
        durationMs: null,
        output: '',
        ts: event.ts,
      };
      entries.push(entry);
      open.set(key, entry);
    } else if (event.type === 'command.finished') {
      const entry = open.get(key);
      const finished = {
        exitCode: typeof event.data?.exitCode === 'number' ? event.data.exitCode : null,
        finished: true,
        timedOut: event.data?.timedOut === true,
        durationMs: typeof event.data?.durationMs === 'number' ? event.data.durationMs : null,
        output: typeof event.data?.outputTail === 'string' ? event.data.outputTail : '',
      };
      if (entry) {
        Object.assign(entry, finished);
        open.delete(key);
      } else
        entries.push({
          id: event.id,
          taskId: event.taskId,
          workerId: event.workerId,
          command,
          ts: event.ts,
          ...finished,
        });
    }
  }
  return entries;
}
