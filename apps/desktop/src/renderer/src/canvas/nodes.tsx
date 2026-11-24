import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { FULL_AT, NectarDrips, PixelDrop } from './cortex/nectar-art';
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  MessagesSquare,
  ChevronRight,
  GitBranch,
  Pin,
  ShieldQuestion,
  FileText,
  Expand,
  Gauge,
  Minimize2,
  Power,
  RotateCcw,
  SquareTerminal,
  Bell,
  CalendarClock,
  Check,
  FlaskConical,
  Play,
  Stamp,
  X,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type {
  AgentEvent,
  CortexOverview,
  CanvasSnapshot,
  CanvasTerminal,
  CanvasWorker,
  DeliveryRequirement,
  FlowBlockState,
  Task,
  TerminalEvent,
  LiveResult,
  TokenMeter,
  ProviderConfig,
  ProviderKind,
} from '@hive/core';
import { providerPresets, selectablePresets } from '@hive/core';
import { AgentBee } from '../mascot';
import { teamRoleLabels } from './team-panel';
import { HoneyJar } from '../honey';
import { ClaudeLogo, ProviderLogo, providerColor } from '../provider-logo';
import { TerminalView } from '../terminal-view';
import { AgentWindow, RestoreButton, type AgentTab } from './agent-window';
import { buildDialogue } from './dialogue';
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
import type { FlowBlock, Frame, Note, ProviderBlock, TerminalBlock } from './use-layout';
import { Select, useTask } from '../ui';

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
  providerBlocks: Map<string, ProviderBlock>;
  terminalBlocks: Map<string, TerminalBlock>;
  flowBlocks: Map<string, FlowBlock>;
  /** What each flow block did last. */
  flowState: Record<string, FlowBlockState>;
  updateFlowBlock: (id: string, patch: Partial<FlowBlock>) => void;
  /** Project commands a check block can run. */
  flowCommands: string[];
  approveFlow: (blockId: string) => Promise<void>;
  triggerFlow: (blockId: string) => Promise<void>;
  /** The terminal running (or last run) in a Terminal block. */
  terminalOfBlock: (blockId: string) => CanvasTerminal | undefined;
  openBlockTerminal: (blockId: string, kind: TerminalBlock['kind']) => Promise<void>;
  updateProviderBlock: (id: string, patch: Partial<ProviderBlock>) => void;
  notes: Map<string, Note>;
  frames: Map<string, Frame>;
  updateNote: (id: string, patch: Partial<Note>) => void;
  updateFrame: (id: string, patch: Partial<Frame>) => void;
  /** Nectar blocks of the project, by id. */
  cortex: Map<string, CortexOverview>;
  openCortex: (cortexId: string) => void;
}

export const CanvasViewContext = createContext<CanvasView | null>(null);

function useView(): CanvasView {
  const view = useContext(CanvasViewContext);
  if (!view) throw new Error('Canvas nodes need a CanvasViewContext.');
  return view;
}

export type NodeData = { ref: string };
export type CanvasNode = Node<
  NodeData,
  | 'agent'
  | 'task'
  | 'lane'
  | 'note'
  | 'frame'
  | 'result'
  | 'cortex'
  | 'tokens'
  | 'dialogue'
  | 'delivery'
  | 'provider'
  | 'terminal'
  | 'flow'
>;

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
  // A line from an agent to a task delegates it (the engine checks it has not started); to a
  // Nectar it gives access. The Queen only connects to a Nectar, for planning context. A line
  // from a Provider block into an agent switches its provider.
  const handles = <Handles source target />;
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
        <span className="nc-sub truncate">
          {roleLabel(worker.role)}
          {worker.team && <span className="nc-team-badge"> · Hive Teams</span>}
        </span>
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
        {task.team && (
          <span className={`nc-team-role role-${task.team.role}`}>
            {teamRoleLabels[task.team.role]}
          </span>
        )}
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

const NEW_PROVIDER = '__new__';
const providerKinds = selectablePresets;

/**
 * Adds a provider that needs no key from the canvas: ChatGPT (signed in through the browser) or a
 * local server. Keys are never typed in the Nexus; those providers are added in the main window.
 */
async function connectProvider(kind: ProviderKind): Promise<ProviderConfig> {
  const preset = providerPresets[kind];
  const provider = await window.hive.invoke('provider.save', {
    kind,
    name: preset.label,
    baseUrl: preset.defaultBaseUrl,
    enabled: true,
  });
  if (preset.signIn === 'chatgpt') await window.hive.invoke('provider.chatgptSignIn', provider.id);
  const test = await window.hive.invoke('provider.test', provider.id);
  if (!test.ok) throw new Error(`Não foi possível conectar: ${test.message}`);
  await window.hive.invoke('provider.models', { providerId: provider.id, refresh: true });
  return provider;
}

/**
 * A provider on the canvas. Pick one (or add one right here), then draw a line from the dot on
 * its right to an agent: the agent switches to it with a model picked and tested for its role.
 */
export const ProviderNode = memo(function ProviderNode({ id, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const block = view.providerBlocks.get(id);
  const [providers, setProviders] = useState<ProviderConfig[] | null>(null);
  const [models, setModels] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ProviderKind>('chatgpt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = () =>
    window.hive
      .invoke('provider.list')
      .then(setProviders)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  const providerId = block?.providerId ?? null;
  useEffect(() => {
    setModels(null);
    if (!providerId) return;
    let alive = true;
    void window.hive
      .invoke('provider.models', { providerId, refresh: false })
      .then((list) => alive && setModels(list.length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [providerId]);
  if (!block) return null;
  const current = providers?.find((provider) => provider.id === providerId) ?? null;
  const users = [...view.workers.values()].filter(
    (worker) => providerId && worker.providerId === providerId,
  );
  const shown = users.slice(0, 6);
  const preset = providerPresets[kind];
  const needsKey = !preset.signIn && !preset.keyOptional;
  const reachable =
    !!current && (current.hasCredential || !!providerPresets[current.kind].keyOptional);
  const tone = !current
    ? 'pending'
    : !reachable || current.lastTest?.ok === false
      ? 'failed'
      : 'running';
  const status = !current
    ? 'Escolha'
    : !reachable
      ? 'Sem acesso'
      : current.lastTest?.ok === false
        ? 'Falhou'
        : 'Conectado';
  const account = current?.credentialHint?.replace(/^ChatGPT · /, '') ?? null;
  const subtitle = current
    ? [
        providerPresets[current.kind].signIn
          ? 'Plano ChatGPT'
          : providerPresets[current.kind].label,
        account,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Fonte de modelos para os agentes';
  const latency = current?.lastTest?.latencyMs;
  // The mark of the provider in use, or of the one being added; none yet keeps the honeycomb.
  const logoKind = current?.kind ?? (adding ? kind : null);
  const submit = () => {
    setBusy(true);
    setError('');
    void connectProvider(kind)
      .then(async (provider) => {
        view.updateProviderBlock(id, { providerId: provider.id, expanded: true });
        setAdding(false);
        await reload();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        void reload();
      })
      .finally(() => setBusy(false));
  };
  const brand = { '--brand': providerColor(logoKind) } as CSSProperties;
  // Folded, a block with a provider is just its logo; a click opens the rest.
  if (providerId && !block.expanded && !adding)
    return (
      <div
        className={`nc-node nc-provider-chip tone-${tone}${selected ? ' selected' : ''}`}
        style={brand}
      >
        <Handle
          type="source"
          position={Position.Right}
          title="Arraste até um agente para ele usar este provedor"
        />
        <button
          type="button"
          className="nc-provider-chip-button"
          aria-label={`${current?.name ?? 'Provedor'} · ${status}. Clique para expandir`}
          title={`${current?.name ?? 'Provedor'} · ${status} — clique para expandir`}
          onClick={() => view.updateProviderBlock(id, { expanded: true })}
        >
          <ProviderLogo kind={logoKind} size={34} />
        </button>
        <span className={`nc-provider-chip-dot tone-${tone}`} aria-hidden />
        {users.length > 0 && (
          <span className="nc-provider-chip-count" title={`${users.length} agentes conectados`}>
            {users.length}
          </span>
        )}
      </div>
    );
  return (
    <div className={`nc-node nc-provider tone-${tone}${selected ? ' selected' : ''}`}>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={!!providerId}
        title={providerId ? 'Arraste até um agente para ele usar este provedor' : undefined}
      />
      <header className="nc-provider-head">
        <span
          className="nc-provider-icon"
          style={brand}
          title={logoKind ? providerPresets[logoKind].label : undefined}
        >
          <ProviderLogo kind={logoKind} size={22} />
        </span>
        <div className="nc-provider-title">
          <strong className="truncate">{current?.name ?? 'Provedor'}</strong>
          <span className="truncate" title={subtitle}>
            {subtitle}
          </span>
        </div>
        <PinMark id={id} />
        <span className={`nc-provider-pill tone-${tone}`}>{status}</span>
        {providerId && !adding && (
          <button
            type="button"
            className="nc-provider-fold nodrag"
            aria-label="Recolher para o logo"
            title="Recolher para o logo"
            onClick={() => view.updateProviderBlock(id, { expanded: false })}
          >
            <Minimize2 size={13} />
          </button>
        )}
      </header>

      {adding ? (
        <div className="nc-provider-body nodrag">
          <label className="nc-provider-field">
            <span>Novo provedor</span>
            <Select
              size="sm"
              className="nodrag"
              ariaLabel="Novo provedor"
              value={kind}
              options={providerKinds.map((item) => ({
                value: item.kind,
                label: item.label,
                tag: item.free.available ? { label: 'Grátis', tone: 'free' } : undefined,
              }))}
              onChange={(value) => setKind(value as ProviderKind)}
              menuMinWidth={260}
            />
          </label>
          <p className="nc-provider-note">
            {needsKey
              ? 'Usa chave de API. Por segurança, chaves só são digitadas na janela principal do Hive.'
              : preset.free.summary}
          </p>
          <div className="nc-provider-actions">
            <button
              type="button"
              className="nc-provider-button ghost"
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="nc-provider-button primary"
              disabled={busy}
              onClick={() => {
                if (!needsKey) return submit();
                // Back here, the new provider shows up in the list to pick.
                setAdding(false);
                void window.hive.invoke('window.addProvider');
              }}
            >
              {busy
                ? preset.signIn
                  ? 'Aguardando o navegador…'
                  : 'Conectando…'
                : preset.signIn
                  ? 'Continuar com o ChatGPT'
                  : needsKey
                    ? 'Abrir Provedores'
                    : 'Adicionar e testar'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="nc-provider-metrics">
            <div title="Agentes que usam este provedor agora">
              <dd>{current ? users.length : '—'}</dd>
              <dt>agentes</dt>
            </div>
            <div title="Modelos no catálogo do provedor">
              <dd>{current ? (models ?? '…') : '—'}</dd>
              <dt>modelos</dt>
            </div>
            <div title="Tempo de resposta do último teste de conexão">
              <dd>
                {typeof latency === 'number'
                  ? latency < 1000
                    ? `${latency}ms`
                    : `${(latency / 1000).toFixed(1).replace('.', ',')}s`
                  : '—'}
              </dd>
              <dt>latência</dt>
            </div>
          </dl>
          <div className="nc-provider-bees">
            {shown.length ? (
              <>
                {shown.map((worker) => (
                  <span key={worker.id} className="nc-provider-bee" title={worker.name}>
                    <AgentBee worker={worker} size={16} mood="still" />
                  </span>
                ))}
                {users.length > shown.length && (
                  <span
                    className="nc-provider-bee more"
                    title={users
                      .slice(shown.length)
                      .map((worker) => worker.name)
                      .join(', ')}
                  >
                    +{users.length - shown.length}
                  </span>
                )}
                <span className="nc-provider-who truncate">
                  {users.length === 1 ? users[0]!.name : `${users.length} agentes conectados`}
                </span>
              </>
            ) : (
              <span className="nc-provider-who muted">
                {current
                  ? 'Arraste do ponto à direita até um agente'
                  : 'Escolha um provedor para ligá-lo a um agente'}
              </span>
            )}
          </div>
          <footer className="nc-provider-foot nodrag">
            <Select
              size="sm"
              className="nodrag"
              ariaLabel="Provedor"
              value={providerId ?? ''}
              placeholder={providers ? 'Escolha um provedor…' : 'Carregando…'}
              options={[
                ...(providers ?? []).map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                  group: 'Conectados',
                })),
                { value: NEW_PROVIDER, label: '+ Conectar novo provedor…', group: 'Novo' },
              ]}
              onChange={(value) => {
                if (value === NEW_PROVIDER) setAdding(true);
                else view.updateProviderBlock(id, { providerId: value || null, expanded: true });
              }}
              menuMinWidth={260}
            />
          </footer>
        </>
      )}
      {error && (
        <p className="nc-provider-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});

const METER_POLL_MS = 3_000;
const tokenFormat = new Intl.NumberFormat('pt-BR', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Today's tokens against the daily budget, 0–100 %, refreshed every few seconds while agents
 * work. Without a budget it still counts, and says where to set one.
 */
export const TokensNode = memo(function TokensNode({ id, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const [meter, setMeter] = useState<TokenMeter | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      void window.hive
        .invoke('usage.today')
        .then((value) => {
          if (!alive) return;
          setMeter(value);
          setError('');
        })
        .catch((caught: unknown) => {
          if (alive) setError(caught instanceof Error ? caught.message : String(caught));
        });
    load();
    const timer = setInterval(load, METER_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const used = meter ? meter.promptTokens + meter.completionTokens : 0;
  const percent = meter?.budget ? Math.min(100, Math.round((used / meter.budget) * 100)) : null;
  const tone = percent === null ? 'idle' : percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low';
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={220}
        minHeight={150}
        lineClassName="nc-resize-line"
        handleClassName="nc-resize-handle"
        onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
      />
      <div className={`nc-tokens tone-${tone}${selected ? ' selected' : ''}`}>
        <header>
          <Gauge size={14} /> <strong>Tokens</strong>
          <span className="nc-tokens-scope">hoje</span>
        </header>
        {error ? (
          <p className="nc-tokens-note">{error}</p>
        ) : !meter ? (
          <p className="nc-tokens-note">Carregando…</p>
        ) : (
          <>
            <div className="nc-tokens-figure">
              <span className="nc-tokens-percent">{percent === null ? '—' : `${percent}%`}</span>
              <span className="nc-tokens-count">
                {tokenFormat.format(used)}
                {meter.budget ? ` de ${tokenFormat.format(meter.budget)}` : ' tokens'}
              </span>
            </div>
            <div
              className="nc-tokens-bar"
              role="meter"
              aria-label="Uso de tokens hoje"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? 0}
            >
              <span style={{ width: `${percent ?? 0}%` }} />
            </div>
            {!meter.budget && (
              <p className="nc-tokens-note">
                Defina um orçamento diário em Configurações para ver a porcentagem.
              </p>
            )}
            {meter.budget > 0 && used >= meter.budget && (
              <p className="nc-tokens-note">Orçamento de hoje atingido.</p>
            )}
            <ul className="nc-tokens-list nowheel">
              {meter.byWorker.slice(0, 6).map((row) => (
                <li key={row.workerId ?? 'other'}>
                  <span>{row.name}</span>
                  <span>{tokenFormat.format(row.tokens)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
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

/**
 * Shared memory of the project. A line from an agent to it is that agent's access; what the agent
 * may do comes from the permissions set on the line. Double-click opens the Inspector.
 */
export const CortexNode = memo(function CortexNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const block = view.cortex.get(data.ref);
  if (!block) return null;
  const { node } = block;
  const connected = node.connections
    .map((connection) => view.workers.get(connection.workerId))
    .filter((worker): worker is CanvasWorker => !!worker);
  const pending = block.pendingApprovals;
  const degraded = !!block.embedding.degraded;
  const tone = pending ? 'waiting' : connected.length ? 'running' : 'pending';
  const status = pending
    ? `${pending} ${pending === 1 ? 'pendente' : 'pendentes'}`
    : connected.length
      ? 'Ativo'
      : 'Sem acesso';
  const shown = connected.slice(0, 4);
  return (
    <div
      className={`nc-node nc-cortex tone-${tone}${selected ? ' selected' : ''}`}
      style={{ '--level': Math.min(block.memories.active / FULL_AT, 1) } as CSSProperties}
    >
      <span className="nc-cortex-fill" aria-hidden />
      <Handle type="target" position={Position.Left} isConnectable />
      <Handle type="target" position={Position.Top} id="top" isConnectable />
      <header className="nc-cortex-head">
        <span className="nc-cortex-icon" aria-hidden>
          <PixelDrop size={22} />
        </span>
        <div className="nc-cortex-title">
          <strong className="truncate">{node.name}</strong>
          <span className="truncate">
            Shared Intelligence · {view.snapshot.workspace?.name ?? 'projeto'}
          </span>
        </div>
        <PinMark id={id} />
        {connected.length > 0 && (
          <span
            className="nc-cortex-bees"
            aria-label={`Conectados: ${connected.map((worker) => worker.name).join(', ')}`}
          >
            {shown.map((worker) => (
              <span key={worker.id} className="nc-cortex-bee" title={worker.name}>
                <AgentBee worker={worker} size={15} mood="still" />
              </span>
            ))}
            {connected.length > shown.length && (
              <span
                className="nc-cortex-bee more"
                title={connected
                  .slice(shown.length)
                  .map((worker) => worker.name)
                  .join(', ')}
              >
                +{connected.length - shown.length}
              </span>
            )}
          </span>
        )}
        <span
          className={`nc-cortex-pill tone-${tone}`}
          title={connected.length ? undefined : 'Arraste de um agente até o bloco para dar acesso'}
        >
          {status}
        </span>
      </header>
      <dl className="nc-cortex-metrics">
        <div title="Memórias aprovadas e vigentes">
          <dd>{block.memories.active}</dd>
          <dt>memórias</dt>
        </div>
        <div title="Decisões arquiteturais registradas (vigentes e históricas)">
          <dd>{block.decisions}</dd>
          <dt>decisões</dt>
        </div>
        <div
          className={pending ? 'tone-waiting' : undefined}
          title="Propostas aguardando sua aprovação"
        >
          <dd>{pending}</dd>
          <dt>pendentes</dt>
        </div>
      </dl>
      <footer className="nc-cortex-foot">
        <span className={`nc-cortex-state${degraded ? ' degraded' : ''}`}>
          <span className="nc-dot" aria-hidden />
          {degraded
            ? 'Busca local (provedor indisponível)'
            : node.config.semanticSearch
              ? 'Busca semântica'
              : 'Busca por palavras'}
        </span>
        <button
          className="nc-cortex-open nodrag"
          onClick={() => view.openCortex(node.id)}
          title="Abrir o Nectar Inspector (duplo clique)"
        >
          Abrir <ArrowUpRight size={12} />
        </button>
      </footer>
      {connected.length > 0 && <NectarDrips pending={pending} />}
    </div>
  );
});

const terminalBlockCopy = {
  shell: {
    title: 'Terminal',
    empty: 'Um terminal de verdade na pasta do projeto, ao lado da equipe.',
    action: 'Abrir terminal',
  },
  claude: {
    title: 'Claude Code',
    empty:
      'Abre o Claude Code com a sua conta na pasta do projeto. Você conversa com ele aqui, enquanto as abelhas trabalham no mesmo código.',
    action: 'Iniciar Claude Code',
  },
} as const;

/**
 * A terminal of its own on the canvas, in the project folder: a shell, or Claude Code, which the
 * user drives with their own sign-in. The session lives in the main process while Hive runs;
 * after a restart the block offers to open it again.
 */
export const TerminalBlockNode = memo(function TerminalBlockNode({
  id,
  selected,
}: NodeProps<CanvasNode>) {
  const view = useView();
  const action = useTask();
  const block = view.terminalBlocks.get(id);
  if (!block) return null;
  const copy = terminalBlockCopy[block.kind];
  const claude = block.kind === 'claude';
  const terminal = view.terminalOfBlock(id);
  const running = terminal?.session.status === 'running';
  const open = () => void action.run(() => view.openBlockTerminal(id, block.kind));
  const status = !terminal
    ? 'pasta do projeto'
    : running
      ? 'ativo · pasta do projeto'
      : `encerrado${terminal.session.exitCode !== null ? ` (${terminal.session.exitCode})` : ''}`;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={360}
        minHeight={220}
        lineClassName="nc-resize-line"
        handleClassName="nc-resize-handle"
        onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
      />
      <div
        className={`nc-node nc-term-block kind-${block.kind}${running ? ' running' : ''}${selected ? ' selected' : ''}`}
      >
        <header className="nc-term-block-head">
          <span className="nc-term-block-icon" aria-hidden>
            {claude ? <ClaudeLogo size={16} /> : <SquareTerminal size={15} />}
          </span>
          <div className="nc-term-block-title">
            <strong>{copy.title}</strong>
            <span className="truncate">{status}</span>
          </div>
          <PinMark id={id} />
          {terminal &&
            (running ? (
              <button
                type="button"
                className="nc-term-block-button nodrag"
                title="Encerrar"
                aria-label="Encerrar terminal"
                disabled={action.running}
                onClick={() => void action.run(() => view.stopTerminal(terminal.session.id))}
              >
                <Power size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="nc-term-block-button nodrag"
                title="Abrir de novo"
                aria-label="Abrir de novo"
                disabled={action.running}
                onClick={open}
              >
                <RotateCcw size={13} />
              </button>
            ))}
        </header>
        <div className="nc-term-block-body nodrag nowheel">
          {terminal ? (
            <TerminalView
              key={terminal.session.id}
              session={terminal.session}
              clearSignal={0}
              subscribe={view.subscribeTerminal}
              autoFocus={false}
            />
          ) : (
            <div className="nc-term-block-empty">
              <span className="nc-term-block-mark" aria-hidden>
                {claude ? <ClaudeLogo size={30} /> : <SquareTerminal size={26} />}
              </span>
              <p>{copy.empty}</p>
              <button type="button" disabled={action.running} onClick={open}>
                {action.running ? 'Abrindo…' : copy.action}
              </button>
            </div>
          )}
        </div>
        {action.error && <p className="nc-term-block-error">{action.error}</p>}
      </div>
    </>
  );
});

const flowCopy = {
  schedule: { title: 'Agendado', icon: CalendarClock, color: '#6ea8fe' },
  check: { title: 'Verificação', icon: FlaskConical, color: '#4cd6a0' },
  approval: { title: 'Aprovação', icon: Stamp, color: '#f5b544' },
  notify: { title: 'Notificação', icon: Bell, color: '#c084fc' },
} as const;
const weekDays = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function ago(at: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (seconds < 60) return 'agora';
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  return `há ${Math.round(seconds / 3600)} h`;
}

/**
 * A flow block, like an n8n node, that acts on the real run: a schedule starts it, a check runs
 * a project command on each finished task (✓ and ✗ outputs), an approval holds the work until
 * you apply it, and a notification tells you in Windows.
 */
export const FlowNode = memo(function FlowNode({ id, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const action = useTask();
  const block = view.flowBlocks.get(id);
  const [command, setCommand] = useState(block?.command ?? '');
  useEffect(() => setCommand(block?.command ?? ''), [block?.command]);
  if (!block) return null;
  const copy = flowCopy[block.kind];
  const Icon = copy.icon;
  const state = view.flowState[id];
  const update = (patch: Partial<FlowBlock>) => view.updateFlowBlock(id, patch);
  const days = block.days ?? [];
  return (
    <div
      className={`nc-node nc-flow kind-${block.kind}${state ? ` state-${state.status}` : ''}${selected ? ' selected' : ''}`}
      style={{ '--flow': copy.color } as CSSProperties}
    >
      {block.kind !== 'schedule' && (
        <Handle type="target" position={Position.Left} className="nc-flow-in" />
      )}
      {block.kind === 'check' ? (
        <>
          <Handle
            id="pass"
            type="source"
            position={Position.Right}
            className="nc-flow-out pass"
            style={{ top: '38%' }}
            title="Passou"
          />
          <Handle
            id="fail"
            type="source"
            position={Position.Right}
            className="nc-flow-out fail"
            style={{ top: '72%' }}
            title="Falhou: ligue de volta ao agente para ele corrigir"
          />
          <span className="nc-flow-port pass" style={{ top: '38%' }}>
            passou
          </span>
          <span className="nc-flow-port fail" style={{ top: '72%' }}>
            falhou
          </span>
        </>
      ) : block.kind !== 'notify' ? (
        <Handle id="out" type="source" position={Position.Right} className="nc-flow-out" />
      ) : null}

      <header className="nc-flow-head">
        <span className="nc-flow-icon" aria-hidden>
          <Icon size={15} />
        </span>
        <strong>{copy.title}</strong>
        <PinMark id={id} />
      </header>

      <div className="nc-flow-body nodrag">
        {block.kind === 'schedule' && (
          <>
            <label className="nc-flow-field">
              <span>Horário</span>
              <input
                type="time"
                value={block.time ?? ''}
                onChange={(event) => update({ time: event.target.value || undefined })}
              />
            </label>
            <div className="nc-flow-days" role="group" aria-label="Dias da semana">
              {weekDays.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={!days.length || days.includes(day)}
                  className={!days.length || days.includes(day) ? 'on' : undefined}
                  onClick={() => {
                    const all = days.length ? days : [0, 1, 2, 3, 4, 5, 6];
                    const next = all.includes(day)
                      ? all.filter((item) => item !== day)
                      : [...all, day].sort();
                    update({ days: next.length === 7 ? undefined : next });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="nc-flow-action"
              disabled={action.running}
              onClick={() => void action.run(() => view.triggerFlow(id))}
            >
              <Play size={12} /> Rodar agora
            </button>
          </>
        )}
        {block.kind === 'check' && (
          <>
            <label className="nc-flow-field">
              <span>Comando</span>
              <input
                list={`cmds-${id}`}
                value={command}
                placeholder={view.flowCommands[0] ?? 'npm test'}
                spellCheck={false}
                onChange={(event) => setCommand(event.target.value)}
                onBlur={() => update({ command: command.trim() || undefined })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                }}
              />
              <datalist id={`cmds-${id}`}>
                {view.flowCommands.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
            <label className="nc-flow-field row">
              <span>Correções automáticas</span>
              <Select
                size="sm"
                className="nodrag"
                ariaLabel="Correções automáticas"
                value={String(block.retries ?? 1)}
                options={[0, 1, 2, 3].map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
                onChange={(value) => update({ retries: Number(value) })}
                menuMinWidth={80}
              />
            </label>
          </>
        )}
        {block.kind === 'approval' && (
          <>
            <label className="nc-flow-toggle">
              <input
                type="checkbox"
                checked={!!block.auto}
                onChange={(event) => update({ auto: event.target.checked })}
              />
              <span>Aplicar sozinho quando chegar aqui</span>
            </label>
            {state?.status === 'waiting' && (
              <button
                type="button"
                className="nc-flow-action primary"
                disabled={action.running}
                onClick={() => void action.run(() => view.approveFlow(id))}
              >
                <Check size={12} /> Aprovar e aplicar
              </button>
            )}
          </>
        )}
        {block.kind === 'notify' && (
          <p className="nc-flow-text">Avisa no Windows quando algo chega aqui.</p>
        )}
      </div>

      <footer className={`nc-flow-status ${state?.status ?? 'idle'}`}>
        {state ? (
          <>
            {state.status === 'passed' || state.status === 'done' ? (
              <Check size={12} />
            ) : state.status === 'failed' ? (
              <X size={12} />
            ) : (
              <span className="nc-flow-spinner" aria-hidden />
            )}
            <span className="truncate" title={state.detail}>
              {state.detail}
            </span>
            <span className="nc-flow-when">
              {state.durationMs !== null
                ? `${(state.durationMs / 1000).toFixed(1).replace('.', ',')} s`
                : ago(state.at)}
            </span>
          </>
        ) : (
          <span className="truncate">
            {block.kind === 'schedule'
              ? block.time
                ? `Próximo: ${block.time}`
                : 'Escolha o horário'
              : 'Esperando o fluxo'}
          </span>
        )}
      </footer>
      {action.error && <p className="nc-flow-error">{action.error}</p>}
    </div>
  );
});

const dialogueTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * The Dialogue block: the team's conversation in this run, as a chat. Each line is something
 * that really happened (see `buildDialogue`); it follows the newest line unless the user
 * scrolled up to read.
 */
export const DialogueNode = memo(function DialogueNode({ id, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const { tasks, run } = view.snapshot.detail;
  const messages = useMemo(
    () => buildDialogue({ tasks, events: view.events, queenWorkerId: run.queenWorkerId }),
    [tasks, view.events, run.queenWorkerId],
  );
  const list = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages.length]);
  const name = (workerId: string | null) =>
    workerId ? (view.workers.get(workerId)?.name ?? 'Agente') : 'Hive';
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={240}
        lineClassName="nc-resize-line"
        handleClassName="nc-resize-handle"
        onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
      />
      <div className={`nc-dialogue${selected ? ' selected' : ''}`}>
        <header>
          <MessagesSquare size={14} /> <strong>Diálogo</strong>
          <span className="nc-dialogue-count">
            {messages.length ? `${messages.length} mensagens` : 'aguardando'}
          </span>
        </header>
        {!messages.length ? (
          <p className="nc-dialogue-empty">
            A conversa da equipe aparece aqui: a Queen entregando as tarefas, cada agente começando
            com o que recebeu e passando o resultado adiante.
          </p>
        ) : (
          <ol
            ref={list}
            className="nc-dialogue-list nowheel nodrag"
            aria-label="Conversa da equipe"
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            }}
          >
            {messages.map((message) => {
              const worker = message.from ? view.workers.get(message.from) : undefined;
              return (
                <li key={message.id} className={`nc-dialogue-line kind-${message.kind}`}>
                  <span className="nc-dialogue-avatar" aria-hidden>
                    {worker ? (
                      <AgentBee worker={worker} size={22} mood="still" />
                    ) : (
                      <Bot size={16} />
                    )}
                  </span>
                  <div className="nc-dialogue-body">
                    <div className="nc-dialogue-meta">
                      <strong className="truncate">{name(message.from)}</strong>
                      {message.to.length > 0 && (
                        <span className="nc-dialogue-to truncate">
                          → {message.to.map((to) => name(to)).join(', ')}
                        </span>
                      )}
                      <time dateTime={message.at}>{dialogueTime.format(new Date(message.at))}</time>
                    </div>
                    <p>{message.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
});

const requirementLabels: Record<DeliveryRequirement['status'], string> = {
  met: 'Entregue e verificado',
  unverified: 'Feito, sem prova',
  pending: 'Não terminou',
  uncovered: 'Ninguém cobriu',
};

/**
 * The Delivery block: what the mission must deliver (the plan's requirements) and where each
 * stands, then the delivery gate's verdict on the merged work. While the run goes, each
 * requirement shows how many of its tasks are done; nothing is called delivered without the
 * final check.
 */
export const DeliveryNode = memo(function DeliveryNode({ id, selected }: NodeProps<CanvasNode>) {
  const view = useView();
  const { tasks, requirements = [], delivery = null } = view.snapshot.detail;
  const verdict = delivery?.status ?? null;
  const badge =
    verdict === 'verified'
      ? { tone: 'ok', text: 'Pronta e verificada', icon: <ShieldCheck size={13} /> }
      : verdict === 'pending'
        ? { tone: 'warn', text: 'Com pendências', icon: <ShieldAlert size={13} /> }
        : verdict === 'checking'
          ? { tone: 'busy', text: 'Verificando…', icon: <Loader2 size={13} className="spin" /> }
          : { tone: 'idle', text: 'Em andamento', icon: null };
  // Before the verdict: progress from the tasks that cover each requirement.
  const live = (requirementId: string) => {
    const covering = tasks.filter(
      (task) => !task.candidateOf && task.covers?.includes(requirementId),
    );
    const done = covering.filter((task) => ['completed', 'approved'].includes(task.status));
    return { covering, done };
  };
  const rows: {
    id: string;
    text: string;
    tone: string;
    label: string;
    reason: string;
  }[] = delivery
    ? delivery.requirements.map((item) => ({
        id: item.id,
        text: item.text,
        tone: item.status,
        label: requirementLabels[item.status],
        reason: item.reason,
      }))
    : requirements.map((item) => {
        const { covering, done } = live(item.id);
        return {
          id: item.id,
          text: item.text,
          tone: !covering.length ? 'uncovered' : 'progress',
          label: !covering.length
            ? requirementLabels.uncovered
            : `${done.length}/${covering.length} tarefa(s)`,
          reason: covering.map((task) => `“${task.title}”`).join(', '),
        };
      });
  const met = delivery?.requirements.filter((item) => item.status === 'met').length ?? 0;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={220}
        lineClassName="nc-resize-line"
        handleClassName="nc-resize-handle"
        onResizeEnd={(_, size) => view.setSize(id, { width: size.width, height: size.height })}
      />
      <div className={`nc-delivery verdict-${badge.tone}${selected ? ' selected' : ''}`}>
        <header>
          <ShieldCheck size={14} /> <strong>Entrega</strong>
          <span className={`nc-delivery-badge tone-${badge.tone}`}>
            {badge.icon}
            {badge.text}
          </span>
        </header>
        {delivery && <p className="nc-delivery-summary">{delivery.summary}</p>}
        {delivery && delivery.requirements.length > 0 && (
          <div
            className="nc-delivery-meter"
            role="meter"
            aria-label="Requisitos entregues e verificados"
            aria-valuemin={0}
            aria-valuemax={delivery.requirements.length}
            aria-valuenow={met}
          >
            <span style={{ width: `${(met / delivery.requirements.length) * 100}%` }} />
          </div>
        )}
        <div className="nc-delivery-scroll nowheel nodrag">
          {delivery && (delivery.checks.length > 0 || delivery.problem) && (
            <section>
              <h4>Verificação final</h4>
              {delivery.problem && <p className="nc-delivery-problem">{delivery.problem}</p>}
              <ul className="nc-delivery-checks">
                {delivery.checks.map((check) => (
                  <li key={check.command} className={check.ok ? 'ok' : 'fail'}>
                    <details>
                      <summary>
                        {check.ok ? <Check size={12} /> : <X size={12} />}
                        <code>{check.command}</code>
                        <span>{check.ok ? 'passou' : 'falhou'}</span>
                      </summary>
                      <pre>{check.output || '(sem saída)'}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {rows.length > 0 ? (
            <section>
              <h4>Requisitos</h4>
              <ol className="nc-delivery-requirements">
                {rows.map((row) => (
                  <li key={row.id} className={`tone-${row.tone}`} title={row.reason}>
                    <span className="nc-delivery-id">{row.id}</span>
                    <div>
                      <p>{row.text}</p>
                      <span className="nc-delivery-status">
                        {row.label}
                        {row.reason && <> · {row.reason}</>}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            !delivery && (
              <p className="nc-delivery-empty">
                Os requisitos da missão aparecem aqui depois que a Queen planejar. Quando a equipe
                terminar, o Hive junta o trabalho de todos, roda a verificação final e diz o que foi
                entregue e o que falta.
              </p>
            )
          )}
        </div>
      </div>
    </>
  );
});

export const nodeTypes = {
  dialogue: DialogueNode,
  delivery: DeliveryNode,
  cortex: CortexNode,
  result: LiveResultNode,
  agent: AgentNode,
  task: TaskNode,
  lane: GroupNode,
  note: NoteNode,
  frame: FrameNode,
  tokens: TokensNode,
  provider: ProviderNode,
  terminal: TerminalBlockNode,
  flow: FlowNode,
};
