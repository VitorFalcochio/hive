import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, ChevronRight, File, FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import type { FileEntry, GitStatusSummary } from '@hive/core';
import { message, useHive } from '../context';
import { Modal, useTask } from '../ui';
import { fileTab, useCode, workingDiffTab } from './store';

type Menu = { x: number; y: number; entry: FileEntry | null };
type Dialog =
  { kind: 'create'; type: 'file' | 'dir'; parent: string } | { kind: 'rename'; entry: FileEntry };

const statusLabel: Record<string, string> = {
  M: 'Modificado',
  A: 'Adicionado',
  D: 'Removido',
  R: 'Renomeado',
  '??': 'Novo',
};
const statusClass = (status: string | undefined) =>
  !status
    ? ''
    : status === '??' || status.includes('A')
      ? 's-new'
      : status.includes('D')
        ? 's-del'
        : 's-mod';
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function Explorer({ onError }: { onError: (text: string) => void }) {
  const { summary, onFiles } = useHive();
  const open = useCode((state) => state.open);
  const activePath = useCode((state) => {
    const group = state.groups[state.focused];
    return group?.tabs.find((tab) => tab.id === group.active)?.path ?? null;
  });
  const [mode, setMode] = useState<'files' | 'changes'>('files');
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const workspaceId = summary?.workspace?.id;
  /** Folders currently loaded in the tree, so file events only reload what is visible. */
  const loaded = useRef(new Set<string>());

  const load = useCallback(
    async (dir: string) => {
      try {
        const entries = await window.hive.invoke('fs.list', { path: dir });
        loaded.current.add(dir);
        setChildren((current) => ({ ...current, [dir]: entries }));
      } catch (error) {
        // A folder that disappeared is simply dropped from the tree.
        loaded.current.delete(dir);
        setChildren((current) => {
          const next = { ...current };
          delete next[dir];
          return next;
        });
        if (dir === '') onError(message(error));
      }
    },
    [onError],
  );
  const loadStatus = useCallback(async () => {
    setStatus(await window.hive.invoke('git.status').catch(() => null));
  }, []);

  useEffect(() => {
    loaded.current.clear();
    setChildren({});
    setExpanded(new Set(['']));
    void load('');
    void loadStatus();
  }, [workspaceId, load, loadStatus]);

  useEffect(
    () =>
      onFiles((paths) => {
        for (const dir of new Set(paths.map(parentOf))) if (loaded.current.has(dir)) void load(dir);
        void loadStatus();
      }),
    [onFiles, load, loadStatus],
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const statusByPath = new Map(status?.files.map((file) => [file.path, file.status]) ?? []);
  const changedDirs = new Set<string>();
  for (const file of status?.files ?? []) {
    let dir = parentOf(file.path);
    while (dir) {
      changedDirs.add(dir);
      dir = parentOf(dir);
    }
  }

  function toggle(dir: string) {
    const opening = !expanded.has(dir);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(dir);
      else next.delete(dir);
      return next;
    });
    if (opening && !loaded.current.has(dir)) void load(dir);
  }

  function openMenu(event: MouseEvent, entry: FileEntry | null) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, entry });
  }

  async function trash(entry: FileEntry) {
    if (!window.confirm(`Mover "${entry.name}" para a lixeira?`)) return;
    try {
      await window.hive.invoke('fs.trash', { path: entry.path });
      useCode.getState().forget(entry.path);
      await load(parentOf(entry.path));
    } catch (error) {
      onError(message(error));
    }
  }

  const renderDir = (dir: string, depth: number) =>
    (children[dir] ?? []).map((entry) => {
      const isDir = entry.kind === 'dir';
      const isOpen = expanded.has(entry.path);
      const fileStatus = statusByPath.get(entry.path);
      return (
        <div key={entry.path}>
          <button
            className={activePath === entry.path && !isDir ? 'tree-node selected' : 'tree-node'}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={
              fileStatus ? `${entry.path} · ${statusLabel[fileStatus] ?? fileStatus}` : entry.path
            }
            onClick={() => (isDir ? toggle(entry.path) : open(fileTab(entry.path)))}
            onContextMenu={(event) => openMenu(event, entry)}
          >
            {isDir ? (
              isOpen ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : (
              <File size={13} className="file-icon" />
            )}
            <span className={`truncate ${statusClass(fileStatus)}`}>{entry.name}</span>
            {isDir && changedDirs.has(entry.path) && <span className="change-dot" />}
            {fileStatus && (
              <span className={`git-letter ${statusClass(fileStatus)}`}>
                {fileStatus === '??' ? 'U' : fileStatus[0]}
              </span>
            )}
          </button>
          {isDir && isOpen && renderDir(entry.path, depth + 1)}
        </div>
      );
    });

  return (
    <aside className="explorer" onContextMenu={(event) => openMenu(event, null)}>
      <div className="explorer-tabs">
        <button className={mode === 'files' ? 'selected' : ''} onClick={() => setMode('files')}>
          Arquivos
        </button>
        <button className={mode === 'changes' ? 'selected' : ''} onClick={() => setMode('changes')}>
          Alterações
          {status && status.files.length > 0 && (
            <span className="count">{status.files.length}</span>
          )}
        </button>
        <span className="spacer" />
        {mode === 'files' && (
          <>
            <button
              className="icon-button"
              title="Novo arquivo"
              aria-label="Novo arquivo"
              onClick={() => setDialog({ kind: 'create', type: 'file', parent: '' })}
            >
              <FilePlus size={14} />
            </button>
            <button
              className="icon-button"
              title="Nova pasta"
              aria-label="Nova pasta"
              onClick={() => setDialog({ kind: 'create', type: 'dir', parent: '' })}
            >
              <FolderPlus size={14} />
            </button>
          </>
        )}
        <button
          className="icon-button"
          title="Atualizar"
          aria-label="Atualizar"
          onClick={() => {
            for (const dir of loaded.current) void load(dir);
            void loadStatus();
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="explorer-list">
        {mode === 'files' ? (
          renderDir('', 0)
        ) : status?.files.length ? (
          status.files.map((file) => (
            <button
              key={file.path}
              className="tree-node change-row"
              title={`${statusLabel[file.status] ?? file.status} · ${file.path}`}
              onClick={() => open(workingDiffTab(file.path))}
            >
              <span className={`git-letter ${statusClass(file.status)}`}>
                {file.status === '??' ? 'U' : file.status[0]}
              </span>
              <span className="truncate">{file.path.split('/').pop()}</span>
              <small className="truncate">{parentOf(file.path)}</small>
            </button>
          ))
        ) : (
          <p className="explorer-empty">Nenhuma alteração desde o último commit.</p>
        )}
      </div>

      {menu && (
        <ul
          className="context-menu"
          style={{ top: menu.y, left: menu.x }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {[
            {
              label: 'Novo arquivo',
              run: () =>
                setDialog({
                  kind: 'create',
                  type: 'file',
                  parent: menu.entry
                    ? menu.entry.kind === 'dir'
                      ? menu.entry.path
                      : parentOf(menu.entry.path)
                    : '',
                }),
            },
            {
              label: 'Nova pasta',
              run: () =>
                setDialog({
                  kind: 'create',
                  type: 'dir',
                  parent: menu.entry
                    ? menu.entry.kind === 'dir'
                      ? menu.entry.path
                      : parentOf(menu.entry.path)
                    : '',
                }),
            },
            ...(menu.entry
              ? [
                  {
                    label: 'Renomear',
                    run: () => setDialog({ kind: 'rename', entry: menu.entry! }),
                  },
                  {
                    label: 'Ver alterações',
                    hidden: menu.entry.kind === 'dir' || !statusByPath.has(menu.entry.path),
                    run: () => open(workingDiffTab(menu.entry!.path)),
                  },
                  {
                    label: 'Mover para a lixeira',
                    danger: true,
                    run: () => void trash(menu.entry!),
                  },
                ]
              : []),
          ]
            .filter((item) => !('hidden' in item && item.hidden))
            .map((item) => (
              <li key={item.label}>
                <button
                  className={'danger' in item && item.danger ? 'danger' : undefined}
                  onClick={() => {
                    setMenu(null);
                    item.run();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
        </ul>
      )}

      {dialog && (
        <NameDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
          onDone={async (path) => {
            const parent = parentOf(path);
            setExpanded((current) => new Set([...current, parent]));
            await load(parent);
            if (dialog.kind === 'rename') {
              await load(parentOf(dialog.entry.path));
              useCode.getState().forget(dialog.entry.path);
            }
            if (dialog.kind === 'create' && dialog.type === 'file') open(fileTab(path));
            void loadStatus();
          }}
        />
      )}
    </aside>
  );
}

function NameDialog({
  dialog,
  onClose,
  onDone,
}: {
  dialog: Dialog;
  onClose: () => void;
  onDone: (path: string) => Promise<void>;
}) {
  const initial =
    dialog.kind === 'rename' ? dialog.entry.path : dialog.parent ? `${dialog.parent}/` : '';
  const [value, setValue] = useState(initial);
  const task = useTask();
  const title =
    dialog.kind === 'rename'
      ? `Renomear ${dialog.entry.name}`
      : dialog.type === 'file'
        ? 'Novo arquivo'
        : 'Nova pasta';
  return (
    <Modal title={title} description="Caminho relativo à raiz do projeto." onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const path = value
            .trim()
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
          if (!path) return;
          void task.run(async () => {
            if (dialog.kind === 'rename')
              await window.hive.invoke('fs.rename', { from: dialog.entry.path, to: path });
            else await window.hive.invoke('fs.create', { path, kind: dialog.type });
            onClose();
            await onDone(path);
          });
        }}
      >
        <label>
          Caminho
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              dialog.kind === 'create' && dialog.type === 'dir' ? 'src/components' : 'src/index.ts'
            }
            onFocus={(event) => {
              const input = event.currentTarget;
              const start = input.value.lastIndexOf('/') + 1;
              const dot = input.value.lastIndexOf('.');
              input.setSelectionRange(
                start,
                dialog.kind === 'rename' && dot > start ? dot : input.value.length,
              );
            }}
          />
        </label>
        {task.error && <p className="form-error">{task.error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button disabled={task.running}>{dialog.kind === 'rename' ? 'Renomear' : 'Criar'}</button>
        </div>
      </form>
    </Modal>
  );
}
