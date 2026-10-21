import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, GitBranch, Search, Sparkles } from 'lucide-react';
import { message, useHive } from '../context';
import { Empty, Modal, Select, type SelectOption } from '../ui';
import { EditorGroup, saveFile } from './EditorGroup';
import { Explorer } from './Explorer';
import { AiAssistant } from './AiAssistant';
import { openPaths, syncFromDisk } from './monaco';
import { fileTab, hasUnsavedChanges, useCode } from './store';

export default function CodeView() {
  const { summary, onFiles, fail, notify, pickWorkspace } = useHive();
  const groups = useCode((state) => state.groups);
  const split = useCode((state) => state.split);
  const focused = useCode((state) => state.focused);
  const [width, setWidth] = useState(260);
  const [quickOpen, setQuickOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // A proposal sent from the Design Mode opens the assistant even when it was closed.
  const pendingProposal = useCode((state) => state.pendingProposal);
  const assistantVisible = assistantOpen || pendingProposal !== null;
  const [branches, setBranches] = useState<{ current: string | null; local: string[] } | null>(
    null,
  );
  const workspaceId = summary?.workspace?.id;
  const onError = useCallback((text: string) => fail(new Error(text)), [fail]);

  const loadBranches = useCallback(async () => {
    setBranches(await window.hive.invoke('git.branches').catch(() => null));
  }, []);
  useEffect(() => {
    if (workspaceId) void loadBranches();
  }, [workspaceId, loadBranches]);

  // Keep open documents and the branch picker in sync with the disk.
  useEffect(
    () =>
      onFiles((paths) => {
        void syncFromDisk(paths);
        if (paths.includes('.git/HEAD')) {
          void loadBranches();
          void syncFromDisk(openPaths());
        }
      }),
    [onFiles, loadBranches],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        setQuickOpen(true);
      } else if (key === 's') {
        // Monaco handles Ctrl+S inside the editor; this covers focus elsewhere.
        const state = useCode.getState();
        const group = state.groups[state.focused];
        const tab = group?.tabs.find((item) => item.id === group.active);
        if (tab && (tab.kind === 'file' || tab.source === 'working')) {
          event.preventDefault();
          void saveFile(tab.path, onError);
        }
      } else if (key === '\\') {
        event.preventDefault();
        split();
      } else if (key === 'i') {
        event.preventDefault();
        setAssistantOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onError, split]);

  const branchOptions = useMemo<SelectOption[]>(() => {
    const local = branches?.local ?? [];
    const current = branches?.current;
    // A repository without commits has a current branch that git does not list yet.
    const unborn =
      current && !local.includes(current)
        ? [{ value: current, label: `${current} · sem commits`, group: 'Branches' }]
        : [];
    return [
      ...unborn,
      ...local
        .filter((name) => !name.startsWith('hive/'))
        .map((name) => ({ value: name, label: name, group: 'Branches' })),
      ...local
        .filter((name) => name.startsWith('hive/'))
        .map((name) => ({ value: name, label: name, group: 'Tarefas do Hive' })),
    ];
  }, [branches]);
  const focusedGroup = groups[focused];
  const focusedTab = focusedGroup?.tabs.find((tab) => tab.id === focusedGroup.active);
  const activeFile = focusedTab?.kind === 'file' ? focusedTab.path : null;

  async function checkout(branch: string) {
    if (branch === branches?.current) return;
    if (hasUnsavedChanges()) {
      onError('Salve ou descarte os arquivos abertos antes de trocar de branch.');
      return;
    }
    try {
      await window.hive.invoke('git.checkout', branch);
      await loadBranches();
      await syncFromDisk(openPaths());
      notify(`Agora em ${branch}.`);
    } catch (error) {
      onError(message(error));
    }
  }

  if (!summary?.workspace)
    return (
      <div className="code-view">
        <Empty action={<button onClick={() => void pickWorkspace()}>Abrir repositório</button>}>
          Abra um repositório para navegar e editar os arquivos.
        </Empty>
      </div>
    );

  return (
    <div className="code-view">
      <div className="code-toolbar">
        <div className="branch-picker" title="Branch atual">
          <GitBranch size={14} />
          <Select
            value={branches?.current ?? ''}
            placeholder="Sem branch"
            options={branchOptions}
            onChange={(value) => void checkout(value)}
          />
        </div>
        <span className="spacer" />
        <button className="ghost" onClick={() => setQuickOpen(true)}>
          <Search size={14} /> Buscar arquivo <kbd>Ctrl P</kbd>
        </button>
        <button
          className={assistantOpen ? 'ghost selected' : 'ghost'}
          title="Abrir assistente de código (Ctrl+I)"
          onClick={() => setAssistantOpen((open) => !open)}
        >
          <Sparkles size={14} /> IA no código <kbd>Ctrl I</kbd>
        </button>
        <button
          className="ghost"
          disabled={groups.length > 1}
          title="Dividir o editor (Ctrl+\)"
          onClick={split}
        >
          <Columns2 size={14} /> Dividir
        </button>
      </div>
      <div className="code-workspace">
        <div className="code-body" style={{ gridTemplateColumns: `${width}px 5px minmax(0, 1fr)` }}>
          <Explorer onError={onError} />
          <Resizer width={width} onResize={setWidth} />
          <div className="editor-groups">
            {groups.map((_, index) => (
              <EditorGroup key={index} index={index} onError={onError} />
            ))}
          </div>
        </div>
        {assistantVisible && (
          <AiAssistant
            key={activeFile ?? 'no-file'}
            path={activeFile}
            onClose={() => {
              setAssistantOpen(false);
              useCode.getState().setPendingProposal(null);
            }}
          />
        )}
      </div>
      {quickOpen && <QuickOpen onClose={() => setQuickOpen(false)} />}
    </div>
  );
}

function Resizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      onMouseDown={(event) => {
        event.preventDefault();
        start.current = { x: event.clientX, width };
        const move = (e: MouseEvent) => {
          if (start.current)
            onResize(
              Math.min(520, Math.max(180, start.current.width + e.clientX - start.current.x)),
            );
        };
        const up = () => {
          start.current = null;
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

/** Subsequence match: every query character in order, rewarding consecutive and filename hits. */
function score(path: string, query: string): number {
  const haystack = path.toLowerCase();
  const name = haystack.slice(haystack.lastIndexOf('/') + 1);
  let total = 0;
  let position = -1;
  let streak = 0;
  for (const char of query) {
    const next = haystack.indexOf(char, position + 1);
    if (next < 0) return -1;
    streak = next === position + 1 ? streak + 1 : 0;
    total += 1 + streak * 2 + (next >= haystack.length - name.length ? 2 : 0);
    position = next;
  }
  if (name.startsWith(query)) total += 20;
  return total - path.length * 0.01;
}

function QuickOpen({ onClose }: { onClose: () => void }) {
  const open = useCode((state) => state.open);
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  useEffect(() => {
    void window.hive
      .invoke('fs.files')
      .then(setFiles)
      .catch(() => setFiles([]));
  }, []);
  const results = useMemo(() => {
    const wanted = query.trim().toLowerCase().replace(/\\/g, '/');
    if (!files) return [];
    if (!wanted) return files.slice(0, 50);
    return files
      .map((path) => ({ path, score: score(path, wanted) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((item) => item.path);
  }, [files, query]);
  const choose = (path: string | undefined) => {
    if (!path) return;
    open(fileTab(path));
    onClose();
  };
  return (
    <Modal title="Buscar arquivo" onClose={onClose} wide>
      <input
        autoFocus
        value={query}
        placeholder="Digite parte do nome ou do caminho"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(results.length - 1, index + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(results[active]);
          }
        }}
      />
      <ul className="quick-results" role="listbox">
        {files === null && <li className="muted-row">Carregando…</li>}
        {files !== null && !results.length && <li className="muted-row">Nenhum arquivo.</li>}
        {results.map((path, index) => (
          <li
            key={path}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'active' : undefined}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(path)}
          >
            <span>{path.split('/').pop()}</span>
            <small className="truncate">{path}</small>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
