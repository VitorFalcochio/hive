import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Monitor, MousePointerClick, RefreshCw } from 'lucide-react';
import type { Workspace } from '@hive/core';
import { useHive } from './context';
import { DesignPanel, parseDesignElement, type DesignElement, type DesignPreview } from './design';
import { useTray } from './design-tray';
import { DesignTray } from './design-tray-panel';

function validatePreviewUrl(value: string): string {
  const url = new URL(value.trim());
  const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
  if (!['http:', 'https:'].includes(url.protocol) || !localHosts.has(url.hostname))
    throw new Error('Use uma URL local, como http://localhost:5173.');
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.toString();
}

/**
 * The Live Preview as a pane: a local server or a project HTML page in a frame, reloaded when
 * files change, with the Design Mode inspector. `detected` lists the URLs the terminals printed.
 */
export function PreviewPane({ workspace, detected }: { workspace: Workspace; detected: string[] }) {
  const { onFiles, fail } = useHive();
  const [urlInput, setUrlInput] = useState(detected[0] ?? '');
  const [previewUrl, setPreviewUrl] = useState(detected[0] ?? '');
  const [urlError, setUrlError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [designOn, setDesignOn] = useState(false);
  const [selection, setSelection] = useState<{ frame: number; element: DesignElement } | null>(
    null,
  );
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const [htmlPages, setHtmlPages] = useState<string[]>([]);

  // The first server a terminal prints is opened unless the user already chose an address.
  const firstDetected = detected[0];
  useEffect(() => {
    if (!firstDetected || previewUrl) return;
    setUrlInput(firstDetected);
    setPreviewUrl(firstDetected);
  }, [firstDetected, previewUrl]);

  useEffect(() => {
    if (!previewUrl) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return onFiles(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setReloadKey((value) => value + 1), 600);
    });
  }, [onFiles, previewUrl]);

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

  /**
   * A picture of the element as the preview shows it. Its rect is relative to the page inside
   * the iframe, so it is moved by the iframe's place in the window and kept inside the frame.
   */
  async function captureElement(element: DesignElement): Promise<string | null> {
    const frame = previewFrame.current?.getBoundingClientRect();
    if (!frame) return null;
    const pad = 6;
    const left = Math.max(frame.left, frame.left + element.rect.x - pad);
    const top = Math.max(frame.top, frame.top + element.rect.y - pad);
    const right = Math.min(frame.right, frame.left + element.rect.x + element.rect.width + pad);
    const bottom = Math.min(frame.bottom, frame.top + element.rect.y + element.rect.height + pad);
    if (right - left < 4 || bottom - top < 4) return null;
    return window.hive.invoke('design.capture', {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    });
  }

  // Edits are shown on the page right away; they live only in the preview until saved.
  function postPreview(preview: DesignPreview) {
    previewFrame.current?.contentWindow?.postMessage(
      { source: 'hive-design', type: 'apply', ...preview },
      '*',
    );
  }

  function toggleDesign() {
    const next = !designOn;
    setDesignOn(next);
    if (!next) {
      setSelection(null);
      previewFrame.current?.contentWindow?.postMessage(
        { source: 'hive-design', type: 'reset' },
        '*',
      );
    }
    postDesign(next);
  }

  // HTML pages of the project, listed so they can be opened the way VS Code's Live Server does.
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
  }, [workspace.id, onFiles]);

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

  return (
    <div className="preview-pane">
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
        <input
          aria-label="Endereço do preview"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') openPreview();
          }}
          placeholder="http://localhost:5173"
          spellCheck={false}
        />
        <button className="secondary" onClick={() => openPreview()}>
          Abrir
        </button>
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
          aria-label="Recarregar preview"
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-button"
          onClick={() => void window.hive.invoke('app.openExternal', previewUrl).catch(fail)}
          disabled={!previewUrl}
          title="Abrir no navegador"
          aria-label="Abrir no navegador"
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {urlError && <p className="preview-error">{urlError}</p>}
      {detected.length > 1 && (
        <div className="preview-detected">
          {detected.map((url) => (
            <button key={url} onClick={() => openPreview(url)}>
              {url}
            </button>
          ))}
        </div>
      )}
      {designOn && (
        <p className="design-hint" role="status">
          {selected
            ? 'Ajuste no painel ao lado: o preview muda na hora. Clique em outro elemento para trocar.'
            : 'Clique em um elemento do preview para editar cores, texto e fonte.'}
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
                Rode o projeto num terminal (ex.: npm run dev): o endereço é detectado sozinho. Você
                também pode informá-lo acima.
              </span>
            </div>
          )}
        </div>
        {selected && (
          <DesignPanel
            key={`${selected.selector}:${selected.rect.x}:${selected.rect.y}`}
            element={selected}
            onClose={() => setSelection(null)}
            onPreview={postPreview}
            onCapture={() => captureElement(selected)}
            onAddNote={(note) =>
              useTray.getState().add(workspace.id, { ...note, id: crypto.randomUUID() })
            }
          />
        )}
      </div>
      {designOn && <DesignTray workspaceId={workspace.id} pageUrl={previewUrl} />}
    </div>
  );
}
