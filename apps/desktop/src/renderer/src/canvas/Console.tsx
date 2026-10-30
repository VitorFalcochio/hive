import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Filter } from 'lucide-react';
import type { AgentEvent, Task } from '@hive/core';
import type { ConsoleTab } from './prefs';
import type { CanvasView } from './nodes';
import { changedFiles, formatDuration, terminalEntries, testRuns } from './model';

const tabs: { id: ConsoleTab; label: string }[] = [
  { id: 'logs', label: 'Live Logs' },
  { id: 'terminal', label: 'Agent Terminal' },
  { id: 'files', label: 'Changed Files' },
  { id: 'tests', label: 'Test Results' },
  { id: 'events', label: 'Events' },
];

/** Rows drawn per tab; the full history stays in the database. */
const ROWS = 400;

/** What the console narrows to when "only the selection" is on. */
export interface ConsoleFocus {
  taskIds: Set<string> | null;
  workerId: string | null;
  label: string;
}

export function ExecutionConsole({
  view,
  events,
  tab,
  open,
  height,
  focus,
  onTab,
  onToggle,
  onResize,
}: {
  view: CanvasView;
  events: AgentEvent[];
  tab: ConsoleTab;
  open: boolean;
  height: number;
  focus: ConsoleFocus | null;
  onTab: (tab: ConsoleTab) => void;
  onToggle: () => void;
  onResize: (height: number) => void;
}) {
  const [onlyFocus, setOnlyFocus] = useState(false);
  const narrow = onlyFocus && focus;
  const scoped = useMemo(() => {
    if (!narrow) return events;
    return events.filter(
      (event) =>
        (focus.taskIds && event.taskId && focus.taskIds.has(event.taskId)) ||
        (focus.workerId && event.workerId === focus.workerId),
    );
  }, [events, narrow, focus]);
  const tasks = useMemo(() => {
    const all = [...view.tasks.values()];
    return narrow && focus.taskIds ? all.filter((task) => focus.taskIds!.has(task.id)) : all;
  }, [view.tasks, narrow, focus]);

  const counts = useMemo(
    () => ({
      logs: null,
      terminal: terminalEntries(scoped).length,
      files: changedFiles(tasks, scoped).length,
      tests: testRuns(tasks, scoped).length,
      events: null,
    }),
    [scoped, tasks],
  );

  function startResize(event: React.PointerEvent) {
    const startY = event.clientY;
    const start = height;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) =>
      onResize(Math.min(window.innerHeight * 0.7, Math.max(140, start + startY - moved.clientY)));
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
  }

  return (
    <section
      className={open ? 'nc-console open' : 'nc-console'}
      style={open ? { height } : undefined}
      aria-label="Execution Console"
    >
      {open && (
        <div
          className="nc-console-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionar console"
          onPointerDown={startResize}
        />
      )}
      <div className="nc-console-bar">
        <div role="tablist" className="nc-tabs">
          {tabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'nc-tab selected' : 'nc-tab'}
              onClick={() => {
                onTab(item.id);
                if (!open) onToggle();
              }}
            >
              {item.label}
              {counts[item.id] !== null && counts[item.id]! > 0 && (
                <span className="nc-tab-count">{counts[item.id]}</span>
              )}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {focus && (
          <button
            className={onlyFocus ? 'ghost nc-focus on' : 'ghost nc-focus'}
            aria-pressed={onlyFocus}
            title="Mostrar só o que pertence à seleção"
            onClick={() => setOnlyFocus(!onlyFocus)}
          >
            <Filter size={12} /> {onlyFocus ? focus.label : 'Só a seleção'}
          </button>
        )}
        <button
          className="icon-button"
          aria-label={open ? 'Recolher console' : 'Expandir console'}
          title={open ? 'Recolher console' : 'Expandir console'}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {open && (
        <div className="nc-console-body" role="tabpanel">
          {tab === 'logs' && <LiveLogs events={scoped} view={view} />}
          {tab === 'terminal' && <AgentTerminal events={scoped} view={view} />}
          {tab === 'files' && <Files tasks={tasks} events={scoped} view={view} />}
          {tab === 'tests' && <Tests tasks={tasks} events={scoped} view={view} />}
          {tab === 'events' && <EventTable events={scoped} view={view} />}
        </div>
      )}
    </section>
  );
}

/** Keeps a list scrolled to its end while the user is there; scrolling up stops following. */
function useFollow(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && stuck.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const element = ref.current;
    if (element)
      stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };
  return { ref, onScroll };
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="nc-console-empty">{children}</p>;
}

const time = (ts: string) => new Date(ts).toLocaleTimeString('pt-BR');

function Who({
  view,
  event,
}: {
  view: CanvasView;
  event: Pick<AgentEvent, 'taskId' | 'workerId'>;
}) {
  const worker = event.workerId ? view.workers.get(event.workerId) : undefined;
  const task = event.taskId ? view.tasks.get(event.taskId) : undefined;
  return (
    <span className="nc-who-tag" title={task?.title}>
      {worker?.name ?? (event.taskId ? 'agente' : 'Hive')}
      {task && <em>{task.key}</em>}
    </span>
  );
}

function LiveLogs({ events, view }: { events: AgentEvent[]; view: CanvasView }) {
  const [levels, setLevels] = useState<Set<AgentEvent['level']>>(
    () => new Set(['info', 'warn', 'error']),
  );
  const rows = useMemo(() => {
    const kept = events.filter(
      (event) => levels.has(event.level) && event.type !== 'model.request',
    );
    return kept.slice(-ROWS);
  }, [events, levels]);
  const follow = useFollow(rows);
  const toggle = (level: AgentEvent['level']) =>
    setLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  return (
    <div className="nc-pane">
      <div className="nc-pane-tools">
        {(['debug', 'info', 'warn', 'error'] as const).map((level) => (
          <button
            key={level}
            className={levels.has(level) ? `nc-level on level-${level}` : `nc-level level-${level}`}
            aria-pressed={levels.has(level)}
            onClick={() => toggle(level)}
          >
            {level}
          </button>
        ))}
      </div>
      <div className="nc-scroll mono" ref={follow.ref} onScroll={follow.onScroll}>
        {rows.length ? (
          rows.map((event) => (
            <div key={event.id} className={`nc-log level-${event.level}`}>
              <time>{time(event.ts)}</time>
              <Who view={view} event={event} />
              <span className="nc-log-msg">{event.message}</span>
            </div>
          ))
        ) : (
          <Empty>Nenhum log nesta missão ainda.</Empty>
        )}
      </div>
    </div>
  );
}

function AgentTerminal({ events, view }: { events: AgentEvent[]; view: CanvasView }) {
  const entries = useMemo(() => terminalEntries(events).slice(-ROWS), [events]);
  const follow = useFollow(entries);
  return (
    <div className="nc-scroll mono nc-terminal" ref={follow.ref} onScroll={follow.onScroll}>
      {entries.length ? (
        entries.map((entry) => (
          <div key={entry.id} className="nc-term-entry">
            <div className="nc-term-head">
              <Who view={view} event={entry} />
              <time>{time(entry.ts)}</time>
            </div>
            <div className="nc-term-command">
              <span aria-hidden>$ </span>
              {entry.command}
            </div>
            {entry.output && <pre>{entry.output}</pre>}
            <div
              className={`nc-term-exit ${!entry.finished ? 'running' : entry.exitCode === 0 ? 'ok' : 'fail'}`}
            >
              {!entry.finished
                ? 'executando…'
                : entry.timedOut
                  ? 'tempo esgotado'
                  : `saída ${entry.exitCode ?? '?'} · ${formatDuration(entry.durationMs)}`}
            </div>
          </div>
        ))
      ) : (
        <Empty>Nenhum comando rodado pelos agentes nesta missão.</Empty>
      )}
    </div>
  );
}

function Files({ tasks, events, view }: { tasks: Task[]; events: AgentEvent[]; view: CanvasView }) {
  const files = useMemo(() => changedFiles(tasks, events), [tasks, events]);
  if (!files.length) return <Empty>Nenhum arquivo alterado ainda.</Empty>;
  return (
    <div className="nc-scroll">
      <table className="nc-table">
        <thead>
          <tr>
            <th>Arquivo</th>
            <th>Alteração</th>
            <th>Tarefa</th>
            <th>Origem</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={`${file.taskId}:${file.path}`}>
              <td>
                <code>{file.path}</code>
              </td>
              <td>{file.status}</td>
              <td>{view.tasks.get(file.taskId)?.title ?? file.taskId}</td>
              <td className="muted-text">
                {file.source === 'result' ? 'commit da tarefa' : 'na worktree, em andamento'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tests({ tasks, events, view }: { tasks: Task[]; events: AgentEvent[]; view: CanvasView }) {
  const runs = useMemo(() => testRuns(tasks, events), [tasks, events]);
  const [open, setOpen] = useState<string | null>(null);
  if (!runs.length)
    return <Empty>Nenhum comando de teste, lint ou typecheck foi rodado pelos agentes.</Empty>;
  return (
    <div className="nc-scroll">
      {runs.map((run) => {
        const pass = run.exitCode === 0 && !run.timedOut;
        return (
          <div key={run.id} className={`nc-test ${pass ? 'pass' : 'fail'}`}>
            <button
              className="nc-test-row"
              onClick={() => setOpen(open === run.id ? null : run.id)}
            >
              <span className="nc-test-badge">
                {pass ? 'PASSOU' : run.timedOut ? 'TEMPO' : 'FALHOU'}
              </span>
              <code className="truncate">{run.command}</code>
              <span className="muted-text truncate">
                {view.tasks.get(run.taskId)?.title ?? run.taskId}
              </span>
              <span className="muted-text">{formatDuration(run.durationMs)}</span>
            </button>
            {open === run.id && <pre className="mono">{run.output || 'Sem saída registrada.'}</pre>}
          </div>
        );
      })}
    </div>
  );
}

function EventTable({ events, view }: { events: AgentEvent[]; view: CanvasView }) {
  const rows = useMemo(() => events.slice(-ROWS), [events]);
  const follow = useFollow(rows);
  if (!rows.length) return <Empty>Nenhum evento registrado.</Empty>;
  return (
    <div className="nc-scroll" ref={follow.ref} onScroll={follow.onScroll}>
      <table className="nc-table mono">
        <thead>
          <tr>
            <th>Hora</th>
            <th>Tipo</th>
            <th>Nível</th>
            <th>Origem</th>
            <th>Mensagem</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr key={event.id} className={`level-${event.level}`}>
              <td>{time(event.ts)}</td>
              <td>{event.type}</td>
              <td className="nc-level-cell">{event.level}</td>
              <td>
                <Who view={view} event={event} />
              </td>
              <td className="nc-log-msg">{event.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
