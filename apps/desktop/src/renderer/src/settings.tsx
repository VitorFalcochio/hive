import { useState, type ReactNode } from 'react';
import { FolderOpen, RotateCcw, Save, X } from 'lucide-react';
import { defaultSettings, type Settings } from '@hive/core';
import { PageHeader, useTask } from './ui';

// Only settings the app actually uses are listed here. New agents take the limits below as
// their defaults; existing agents keep their own values.
export function SettingsPage({
  settings,
  onSaved,
}: {
  settings: Settings | null;
  onSaved(): Promise<void>;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Ambiente local"
        title="Configurações"
        description="Preferências deste computador. Elas ficam salvas no banco local do Hive."
      />
      {settings ? (
        <SettingsForm settings={settings} onSaved={onSaved} />
      ) : (
        <p className="hint">Carregando configurações…</p>
      )}
    </>
  );
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved(): Promise<void> }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const task = useTask();
  // The shift has its own page and can be switched from the tray, so this form leaves it alone.
  const dirty =
    JSON.stringify({ ...draft, autopilot: null }) !==
    JSON.stringify({ ...settings, autopilot: null });

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setLimit = <K extends keyof Settings['defaultLimits']>(
    key: K,
    value: Settings['defaultLimits'][K],
  ) =>
    setDraft((current) => ({
      ...current,
      defaultLimits: { ...current.defaultLimits, [key]: value },
    }));

  function save() {
    void task.run(async () => {
      const rest: Partial<Settings> = { ...draft };
      delete rest.autopilot;
      await window.hive.invoke('settings.update', rest);
      await onSaved();
    });
  }

  function restoreDefaults() {
    // The catalog folder is a choice the user made, so restoring defaults keeps it.
    setDraft({
      ...defaultSettings,
      skillforgeCatalogPath: draft.skillforgeCatalogPath,
      autopilot: draft.autopilot,
    });
  }

  function pickCatalog() {
    void task.run(async () => {
      const updated = await window.hive.invoke('skill.pickCatalog');
      setDraft((current) => ({
        ...current,
        skillforgeCatalogPath: updated.skillforgeCatalogPath,
      }));
      await onSaved();
    });
  }

  function clearCatalog() {
    void task.run(async () => {
      await window.hive.invoke('settings.update', { skillforgeCatalogPath: null });
      setDraft((current) => ({ ...current, skillforgeCatalogPath: null }));
      await onSaved();
    });
  }

  return (
    <div className="settings">
      <Section
        title="Execução"
        description="Quantas tarefas de agentes podem rodar ao mesmo tempo."
      >
        <Field
          label="Tarefas em paralelo"
          hint="Entre 1 e 8. Cada tarefa usa uma worktree própria."
        >
          <input
            type="number"
            min={1}
            max={8}
            value={draft.maxConcurrentTasks}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (event.target.value !== '' && Number.isFinite(value))
                set('maxConcurrentTasks', value);
            }}
          />
        </Field>
      </Section>

      <Section
        title="Limites padrão para agentes novos"
        description="Valores iniciais de cada agente criado a partir daqui. Agentes já existentes mantêm os valores deles."
      >
        <div className="settings-grid">
          <NumberField
            label="Passos máximos"
            hint="De 1 a 200."
            min={1}
            max={200}
            value={draft.defaultLimits.maxSteps}
            onChange={(value) => setLimit('maxSteps', value)}
          />
          <NumberField
            label="Tokens por tarefa"
            hint="Prompt e resposta juntos."
            min={1_000}
            max={10_000_000}
            step={1_000}
            value={draft.defaultLimits.maxTokens}
            onChange={(value) => setLimit('maxTokens', value)}
          />
          <NumberField
            label="Tempo limite de comando (s)"
            hint="De 5 a 3.600 segundos."
            min={5}
            max={3_600}
            value={draft.defaultLimits.commandTimeoutSec}
            onChange={(value) => setLimit('commandTimeoutSec', value)}
          />
          <NumberField
            label="Tempo limite da tarefa (min)"
            hint="De 1 a 600 minutos."
            min={1}
            max={600}
            value={draft.defaultLimits.taskTimeoutMin}
            onChange={(value) => setLimit('taskTimeoutMin', value)}
          />
          <Field label="Temperatura" hint="De 0 a 2. Vazio usa o padrão do modelo.">
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              placeholder="padrão do modelo"
              value={draft.defaultLimits.temperature ?? ''}
              onChange={(event) => {
                if (event.target.value === '') return setLimit('temperature', null);
                const value = Number(event.target.value);
                if (Number.isFinite(value)) setLimit('temperature', value);
              }}
            />
          </Field>
        </div>
      </Section>

      <Section title="Skills" description="De onde o Hive carrega o catálogo de skills.">
        <div className="settings-field">
          <span>Catálogo SkillForge</span>
          <div className="settings-path">
            <code title={draft.skillforgeCatalogPath ?? undefined}>
              {draft.skillforgeCatalogPath ?? 'Nenhuma pasta escolhida'}
            </code>
            <button className="secondary" disabled={task.running} onClick={pickCatalog}>
              <FolderOpen size={13} /> Escolher pasta
            </button>
            {draft.skillforgeCatalogPath && (
              <button
                className="icon-button"
                title="Remover pasta"
                aria-label="Remover pasta"
                disabled={task.running}
                onClick={clearCatalog}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <small>Pasta com as skills do catálogo.</small>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.skillforgeCliValidation}
            onChange={(event) => set('skillforgeCliValidation', event.target.checked)}
          />
          Validar skills com o CLI do SkillForge
        </label>
      </Section>

      <Section title="Aparência" description="Como a interface se comporta.">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.reduceMotion === 'on'}
            onChange={(event) => set('reduceMotion', event.target.checked ? 'on' : 'system')}
          />
          Reduzir animações sempre
          <span className="hint">Por padrão, o Hive segue a preferência do sistema.</span>
        </label>
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
        <button className="secondary" disabled={task.running} onClick={restoreDefaults}>
          <RotateCcw size={13} /> Restaurar padrões
        </button>
        <button disabled={!dirty || task.running} onClick={save}>
          <Save size={13} /> {task.running ? 'Salvando…' : 'Salvar'}
        </button>
      </footer>
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="card settings-section">
      <header>
        <strong>{title}</strong>
        <small>{description}</small>
      </header>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (event.target.value !== '' && Number.isFinite(next)) onChange(next);
        }}
      />
    </Field>
  );
}
