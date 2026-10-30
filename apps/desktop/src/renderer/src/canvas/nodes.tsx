import { createContext, memo, useContext, useEffect, useState } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Pin,
  ShieldQuestion,
  FileText,
  Expand,
} from 'lucide-react';
import type {
  AgentEvent,
  CanvasSnapshot,
  CanvasTerminal,
  CanvasWorker,
  Task,
  TerminalEvent,
  LiveResult,
} from '@hive/core';
import { AgentBee } from '../mascot';
import { HoneyJar } from '../honey';
import { AgentWindow, RestoreButton, type AgentTab } from './agent-window';
import {
  UNASSIGNED,
  isLive,
  roleLabel,
  taskStatusLabels,
  taskTone,
  workerStateLabels,
  type AgentStatus,
  type Grouping,
} from './model';
import type { Frame, Note } from './use-layout';

/** What every node reads; nodes only carry the id of what they stand for. */
export interface CanvasView {
  liveResult?: LiveResult | null;
  resultError?: string;
  openResult?: () => void;
  snapshot: CanvasSnapshot;
  grouping: Grouping;
  tasks: Map<string, Task>;
  workers: Map<string, CanvasWorker>;
  agents: Map<string, AgentStatus>;
  events: AgentEvent[];
  now: number;
  /** Latest meaningful line per task from the live stream. */
  activity: Record<string, string>;
  /** Task ids with a command waiting for the user's answer. */
  approvals: Set<string>;
  collapsed: ReadonlySet<string>;
  toggleGroup: (lane: string) => void;
  /** Node ids whose position the user fixed in this view. */
  pinned: ReadonlySet<string>;
  togglePin: (nodeId: string) => void;
  /** Agents (worker ids) shown as a card instead of a window. */
  minimized: ReadonlySet<string>;
  setMinimized: (workerId: string, minimized: boolean) => void;
  setSize: (id: string, size: { width: number; height: number }) => void;
  /** The agent whose window is open full size, if any. */
  expanded: string | null;
  expand: (workerId: string | null) => void;
  agentTab: (workerId: string) => AgentTab;
  setAgentTab: (workerId: string, tab: AgentTab) => void;
  terminalsOf: (workerId: string) => CanvasTerminal[];
  openTerminal: (workerId: string, kind: 'chat' | 'shell') => Promise<void>;
  stopTerminal: (sessionId: string) => Promise<void>;
  subscribeTerminal: (listener: (event: TerminalEvent) => void) => () => void;
  notes: Map<string, Note>;
  frames: Map<string, Frame>;
  updateNote: (id: string, patch: Partial<Note>) => void;
  updateFrame: (id: string, patch: Partial<Frame>) => void;
}

export const CanvasViewContext = createContext<CanvasView | null>(null);

function useView(): CanvasView {
  const view = useContext(CanvasViewContext);
  if (!view) throw new Error('Canvas nodes need a CanvasViewContext.');
  return view;
}

export type NodeData = { ref: string };
export type CanvasNode = Node<NodeData, 'agent' | 'task' | 'lane' | 'note' | 'frame' | 'result'>;

/** Handles are where connections are drawn; the engine decides what a drawn line may do. */
function Handles({ source, target }: { source: boolean; target: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={target} />
      <Handle type="source" position={Position.Right} isConnectable={source} />
    </>
  );
}

function PinMark({ id }: { id: string }) {
  const view = useView();
  if (!view.pinned.has(id)) return null;
  return <Pin size={11} className="nc-pin-mark" aria-label="Posição fixada" />;
}

export const AgentNode = memo(function AgentNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const worker = view.workers.get(data.ref);
  const status = view.agents.get(data.ref);
  if (!worker || !status) return null;
  const queen = worker.role === 'queen';
  // A line from an agent to a task delegates it (the engine checks it has not started).
  const handles = <Handles source={!queen} target={false} />;
  const windowed = view.grouping === 'workspace' && !queen && !view.minimized.has(worker.id);
  if (windowed)
    return (
      <>
        <NodeResizer
          isVisible={selected}
          minWidth={360}
          minHeight={240}
          lineClassName="nc-resize-line"
          handleClassName="nc-resize-handle"
          onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
        />
        {handles}
        <AgentWindow
          view={view}
          workerId={worker.id}
          selected={selected}
          pinned={view.pinned.has(id)}
        />
      </>
    );
  const working = status.tone === 'running';
  const total = status.tasks.length;
  return (
    <div
      className={`nc-node nc-agent tone-${status.tone}${selected ? ' selected' : ''}${queen ? ' queen' : ''}`}
    >
      {handles}
      <div className="nc-agent-avatar">
        <AgentBee worker={worker} size={30} mood={working ? 'working' : 'still'} />
        <span className="nc-pulse" aria-hidden />
      </div>
      <div className="nc-agent-body">
        <strong className="truncate">{worker.name}</strong>
        <span className="nc-sub truncate">{roleLabel(worker.role)}</span>
        <span className="nc-state">
          <span className="nc-dot" aria-hidden />
          {workerStateLabels[status.state]}
          {total > 0 && (
            <span className="nc-count">
              {status.done}/{total}
            </span>
          )}
        </span>
      </div>
      <PinMark id={id} />
      {view.grouping === 'workspace' && !queen && (
        <RestoreButton view={view} workerId={worker.id} />
      )}
      {total > 0 && (
        <span
          className="nc-progress"
          role="progressbar"
          aria-label="Tarefas concluídas"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={status.done}
        >
          <span style={{ width: `${(status.done / total) * 100}%` }} />
        </span>
      )}
    </div>
  );
});

export const TaskNode = memo(function TaskNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const task = view.tasks.get(data.ref);
  if (!task) return null;
  const tone = taskTone(task);
  const worker = task.workerId ? view.workers.get(task.workerId) : undefined;
  const live = isLive(task);
  const asking = view.approvals.has(task.id);
  const line = live
    ? (view.activity[task.id] ?? workerStateLabels[task.workerState])
    : task.error && tone === 'failed'
      ? task.error
      : null;
  return (
    <div className={`nc-node nc-task tone-${tone}${selected ? ' selected' : ''}`}>
      {/* Task to task is a dependency; the engine refuses cycles and tasks already started. */}
      <Handles source target />
      <div className="nc-task-head">
        <span className="nc-dot" aria-hidden />
        <strong className="truncate" title={task.title}>
          {task.title}
        </strong>
        {task.boosted && <HoneyJar size={12} label="Com mel: prioridade" />}
        {asking && <ShieldQuestion size={13} className="nc-asking" aria-label="Pede aprovação" />}
        <PinMark id={id} />
      </div>
      <div className="nc-task-meta">
        {worker ? (
          <span className="nc-who">
            <AgentBee worker={worker} size={13} mood={live ? 'working' : 'still'} />
            <span className="truncate">{worker.name}</span>
          </span>
        ) : (
          <span className="nc-who muted-text">Agente automático</span>
        )}
        <span className="nc-status">{taskStatusLabels[task.status]}</span>
      </div>
      <div className="nc-task-foot">
        {line ? (
          <span className={`nc-line truncate${tone === 'failed' ? ' error' : ''}`} title={line}>
            {line}
          </span>
        ) : (
          <span className="nc-line nc-key truncate">
            {task.key}
            {task.dependsOn.length > 0 && ` · ← ${task.dependsOn.length}`}
            {task.attempt > 1 && ` · tentativa ${task.attempt}`}
          </span>
        )}
        {task.branch && (
          <GitBranch size={11} className="nc-branch" aria-label={`Branch ${task.branch}`} />
        )}
      </div>
      {live && <span className="nc-scan" aria-hidden />}
    </div>
  );
});

export const GroupNode = memo(function GroupNode({ data }: NodeProps<CanvasNode>) {
  const view = useView();
  const lane = data.ref;
  const worker = view.workers.get(lane);
  const status = view.agents.get(lane);
  const tasks =
    status?.tasks ??
    [...view.tasks.values()].filter((task) => !task.workerId && lane === UNASSIGNED);
  const folded = view.collapsed.has(lane);
  const running = tasks.filter(isLive).length;
  const done = tasks.filter((task) => taskTone(task) === 'done').length;
  const failed = tasks.filter((task) => taskTone(task) === 'failed').length;
  return (
    <div className={`nc-group tone-${status?.tone ?? 'pending'}`}>
      {!worker && <Handle type="source" position={Position.Right} isConnectable={false} />}
      <button
        className="nc-group-head nodrag"
        aria-expanded={!folded}
        title={folded ? 'Expandir grupo' : 'Recolher grupo'}
        onClick={() => view.toggleGroup(lane)}
      >
        {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span className="nc-group-name truncate">
          {worker ? roleLabel(worker.role) : 'Sem agente definido'}
        </span>
        <span className="nc-group-counts">
          {tasks.length} {tasks.length === 1 ? 'tarefa' : 'tarefas'}
          {running > 0 && <em className="tone-running">{running} em execução</em>}
          {done > 0 && <em className="tone-done">{done} concluída(s)</em>}
          {failed > 0 && <em className="tone-failed">{failed} com falha</em>}
        </span>
      </button>
    </div>
  );
});

/** Text kept on the canvas: notes and instructions for whoever looks at it. Visual only. */
export const NoteNode = memo(function NoteNode({ id, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const note = view.notes.get(id);
  const stored = note?.text ?? '';
  const [draft, setDraft] = useState(stored);
  // The stored text wins whenever it changes (a save, another edit).
  useEffect(() => setDraft(stored), [stored]);
  if (!note) return null;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={90}
        lineClassName="nc-resize-line"
        handleClassName="nc-resize-handle"
        onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
      />
      <div className={`nc-note tone-note-${note.tone}${selected ? ' selected' : ''}`}>
        <textarea
          className="nodrag nowheel"
          value={draft}
          placeholder="Escreva uma nota…"
          aria-label="Nota"
          maxLength={8000}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft !== note.text && view.updateNote(id, { text: draft })}
        />
      </div>
    </>
  );
});

/** A titled area that groups agents, tasks and notes; moving it moves what is inside. */
export const FrameNode = memo(function FrameNode({ id, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const frame = view.frames.get(id);
  const stored = frame?.title ?? '';
  const [title, setTitle] = useState(stored);
  useEffect(() => setTitle(stored), [stored]);
  if (!frame) return null;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={240}
        minHeight={160}
        lineClassName="nc-resize-line"
        handleClassName="nc-resize-handle"
        onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
      />
      <div className={`nc-frame${selected ? ' selected' : ''}`}>
        <input
          className="nc-frame-title nodrag"
          value={title}
          placeholder="Nome do grupo"
          aria-label="Nome do grupo"
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => title !== frame.title && view.updateFrame(id, { title })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </div>
    </>
  );
});

export const LiveResultNode = memo(function LiveResultNode({
  id,
  selected,
}: NodeProps<CanvasNode>) {
  const view = useView();
  const result = view.liveResult;
  const [seen, setSeen] = useState(result?.changeCount ?? 0);
  const fresh = (result?.changeCount ?? 0) > seen;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={290}
        minHeight={220}
        lineClassName="nc-resize-line"
        handleClassName="nc-resize-handle"
        onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
      />
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className={`nc-node nc-live-result${selected ? ' selected' : ''}`}>
        <header className="nc-window-head">
          <FileText size={18} />
          <strong>Resultado Vivo</strong>
          <PinMark id={id} />
          {fresh && (
            <span
              className="nc-result-new"
              title="Há novas informações"
              aria-label="Novas informações"
            />
          )}
        </header>
        <div className="nc-result-card-body">
          <strong className="truncate">{view.snapshot.detail.mission.title}</strong>
          <span className="nc-sub">
            {result?.changeCount ?? 0} alterações registradas ·{' '}
            {view.resultError
              ? 'Sincronização pendente'
              : !result
                ? 'Conectando…'
                : view.snapshot.detail.run.status === 'running'
                  ? 'Acompanhando execução'
                  : 'Sincronizado'}
          </span>
          <p className="nc-result-excerpt">
            {result
              ? `${result.completed.length} tarefa(s) concluída(s), ${result.active.length} em andamento, ${result.remaining.length} por concluir. ${result.tests.length ? `${result.tests.filter((test) => test.status === 'passed').length}/${result.tests.length} testes/verificações aprovados.` : 'Testes não executados.'}`
              : view.resultError || 'Carregando fatos do motor…'}
          </p>
          <span className="nc-sub">
            Última atualização:{' '}
            {result?.updatedAt ? new Date(result.updatedAt).toLocaleTimeString('pt-BR') : '—'}
          </span>
          <button
            className="ghost nodrag"
            onClick={() => {
              setSeen(result?.changeCount ?? 0);
              view.openResult?.();
            }}
          >
            <Expand size={13} /> Expandir relatório e notas
          </button>
        </div>
      </div>
    </>
  );
});

export const nodeTypes = {
  result: LiveResultNode,
  agent: AgentNode,
  task: TaskNode,
  lane: GroupNode,
  note: NoteNode,
  frame: FrameNode,
};
