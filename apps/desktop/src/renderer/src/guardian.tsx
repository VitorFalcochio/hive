import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Cpu,
  Download,
  HardDrive,
  History,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react';
import {
  destructiveGuardianActions,
  type GuardianActionKind,
  type GuardianIncident,
  type GuardianSnapshot,
  type HealthStatus,
} from '@hive/core';
import { Dot, Empty, useTask } from './ui';

const statusTone = { ok: 'ok', warn: 'busy', fail: 'error' } as const;
const statusLabel: Record<HealthStatus, string> = {
  ok: 'Saudável',
  warn: 'Atenção',
  fail: 'Com falha',
};
const severityLabel: Record<GuardianIncident['severity'], string> = {
  info: 'Aviso',
  warning: 'Atenção',
  critical: 'Crítico',
};

/** The button each recovery gets, and what it asks before running when it removes or stops. */
const actions: Record<GuardianActionKind, { label: string; confirm?: string }> = {
  'retry-task': { label: 'Repetir tarefa' },
  'cancel-task': {
    label: 'Cancelar tarefa',
    confirm:
      'Cancelar esta tarefa? Ela para agora; o que já salvou continua no branch dela e você pode repeti-la depois.',
  },
  'prune-worktrees': {
    label: 'Limpar cópias sobrando',
    confirm:
      'Remover as cópias de tarefas que não existem mais? Cópias com alterações não salvas são mantidas.',
  },
  'reset-providers': { label: 'Liberar modelos agora' },
  backup: { label: 'Fazer backup agora' },
  'reload-windows': {
    label: 'Recarregar janelas',
    confirm:
      'Recarregar as janelas do Hive? As missões continuam rodando; só texto ainda não salvo nas telas se perde.',
  },
};

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

const since = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/**
 * Hive Guardian: the hive's health at a glance, with what is wrong and what to do about it.
 * Every number here comes from the main process (the database, git, Electron's process metrics,
 * the run log); nothing is estimated by a model.
 */
export function GuardianPage() {
  const [snapshot, setSnapshot] = useState<GuardianSnapshot | null>(null);
  const [note, setNote] = useState('');
  const load = useTask();
  const act = useTask();

  const refresh = useCallback(() => window.hive.invoke('guardian.snapshot').then(setSnapshot), []);
  useEffect(() => {
    void refresh().catch(() => undefined);
    return window.hive.subscribe((push) => {
      if (push.kind === 'changed' && push.entity === 'guardian')
        void refresh().catch(() => undefined);
    });
  }, [refresh]);

  const recover = (action: GuardianActionKind, target?: string) => {
    const ask = actions[action].confirm;
    if (destructiveGuardianActions.has(action) && ask && !window.confirm(ask)) return;
    void act.run(async () => {
      const record = await window.hive.invoke('guardian.recover', {
        action,
        ...(target ? { target } : {}),
      });
      setNote(record.ok ? record.detail : `Não deu certo: ${record.detail}`);
      await refresh();
    });
  };

  if (!snapshot)
    return (
      <p role="status" className="muted">
        Carregando o Guardian…
      </p>
    );

  const open = snapshot.incidents.filter((incident) => !incident.resolvedAt);
  const resolved = snapshot.incidents.filter((incident) => incident.resolvedAt).slice(0, 15);
  const { resources } = snapshot;

  return (
    <div className="guardian">
      <section className={`guardian-hero tone-${snapshot.status}`}>
        <div className="guardian-hero-icon" aria-hidden>
          {snapshot.status === 'ok' ? <ShieldCheck size={28} /> : <ShieldAlert size={28} />}
        </div>
        <div className="guardian-hero-body">
          <p className="guardian-eyebrow">Hive Guardian</p>
          <h1>
            {snapshot.status === 'ok'
              ? 'A colmeia está saudável'
              : snapshot.status === 'warn'
                ? 'A colmeia precisa de atenção'
                : 'A colmeia tem falhas'}
          </h1>
          <p className="muted">
            {open.length ? `${open.length} incidente(s) aberto(s). ` : 'Nenhum incidente aberto. '}
            Última checagem: {time(snapshot.checkedAt)}. O Guardian checa tudo a cada 30 segundos,
            sem usar nenhum modelo.
          </p>
        </div>
        <div className="guardian-hero-actions">
          <button
            className="secondary"
            disabled={load.running}
            onClick={() =>
              void load.run(async () => setSnapshot(await window.hive.invoke('guardian.diagnose')))
            }
          >
            <Stethoscope size={14} /> {load.running ? 'Diagnosticando…' : 'Diagnosticar agora'}
          </button>
          <button
            className="ghost"
            disabled={act.running}
            onClick={() =>
              void act.run(async () => {
                const saved = await window.hive.invoke('guardian.export');
                if (saved) setNote(`Relatório salvo em ${saved} (sem chaves nem dados pessoais).`);
              })
            }
          >
            <Download size={14} /> Exportar relatório
          </button>
        </div>
      </section>

      {(note || act.error || load.error) && (
        <p className={act.error || load.error ? 'error-text' : 'guardian-note'} role="status">
          {act.error || load.error || note}
        </p>
      )}

      <section className="guardian-section">
        <h2 className="home-label">
          <TriangleAlert size={13} /> Incidentes abertos
        </h2>
        {open.length ? (
          <ul className="guardian-incidents">
            {open.map((incident) => (
              <li key={incident.id} className={`severity-${incident.severity}`}>
                <div>
                  <strong>{incident.title}</strong>
                  <p>{incident.detail}</p>
                  <span className="muted">
                    {severityLabel[incident.severity]} · aberto {time(incident.openedAt)} · visto{' '}
                    {time(incident.lastSeenAt)}
                  </span>
                </div>
                {incident.action && (
                  <button
                    className="ghost"
                    disabled={act.running}
                    onClick={() => recover(incident.action!, incident.taskId ?? undefined)}
                  >
                    {actions[incident.action].label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nada de errado agora.</Empty>
        )}
      </section>

      <section className="guardian-section">
        <h2 className="home-label">
          <Activity size={13} /> Componentes
        </h2>
        <ul className="guardian-checks">
          {snapshot.checks.map((check) => (
            <li key={check.id}>
              <Dot tone={statusTone[check.status]} label={statusLabel[check.status]} />
              <div>
                <strong>{check.name}</strong>
                <p>{check.detail}</p>
              </div>
              <span className="muted">{check.durationMs} ms</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="guardian-columns">
        <section className="guardian-section">
          <h2 className="home-label">
            <Activity size={13} /> Agentes trabalhando
          </h2>
          {snapshot.agents.length ? (
            <ul className="guardian-checks">
              {snapshot.agents.map((agent) => (
                <li key={agent.taskId}>
                  <Dot tone={statusTone[agent.status]} label={statusLabel[agent.status]} />
                  <div>
                    <strong>{agent.workerName}</strong>
                    <p>
                      {agent.taskTitle} · {agent.state}
                    </p>
                  </div>
                  <span className="muted">sinal há {since(agent.silentMs)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nenhum agente trabalhando agora.</p>
          )}
        </section>

        <section className="guardian-section">
          <h2 className="home-label">
            <Cpu size={13} /> Recursos
          </h2>
          {resources ? (
            <dl className="guardian-stats">
              <div>
                <dt>CPU do Hive</dt>
                <dd>{Math.round(resources.cpuPercent)}%</dd>
              </div>
              <div>
                <dt>Memória do Hive</dt>
                <dd>{resources.memoryMb} MB</dd>
              </div>
              <div>
                <dt>Livre no computador</dt>
                <dd>
                  {resources.systemFreeMb} / {resources.systemTotalMb} MB
                </dd>
              </div>
              <div>
                <dt>
                  <HardDrive size={12} /> Disco livre
                </dt>
                <dd>{resources.diskFreeMb === null ? '—' : `${resources.diskFreeMb} MB`}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Medindo…</p>
          )}
          {resources && (
            <details className="guardian-details">
              <summary>{resources.processes.length} processos do Hive</summary>
              <ul>
                {resources.processes.map((item) => (
                  <li key={item.pid}>
                    <code>{item.type}</code> pid {item.pid}: {item.cpuPercent}% CPU, {item.memoryMb}{' '}
                    MB
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>

      <section className="guardian-section">
        <h2 className="home-label">
          <RefreshCw size={13} /> Recuperação manual
        </h2>
        <div className="guardian-actions">
          {(['backup', 'reset-providers', 'prune-worktrees', 'reload-windows'] as const).map(
            (action) => (
              <button
                key={action}
                className="ghost"
                disabled={act.running}
                onClick={() => recover(action)}
              >
                {actions[action].label}
              </button>
            ),
          )}
        </div>
      </section>

      <div className="guardian-columns">
        <section className="guardian-section">
          <h2 className="home-label">
            <History size={13} /> Histórico de recuperações
          </h2>
          {snapshot.recoveries.length ? (
            <ul className="guardian-history">
              {snapshot.recoveries.slice(0, 20).map((record) => (
                <li key={record.id}>
                  <Dot tone={record.ok ? 'ok' : 'error'} />
                  <span>
                    {actions[record.action].label}: {record.detail}
                  </span>
                  <span className="muted">{time(record.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nenhuma recuperação ainda.</p>
          )}
          {resolved.length > 0 && (
            <details className="guardian-details">
              <summary>{resolved.length} incidente(s) resolvido(s) recentemente</summary>
              <ul>
                {resolved.map((incident) => (
                  <li key={incident.id}>
                    {incident.title} <span className="muted">· {time(incident.resolvedAt)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="guardian-section">
          <h2 className="home-label">
            <ScrollText size={13} /> Log técnico
          </h2>
          <pre className="guardian-log" tabIndex={0} aria-label="Log técnico recente">
            {snapshot.logs
              .slice(-120)
              .map(
                (line) =>
                  `${line.at.slice(11, 19)} ${line.level.toUpperCase().padEnd(5)} [${line.scope}] ${line.text}`,
              )
              .join('\n') || 'Sem linhas ainda.'}
          </pre>
        </section>
      </div>
    </div>
  );
}
