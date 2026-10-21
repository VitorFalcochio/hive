import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Pause, Play, Save, X } from 'lucide-react';
import type { AutopilotSettings, AutopilotStatus, Settings } from '@hive/core';
import { useHive } from './context';
import { Field, NumberField, Section } from './settings';
import { Dot, Empty, PageHeader, runTone, statusLabels, useTask } from './ui';

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

  return (
    <>
      <PageHeader
        eyebrow="Trabalho sem supervisão"
        title="Modo Turno"
        description="Deixe uma fila de missões e o Hive planeja e executa uma após a outra, sem esperar por você. Nada é aplicado no projeto sozinho: as entregas ficam prontas para sua revisão."
      >
        <button
          className={enabled ? 'secondary' : undefined}
          disabled={action.running || !status}
          onClick={() => call(() => window.hive.invoke('autopilot.setEnabled', !enabled))}
        >
          {enabled ? <Pause size={14} /> : <Play size={14} />}
          {enabled ? 'Pausar o turno' : 'Ligar o turno'}
        </button>
      </PageHeader>

      <div className="shift-status card">
        <Dot tone={working ? 'busy' : enabled ? 'ok' : 'idle'} />
        <div>
          <strong>
            {working
              ? `Trabalhando: ${queue.length} missão(ões) na fila`
              : enabled
                ? 'Turno ligado, esperando missões'
                : 'Turno pausado'}
          </strong>
          <small>
            {enabled
              ? 'Comandos fora da lista segura são negados na hora, e tarefas que falham são tentadas de novo.'
              : 'Com o turno pausado, a fila fica parada e os agentes voltam a pedir sua aprovação.'}
          </small>
        </div>
      </div>
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

      <section className="card shift-section">
        <header>
          <strong>Fila</strong>
          <small>A primeira missão é a que está em andamento ou a próxima a começar.</small>
        </header>
        {queue.length ? (
          <ol className="shift-queue">
            {queue.map((item, index) => {
              const current = item.runId === status?.currentRunId;
              return (
                <li key={item.runId} className={current ? 'current' : undefined}>
                  <span className="shift-position">{index + 1}</span>
                  <button className="shift-title" onClick={() => void openMission(item.missionId)}>
                    <strong className="truncate">{item.missionTitle}</strong>
                    <small>
                      {item.workspaceName}
                      {item.tasks.total
                        ? ` · ${item.tasks.done} de ${item.tasks.total} tarefas prontas`
                        : ' · sem plano ainda'}
                      {item.tasks.failed ? ` · ${item.tasks.failed} com falha` : ''}
                    </small>
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
            Nenhuma missão na fila. Ao criar uma missão, marque “Colocar na fila do Modo Turno”, ou
            abra uma missão e clique em “Colocar no turno”.
          </Empty>
        )}
      </section>

      <section className="card shift-section">
        <header>
          <strong>O que o turno já fez</strong>
          <small>As últimas 50 missões concluídas pelo turno.</small>
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
  const [commands, setCommands] = useState(settings.safeCommands.join('\n'));
  const task = useTask();
  const safeCommands = commands
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // Whether the shift is on is switched by the header button, never by this form.
  const next: AutopilotSettings = { ...draft, safeCommands, enabled: settings.enabled };
  const dirty = JSON.stringify(next) !== JSON.stringify(settings);
  const set = <K extends keyof AutopilotSettings>(key: K, value: AutopilotSettings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function save() {
    void task.run(async () => {
      await window.hive.invoke('settings.update', { autopilot: next });
      await onSaved();
    });
  }

  return (
    <div className="settings">
      <Section
        title="Como o turno trabalha"
        description="Regras que valem só para missões na fila, enquanto o turno está ligado."
      >
        <div className="settings-grid">
          <NumberField
            label="Tentativas por tarefa"
            hint="De 1 a 5, contando a primeira. A nova tentativa recebe o erro anterior."
            min={1}
            max={5}
            value={draft.maxAttempts}
            onChange={(value) => set('maxAttempts', value)}
          />
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.keepAwake}
            onChange={(event) => set('keepAwake', event.target.checked)}
          />
          Impedir que o computador entre em suspensão enquanto houver fila
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.runInBackground}
            onChange={(event) => set('runInBackground', event.target.checked)}
          />
          Continuar trabalhando na bandeja do Windows ao fechar a janela
        </label>
        <Field
          label="Comandos liberados sem perguntar"
          hint="Um por linha. Termine com * para aceitar argumentos (ex.: npm test *). Comandos encadeados com ; & | ou redirecionamentos nunca são liberados. Os demais são negados e aparecem no histórico da tarefa."
        >
          <textarea
            rows={8}
            spellCheck={false}
            value={commands}
            onChange={(event) => setCommands(event.target.value)}
          />
        </Field>
      </Section>
      <footer className="settings-savebar">
        <span className={dirty ? 'settings-dirty' : 'settings-dirty clean'}>
          {task.error ? (
            <span role="alert" className="error-text">
              {task.error}
            </span>
          ) : dirty ? (
            'Alterações não salvas'
          ) : (
            'Tudo salvo'
          )}
        </span>
        <button disabled={!dirty || task.running} onClick={save}>
          <Save size={13} /> {task.running ? 'Salvando…' : 'Salvar regras'}
        </button>
      </footer>
    </div>
  );
}
