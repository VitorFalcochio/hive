import { useState } from 'react';
import { ChevronDown, Inbox, Send, Trash2, X } from 'lucide-react';
import { useHive, usableWorkers } from './context';
import {
  MAX_TRAY_NOTES,
  buildDesignTask,
  describeElement,
  designPlan,
  noteLines,
  useTray,
} from './design-tray';
import { useTask } from './ui';

/**
 * Notes collected in the Design Mode. Sending turns them into one mission with a single task
 * for a frontend agent, which can also go to the shift queue.
 */
export function DesignTray({ workspaceId, pageUrl }: { workspaceId: string; pageUrl: string }) {
  const { workers, providers, setDetail, refresh, go, notify } = useHive();
  const notes = useTray((state) => state.notes[workspaceId]) ?? [];
  const { update, remove, clear } = useTray.getState();
  const [open, setOpen] = useState(true);
  const [queue, setQueue] = useState(false);
  const send = useTask();
  if (!notes.length) return null;

  const usable = usableWorkers(workers, providers);
  const worker = usable.find((item) => item.role === 'frontend') ?? null;
  const full = notes.length >= MAX_TRAY_NOTES;

  function submit() {
    void send.run(async () => {
      const task = buildDesignTask(notes, pageUrl);
      const created = await window.hive.invoke('mission.create', {
        title: task.title,
        objective: task.description,
      });
      await window.hive.invoke('run.setPlan', {
        runId: created.runId,
        plan: designPlan(task, worker?.id ?? null),
      });
      if (queue) await window.hive.invoke('autopilot.enqueue', created.runId);
      else await window.hive.invoke('run.start', created.runId);
      clear(workspaceId);
      setDetail(await window.hive.invoke('run.get', created.runId));
      await refresh();
      notify(
        queue
          ? 'Ajustes colocados na fila do Modo Turno.'
          : 'Ajustes enviados. O agente já está trabalhando.',
      );
      go('mission');
    });
  }

  return (
    <section
      className={open ? 'design-tray open' : 'design-tray'}
      aria-label="Bandeja de anotações"
    >
      <header className="design-tray-head">
        <button
          className="design-tray-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown size={13} className={open ? 'chevron open' : 'chevron'} />
          <Inbox size={14} />
          <strong>Bandeja</strong>
          <span className="design-tray-count">{notes.length}</span>
        </button>
        <span className="design-tray-spacer" />
        <label className="design-tray-queue" title="O Modo Turno executa sem esperar por você">
          <input
            type="checkbox"
            checked={queue}
            onChange={(event) => setQueue(event.target.checked)}
          />
          No Modo Turno
        </label>
        <button
          className="icon-button"
          title="Esvaziar a bandeja"
          aria-label="Esvaziar a bandeja"
          disabled={send.running}
          onClick={() => clear(workspaceId)}
        >
          <Trash2 size={14} />
        </button>
        <button className="primary" disabled={send.running} onClick={submit}>
          <Send size={13} />
          {send.running
            ? 'Enviando…'
            : `Enviar ${notes.length} ${notes.length === 1 ? 'ajuste' : 'ajustes'} ao agente`}
        </button>
      </header>
      {send.error && (
        <p className="error-text design-tray-error" role="alert">
          {send.error}
        </p>
      )}
      {open && (
        <ul className="design-tray-notes">
          {notes.map((note) => (
            <li key={note.id} className="design-note">
              {note.image ? (
                <img src={note.image} alt="" className="design-note-image" />
              ) : (
                <span className="design-note-image empty" aria-hidden="true">
                  &lt;{note.element.tag}&gt;
                </span>
              )}
              <div className="design-note-body">
                <strong className="truncate" title={describeElement(note.element)}>
                  {describeElement(note.element)}
                </strong>
                <small className="truncate">
                  {note.file
                    ? `${note.file.path}${note.file.line ? `:${note.file.line}` : ''}`
                    : 'Arquivo: o agente procura'}
                </small>
                <ul className="design-note-lines">
                  {noteLines({ ...note, comment: '' }).map((line) => (
                    <li key={line} className="truncate">
                      {line}
                    </li>
                  ))}
                </ul>
                <textarea
                  rows={1}
                  value={note.comment}
                  placeholder="Pedido em palavras (opcional)"
                  aria-label="Pedido em palavras"
                  onChange={(event) =>
                    update(workspaceId, note.id, { comment: event.target.value })
                  }
                />
              </div>
              <button
                className="icon-button"
                title="Tirar da bandeja"
                aria-label="Tirar da bandeja"
                onClick={() => remove(workspaceId, note.id)}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {full && (
        <p className="design-hint-inline design-tray-error">
          A bandeja está cheia ({MAX_TRAY_NOTES}). Envie estes ajustes antes de anotar outros.
        </p>
      )}
    </section>
  );
}
