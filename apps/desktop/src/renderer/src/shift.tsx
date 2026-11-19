import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Coffee,
  History,
  ListOrdered,
  Lock,
  Moon,
  PanelBottom,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  ShieldMinus,
  ShieldOff,
  SlidersHorizontal,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { AutopilotSettings, AutopilotStatus, Settings } from '@hive/core';
import { useHive } from './context';
import { ShiftSky } from './shift-sky';
import { Dot, Empty, runTone, statusLabels, useTask } from './ui';

/** Shift status, refreshed whenever the main process reports a change. */
export function useShift() {
  const { summary } = useHive();
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  useEffect(() => {
    let alive = true;
    window.hive
      .invoke('autopilot.status')
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // The summary reloads on every pushed change, which is when the queue can move.
  }, [summary]);
  return [status, setStatus] as const;
}

const time = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export function ShiftPage({
  settings,
  onSaved,
}: {
  settings: Settings | null;
  onSaved(): Promise<void>;
}) {
  const { openMission, workers } = useHive();
  const [status, setStatus] = useShift();
  const action = useTask();
  const queen = workers.find((worker) => worker.role === 'queen');
  const queenReady = !!queen?.providerId && !!queen.modelId;

  const call = (work: () => Promise<AutopilotStatus>) =>
    void action.run(async () => setStatus(await work()));

  const enabled = status?.enabled ?? false;
  const queue = status?.queue ?? [];
  const working = enabled && queue.length > 0;
  const mood = working ? 'working' : enabled ? 'waiting' : 'paused';

  return (
    <>
      <ShiftSky mood={mood} />
      <section className="shift-hero">
        <div className="shift-hero-body">
          <p className="shift-eyebrow">
            <Moon size={12} /> Trabalho sem supervisão
          </p>
          <h1>Modo Turno</h1>
          <p className="shift-hero-text">
            Deixe uma fila de missões e vá descansar: o Hive planeja e executa uma após a outra, sem
            esperar por você. Nada é aplicado no projeto sozinho, as entregas ficam prontas para sua
            revisão.
          </p>
          <div className="shift-hero-actions">
            <button
              className={enabled ? 'shift-toggle on' : 'shift-toggle'}
              disabled={action.running || !status}
              onClick={() => call(() => window.hive.invoke('autopilot.setEnabled', !enabled))}
            >
              {enabled ? <Pause size={14} /> : <Play size={14} />}
              {enabled ? 'Pausar o turno' : 'Ligar o turno'}
            </button>
            <span className="shift-pill">
              <Dot tone={working ? 'busy' : enabled ? 'ok' : 'idle'} />
              {working
                ? `Trabalhando: ${queue.length} ${queue.length === 1 ? 'missão' : 'missões'} na fila`
                : enabled
                  ? 'Turno ligado, esperando missões'
                  : 'Turno pausado'}
            </span>
          </div>
          <p className="shift-hero-note">
            {enabled
              ? 'Comandos fora da lista segura são negados na hora, e tarefas que falham são tentadas de novo.'
              : 'Com o turno pausado, a fila fica parada e os agentes voltam a pedir sua aprovação.'}
          </p>
          <dl className="shift-stats">
            <div>
              <dt>Na fila</dt>
              <dd>{queue.length}</dd>
            </div>
            <div>
              <dt>Feitas pelo turno</dt>
              <dd>{status?.history.length ?? 0}</dd>
            </div>
            <div>
              <dt>Tentativas por tarefa</dt>
              <dd>{settings?.autopilot.maxAttempts ?? '–'}</dd>
            </div>
          </dl>
        </div>
      </section>

      {!queenReady && (
        <p className="error-text shift-warning" role="alert">
          A Queen não tem provedor e modelo. Configure-a na aba Agentes para o turno conseguir
          planejar as missões.
        </p>
      )}
      {action.error && (
        <p className="error-text shift-warning" role="alert">
          {action.error}
        </p>
      )}

      <div className="shift-columns">
        <section className="card shift-section">
          <header>
            <span className="shift-section-icon">
              <ListOrdered size={14} />
            </span>
            <div>
              <strong>Fila da noite</strong>
              <small>A primeira missão é a que está em andamento ou a próxima a começar.</small>
            </div>
          </header>
          {queue.length ? (
            <ol className="shift-queue">
              {queue.map((item, index) => {
                const current = item.runId === status?.currentRunId;
                return (
                  <li key={item.runId} className={current ? 'current' : undefined}>
                    <span className="shift-position">{index + 1}</span>
                    <button
                      className="shift-title"
                      onClick={() => void openMission(item.missionId)}
                    >
                      <strong className="truncate">{item.missionTitle}</strong>
                      <small>
                        {item.workspaceName}
                        {item.tasks.total
                          ? ` · ${item.tasks.done} de ${item.tasks.total} tarefas prontas`
                          : ' · sem plano ainda'}
                        {item.tasks.failed ? ` · ${item.tasks.failed} com falha` : ''}
                      </small>
                      {item.tasks.total > 0 && (
                        <span className="shift-progress" aria-hidden>
                          <span
                            style={{ width: `${(item.tasks.done / item.tasks.total) * 100}%` }}
                          />
                        </span>
                      )}
                    </button>
                    <span className="shift-run-status">
                      <Dot tone={runTone(item.status)} />
                      {current ? statusLabels[item.status] : 'Na fila'}
                    </span>
                    <div className="shift-item-actions">
                      <button
                        className="icon-button"
                        title="Subir"
                        aria-label={`Subir ${item.missionTitle}`}
                        disabled={action.running || current || index === 0}
                        onClick={() =>
                          call(() =>
                            window.hive.invoke('autopilot.move', { runId: item.runId, offset: -1 }),
                          )
                        }
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="icon-button"
                        title="Descer"
                        aria-label={`Descer ${item.missionTitle}`}
                        disabled={action.running || current || index === queue.length - 1}
                        onClick={() =>
                          call(() =>
                            window.hive.invoke('autopilot.move', { runId: item.runId, offset: 1 }),
                          )
                        }
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        className="icon-button"
                        title="Tirar da fila"
                        aria-label={`Tirar ${item.missionTitle} da fila`}
                        disabled={action.running}
                        onClick={() =>
                          call(() => window.hive.invoke('autopilot.dequeue', item.runId))
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Empty>
              Nenhuma missão na fila. Ao criar uma missão, marque “Colocar na fila do Modo Turno”,
              ou abra uma missão e clique em “Colocar no turno”.
            </Empty>
          )}
        </section>

        <section className="card shift-section">
          <header>
            <span className="shift-section-icon">
              <History size={14} />
            </span>
            <div>
              <strong>O que o turno já fez</strong>
              <small>As últimas 50 missões concluídas pelo turno.</small>
            </div>
          </header>
          {status?.history.length ? (
            <ul className="shift-history">
              {status.history.map((item) => (
                <li key={`${item.runId}-${item.finishedAt}`}>
                  <Dot tone={runTone(item.status)} />
                  <div>
                    <strong className="truncate">{item.missionTitle}</strong>
                    <small>
                      {statusLabels[item.status]} · {time(item.finishedAt)}
                    </small>
                    {item.error && <small className="error-text">{item.error}</small>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nada ainda. As missões terminadas pelo turno aparecem aqui.</Empty>
          )}
        </section>
      </div>

      {settings && <ShiftSettings settings={settings.autopilot} onSaved={onSaved} />}
    </>
  );
}

function ShiftSettings({
  settings,
  onSaved,
}: {
  settings: AutopilotSettings;
  onSaved(): Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [newCommand, setNewCommand] = useState('');
  const task = useTask();
  // Whether the shift is on is switched by the header button, never by this form.
  const next: AutopilotSettings = { ...draft, enabled: settings.enabled };
  const dirty = JSON.stringify(next) !== JSON.stringify(settings);
  const set = <K extends keyof AutopilotSettings>(key: K, value: AutopilotSettings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // "Somente" edits the allowed list, "Todos, exceto" the blocked one; "Todos" has no list.
  const listKey = draft.commandMode === 'except' ? 'blockedCommands' : 'safeCommands';
  const list = draft.commandMode === 'all' ? [] : draft[listKey];

  function addCommand() {
    const command = newCommand.trim();
    if (!command) return;
    if (!list.includes(command)) set(listKey, [...list, command].slice(0, 100));
    setNewCommand('');
  }

  function save() {
    void task.run(async () => {
      await window.hive.invoke('settings.update', { autopilot: next });
      await onSaved();
    });
  }

  return (
    <section className="card shift-section shift-rules">
      <header>
        <span className="shift-section-icon">
          <SlidersHorizontal size={14} />
        </span>
        <div>
          <strong>Como o turno trabalha</strong>
          <small>Regras que valem só para missões na fila, enquanto o turno está ligado.</small>
        </div>
      </header>

      <div className="shift-rules-row">
        <div className="shift-rule shift-attempts-rule">
          <div className="shift-rule-text">
            <strong>
              <RotateCcw size={13} /> Tentativas por tarefa
            </strong>
            <small>Contando a primeira. A nova tentativa recebe o erro anterior.</small>
          </div>
          <div className="shift-attempts" role="radiogroup" aria-label="Tentativas por tarefa">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                role="radio"
                aria-checked={draft.maxAttempts === value}
                className={draft.maxAttempts === value ? 'selected' : undefined}
                onClick={() => set('maxAttempts', value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <ShiftSwitch
          icon={<Coffee size={13} />}
          title="Manter o computador acordado"
          hint="Impede a suspensão enquanto houver missões na fila."
          checked={draft.keepAwake}
          onChange={(value) => set('keepAwake', value)}
        />
        <ShiftSwitch
          icon={<PanelBottom size={13} />}
          title="Seguir na bandeja ao fechar a janela"
          hint="O Hive continua trabalhando ao lado do relógio do Windows."
          checked={draft.runInBackground}
          onChange={(value) => set('runInBackground', value)}
        />
      </div>

      <div className="shift-commands">
        <div className="shift-rule-text">
          <strong>
            <Terminal size={13} /> Comandos durante o turno
          </strong>
          <small>
            Ninguém está olhando para aprovar: o que não for liberado é negado na hora e aparece no
            histórico da tarefa.
          </small>
        </div>
        <div className="shift-modes" role="radiogroup" aria-label="Comandos liberados">
          {COMMAND_MODES.map((mode) => (
            <button
              key={mode.value}
              role="radio"
              aria-checked={draft.commandMode === mode.value}
              className={draft.commandMode === mode.value ? `selected ${mode.value}` : mode.value}
              onClick={() => {
                set('commandMode', mode.value);
                setNewCommand('');
              }}
            >
              <strong>
                {mode.icon} {mode.label}
              </strong>
              <small>{mode.hint}</small>
            </button>
          ))}
        </div>

        {draft.commandMode === 'all' ? (
          <p className="shift-all-warning" role="note">
            <TriangleAlert size={14} />
            Os agentes poderão instalar pacotes, apagar arquivos e acessar a internet sem perguntar.
            Use só em projetos de teste ou que você possa restaurar.
          </p>
        ) : (
          <div className="shift-list">
            <span className="shift-list-label">
              {draft.commandMode === 'except' ? 'Bloqueados' : 'Liberados'} · {list.length}
              <small>Termine com * para aceitar argumentos, ex.: npm test *</small>
            </span>
            <ul className={draft.commandMode === 'except' ? 'shift-chips blocked' : 'shift-chips'}>
              {list.map((command) => (
                <li key={command}>
                  <code>{command}</code>
                  <button
                    className="icon-button"
                    title="Remover"
                    aria-label={`Remover ${command}`}
                    onClick={() =>
                      set(
                        listKey,
                        list.filter((item) => item !== command),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
              {!list.length && (
                <li className="shift-chips-empty">
                  {draft.commandMode === 'except'
                    ? 'Nada bloqueado: todos os comandos rodam.'
                    : 'Nenhum comando: só os que apenas leem rodam.'}
                </li>
              )}
            </ul>
            <form
              className="shift-add-command"
              onSubmit={(event) => {
                event.preventDefault();
                addCommand();
              }}
            >
              <input
                value={newCommand}
                maxLength={200}
                spellCheck={false}
                placeholder={
                  draft.commandMode === 'except'
                    ? 'Bloquear comando, ex.: npm install *'
                    : 'Liberar comando, ex.: pnpm test *'
                }
                onChange={(event) => setNewCommand(event.target.value)}
              />
              <button type="submit" className="secondary" disabled={!newCommand.trim()}>
                <Plus size={13} /> Adicionar
              </button>
            </form>
          </div>
        )}

        <p className="shift-never">
          <Lock size={12} />
          Sempre negados, em qualquer modo: git push, commit, reset, rebase, merge, checkout,
          switch, tag e branch, e publicar pacotes. Isso fica com você.
        </p>
      </div>

      <footer className="shift-savebar">
        <span className={dirty ? 'shift-dirty' : 'shift-dirty clean'}>
          {task.error ? (
            <span role="alert" className="error-text">
              {task.error}
            </span>
          ) : dirty ? (
            'Alterações não salvas'
          ) : (
            <>
              <Check size={13} /> Tudo salvo
            </>
          )}
        </span>
        <button className="shift-save" disabled={!dirty || task.running} onClick={save}>
          <Save size={13} /> {task.running ? 'Salvando…' : 'Salvar regras'}
        </button>
      </footer>
    </section>
  );
}

/** How the shift picks commands, as the user reads it. */
const COMMAND_MODES: {
  value: AutopilotSettings['commandMode'];
  label: string;
  hint: string;
  icon: ReactNode;
}[] = [
  {
    value: 'only',
    label: 'Somente estes',
    hint: 'Só os comandos da lista e os que apenas leem. Recomendado.',
    icon: <ShieldCheck size={13} />,
  },
  {
    value: 'except',
    label: 'Todos, exceto estes',
    hint: 'Qualquer comando roda, menos os da lista.',
    icon: <ShieldMinus size={13} />,
  },
  {
    value: 'all',
    label: 'Todos',
    hint: 'Qualquer comando roda sem perguntar.',
    icon: <ShieldOff size={13} />,
  },
];

/** A setting that is on or off, as a switch with its explanation beside it. */
function ShiftSwitch({
  icon,
  title,
  hint,
  checked,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="shift-rule shift-switch-row">
      <span className="shift-rule-text">
        <strong>
          {icon} {title}
        </strong>
        <small>{hint}</small>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={checked ? 'shift-switch on' : 'shift-switch'}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </label>
  );
}
