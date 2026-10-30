import { useCallback, useEffect, useState } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import {
  Columns3,
  Crosshair,
  ExternalLink,
  Hexagon,
  LayoutDashboard,
  LayoutGrid,
  Maximize,
  Network,
  PanelBottom,
  PanelRight,
  PanelRightClose,
  Play,
  Plus,
  RefreshCw,
  Rows3,
  Sparkles,
  Square,
  Unplug,
  ZoomIn,
  ZoomOut,
  Search,
} from 'lucide-react';
import type { CanvasRunSummary, CanvasSnapshot } from '@hive/core';
import { Mascot } from '../mascot';
import { Dot, Select, runTone, statusLabels, useTask } from '../ui';
import { NewMissionForm } from './forms';
import { activeAgents, formatDuration, isLive, runElapsedMs, taskTone } from './model';
import { loadPrefs, savePrefs, type CanvasPrefs } from './prefs';
import { useCanvasData, useCanvasRuns, type Connection } from './use-canvas-data';
import { Workspace, useNow } from './workspace';
import { CommandPalette } from './command-palette';
import { CommandRegistry, registerCanvasCommands, type CommandContext } from './command-registry';

const emptyCommands = registerCanvasCommands(new CommandRegistry<CommandContext>());
function EmptyCanvasCommands({
  creating,
  onNewMission,
}: {
  creating: boolean;
  onNewMission: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      blocked={creating}
      registry={emptyCommands}
      onError={() => {}}
      context={{
        snapshot: null,
        ready: false,
        selectedNodeIds: [],
        perform: (operation) => {
          if (operation === 'new-mission') onNewMission();
        },
        reveal: () => {},
        find: () => {},
        ask: () => {},
        autopilot: () => {},
      }}
    />
  );
}

function usePrefs(): [CanvasPrefs, (patch: Partial<CanvasPrefs>) => void] {
  const [prefs, setPrefs] = useState(loadPrefs);
  const update = useCallback((patch: Partial<CanvasPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);
  return [prefs, update];
}

/** The run to show: the one picked before if it still exists, else one at work, else the latest. */
function pickRun(runs: CanvasRunSummary[], wanted: string | null): string | null {
  if (wanted && runs.some((run) => run.runId === wanted)) return wanted;
  return (
    runs.find((run) => run.status === 'running' || run.status === 'planning')?.runId ??
    runs[0]?.runId ??
    null
  );
}

export function CanvasApp() {
  return (
    <ReactFlowProvider>
      <CanvasShell />
    </ReactFlowProvider>
  );
}

function CanvasShell() {
  const [prefs, setPrefs] = usePrefs();
  const [platform, setPlatform] = useState('unknown');
  const [requested, setRequested] = useState<string | null>(prefs.runId);
  const [creating, setCreating] = useState(false);
  const runs = useCanvasRuns();
  // A mission just created may not be in the list yet; it is shown as soon as it is.
  const runId = runs ? pickRun(runs, requested) : null;
  const data = useCanvasData(runId);

  useEffect(() => {
    void window.hive
      .invoke('app.info')
      .then((info) => setPlatform(info.platform))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (runId && runId !== prefs.runId) setPrefs({ runId });
  }, [runId, prefs.runId, setPrefs]);
  useEffect(() => {
    if (data.missing) setRequested(null);
  }, [data.missing]);
  useEffect(() => {
    const create = () => setCreating(true);
    window.addEventListener('nc:new-mission', create);
    return () => window.removeEventListener('nc:new-mission', create);
  }, []);

  return (
    <div className={`nc-shell platform-${platform}`}>
      {!data.snapshot && (
        <EmptyCanvasCommands creating={creating} onNewMission={() => setCreating(true)} />
      )}
      <Toolbar
        runs={runs ?? []}
        runId={runId}
        snapshot={data.snapshot}
        connection={data.connection}
        prefs={prefs}
        onRun={(id) => setRequested(id)}
        onPrefs={setPrefs}
        onNewMission={() => setCreating(true)}
      />
      {runs === null ? (
        <State icon={<Mascot size={44} mood="working" />} title="Conectando ao Hive…" />
      ) : !runs.length ? (
        <State
          icon={<Mascot size={44} />}
          title="Nenhuma missão ainda"
          text="Crie uma missão e a Queen monta a equipe aqui: cada agente com a própria janela, as tarefas e as dependências, ao vivo."
          action={
            <button onClick={() => setCreating(true)}>
              <Plus size={14} /> Nova missão
            </button>
          }
        />
      ) : !data.snapshot ? (
        data.connection === 'disconnected' ? (
          <State
            icon={<Unplug size={30} />}
            title="Sem conexão com o motor do Hive"
            text={data.error}
            action={
              <button className="secondary" onClick={data.reload}>
                <RefreshCw size={13} /> Tentar de novo
              </button>
            }
          />
        ) : (
          <State icon={<Mascot size={44} mood="working" />} title="Carregando a missão…" />
        )
      ) : (
        <Workspace
          key={data.snapshot.detail.run.id}
          snapshot={data.snapshot}
          events={data.events}
          connection={data.connection}
          error={data.error}
          prefs={prefs}
          onPrefs={setPrefs}
          onReconnect={data.reload}
          empty={data.snapshot.detail.tasks.length ? null : <EmptyGraph snapshot={data.snapshot} />}
        />
      )}
      {creating && (
        <NewMissionForm
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setRequested(created);
          }}
        />
      )}
    </div>
  );
}

function State({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="nc-state-screen" role="status">
      {icon}
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

/** The Queen able to plan: the run's own, or the team's Queen with a model. */
function planner(snapshot: CanvasSnapshot) {
  const usable = (worker: CanvasSnapshot['workers'][number]) =>
    worker.role === 'queen' && !!worker.providerId && !!worker.modelId;
  return (
    snapshot.workers.find(
      (worker) => worker.id === snapshot.detail.run.queenWorkerId && usable(worker),
    ) ?? snapshot.workers.find(usable)
  );
}

const modes = [
  {
    id: 'workspace',
    label: 'Workspace',
    icon: LayoutGrid,
    title: 'Janelas dos agentes, com as tarefas de cada um',
  },
  { id: 'agent', label: 'Agentes', icon: Rows3, title: 'Tarefas em raias por agente' },
  { id: 'none', label: 'Fluxo', icon: Columns3, title: 'Só as tarefas, em colunas de dependência' },
] as const;

function Toolbar({
  runs,
  runId,
  snapshot,
  connection,
  prefs,
  onRun,
  onPrefs,
  onNewMission,
}: {
  runs: CanvasRunSummary[];
  runId: string | null;
  snapshot: CanvasSnapshot | null;
  connection: Connection;
  prefs: CanvasPrefs;
  onRun: (runId: string) => void;
  onPrefs: (patch: Partial<CanvasPrefs>) => void;
  onNewMission: () => void;
}) {
  const flow = useReactFlow();
  const action = useTask();
  const tasks = snapshot?.detail.tasks ?? [];
  const live = !!snapshot && (snapshot.detail.run.status === 'running' || tasks.some(isLive));
  const now = useNow(live);
  const run = snapshot?.detail.run;
  const planning = !!snapshot?.planning;
  const canExecute =
    !!run &&
    tasks.length > 0 &&
    !planning &&
    ['awaiting_plan_approval', 'failed', 'cancelled', 'review'].includes(run.status) &&
    tasks.some((task) => ['pending', 'blocked', 'failed', 'cancelled'].includes(task.status));
  const done = tasks.filter((task) => taskTone(task) === 'done').length;

  const options = runs.map((item) => ({
    value: item.runId,
    label: item.missionTitle,
    hint: item.workspaceName,
    tag:
      item.status === 'running' || item.status === 'planning'
        ? { label: statusLabels[item.status] }
        : undefined,
    group: item.status === 'running' || item.status === 'planning' ? 'Em andamento' : 'Recentes',
  }));

  return (
    <header className="nc-toolbar">
      <div className="nc-brand">
        <Hexagon size={15} strokeWidth={2.4} />
        <span>hive</span>
        <span className="sep">/</span>
        <Network size={14} />
        <span>Nexus</span>
      </div>
      <div className="nc-picker nodrag">
        <Select
          value={runId ?? ''}
          options={options}
          onChange={onRun}
          placeholder="Escolha uma missão"
        />
      </div>
      <button
        className="icon-button"
        title="Nova missão"
        aria-label="Nova missão"
        onClick={onNewMission}
      >
        <Plus size={15} />
      </button>
      {run && snapshot && (
        <div className="nc-stats">
          <span className="nc-stat" title="Estado da execução">
            <Dot tone={planning ? 'busy' : runTone(run.status)} />
            {planning ? 'Planejando' : statusLabels[run.status]}
          </span>
          <span className="nc-stat" title="Agentes trabalhando agora">
            <strong>{activeAgents(snapshot)}</strong> ativos
          </span>
          <span className="nc-stat" title="Tarefas concluídas / total">
            <strong>
              {done}/{tasks.length}
            </strong>{' '}
            tarefas
          </span>
          <span className="nc-stat mono" title="Desde a primeira tarefa iniciada">
            {formatDuration(runElapsedMs(snapshot, now))}
          </span>
          {connection !== 'live' && (
            <span className={`nc-stat nc-conn ${connection}`}>
              <Unplug size={12} /> {connection === 'connecting' ? 'Reconectando' : 'Desconectado'}
            </span>
          )}
        </div>
      )}
      <span className="spacer" />
      <div className="nc-tools nodrag">
        <div className="nc-segment" role="group" aria-label="Visualização">
          {modes.map(({ id, label, icon: Icon, title }) => (
            <button
              key={id}
              className={prefs.grouping === id ? 'on' : undefined}
              aria-pressed={prefs.grouping === id}
              title={title}
              onClick={() => onPrefs({ grouping: id })}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <span className="nc-divider" />
        {run && snapshot && (
          <button
            className="secondary nc-small nc-autopilot-button"
            title="Criar fluxo visual com a Queen"
            onClick={() => window.dispatchEvent(new Event('nc:autopilot'))}
          >
            <Sparkles size={12} /> Autopilot
          </button>
        )}
        <button
          className="icon-button"
          title="Command Palette (Ctrl + Espaço)"
          aria-label="Abrir Command Palette"
          onClick={() => window.dispatchEvent(new Event('nc:commands'))}
        >
          <Search size={15} />
        </button>
        <button
          className="icon-button"
          title="Aproximar"
          aria-label="Aproximar"
          onClick={() => void flow.zoomIn({ duration: 150 })}
        >
          <ZoomIn size={15} />
        </button>
        <button
          className="icon-button"
          title="Afastar"
          aria-label="Afastar"
          onClick={() => void flow.zoomOut({ duration: 150 })}
        >
          <ZoomOut size={15} />
        </button>
        <button
          className="icon-button"
          title="Ajustar à tela (F)"
          aria-label="Ajustar à tela"
          onClick={() => void flow.fitView({ padding: 0.12, duration: 250 })}
        >
          <Maximize size={14} />
        </button>
        <button
          className="icon-button"
          title="Centralizar no trabalho em andamento"
          aria-label="Centralizar"
          onClick={() => {
            const busy = tasks
              .filter(isLive)
              .flatMap((task) => [
                { id: `task:${task.id}` },
                ...(task.workerId ? [{ id: `agent:${task.workerId}` }] : []),
              ]);
            void flow.fitView({
              nodes: busy.length ? busy : undefined,
              padding: 0.3,
              maxZoom: 1.1,
              duration: 300,
            });
          }}
        >
          <Crosshair size={14} />
        </button>
        <button
          className="icon-button"
          title="Reorganizar: o que foi movido volta à organização automática; o que está fixado fica"
          aria-label="Reorganizar"
          onClick={() => window.dispatchEvent(new Event('nc:relayout'))}
        >
          <LayoutDashboard size={14} />
        </button>
        <span className="nc-divider" />
        {run && run.status === 'running' && (
          <button
            className="secondary nc-small"
            disabled={action.running}
            title="Cancela as tarefas em andamento; dá para retomar depois"
            onClick={() => {
              if (
                window.confirm('Cancelar a execução desta missão? As tarefas em andamento param.')
              )
                void action.run(async () => void (await window.hive.invoke('run.cancel', run.id)));
            }}
          >
            <Square size={11} /> Cancelar
          </button>
        )}
        {run && canExecute && (
          <button
            className="nc-small"
            disabled={action.running}
            onClick={() =>
              void action.run(async () => void (await window.hive.invoke('run.start', run.id)))
            }
          >
            <Play size={12} />{' '}
            {run.status === 'awaiting_plan_approval' ? 'Executar plano' : 'Retomar'}
          </button>
        )}
        {run && (
          <button
            className="icon-button"
            title="Abrir esta missão na janela principal"
            aria-label="Abrir no Hive"
            onClick={() => void window.hive.invoke('window.showRun', run.id).catch(() => undefined)}
          >
            <ExternalLink size={14} />
          </button>
        )}
        <button
          className="icon-button"
          title={prefs.consoleOpen ? 'Recolher console' : 'Mostrar console'}
          aria-label="Console"
          aria-pressed={prefs.consoleOpen}
          onClick={() => onPrefs({ consoleOpen: !prefs.consoleOpen })}
        >
          <PanelBottom size={14} />
        </button>
        <button
          className="icon-button"
          title={prefs.inspectorOpen ? 'Esconder inspector' : 'Mostrar inspector'}
          aria-label="Inspector"
          aria-pressed={prefs.inspectorOpen}
          onClick={() => onPrefs({ inspectorOpen: !prefs.inspectorOpen })}
        >
          {prefs.inspectorOpen ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
        </button>
      </div>
      {action.error && (
        <p className="nc-toolbar-error" role="alert">
          {action.error}
        </p>
      )}
    </header>
  );
}

/** A run without tasks: the Queen can plan it from here, with the engine's own planning. */
function EmptyGraph({ snapshot }: { snapshot: CanvasSnapshot }) {
  const action = useTask();
  const { run } = snapshot.detail;
  const planning = snapshot.planning;
  const queen = planner(snapshot);
  return (
    <div className="nc-empty-graph" role="status">
      <Mascot size={36} mood={planning || action.running ? 'working' : 'still'} />
      <strong>
        {planning || action.running
          ? 'A Queen está planejando esta missão…'
          : run.status === 'failed'
            ? 'O planejamento falhou'
            : 'Esta missão ainda não tem plano'}
      </strong>
      <p>
        {planning || action.running
          ? 'Os agentes e as tarefas aparecem aqui assim que o plano ficar pronto.'
          : queen
            ? 'A Queen divide a missão em tarefas, escolhe os agentes e organiza o workspace. Depois é só executar, ou ajustar à mão.'
            : 'Configure o provedor e o modelo da Queen na tela Agentes da janela principal.'}
      </p>
      {run.error && !planning && <p className="form-error">{run.error}</p>}
      {action.error && <p className="form-error">{action.error}</p>}
      {!planning && !action.running && (
        <div className="nc-actions">
          {queen && (
            <button
              onClick={() =>
                void action.run(
                  async () =>
                    void (await window.hive.invoke('run.plan', {
                      runId: run.id,
                      queenWorkerId: queen.id,
                    })),
                )
              }
            >
              <Sparkles size={13} /> Planejar com a Queen
            </button>
          )}
          <button
            className="secondary"
            onClick={() => void window.hive.invoke('window.showRun', run.id).catch(() => undefined)}
          >
            <ExternalLink size={13} /> Abrir no Hive
          </button>
        </div>
      )}
    </div>
  );
}
