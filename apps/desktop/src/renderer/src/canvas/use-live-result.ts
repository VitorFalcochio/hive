import { useEffect, useRef, useState } from 'react';
import type { LiveResult } from '@hive/core';

/** Subscribe before reading; periodic reconciliation also recovers missed pushes. */
export function useLiveResult(runId: string) {
  const [result, setResult] = useState<LiveResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let busy = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const value = await window.hive.invoke('canvas.result.get', runId);
        if (alive && value) {
          setResult(value);
          setError('');
        }
      } catch (failure) {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        busy = false;
        if (alive && again) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void read();
      }, 700);
    };
    const off = window.hive.subscribe((push) => {
      if (
        (push.kind === 'changed' && push.entity === 'result' && push.id === runId) ||
        (push.kind === 'event' && push.event.runId === runId)
      )
        schedule();
    });
    setResult(null);
    void read();
    const interval = setInterval(() => void read(), 10_000);
    const focus = () => void read();
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      off();
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('focus', focus);
    };
  }, [runId]);
  return { result, error };
}

type Draft = { text: string; revision: number };
type Recovery = Draft & { key: string };
type NoteState = {
  text: string;
  ready: boolean;
  status: string;
  conflict: boolean;
  saved: string;
  recoveries: Recovery[];
};

/** The synchronous recovery draft protects the last keystroke, including during IPC failure/close. */
export function useMissionNotes(missionId: string) {
  const [state, setState] = useState<NoteState>({
    text: '',
    ready: false,
    status: 'Carregando…',
    conflict: false,
    saved: '',
    recoveries: [],
  });
  const editor = useRef<{ change: (text: string) => void; retry: () => void; resolve: () => void }>(
    { change: () => {}, retry: () => {}, resolve: () => {} },
  );
  useEffect(() => {
    const key = `hive.mission-note:${missionId}`;
    const recoveryPrefix = `${key}:recovery:`;
    const recoveryKey = `${recoveryPrefix}${crypto.randomUUID()}`;
    let recoveries: Recovery[] = [];
    let alive = true;
    let ready = false;
    let busy = false;
    let dirty = false;
    let conflict = false;
    let text = '';
    let saved = '';
    let revision = 0;
    let loadSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (status: string) => {
      if (alive) setState({ text, ready, status, conflict, saved, recoveries });
    };
    const store = () => {
      try {
        const draft = JSON.stringify({ text, revision } satisfies Draft);
        // Independent recovery slots protect simultaneous unsaved editors.
        localStorage.setItem(recoveryKey, draft);
        localStorage.setItem(key, draft);
        return true;
      } catch {
        publish('Rascunho local indisponível; mantenha a janela aberta até salvar.');
        return false;
      }
    };
    const save = async () => {
      clearTimeout(timer);
      if (!ready || busy || !dirty || conflict) return;
      busy = true;
      const writing = text;
      const writingRevision = revision;
      publish('Salvando…');
      try {
        const note = await window.hive.invoke('canvas.notes.save', {
          missionId,
          text: writing,
          revision,
        });
        revision = note.revision;
        saved = note.text;
        dirty = text !== writing;
        if (dirty && alive) store();
        else {
          try {
            if (dirty)
              localStorage.setItem(recoveryKey, JSON.stringify({ text, revision } satisfies Draft));
            else localStorage.removeItem(recoveryKey);
            const pendingDraft = JSON.parse(localStorage.getItem(key) ?? 'null') as Draft | null;
            // A closing editor's late ACK must not erase a newer recovery draft.
            if (
              !dirty &&
              pendingDraft?.text === writing &&
              pendingDraft.revision === writingRevision
            )
              localStorage.removeItem(key);
          } catch {
            /* The database has acknowledged the write. */
          }
        }
        publish(dirty ? 'Alterações pendentes…' : 'Salvo');
      } catch (failure) {
        conflict =
          !!failure &&
          typeof failure === 'object' &&
          'code' in failure &&
          failure.code === 'CONFLICT';
        if (conflict) {
          try {
            const note = await window.hive.invoke('canvas.notes.get', missionId);
            saved = note.text;
            revision = note.revision;
          } catch {
            /* Keep recovery draft. */
          }
        }
        publish(
          conflict
            ? 'Conflito: rascunho preservado. Compare com a versão salva.'
            : `Falha ao salvar: ${failure instanceof Error ? failure.message : String(failure)}. Rascunho preservado.`,
        );
      } finally {
        busy = false;
        if (alive && dirty && !conflict && text !== writing)
          timer = setTimeout(() => void save(), 600);
      }
    };
    const load = async () => {
      const sequence = ++loadSequence;
      try {
        const note = await window.hive.invoke('canvas.notes.get', missionId);
        if (!alive || sequence !== loadSequence || (ready && (dirty || busy))) return;
        revision = note.revision;
        text = saved = note.text;
        let draft: Draft | null = null;
        try {
          recoveries = [];
          for (let index = 0; index < localStorage.length; index++) {
            const candidateKey = localStorage.key(index);
            if (!candidateKey?.startsWith(recoveryPrefix) || candidateKey === recoveryKey) continue;
            try {
              const candidate = JSON.parse(
                localStorage.getItem(candidateKey) ?? 'null',
              ) as Draft | null;
              if (
                candidate &&
                typeof candidate.text === 'string' &&
                typeof candidate.revision === 'number' &&
                candidate.text !== saved
              )
                recoveries.push({
                  key: candidateKey,
                  text: candidate.text,
                  revision: candidate.revision,
                });
            } catch {
              /* Keep malformed records untouched. */
            }
          }
          const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
          if (
            raw &&
            typeof raw === 'object' &&
            'text' in raw &&
            typeof raw.text === 'string' &&
            'revision' in raw &&
            typeof raw.revision === 'number'
          )
            draft = raw as Draft;
        } catch {
          /* A malformed draft cannot replace the stored note. */
        }
        draft ??= recoveries.at(-1) ?? null;
        if (draft && draft.text !== saved) {
          text = draft.text;
          dirty = true;
          conflict = draft.revision !== revision;
        }
        ready = true;
        publish(
          conflict
            ? 'Rascunho recuperado com conflito. Compare com a versão salva.'
            : dirty
              ? 'Rascunho recuperado…'
              : 'Salvo',
        );
        if (dirty && !conflict) timer = setTimeout(() => void save(), 600);
      } catch (failure) {
        publish(
          `Não foi possível carregar as notas: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    };
    editor.current = {
      change: (value) => {
        if (!ready) return;
        text = value;
        dirty = true;
        const protectedDraft = store();
        if (protectedDraft)
          publish(conflict ? 'Conflito: rascunho preservado.' : 'Alterações pendentes…');
        clearTimeout(timer);
        timer = setTimeout(() => void save(), 600);
      },
      retry: () => {
        if (!ready) void load();
        else void save();
      },
      resolve: () => {
        conflict = false;
        dirty = true;
        store();
        void save();
      },
    };
    void load();
    const close = () => {
      if (dirty) {
        store();
        void save();
      }
    };
    window.addEventListener('beforeunload', close);
    const off = window.hive.subscribe((push) => {
      if (
        push.kind !== 'changed' ||
        push.entity !== 'missionNote' ||
        push.id !== missionId ||
        busy ||
        dirty
      )
        return;
      void load();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('beforeunload', close);
      off();
      close();
    };
  }, [missionId]);
  return {
    ...state,
    change: (text: string) => editor.current.change(text),
    retry: () => editor.current.retry(),
    resolve: () => editor.current.resolve(),
  };
}
