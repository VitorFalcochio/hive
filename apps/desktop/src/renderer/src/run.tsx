import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ChevronDown,
  ExternalLink,
  Monitor,
  MousePointerClick,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import type { TerminalEvent, TerminalSession, TerminalStatus } from '@hive/core';
import { useHive } from './context';
import { Dot } from './ui';
import { DesignPanel, parseDesignElement, type DesignElement } from './design';

const MAX_RENDERED_OUTPUT = 1024 * 1024;

const suggestedCommands = ['npm run dev', 'npm start', 'npm test', 'npm run build'];

const statusLabel: Record<TerminalStatus, string> = {
  running: 'Executando',
  stopping: 'Encerrando',
  exited: 'Concluído',
  failed: 'Falhou',
  stopped: 'Interrompido',
};

function terminalTone(status: TerminalStatus) {
  if (status === 'running' || status === 'stopping') return 'busy' as const;
  if (status === 'exited') return 'ok' as const;
  if (status === 'failed') return 'error' as const;
  return 'idle' as const;
}

function upsert(sessions: TerminalSession[], next: TerminalSession): TerminalSession[] {
  const found = sessions.some((session) => session.id === next.id);
  return found
    ? sessions.map((session) => (session.id === next.id ? next : session))
    : [next, ...sessions];
}

function validatePreviewUrl(value: string): string {
  const url = new URL(value.trim());
  const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  if (!['http:', 'https:'].includes(url.protocol) || !localHosts.has(url.hostname))
    throw new Error('Use uma URL local, como http://localhost:5173.');
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.toString();
}

export function RunPage() {
  const { summary, onFiles, onTerminal, fail } = useHive();
  const workspace = summary?.workspace ?? null;
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [command, setCommand] = useState('npm run dev');
  const [urlInput, setUrlInput] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [designOn, setDesignOn] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [selection, setSelection] = useState<{ frame: number; element: DesignElement } | null>(
    null,
  );
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const [htmlPages, setHtmlPages] = useState<string[]>([]);
  const outputRef = useRef<HTMLPreElement>(null);

  const active = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? sessions[0] ?? null,
    [activeId, sessions],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSessions([]);
    setActiveId(null);
    setUrlInput('');
    setPreviewUrl('');
    setUrlError('');
    void window.hive
      .invoke('terminal.list')
      .then((result) => {
        if (!alive) return;
        setSessions(result);
        setActiveId(result[0]?.id ?? null);
      })
      .catch((error) => {
        if (alive) fail(error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspace?.id, fail]);

  useEffect(
    () =>
      onTerminal((event: TerminalEvent) => {
        if (event.type === 'started') {
          if (event.session.workspaceId !== workspace?.id) return;
          setSessions((current) => upsert(current, event.session));
          setActiveId(event.session.id);
          return;
        }
        if (event.type === 'state') {
          setSessions((current) =>
            current.some((session) => session.id === event.session.id)
              ? upsert(current, event.session)
              : current,
          );
          return;
        }
        setSessions((current) =>
          current.map((session) =>
            session.id === event.sessionId
              ? {
                  ...session,
                  output: (session.output + event.chunk).slice(-MAX_RENDERED_OUTPUT),
                  previewUrls: event.previewUrls,
                }
              : session,
          ),
        );
      }),
    [onTerminal, workspace?.id],
  );

  useEffect(() => {
    const detected = active?.previewUrls[0];
    if (!detected || previewUrl) return;
    setUrlInput(detected);
    setPreviewUrl(detected);
  }, [active?.previewUrls, previewUrl]);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [active?.output]);

  useEffect(() => {
    if (!previewUrl) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return onFiles(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setReloadKey((value) => value + 1), 600);
    });
  }, [onFiles, previewUrl]);

  const start = useCallback(
    async (nextCommand: string) => {
      if (!workspace || !nextCommand.trim()) return;
      setBusy(true);
      try {
        const session = await window.hive.invoke('terminal.start', {
          command: nextCommand.trim(),
        });
        // The push event normally arrives before the IPC response. Keep any output received
        // in that interval instead of replacing it with the start response snapshot.
        setSessions((current) =>
          current.some((item) => item.id === session.id) ? current : [session, ...current],
        );
        setActiveId(session.id);
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
    },
    [fail, workspace],
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    void start(command);
  }

  async function stop() {
    if (!active) return;
    setBusy(true);
    try {
      const session = await window.hive.invoke('terminal.stop', active.id);
      setSessions((current) => upsert(current, session));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!active) return;
    try {
      const session = await window.hive.invoke('terminal.clear', active.id);
      setSessions((current) => upsert(current, session));
    } catch (error) {
      fail(error);
    }
  }

  function openPreview(value = urlInput) {
    try {
      const normalized = validatePreviewUrl(value);
      setUrlInput(normalized);
      setPreviewUrl(normalized);
      setUrlError('');
      setReloadKey((current) => current + 1);
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : String(error));
    }
  }

  // The preview is a cross-origin iframe, so the inspector reports through postMessage.
  // Only messages from this iframe's window are accepted. A selection is tagged with the
  // reload it came from, so it is ignored once the preview has reloaded.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== previewFrame.current?.contentWindow) return;
      const element = parseDesignElement(event.data);
      if (element) setSelection({ frame: reloadKey, element });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [reloadKey]);
  const selected = selection?.frame === reloadKey ? selection.element : null;

  function postDesign(enabled: boolean) {
    previewFrame.current?.contentWindow?.postMessage(
      { source: 'hive-design', type: enabled ? 'enable' : 'disable' },
      '*',
    );
  }

  function toggleDesign() {
    const next = !designOn;
    setDesignOn(next);
    if (!next) setSelection(null);
    postDesign(next);
  }

  // HTML pages of the project, listed so they can be opened the way VS Code's Live Server does.
  const workspaceId = workspace?.id;
  useEffect(() => {
    let alive = true;
    const load = () =>
      void window.hive
        .invoke('fs.files')
        .then((files) => {
          if (alive) setHtmlPages(files.filter((file) => /\.html?$/i.test(file)));
        })
        .catch(() => {
          if (alive) setHtmlPages([]);
        });
    load();
    const unsubscribe = onFiles(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [workspaceId, onFiles]);

  async function openHtml(relative: string) {
    if (!relative) return;
    try {
      const { url } = await window.hive.invoke('preview.serve', { path: relative });
      setUrlError('');
      openPreview(url);
    } catch (error) {
      fail(error);
    }
  }

  if (!workspace) {
    return (
      <section className="run-empty">
        <TerminalSquare size={30} />
        <h1>Rodar projeto</h1>
        <p>Abra um repositório para executar comandos e visualizar o site.</p>
      </section>
    );
  }

  const running = active?.status === 'running' || active?.status === 'stopping';

  return (
    <section className="run-page">
      <header className="run-header">
        <div>
          <h1>Rodar projeto</h1>
          <p>Execute o projeto e acompanhe o resultado sem sair do Hive.</p>
        </div>
        <span className="run-workspace">{workspace.name}</span>
      </header>

      <form className="command-bar" onSubmit={submit}>
        <span aria-hidden="true">$</span>
        <label className="sr-only" htmlFor="run-command">
          Comando
        </label>
        <input
          id="run-command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="npm run dev"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="primary" type="submit" disabled={busy || !command.trim()}>
          <Play size={14} fill="currentColor" /> Executar
        </button>
      </form>

      <div className={terminalOpen ? 'run-grid' : 'run-grid terminal-collapsed'}>
        <section className="run-panel terminal-panel" aria-label="Terminal">
          <div className="run-panel-header">
            <div className="run-panel-title">
              <TerminalSquare size={15} />
              <strong>Terminal</strong>
              {active && (
                <span className="terminal-status">
                  <Dot tone={terminalTone(active.status)} /> {statusLabel[active.status]}
                </span>
              )}
            </div>
            <div className="run-actions">
              <button
                className="icon-button"
                onClick={() => setTerminalOpen((open) => !open)}
                title={terminalOpen ? 'Recolher terminal' : 'Expandir terminal'}
                aria-expanded={terminalOpen}
              >
                <ChevronDown size={15} />
              </button>
              {running ? (
                <button
                  className="icon-button"
                  onClick={() => void stop()}
                  disabled={busy}
                  title="Parar"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="icon-button"
                  onClick={() => active && void start(active.command)}
                  disabled={!active || busy}
                  title="Executar novamente"
                >
                  <RotateCcw size={14} />
                </button>
              )}
              <button
                className="icon-button"
                onClick={() => void clear()}
                disabled={!active || !active.output}
                title="Limpar saída"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {sessions.length > 0 && (
            <div className="terminal-tabs" aria-label="Sessões do terminal">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={session.id === active?.id ? 'selected' : ''}
                  onClick={() => setActiveId(session.id)}
                  title={session.command}
                >
                  <Dot tone={terminalTone(session.status)} />
                  <span>{session.command}</span>
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div className="terminal-placeholder" role="status">
              Carregando sessões…
            </div>
          ) : active ? (
            <pre ref={outputRef} className="terminal-output" aria-label="Saída do terminal">
              <span className="terminal-prompt">$ {active.command}</span>
              {'\n'}
              {active.output || (running ? 'Iniciando…' : 'Sem saída.')}
            </pre>
          ) : (
            <div className="terminal-placeholder">
              <TerminalSquare size={24} />
              <span>Escolha um comando ou digite o seu acima.</span>
              <div className="terminal-suggestions">
                {suggestedCommands.map((suggested) => (
                  <button key={suggested} type="button" onClick={() => setCommand(suggested)}>
                    <code>{suggested}</code>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="run-panel preview-panel" aria-label="Live Preview">
          <div className="run-panel-header preview-header">
            <div className="run-panel-title">
              <Monitor size={15} /> <strong>Live Preview</strong>
              {previewUrl && <span className="preview-host">{new URL(previewUrl).host}</span>}
            </div>
            <div className="run-actions">
              <button
                className={designOn ? 'design-toggle active' : 'design-toggle'}
                onClick={toggleDesign}
                disabled={!previewUrl}
                aria-pressed={designOn}
                title="Design Mode: selecionar um elemento do preview"
              >
                <MousePointerClick size={14} /> Inspecionar
              </button>
              <button
                className="icon-button"
                onClick={() => setReloadKey((value) => value + 1)}
                disabled={!previewUrl}
                title="Recarregar preview"
              >
                <RefreshCw size={15} />
              </button>
              <button
                className="icon-button"
                onClick={() => void window.hive.invoke('app.openExternal', previewUrl).catch(fail)}
                disabled={!previewUrl}
                title="Abrir no navegador"
              >
                <ExternalLink size={15} />
              </button>
            </div>
          </div>
          <div className="preview-address">
            <select
              className="preview-pages"
              aria-label="Abrir página HTML do projeto"
              value=""
              onChange={(event) => void openHtml(event.target.value)}
              disabled={!htmlPages.length}
            >
              <option value="">
                {htmlPages.length ? 'Páginas do projeto…' : 'Nenhuma página HTML'}
              </option>
              {htmlPages.map((page) => (
                <option key={page} value={page}>
                  {page}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="preview-url">
              Endereço do preview
            </label>
            <input
              id="preview-url"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') openPreview();
              }}
              placeholder="http://localhost:5173"
              spellCheck={false}
            />
            <button onClick={() => openPreview()}>Abrir</button>
          </div>
          {urlError && <p className="preview-error">{urlError}</p>}
          {active && active.previewUrls.length > 1 && (
            <div className="preview-detected">
              {active.previewUrls.map((url) => (
                <button key={url} onClick={() => openPreview(url)}>
                  {url}
                </button>
              ))}
            </div>
          )}
          {designOn && (
            <p className="design-hint" role="status">
              {selected
                ? 'Elemento selecionado. Clique em outro para trocar.'
                : 'Clique em um elemento do preview para inspecioná-lo.'}
            </p>
          )}
          <div className="preview-body">
            <div className="preview-canvas">
              {previewUrl ? (
                <iframe
                  key={`${previewUrl}-${reloadKey}`}
                  ref={previewFrame}
                  src={previewUrl}
                  title={`Preview de ${workspace.name}`}
                  sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                  referrerPolicy="no-referrer"
                  onLoad={() => {
                    if (designOn) postDesign(true);
                  }}
                />
              ) : (
                <div className="preview-placeholder">
                  <Monitor size={30} />
                  <strong>Aguardando o servidor local</strong>
                  <span>
                    A URL será detectada na saída do comando. Você também pode informá-la acima.
                  </span>
                </div>
              )}
            </div>
            {selected && (
              <DesignPanel
                key={`${selected.selector}:${selected.rect.x}:${selected.rect.y}`}
                element={selected}
                onClose={() => setSelection(null)}
              />
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
