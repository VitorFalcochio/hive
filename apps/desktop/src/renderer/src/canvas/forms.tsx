import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  rolePresets,
  type CanvasSnapshot,
  type CanvasWorker,
  type ModelInfo,
  type ProviderConfig,
} from '@hive/core';
import { Modal, Select, useTask } from '../ui';
import { roleLabel, sortTasks } from './model';

/* ------------------------------------------------------------------ mission */

/** A mission created from the canvas, in any project; the Queen plans it from here too. */
export function NewMissionForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (runId: string) => void;
}) {
  const action = useTask();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  useEffect(() => {
    void window.hive
      .invoke('canvas.workspaces')
      .then((list) => {
        setProjects(list);
        setWorkspaceId((current) => current || list[0]?.id || '');
      })
      .catch(() => setProjects([]));
  }, []);
  return (
    <Modal
      title="Nova missão"
      description="A missão fica no projeto escolhido. Depois, a Queen planeja as tarefas aqui no canvas."
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const created = await window.hive.invoke('canvas.mission.create', {
              workspaceId,
              title,
              objective,
            });
            onCreated(created.runId);
          });
        }}
      >
        <label>
          Projeto
          <Select
            value={workspaceId}
            options={(projects ?? []).map((item) => ({ value: item.id, label: item.name }))}
            onChange={setWorkspaceId}
            placeholder={projects?.length === 0 ? 'Abra um projeto na janela principal' : 'Projeto'}
          />
        </label>
        <label>
          Título
          <input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Objetivo
          <textarea
            rows={5}
            value={objective}
            maxLength={10_000}
            onChange={(e) => setObjective(e.target.value)}
          />
        </label>
        {action.error && <p className="form-error">{action.error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={action.running || !workspaceId || !title.trim() || !objective.trim()}
          >
            Criar missão
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ task */

/** A key the plan does not use yet, from the title: "Tela de login" → "tela-de-login". */
export function taskKey(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'tarefa';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 36)}-${n}`;
  return key;
}

export const executors = (workers: CanvasWorker[]) =>
  workers.filter((worker) => worker.role !== 'queen' && worker.providerId && worker.modelId);

/** A task added by hand; the engine checks it like a task of the Queen's plan. */
export function NewTaskForm({
  snapshot,
  defaultWorkerId,
  onClose,
  onCreated,
}: {
  snapshot: CanvasSnapshot;
  defaultWorkerId?: string;
  onClose: () => void;
  onCreated?: (taskId: string) => void;
}) {
  const action = useTask();
  const tasks = sortTasks(snapshot.detail.tasks);
  const agents = executors(snapshot.workers);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [workerId, setWorkerId] = useState(
    agents.some((agent) => agent.id === defaultWorkerId) ? defaultWorkerId! : '',
  );
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const lines = criteria
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    <Modal
      title="Nova tarefa"
      description="Entra no plano desta missão com as mesmas regras das tarefas da Queen. Se a missão está em execução, começa assim que as dependências terminarem."
      onClose={onClose}
      wide
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const created = await window.hive.invoke('canvas.task.create', {
              runId: snapshot.detail.run.id,
              task: {
                key: taskKey(title, new Set(tasks.map((task) => task.key))),
                title: title.trim(),
                description: description.trim(),
                workerId: workerId || null,
                dependsOn,
                acceptanceCriteria: lines.slice(0, 10),
              },
            });
            onCreated?.(created.id);
            onClose();
          });
        }}
      >
        <label>
          Título
          <input
            autoFocus
            value={title}
            maxLength={140}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          O que fazer
          <textarea
            rows={4}
            value={description}
            maxLength={4_000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          Critérios de aceite (um por linha)
          <textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </label>
        <label>
          Agente
          <Select
            value={workerId}
            options={[
              { value: '', label: 'Automático (o Hive escolhe ao executar)' },
              ...agents.map((agent) => ({
                value: agent.id,
                label: agent.name,
                hint: agent.modelId ?? undefined,
              })),
            ]}
            onChange={setWorkerId}
          />
        </label>
        {tasks.length > 0 && (
          <fieldset className="nc-checks">
            <legend>Depende de</legend>
            {tasks.map((task) => (
              <label key={task.id}>
                <input
                  type="checkbox"
                  checked={dependsOn.includes(task.key)}
                  onChange={(event) =>
                    setDependsOn((current) =>
                      event.target.checked
                        ? [...current, task.key].slice(0, 10)
                        : current.filter((key) => key !== task.key),
                    )
                  }
                />
                {task.title}
              </label>
            ))}
          </fieldset>
        )}
        {action.error && <p className="form-error">{action.error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={action.running || !title.trim() || !description.trim() || !lines.length}
          >
            Adicionar tarefa
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ agents */

/** Provider and model pickers backed by the providers the user configured. */
function useModelPicker(initialProvider: string | null, initialModel: string | null) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState(initialProvider ?? '');
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelId, setModelId] = useState(initialModel ?? '');
  const refresh = useTask();
  useEffect(() => {
    void window.hive
      .invoke('provider.list')
      .then((list) => {
        const usable = list.filter((provider) => provider.enabled);
        setProviders(usable);
        setProviderId((current) => current || usable[0]?.id || '');
      })
      .catch(() => setProviders([]));
  }, []);
  useEffect(() => {
    if (!providerId) return;
    let alive = true;
    setModels(null);
    void window.hive
      .invoke('provider.models', { providerId, refresh: false })
      .then((list) => alive && setModels(list))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [providerId]);
  const fields = (
    <>
      <label>
        Provedor
        <Select
          value={providerId}
          options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
          onChange={(value) => {
            setProviderId(value);
            setModelId('');
          }}
          placeholder={providers.length ? 'Provedor' : 'Configure um provedor na janela principal'}
        />
      </label>
      <label>
        Modelo
        <Select
          value={modelId}
          options={(models ?? []).map((model) => ({
            value: model.id,
            label: model.displayName,
            hint: model.capabilities.tools === 'no' ? 'sem ferramentas' : undefined,
          }))}
          onChange={setModelId}
          placeholder={models === null ? 'Carregando…' : models.length ? 'Modelo' : 'Lista vazia'}
        />
      </label>
      {models?.length === 0 && providerId && (
        <button
          type="button"
          className="ghost"
          disabled={refresh.running}
          onClick={() =>
            void refresh.run(async () =>
              setModels(await window.hive.invoke('provider.models', { providerId, refresh: true })),
            )
          }
        >
          {refresh.running ? 'Buscando modelos…' : 'Buscar modelos no provedor'}
        </button>
      )}
      {refresh.error && <p className="form-error">{refresh.error}</p>}
    </>
  );
  return { providerId, modelId, fields };
}

/**
 * Puts an agent on the canvas: one of the team, or a new one made from a role's preset. Placing
 * it gives it no task and no access; work reaches it by delegation or a conversation.
 */
export function AddAgentForm({
  snapshot,
  onCanvas,
  onClose,
  onAdd,
}: {
  snapshot: CanvasSnapshot;
  onCanvas: ReadonlySet<string>;
  onClose: () => void;
  onAdd: (workerId: string) => void;
}) {
  const action = useTask();
  const available = snapshot.workers.filter(
    (worker) => worker.role !== 'queen' && !onCanvas.has(worker.id),
  );
  const [mode, setMode] = useState<'team' | 'new'>(available.length ? 'team' : 'new');
  const [existing, setExisting] = useState(available[0]?.id ?? '');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Exclude<CanvasWorker['role'], 'queen'>>('backend');
  const picker = useModelPicker(null, null);
  const roles = (Object.keys(rolePresets) as CanvasWorker['role'][]).filter(
    (item): item is Exclude<CanvasWorker['role'], 'queen'> => item !== 'queen',
  );
  return (
    <Modal title="Adicionar agente ao canvas" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            if (mode === 'team') onAdd(existing);
            else {
              const created = await window.hive.invoke('canvas.worker.create', {
                name: name.trim() || rolePresets[role].label,
                role,
                providerId: picker.providerId || null,
                modelId: picker.modelId || null,
              });
              onAdd(created.id);
            }
            onClose();
          });
        }}
      >
        <div className="nc-segment" role="group" aria-label="Origem do agente">
          <button
            type="button"
            className={mode === 'team' ? 'on' : undefined}
            disabled={!available.length}
            onClick={() => setMode('team')}
          >
            Da equipe
          </button>
          <button
            type="button"
            className={mode === 'new' ? 'on' : undefined}
            onClick={() => setMode('new')}
          >
            Criar novo
          </button>
        </div>
        {mode === 'team' ? (
          <label>
            Agente
            <Select
              value={existing}
              options={available.map((worker) => ({
                value: worker.id,
                label: worker.name,
                hint: worker.modelId ?? 'sem modelo',
              }))}
              onChange={setExisting}
            />
          </label>
        ) : (
          <>
            <label>
              Papel
              <Select
                value={role}
                options={roles.map((item) => ({ value: item, label: roleLabel(item) }))}
                onChange={(value) => setRole(value as typeof role)}
              />
            </label>
            <label>
              Nome
              <input
                value={name}
                maxLength={60}
                placeholder={rolePresets[role].label}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {picker.fields}
            <p className="hint">
              O agente nasce com as ferramentas, skills e instruções do papel escolhido; ajuste os
              detalhes na tela Agentes da janela principal.
            </p>
          </>
        )}
        {action.error && <p className="form-error">{action.error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" disabled={action.running || (mode === 'team' && !existing)}>
            {mode === 'team' ? 'Colocar no canvas' : 'Criar agente'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Another model for one agent: its next task or conversation uses it. */
export function ModelForm({ worker, onClose }: { worker: CanvasWorker; onClose: () => void }) {
  const action = useTask();
  const picker = useModelPicker(worker.providerId, worker.modelId);
  return (
    <Modal
      title={`Modelo de ${worker.name}`}
      description="Vale para a próxima tarefa ou conversa deste agente. Uma tarefa em andamento termina com o modelo com que começou."
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await window.hive.invoke('canvas.worker.setModel', {
              workerId: worker.id,
              providerId: picker.providerId,
              modelId: picker.modelId,
            });
            onClose();
          });
        }}
      >
        {picker.fields}
        {action.error && <p className="form-error">{action.error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" disabled={action.running || !picker.providerId || !picker.modelId}>
            Salvar modelo
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ context menu */

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled, shown as a tooltip. */
  reason?: string;
  run: () => void;
}

export function ContextMenu({
  x,
  y,
  title,
  items,
  onClose,
}: {
  x: number;
  y: number;
  title?: ReactNode;
  items: (MenuItem | 'separator')[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  // Kept inside the window when opened near an edge.
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace({
      left: Math.min(x, window.innerWidth - rect.width - 8),
      top: Math.min(y, window.innerHeight - rect.height - 8),
    });
  }, [x, y]);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof MouseEvent && box.current?.contains(event.target as Node)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const visible = useMemo(
    () =>
      items.filter(
        (item, index) => item !== 'separator' || (index > 0 && items[index - 1] !== 'separator'),
      ),
    [items],
  );
  return (
    <div ref={box} className="nc-menu" role="menu" style={place}>
      {title && <div className="nc-menu-title">{title}</div>}
      {visible.map((item, index) =>
        item === 'separator' ? (
          <hr key={`s${index}`} />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            title={item.disabled ? item.reason : undefined}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
