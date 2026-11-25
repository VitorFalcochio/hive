import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Globe,
  Hand,
  Keyboard,
  Monitor,
  Play,
  Plus,
  RotateCw,
  Smartphone,
  Tablet,
  Terminal,
  X,
} from 'lucide-react';
import type { BrowserTabState } from '@hive/core';
import { Empty, useTask } from './ui';

/** How often the live view refreshes while the page is open. */
const LIVE_MS = 1_200;
const devices = [
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'mobile', label: 'Celular', icon: Smartphone },
] as const;

/**
 * The Hive Browser: every tab the user or an agent has open, in the Chromium inside Hive. The
 * view is a live screenshot of the tab, so a click on it clicks the page and the wheel scrolls
 * it; agents' tabs show who drives them, and the user can stop that agent's automation.
 * It lives as a block of the Workspace; there, compact keeps the console behind a button.
 */
export function BrowserView({ compact = false }: { compact?: boolean }) {
  const [sideOpen, setSideOpen] = useState(!compact);
  const [tabs, setTabs] = useState<BrowserTabState[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [typing, setTyping] = useState('');
  const [shot, setShot] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const action = useTask();
  const image = useRef<HTMLImageElement>(null);
  const wheel = useRef(0);

  const tab = tabs.find((item) => item.id === selected) ?? tabs[0] ?? null;
  const agentTab = !!tab && tab.owner.key !== 'user';

  const reload = useCallback(
    () =>
      window.hive.invoke('browser.list').then((next) => {
        setTabs(next);
        setSelected((current) =>
          current && next.some((item) => item.id === current) ? current : (next[0]?.id ?? null),
        );
      }),
    [],
  );
  useEffect(() => {
    void reload().catch(() => undefined);
    return window.hive.subscribe((push) => {
      if (push.kind === 'changed' && push.entity === 'browser')
        void reload().catch(() => undefined);
    });
  }, [reload]);

  // The address bar follows the tab, unless the user is typing a new address.
  const tabId = tab?.id ?? null;
  const tabUrl = tab?.url ?? '';
  useEffect(() => setAddress(tabUrl), [tabId, tabUrl]);

  // The live view and the console of the selected tab, while it exists.
  useEffect(() => {
    if (!tabId) {
      setShot(null);
      setLines([]);
      return;
    }
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      void window.hive
        .invoke('browser.preview', tabId)
        .then((next) => alive && setShot(next))
        .catch(() => undefined);
      void window.hive
        .invoke('browser.console', tabId)
        .then((next) => alive && setLines(next))
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, LIVE_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tabId]);

  const call = (work: () => Promise<BrowserTabState[] | void>) =>
    void action.run(async () => {
      const next = await work();
      if (next) setTabs(next);
    });

  const go = (event: FormEvent) => {
    event.preventDefault();
    const url = address.trim();
    if (!url) return;
    if (!tab) call(() => window.hive.invoke('browser.open', { url }));
    else call(() => window.hive.invoke('browser.navigate', { tabId: tab.id, action: 'goto', url }));
  };

  const openNew = () =>
    call(async () => {
      const next = await window.hive.invoke('browser.open', {
        url: address.trim() || 'http://localhost:5173',
      });
      setSelected(next.at(-1)?.id ?? null);
      return next;
    });

  /** Page coordinates of a click on the live view, from its displayed size. */
  const clickView = (event: React.MouseEvent<HTMLImageElement>) => {
    if (!tab || !image.current) return;
    const box = image.current.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * tab.width;
    const y = ((event.clientY - box.top) / box.height) * tab.height;
    call(() => window.hive.invoke('browser.click', { tabId: tab.id, x, y }));
  };

  const scrollView = (event: React.WheelEvent) => {
    if (!tab) return;
    // One scroll per burst of wheel ticks.
    wheel.current += event.deltaY;
    const dy = wheel.current;
    if (Math.abs(dy) < 80) return;
    wheel.current = 0;
    void window.hive.invoke('browser.scroll', { tabId: tab.id, dy }).catch(() => undefined);
  };

  return (
    <div className={compact ? 'hive-browser compact' : 'hive-browser'}>
      <div className="hive-browser-tabs" role="tablist" aria-label="Abas do Hive Browser">
        {tabs.map((item) => (
          <div
            key={item.id}
            role="tab"
            tabIndex={0}
            aria-selected={item.id === tab?.id}
            className={item.id === tab?.id ? 'hive-browser-tab selected' : 'hive-browser-tab'}
            onClick={() => setSelected(item.id)}
            onKeyDown={(event) => event.key === 'Enter' && setSelected(item.id)}
            title={item.url}
          >
            {item.owner.key === 'user' ? <Globe size={12} /> : <Bot size={12} />}
            <span className="truncate">{item.title || item.url || 'Nova aba'}</span>
            {item.errors > 0 && <span className="hive-browser-errors">{item.errors}</span>}
            <button
              className="ghost"
              aria-label={`Fechar ${item.title || item.url}`}
              onClick={(event) => {
                event.stopPropagation();
                call(() => window.hive.invoke('browser.close', item.id));
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="ghost" aria-label="Nova aba" disabled={action.running} onClick={openNew}>
          <Plus size={14} />
        </button>
      </div>

      <form className="hive-browser-bar" onSubmit={go}>
        <button
          type="button"
          className="ghost"
          aria-label="Voltar"
          disabled={!tab?.canGoBack || action.running}
          onClick={() =>
            tab &&
            call(() => window.hive.invoke('browser.navigate', { tabId: tab.id, action: 'back' }))
          }
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="ghost"
          aria-label="Avançar"
          disabled={!tab?.canGoForward || action.running}
          onClick={() =>
            tab &&
            call(() => window.hive.invoke('browser.navigate', { tabId: tab.id, action: 'forward' }))
          }
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="ghost"
          aria-label="Recarregar"
          disabled={!tab || action.running}
          onClick={() =>
            tab &&
            call(() => window.hive.invoke('browser.navigate', { tabId: tab.id, action: 'reload' }))
          }
        >
          <RotateCw size={14} className={tab?.loading ? 'spin' : undefined} />
        </button>
        <input
          aria-label="Endereço"
          value={address}
          placeholder="http://localhost:5173"
          onChange={(event) => setAddress(event.target.value)}
        />
        <div className="hive-browser-devices" role="group" aria-label="Modo de tela">
          {devices.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={tab?.device === id ? 'ghost selected' : 'ghost'}
              aria-label={label}
              aria-pressed={tab?.device === id}
              title={label}
              disabled={!tab || action.running}
              onClick={() =>
                tab &&
                call(() => window.hive.invoke('browser.resize', { tabId: tab.id, device: id }))
              }
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
        {compact && (
          <button
            type="button"
            className={sideOpen ? 'ghost selected' : 'ghost'}
            aria-label="Console e digitação"
            aria-pressed={sideOpen}
            title="Console e digitação"
            disabled={!tab}
            onClick={() => setSideOpen(!sideOpen)}
          >
            <Terminal size={14} />
            {tab && tab.errors > 0 && <span className="hive-browser-errors">{tab.errors}</span>}
          </button>
        )}
      </form>

      {agentTab && tab && (
        <div className={tab.paused ? 'hive-browser-owner paused' : 'hive-browser-owner'}>
          <Bot size={14} />
          <span>
            {tab.paused
              ? `Automação de ${tab.owner.label} interrompida. Você pode usar a aba.`
              : `${tab.owner.label} está controlando esta aba.`}
          </span>
          <button
            className="secondary"
            disabled={action.running}
            onClick={() =>
              call(() =>
                window.hive.invoke('browser.interrupt', {
                  ownerKey: tab.owner.key,
                  stopped: !tab.paused,
                }),
              )
            }
          >
            {tab.paused ? <Play size={13} /> : <Hand size={13} />}
            {tab.paused ? 'Deixar continuar' : 'Interromper'}
          </button>
        </div>
      )}

      {action.error && (
        <p className="error-text" role="alert">
          {action.error}
        </p>
      )}

      {!tab ? (
        <Empty
          action={
            <button className="secondary" onClick={openNew} disabled={action.running}>
              <Plus size={14} /> Abrir aba
            </button>
          }
        >
          Nenhuma aba aberta. Digite o endereço do seu app (por exemplo http://localhost:5173) ou
          espere um agente de QA abrir o dele. Cada aba é isolada: não usa os cookies nem os logins
          do seu navegador.
        </Empty>
      ) : (
        <div className="hive-browser-body">
          <div className="hive-browser-view" onWheel={scrollView}>
            {shot ? (
              <img
                ref={image}
                src={shot.dataUrl}
                alt={`Tela de ${tab.title || tab.url}`}
                onClick={clickView}
                style={{ aspectRatio: `${tab.width} / ${tab.height}` }}
              />
            ) : (
              <p className="muted">Carregando a tela…</p>
            )}
          </div>
          {sideOpen && (
            <aside className="hive-browser-side">
              <form
                className="hive-browser-type"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!typing) return;
                  const text = typing;
                  setTyping('');
                  call(() =>
                    window.hive.invoke('browser.type', { tabId: tab.id, text, submit: true }),
                  );
                }}
              >
                <label>
                  <Keyboard size={12} /> Digitar no campo selecionado
                </label>
                <input
                  value={typing}
                  placeholder="Clique num campo da tela e digite aqui"
                  onChange={(event) => setTyping(event.target.value)}
                />
              </form>
              <h3>
                <Terminal size={12} /> Console {tab.errors > 0 && `· ${tab.errors} erro(s)`}
              </h3>
              <pre className="hive-browser-console" tabIndex={0} aria-label="Console da aba">
                {lines.length ? lines.join('\n') : 'Nada no console.'}
              </pre>
              <p className="muted hive-browser-note">
                {tab.width}×{tab.height} · {tab.device}. Clique na tela para clicar na página; a
                roda do mouse rola.
              </p>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
