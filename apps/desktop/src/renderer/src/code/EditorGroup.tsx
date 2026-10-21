import { useEffect, useRef, useState } from 'react';
import { Columns2, FileDiff, Rows2, X } from 'lucide-react';
import { message } from '../context';
import {
  diffModel,
  editorOptions,
  getDoc,
  monaco,
  openDoc,
  reloadDoc,
  saveDoc,
  UnopenableFile,
} from './monaco';
import { tabTitle, useCode, type Tab } from './store';

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

const isConflict = (error: unknown) => (error as { code?: string })?.code === 'CONFLICT';

/** Save with conflict detection; a conflict is flagged instead of overwriting. */
export async function saveFile(path: string, notifyError: (text: string) => void) {
  try {
    await saveDoc(path);
  } catch (error) {
    if (isConflict(error)) useCode.getState().setConflict(path, true);
    else notifyError(message(error));
  }
}

export function EditorGroup({
  index,
  onError,
}: {
  index: number;
  onError: (text: string) => void;
}) {
  const group = useCode((state) => state.groups[index]);
  const focused = useCode((state) => state.focused === index && state.groups.length > 1);
  const dirty = useCode((state) => state.dirty);
  const { activate, close, focus } = useCode.getState();
  if (!group) return null;
  const active = group.tabs.find((tab) => tab.id === group.active) ?? null;

  function closeTab(tab: Tab) {
    // The same file open in the other group keeps its edits; only the last tab asks.
    const stillOpen = useCode
      .getState()
      .groups.some((other, i) => i !== index && other.tabs.some((item) => item.id === tab.id));
    if (tab.kind === 'file' && dirty[tab.path] && !stillOpen) {
      if (!window.confirm(`"${tabTitle(tab)}" tem alterações não salvas. Fechar e descartar?`))
        return;
      void reloadDoc(tab.path);
    }
    close(tab.id, index);
  }

  return (
    <section
      className={focused ? 'editor-group focused' : 'editor-group'}
      onMouseDown={() => focus(index)}
    >
      <div className="tab-bar" role="tablist">
        {group.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === group.active}
            className={tab.id === group.active ? 'editor-tab active' : 'editor-tab'}
            title={
              tab.kind === 'diff' && tab.source === 'task'
                ? `${tab.taskTitle} · ${tab.path}`
                : tab.path
            }
            onClick={() => activate(tab.id, index)}
            onAuxClick={(event) => {
              if (event.button === 1) closeTab(tab);
            }}
          >
            {tab.kind === 'diff' && <FileDiff size={13} className="tab-kind" />}
            <span className="truncate">{tabTitle(tab)}</span>
            {tab.kind === 'file' && dirty[tab.path] ? (
              <span className="dirty-dot" aria-label="não salvo" />
            ) : null}
            <button
              className="tab-close"
              aria-label={`Fechar ${tabTitle(tab)}`}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="editor-body">
        {active ? (
          active.kind === 'file' ? (
            <FilePane
              key={`${index}:${active.id}`}
              path={active.path}
              stateKey={`${index}:${active.id}`}
              onError={onError}
            />
          ) : (
            <DiffPane key={`${index}:${active.id}`} tab={active} onError={onError} />
          )
        ) : (
          <div className="editor-empty">
            <p>Abra um arquivo no explorador</p>
            <small>
              <kbd>Ctrl</kbd> + <kbd>P</kbd> para buscar · <kbd>Ctrl</kbd> + <kbd>S</kbd> para
              salvar
            </small>
          </div>
        )}
      </div>
    </section>
  );
}

function ConflictBanner({ path, onError }: { path: string; onError: (text: string) => void }) {
  const conflict = useCode((state) => state.conflicts[path]);
  if (!conflict) return null;
  return (
    <div className="editor-banner" role="alert">
      <span>Este arquivo mudou no disco enquanto você editava.</span>
      <button className="ghost" onClick={() => void reloadDoc(path)}>
        Usar a versão do disco
      </button>
      <button
        className="ghost"
        onClick={() => void saveDoc(path, true).catch((error) => onError(message(error)))}
      >
        Manter a minha e salvar
      </button>
    </div>
  );
}

function FilePane({
  path,
  stateKey,
  onError,
}: {
  path: string;
  stateKey: string;
  onError: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let disposed = false;
    setError('');
    openDoc(path)
      .then((doc) => {
        if (disposed || !host.current) return;
        editor = monaco.editor.create(host.current, { ...editorOptions, model: doc.model });
        const state = viewStates.get(stateKey);
        if (state) editor.restoreViewState(state);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void saveFile(path, onError);
        });
        const currentEditor = editor;
        const publishSelection = () => {
          const selection = currentEditor.getSelection();
          if (!selection || selection.isEmpty()) {
            if (useCode.getState().selection?.path === path) useCode.getState().setSelection(null);
            return;
          }
          const model = currentEditor.getModel();
          if (!model) return;
          useCode.getState().setSelection({
            path,
            startOffset: model.getOffsetAt(selection.getStartPosition()),
            endOffset: model.getOffsetAt(selection.getEndPosition()),
            text: model.getValueInRange(selection),
          });
        };
        editor.onDidChangeCursorSelection(publishSelection);
        publishSelection();
        editor.focus();
      })
      .catch((failure: unknown) => {
        if (!disposed)
          setError(failure instanceof UnopenableFile ? failure.message : message(failure));
      });
    return () => {
      disposed = true;
      if (editor) {
        viewStates.set(stateKey, editor.saveViewState());
        editor.dispose();
      }
      if (useCode.getState().selection?.path === path) useCode.getState().setSelection(null);
    };
  }, [path, stateKey, onError]);
  return (
    <>
      <ConflictBanner path={path} onError={onError} />
      {error ? (
        <div className="editor-empty">
          <p>{error}</p>
        </div>
      ) : (
        <div ref={host} className="monaco-host" />
      )}
    </>
  );
}

function DiffPane({
  tab,
  onError,
}: {
  tab: Extract<Tab, { kind: 'diff' }>;
  onError: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [error, setError] = useState('');
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const taskId = tab.source === 'task' ? tab.taskId : null;

  useEffect(() => {
    let disposed = false;
    let diff: monaco.editor.IStandaloneDiffEditor | null = null;
    const load = async () => {
      if (taskId) {
        const content = await window.hive.invoke('task.fileDiff', { taskId, path: tab.path });
        return {
          original: diffModel(`task-base:${taskId}`, tab.path, content.original),
          modified: diffModel(`task:${taskId}`, tab.path, content.modified),
          editable: false,
        };
      }
      const content = await window.hive.invoke('git.fileDiff', { path: tab.path });
      // The working copy side is the real document, so edits here are saved like any file.
      const doc = await openDoc(tab.path).catch(() => null);
      return {
        original: diffModel('head', tab.path, content.original),
        modified: doc?.model ?? diffModel('deleted', tab.path, content.modified),
        editable: !!doc,
      };
    };
    load()
      .then(({ original, modified, editable }) => {
        if (disposed || !host.current) return;
        diff = monaco.editor.createDiffEditor(host.current, {
          ...editorOptions,
          readOnly: !editable,
          originalEditable: false,
          renderSideBySide: true,
          ignoreTrimWhitespace: false,
        });
        diff.setModel({ original, modified });
        if (editable)
          diff.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            void saveFile(tab.path, onError);
          });
        editorRef.current = diff;
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(message(failure));
      });
    return () => {
      disposed = true;
      editorRef.current = null;
      diff?.dispose();
    };
  }, [tab.path, taskId, onError]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return (
    <>
      <div className="diff-header">
        <span className="truncate">
          {tab.source === 'task' ? (
            <>
              Tarefa <strong>{tab.taskTitle}</strong> · antes ↔ depois
            </>
          ) : (
            <>
              Último commit ↔ <strong>sua cópia</strong>
              {getDoc(tab.path) ? ' (editável)' : ''}
            </>
          )}
        </span>
        <button
          className="icon-button"
          title={sideBySide ? 'Ver em linha' : 'Ver lado a lado'}
          aria-label={sideBySide ? 'Ver em linha' : 'Ver lado a lado'}
          onClick={() => setSideBySide((value) => !value)}
        >
          {sideBySide ? <Rows2 size={14} /> : <Columns2 size={14} />}
        </button>
      </div>
      {tab.source === 'working' && <ConflictBanner path={tab.path} onError={onError} />}
      {error ? (
        <div className="editor-empty">
          <p>{error}</p>
        </div>
      ) : (
        <div ref={host} className="monaco-host" />
      )}
    </>
  );
}
