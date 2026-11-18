import { useCallback, useEffect, useState } from 'react';
import { Archive, Download, FolderOpen, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import type { BackupOverview, Settings, UpdateState } from '@hive/core';
import { useHive } from './context';
import { Section } from './settings';
import { useTask } from './ui';

const kindLabels = { auto: 'Automático', manual: 'Manual', 'pre-restore': 'Antes de restaurar' };

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Backups: the toggles belong to the settings draft (saved with the page), the actions run
 * right away.
 */
export function BackupSection({
  value,
  onChange,
}: {
  value: Settings['backup'];
  onChange(value: Settings['backup']): void;
}) {
  const { notify } = useHive();
  const task = useTask();
  const [overview, setOverview] = useState<BackupOverview | null>(null);
  const load = useCallback(async () => {
    setOverview(await window.hive.invoke('backup.overview'));
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const action = (run: () => Promise<void>) =>
    void task.run(async () => {
      await run();
      await load();
    });

  return (
    <Section
      title="Backup"
      description="Uma cópia de missões, agentes, provedores, configurações, memórias do Nectar e skills. Use para voltar atrás ou levar o Hive para outro computador."
    >
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value.auto}
          onChange={(event) => onChange({ ...value, auto: event.target.checked })}
        />
        Fazer um backup automático por dia
        <span className="hint">
          Fica na pasta de backups do Hive. Guarda os últimos{' '}
          <input
            className="backup-keep"
            type="number"
            min={1}
            max={60}
            value={value.keep}
            disabled={!value.auto}
            aria-label="Quantos backups automáticos guardar"
            onChange={(event) => {
              const keep = Number(event.target.value);
              if (event.target.value !== '' && Number.isInteger(keep) && keep >= 1 && keep <= 60)
                onChange({ ...value, keep });
            }}
          />{' '}
          e apaga os mais antigos.
        </span>
      </label>

      <div className="backup-actions">
        <button
          className="secondary"
          disabled={task.running}
          onClick={() =>
            action(async () => {
              await window.hive.invoke('backup.create');
              notify('Backup criado.');
            })
          }
        >
          <Archive size={13} /> Fazer backup agora
        </button>
        <button
          className="secondary"
          disabled={task.running}
          onClick={() =>
            action(async () => {
              const file = await window.hive.invoke('backup.export');
              if (file) notify(`Backup exportado para ${file}`);
            })
          }
        >
          <Download size={13} /> Exportar…
        </button>
        <button
          className="secondary"
          disabled={task.running}
          onClick={() => action(async () => void (await window.hive.invoke('backup.restore', {})))}
        >
          <Upload size={13} /> Restaurar de um arquivo…
        </button>
        <button
          className="secondary"
          disabled={task.running}
          onClick={() => action(() => window.hive.invoke('backup.openFolder'))}
        >
          <FolderOpen size={13} /> Abrir pasta
        </button>
      </div>
      {task.error && (
        <p role="alert" className="error-text">
          {task.error}
        </p>
      )}

      {overview && overview.items.length > 0 ? (
        <ul className="backup-list">
          {overview.items.map((item) => (
            <li key={item.name}>
              <span className="backup-when">{formatDate(item.createdAt)}</span>
              <span className={`backup-kind ${item.kind}`}>{kindLabels[item.kind]}</span>
              <span className="backup-size">{formatSize(item.size)}</span>
              <button
                className="secondary"
                disabled={task.running}
                title="Restaurar este backup"
                onClick={() =>
                  action(
                    async () =>
                      void (await window.hive.invoke('backup.restore', { name: item.name })),
                  )
                }
              >
                <RotateCcw size={13} /> Restaurar
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Nenhum backup ainda.</p>
      )}
      <small className="backup-note">
        As chaves de API vão no backup protegidas pela sua conta do Windows. Em outro computador ou
        usuário, cadastre as chaves de novo em Provedores.
      </small>
    </Section>
  );
}

function describe(state: UpdateState): string {
  switch (state.status) {
    case 'disabled':
      return state.reason === 'dev'
        ? 'Atualizações automáticas só funcionam no Hive instalado (não no modo de desenvolvimento).'
        : 'A versão portátil não se atualiza sozinha. Baixe a nova versão ou use o instalador.';
    case 'idle':
      return 'Ainda não verificado nesta sessão.';
    case 'checking':
      return 'Procurando atualizações…';
    case 'none':
      return `Você está na versão mais recente (verificado às ${new Date(state.checkedAt).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}).`;
    case 'downloading':
      return `Baixando a versão ${state.version}… ${state.percent}%`;
    case 'ready':
      return `A versão ${state.version} está pronta. Ela entra quando você fechar o Hive, ou agora com o botão ao lado.`;
    case 'error':
      return `Não foi possível verificar: ${state.message}`;
  }
}

export function UpdatesSection({
  value,
  onChange,
}: {
  value: Settings['updates'];
  onChange(value: Settings['updates']): void;
}) {
  const task = useTask();
  const [state, setState] = useState<UpdateState | null>(null);
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.hive.invoke('update.status').then(setState, () => undefined);
    void window.hive.invoke('app.info').then(
      (info) => setVersion(info.version),
      () => undefined,
    );
    return window.hive.subscribe((push) => {
      if (push.kind === 'update') setState(push.state);
    });
  }, []);
  const disabled = state?.status === 'disabled';
  const busy = state?.status === 'checking' || state?.status === 'downloading';

  return (
    <Section
      title="Atualizações"
      description={`Versão instalada: ${version || '…'}. Versões novas são baixadas em segundo plano e instaladas ao fechar o Hive.`}
    >
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value.auto}
          disabled={disabled}
          onChange={(event) => onChange({ auto: event.target.checked })}
        />
        Procurar e baixar atualizações automaticamente
      </label>
      <div className="settings-apply">
        {state?.status === 'ready' ? (
          <button
            disabled={task.running}
            onClick={() => void task.run(() => window.hive.invoke('update.install'))}
          >
            <RotateCcw size={13} /> Reiniciar e atualizar
          </button>
        ) : (
          <button
            className="secondary"
            disabled={disabled || busy || task.running}
            onClick={() =>
              void task.run(async () => setState(await window.hive.invoke('update.check')))
            }
          >
            <RefreshCw size={13} /> Procurar agora
          </button>
        )}
        <small role="status">{state ? describe(state) : ''}</small>
      </div>
    </Section>
  );
}
