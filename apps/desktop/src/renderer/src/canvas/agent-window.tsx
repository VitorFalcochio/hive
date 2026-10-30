import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AppWindow,
  GitBranch,
  Maximize2,
  MessageSquare,
  Minus,
  Pin,
  PinOff,
  Power,
  ScrollText,
  SquareTerminal,
} from 'lucide-react';
import { looksLikeTestCommand, type AgentEvent, type CanvasTerminal, type Task } from '@hive/core';
import { AgentBee } from '../mascot';
import { Markdown } from '../markdown';
import { TerminalView } from '../terminal-view';
import { useTask } from '../ui';
import { formatDuration, isLive, roleLabel, taskElapsedMs, workerStateLabels } from './model';
import type { CanvasView } from './nodes';

export type AgentTab = 'activity' | 'chat' | 'shell' | 'result';

const tabs: { id: AgentTab; label: string; icon: typeof Activity }[] = [
  { id: 'activity', label: 'Atividade', icon: Activity },
  { id: 'chat', label: 'Conversa', icon: MessageSquare },
  { id: 'shell', label: 'Terminal', icon: SquareTerminal },
  { id: 'result', label: 'Resultado', icon: ScrollText },
];

/**
 * An agent's window on the workspace: who it is, what it does right now (from the engine's own
 * events) and a way to work with it: a real conversation (the `agents` command, opened on this
 * agent) and a real shell in the worktree of its task. Nothing here is simulated.
 */
export function AgentWindow({
  view,
  workerId,
  selected,
  pinned,
}: {
  view: CanvasView;
  workerId: string;
  selected: boolean;
  pinned: boolean;
}) {
  const worker = view.workers.get(workerId)!;
  const status = view.agents.get(workerId)!;
  const expanded = view.expanded === workerId;
  return (
    <div
      className={`nc-window tone-${status.tone}${selected ? ' selected' : ''}${worker.role === 'queen' ? ' queen' : ''}`}
    >
      <header className="nc-window-head">
        <AgentBee
          worker={worker}
          size={22}
          mood={status.tone === 'running' ? 'working' : 'still'}
        />
        <div className="nc-window-title">
          <strong className="truncate">{worker.name}</strong>
          <span className="truncate">
            {roleLabel(worker.role)} · {worker.modelId ?? 'sem modelo'}
            {worker.providerName && ` · ${worker.providerName}`}
          </span>
        </div>
        <span className={`nc-chip tone-${status.tone}`}>{workerStateLabels[status.state]}</span>
        <div className="nc-window-actions nodrag">
          <button
            className="icon-button"
            title={
              pinned ? 'Desafixar (a organização automática volta a posicionar)' : 'Fixar posição'
            }
            aria-label={pinned ? 'Desafixar' : 'Fixar'}
            onClick={() => view.togglePin(`agent:${workerId}`)}
          >
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            className="icon-button"
            title="Expandir"
            aria-label="Expandir"
            onClick={() => view.expand(workerId)}
          >
            <Maximize2 size={13} />
          </button>
          <button
            className="icon-button"
            title="Minimizar para um cartão"
            aria-label="Minimizar"
            onClick={() => view.setMinimized(workerId, true)}
          >
            <Minus size={13} />
          </button>
        </div>
      </header>
      {expanded ? (
        <div className="nc-window-away">
          <Maximize2 size={14} /> Aberto em tela cheia
        </div>
      ) : (
        <AgentPanel view={view} workerId={workerId} compact />
      )}
    </div>
  );
}

/** The body of an agent's window; also shown full size when the window is expanded. */
export function AgentPanel({
  view,
  workerId,
  compact = false,
}: {
  view: CanvasView;
  workerId: string;
  compact?: boolean;
}) {
  const [tab, setTab] = useState<AgentTab>(() => view.agentTab(workerId));
  const status = view.agents.get(workerId)!;
  const choose = (next: AgentTab) => {
    setTab(next);
    view.setAgentTab(workerId, next);
  };
  const current = status.current;
  const place = current ?? [...status.tasks].reverse().find((task) => task.branch) ?? null;
  return (
    <div className={`nc-panel nodrag nowheel nopan${compact ? ' compact' : ''}`}>
      <div className="nc-panel-strip">
        {current ? (
          <span className="truncate" title={current.title}>
            <span className="nc-dot" /> {current.title} ·{' '}
            {formatDuration(taskElapsedMs(current, view.now))}
          </span>
        ) : (
          <span className="muted-text truncate">
            {status.tasks.length
              ? `${status.done}/${status.tasks.length} tarefas concluídas`
              : 'Sem tarefa nesta missão'}
          </span>
        )}
        {place?.branch && (
          <code className="truncate" title={place.worktreePath ?? place.branch}>
            <GitBranch size={11} /> {place.branch}
          </code>
        )}
      </div>
      <div role="tablist" className="nc-panel-tabs">
        {tabs.map((item) => {
          const Icon = item.icon;
          const open = view
            .terminalsOf(workerId)
            .some((terminal) => terminal.kind === item.id && terminal.session.status === 'running');
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'selected' : undefined}
              onClick={() => choose(item.id)}
            >
              <Icon size={12} /> {item.label}
              {open && <span className="nc-live-dot" aria-label="aberto" />}
            </button>
          );
        })}
      </div>
      <div className="nc-panel-body">
        {tab === 'activity' && <ActivityFeed view={view} workerId={workerId} />}
        {(tab === 'chat' || tab === 'shell') && (
          <TerminalTab view={view} workerId={workerId} kind={tab} />
        )}
        {tab === 'result' && <ResultTab tasks={status.tasks} />}
      </div>
    </div>
  );
}

function ActivityFeed({ view, workerId }: { view: CanvasView; workerId: string }) {
  const rows = useMemo(() => {
    const mine: AgentEvent[] = [];
    for (let index = view.events.length - 1; index >= 0 && mine.length < 120; index--) {
      const event = view.events[index]!;
      if (event.workerId === workerId && event.level !== 'debug' && event.type !== 'model.request')
        mine.push(event);
    }
    return mine.reverse();
  }, [view.events, workerId]);
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    if (box.current && stuck.current) box.current.scrollTop = box.current.scrollHeight;
  }, [rows]);
  if (!rows.length)
    return (
      <p className="nc-panel-empty">
        Nada registrado ainda. Quando este agente trabalhar numa tarefa, cada passo aparece aqui.
      </p>
    );
  return (
    <div
      ref={box}
      className="nc-feed mono"
      onScroll={(event) => {
        const element = event.currentTarget;
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {rows.map((event) => (
        <div
          key={event.id}
          className={`nc-feed-row level-${event.level} type-${event.type.replace('.', '-')}`}
        >
          <time>{new Date(event.ts).toLocaleTimeString('pt-BR')}</time>
          <span>{event.message}</span>
        </div>
      ))}
    </div>
  );
}

const terminalCopy = {
  chat: {
    title: 'Conversar com este agente',
    text: 'Abre o comando agents já nesta abelha. Ela responde e trabalha direto na pasta do projeto, como num terminal do Hive; comandos dela pedem a sua aprovação.',
    action: 'Abrir conversa',
  },
  shell: {
    title: 'Terminal',
    text: 'Um shell de verdade. Se o agente está numa tarefa, abre na worktree dela (os mesmos arquivos que ele edita); senão, na pasta do projeto.',
    action: 'Abrir terminal',
  },
} as const;

function TerminalTab({
  view,
  workerId,
  kind,
}: {
  view: CanvasView;
  workerId: string;
  kind: 'chat' | 'shell';
}) {
  const action = useTask();
  const worker = view.workers.get(workerId)!;
  const sessions = view.terminalsOf(workerId).filter((terminal) => terminal.kind === kind);
  const terminal: CanvasTerminal | undefined =
    sessions.find((item) => item.session.status === 'running') ?? sessions[0];
  const copy = terminalCopy[kind];
  const unusable = kind === 'chat' && (!worker.providerId || !worker.modelId);
  const open = () => void action.run(() => view.openTerminal(workerId, kind));
  if (!terminal)
    return (
      <div className="nc-panel-empty">
        <strong>{copy.title}</strong>
        <p>{unusable ? `${worker.name} ainda não tem provedor e modelo.` : copy.text}</p>
        <button className="secondary" disabled={unusable || action.running} onClick={open}>
          {kind === 'chat' ? <MessageSquare size={13} /> : <SquareTerminal size={13} />}{' '}
          {action.running ? 'Abrindo…' : copy.action}
        </button>
        {action.error && <p className="form-error">{action.error}</p>}
      </div>
    );
  const running = terminal.session.status === 'running';
  const where = terminal.taskId
    ? `worktree de ${view.tasks.get(terminal.taskId)?.key ?? 'tarefa'}`
    : 'pasta do projeto';
  return (
    <div className="nc-term">
      <div className="nc-term-bar">
        <span className="truncate">
          {kind === 'chat' ? 'agents' : 'shell'} · {where}
          {!running &&
            ` · encerrado${terminal.session.exitCode !== null ? ` (${terminal.session.exitCode})` : ''}`}
        </span>
        {running ? (
          <button
            className="ghost"
            title="Encerrar este terminal"
            onClick={() => void action.run(() => view.stopTerminal(terminal.session.id))}
          >
            <Power size={12} /> Encerrar
          </button>
        ) : (
          <button className="ghost" disabled={unusable || action.running} onClick={open}>
            Abrir de novo
          </button>
        )}
      </div>
      <div className="nc-term-host">
        <TerminalView
          key={terminal.session.id}
          session={terminal.session}
          clearSignal={0}
          subscribe={view.subscribeTerminal}
          autoFocus={false}
        />
      </div>
      {action.error && <p className="form-error">{action.error}</p>}
    </div>
  );
}

function ResultTab({ tasks }: { tasks: Task[] }) {
  const finished = [...tasks].reverse().find((task) => task.result && !isLive(task));
  if (!finished?.result)
    return <p className="nc-panel-empty">Nenhuma tarefa deste agente terminou ainda.</p>;
  const result = finished.result;
  const tests = result.commands.filter((command) => looksLikeTestCommand(command.command));
  return (
    <div className="nc-result">
      <p className="nc-result-title">
        <strong>{finished.title}</strong> <span className="success-text">+{result.insertions}</span>{' '}
        <span className="error-text">−{result.deletions}</span>
      </p>
      {result.summary && <Markdown source={result.summary} className="nc-markdown" />}
      {result.filesChanged.length > 0 && (
        <ul className="nc-files">
          {result.filesChanged.map((file) => (
            <li key={file.path}>
              <span className="nc-file-status">{file.status.charAt(0).toUpperCase()}</span>
              <code className="truncate">{file.path}</code>
            </li>
          ))}
        </ul>
      )}
      {tests.length > 0 && (
        <ul className="nc-tests">
          {tests.map((test, index) => (
            <li key={index} className={test.exitCode === 0 ? 'pass' : 'fail'}>
              <span>{test.exitCode === 0 ? 'passou' : 'falhou'}</span>
              <code className="truncate">{test.command}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Restores an agent window from its card, shown in the card itself. */
export function RestoreButton({ view, workerId }: { view: CanvasView; workerId: string }) {
  return (
    <button
      className="icon-button nc-restore nodrag"
      title="Abrir a janela do agente"
      aria-label="Abrir a janela do agente"
      onClick={(event) => {
        event.stopPropagation();
        view.setMinimized(workerId, false);
      }}
    >
      <AppWindow size={12} />
    </button>
  );
}
