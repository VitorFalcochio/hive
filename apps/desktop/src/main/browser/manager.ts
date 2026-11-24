import { BrowserWindow, session, type WebContents } from 'electron';
import {
  isLocalUrl,
  parseWebUrl,
  type BrowserDevice,
  type BrowserDriver,
  type BrowserOwner,
  type BrowserShot,
  type BrowserTabInfo,
} from '@hive/agents';
import type { BrowserTabState } from '@hive/core';
import { HiveError, errorMessage, newId, nowIso } from '@hive/shared';

/** An in-memory session (no "persist:"): nothing of it reaches disk, and no personal cookies. */
const PARTITION = 'hive-browser';
const LOAD_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_TABS_PER_OWNER = 4;
const MAX_TABS = 12;
const MAX_LOG = 300;
const MAX_SHOT_WIDTH = 1280;
/** Rendering off screen costs CPU at 60 fps; a few frames a second is enough to look at. */
const FRAME_RATE = 10;

const SIZES: Record<BrowserDevice, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};
const MOBILE_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

export const USER_OWNER: BrowserOwner = {
  key: 'user',
  label: 'Você',
  workerId: null,
  taskId: null,
  runId: null,
};

interface Tab {
  id: string;
  owner: BrowserOwner;
  window: BrowserWindow;
  device: BrowserDevice;
  width: number;
  height: number;
  console: string[];
  network: { line: string; failed: boolean }[];
  errors: number;
  createdAt: string;
}

export interface BrowserManagerOptions {
  onChange: () => void;
  /** An agent's screenshot, kept as evidence of what it tested. */
  onEvidence?: (owner: BrowserOwner, shot: BrowserShot) => void;
}

const withTimeout = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HiveError('TIMEOUT', `${what} passou de ${Math.round(ms / 1000)} s.`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hive Browser: tabs of the Chromium inside Electron, each in a hidden off-screen window of its
 * own, in one isolated, in-memory session: sandboxed, no Node, no preload, no downloads, no
 * pop-ups, no permissions (camera, location, notifications…), no file:// pages. Agents drive
 * their own tabs through the browser tools; the user sees and drives any tab from the Browser
 * page, and can stop an agent's automation at any time.
 */
export class BrowserManager implements BrowserDriver {
  private readonly tabs = new Map<string, Tab>();
  /** The tab each owner used last, so the tools can leave the tab out. */
  private readonly lastTab = new Map<string, string>();
  /** Owners whose automation the user stopped. */
  private readonly paused = new Set<string>();
  /** Hosts outside this computer an owner was allowed to visit. */
  private readonly approvedHosts = new Map<string, Set<string>>();
  private prepared = false;

  constructor(private readonly options: BrowserManagerOptions) {}

  /** The session's rules, set once: nothing the page asks for is granted. */
  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    const browser = session.fromPartition(PARTITION);
    browser.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browser.setPermissionCheckHandler(() => false);
    browser.on('will-download', (event, item, contents) => {
      event.preventDefault();
      this.byContents(contents)?.console.push(`[hive] Download bloqueado: ${item.getURL()}`);
    });
    const record = (id: number | undefined, line: string, failed: boolean) => {
      const tab = id === undefined ? undefined : this.byContentsId(id);
      if (!tab) return;
      tab.network.push({ line, failed });
      if (tab.network.length > MAX_LOG) tab.network.splice(0, tab.network.length - MAX_LOG);
    };
    browser.webRequest.onCompleted((details) =>
      record(
        details.webContentsId,
        `${details.method} ${details.statusCode} ${details.url}`,
        details.statusCode >= 400,
      ),
    );
    browser.webRequest.onErrorOccurred((details) =>
      record(details.webContentsId, `${details.method} ERRO ${details.error} ${details.url}`, true),
    );
  }

  private byContentsId(id: number): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.window.webContents.id === id) return tab;
    return undefined;
  }

  private byContents(contents: WebContents | null | undefined): Tab | undefined {
    return contents ? this.byContentsId(contents.id) : undefined;
  }

  /** The tab an owner means, checking the owner may drive it and is not stopped. */
  private tab(owner: BrowserOwner, id: string | undefined): Tab {
    if (owner.key !== USER_OWNER.key && this.paused.has(owner.key))
      throw new HiveError(
        'DENIED',
        'O usuário interrompeu a automação do navegador. Não tente de novo nesta tarefa; relate o que já verificou.',
      );
    const key = id ?? this.lastTab.get(owner.key);
    const tab = key ? this.tabs.get(key) : undefined;
    if (!tab || tab.window.isDestroyed())
      throw new HiveError(
        'NOT_FOUND',
        id ? `Aba ${id} não existe.` : 'Nenhuma aba aberta: use browser_open.',
      );
    // The user drives any tab; an agent only its own.
    if (owner.key !== USER_OWNER.key && tab.owner.key !== owner.key)
      throw new HiveError('DENIED', `A aba ${tab.id} é de ${tab.owner.label}.`);
    this.lastTab.set(owner.key, tab.id);
    return tab;
  }

  private info(tab: Tab): BrowserTabInfo {
    const contents = tab.window.webContents;
    return {
      id: tab.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      device: tab.device,
      width: tab.width,
      height: tab.height,
    };
  }

  /** What the Browser page shows of every tab. */
  list(): BrowserTabState[] {
    return [...this.tabs.values()]
      .filter((tab) => !tab.window.isDestroyed())
      .map((tab) => ({
        ...this.info(tab),
        loading: tab.window.webContents.isLoading(),
        canGoBack: tab.window.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.window.webContents.navigationHistory.canGoForward(),
        owner: {
          key: tab.owner.key,
          label: tab.owner.label,
          workerId: tab.owner.workerId,
          taskId: tab.owner.taskId,
        },
        paused: this.paused.has(tab.owner.key),
        errors: tab.errors,
        createdAt: tab.createdAt,
      }));
  }

  /** Stops (or lets go on) an agent's automation; its tabs stay open for the user to look at. */
  interrupt(ownerKey: string, stopped: boolean): void {
    if (stopped) this.paused.add(ownerKey);
    else this.paused.delete(ownerKey);
    this.options.onChange();
  }

  /** Called by the tools only once the user allowed a host outside this computer. */
  private allow(owner: BrowserOwner, url: string): void {
    const parsed = new URL(url);
    if (isLocalUrl(parsed)) return;
    const hosts = this.approvedHosts.get(owner.key) ?? new Set<string>();
    hosts.add(parsed.host);
    this.approvedHosts.set(owner.key, hosts);
  }

  /** Where a page may take itself: http(s) only, and an agent's tab stays on approved hosts. */
  private mayVisit(owner: BrowserOwner, url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (owner.key === USER_OWNER.key || isLocalUrl(parsed)) return true;
    return this.approvedHosts.get(owner.key)?.has(parsed.host) ?? false;
  }

  async open(
    owner: BrowserOwner,
    url: string,
    device: BrowserDevice = 'desktop',
  ): Promise<BrowserTabInfo> {
    const target = parseWebUrl(url).href;
    if (owner.key !== USER_OWNER.key && this.paused.has(owner.key)) this.tab(owner, undefined);
    const live = [...this.tabs.values()].filter((tab) => !tab.window.isDestroyed());
    if (live.length >= MAX_TABS)
      throw new HiveError('LIMIT', `O Hive Browser já tem ${MAX_TABS} abas abertas. Feche alguma.`);
    if (live.filter((tab) => tab.owner.key === owner.key).length >= MAX_TABS_PER_OWNER)
      throw new HiveError(
        'LIMIT',
        `No máximo ${MAX_TABS_PER_OWNER} abas por vez; feche uma com browser_close.`,
      );
    this.prepare();
    this.allow(owner, target);
    const size = SIZES[device];
    const window = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true,
        spellcheck: false,
      },
    });
    const tab: Tab = {
      id: newId('tab'),
      owner,
      window,
      device,
      width: size.width,
      height: size.height,
      console: [],
      network: [],
      errors: 0,
      createdAt: nowIso(),
    };
    this.tabs.set(tab.id, tab);
    this.lastTab.set(owner.key, tab.id);
    const contents = window.webContents;
    contents.setFrameRate(FRAME_RATE);
    contents.setWindowOpenHandler((details) => {
      tab.console.push(`[hive] Pop-up bloqueado: ${details.url}`);
      return { action: 'deny' };
    });
    const guard = (event: { preventDefault: () => void; url: string }) => {
      if (this.mayVisit(owner, event.url)) return;
      event.preventDefault();
      tab.console.push(
        `[hive] Navegação bloqueada para ${event.url}: fora deste computador e sem aprovação.`,
      );
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('console-message', (details) => {
      if (details.level === 'error') tab.errors++;
      tab.console.push(
        `[${details.level}] ${details.message}${details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''}`,
      );
      if (tab.console.length > MAX_LOG) tab.console.splice(0, tab.console.length - MAX_LOG);
    });
    contents.on('did-finish-load', () => this.options.onChange());
    contents.on('page-title-updated', () => this.options.onChange());
    window.on('closed', () => {
      this.tabs.delete(tab.id);
      this.options.onChange();
    });
    this.applyDevice(tab, device);
    this.options.onChange();
    await this.load(tab, target);
    return this.info(tab);
  }

  private applyDevice(
    tab: Tab,
    device: BrowserDevice,
    custom?: { width: number; height: number },
  ): void {
    const size = custom ?? SIZES[device];
    tab.device = device;
    tab.width = size.width;
    tab.height = size.height;
    tab.window.setContentSize(size.width, size.height);
    const contents = tab.window.webContents;
    // The viewport size and the user agent are what pages read to lay out for a phone or a
    // tablet. enableDeviceEmulation would also fake touch, but on an off-screen window it
    // crashes the whole app (Electron 44, found by the end-to-end test), so it is not used.
    contents.setUserAgent(
      device === 'desktop' ? session.defaultSession.getUserAgent() : MOBILE_AGENT,
    );
  }

  private async load(tab: Tab, url: string): Promise<void> {
    try {
      await withTimeout(tab.window.webContents.loadURL(url), LOAD_TIMEOUT_MS, 'Abrir a página');
    } catch (error) {
      const message = errorMessage(error);
      // A page that fails to load is still a tab to look at, with the reason in its console.
      tab.console.push(`[hive] Não carregou ${url}: ${message}`);
      throw new HiveError('NETWORK', `Não carregou ${url}: ${message}. O servidor está rodando?`);
    } finally {
      this.options.onChange();
    }
  }

  async navigate(
    owner: BrowserOwner,
    id: string | undefined,
    action: 'goto' | 'back' | 'forward' | 'reload',
    url?: string,
  ): Promise<BrowserTabInfo> {
    const tab = this.tab(owner, id);
    const history = tab.window.webContents.navigationHistory;
    if (action === 'goto') {
      const target = parseWebUrl(url ?? '').href;
      this.allow(owner, target);
      await this.load(tab, target);
    } else {
      if (action === 'back' && history.canGoBack()) history.goBack();
      else if (action === 'forward' && history.canGoForward()) history.goForward();
      else if (action === 'reload') tab.window.webContents.reload();
      await this.settle(tab);
    }
    return this.info(tab);
  }

  /** Waits for the page to finish what an action started (navigation, rendering). */
  private async settle(tab: Tab): Promise<void> {
    const contents = tab.window.webContents;
    const started = Date.now();
    await pause(150);
    while (contents.isLoading() && Date.now() - started < LOAD_TIMEOUT_MS) await pause(100);
    await pause(250);
    this.options.onChange();
  }

  private script<T>(tab: Tab, code: string): Promise<T> {
    return withTimeout(
      tab.window.webContents.executeJavaScript(code, true) as Promise<T>,
      ACTION_TIMEOUT_MS,
      'A ação no navegador',
    );
  }

  /** Finds an element by selector or visible text, scrolls it into view, gives its center. */
  private async locate(
    tab: Tab,
    target: { selector?: string; text?: string },
  ): Promise<{ x: number; y: number; label: string }> {
    const found = await this.script<{ x: number; y: number; label: string } | { error: string }>(
      tab,
      `(() => {
        const selector = ${JSON.stringify(target.selector ?? null)};
        const text = ${JSON.stringify(target.text ?? null)};
        let element = null;
        if (selector) {
          try { element = document.querySelector(selector); }
          catch { return { error: 'Seletor CSS inválido: ' + selector }; }
        } else if (text) {
          const wanted = text.trim().toLowerCase();
          const candidates = [...document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], label, summary, [onclick], li, span, div')]
            .filter((node) => node.offsetParent !== null && (node.innerText || node.value || '').trim().toLowerCase().includes(wanted));
          candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
          element = candidates[0] || null;
        }
        if (!element) return { error: 'Elemento não encontrado: ' + (selector || text) };
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return { error: 'O elemento está invisível: ' + (selector || text) };
        const label = (element.innerText || element.value || element.getAttribute('aria-label') || element.tagName).trim().slice(0, 80);
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), label };
      })()`,
    );
    if ('error' in found) throw new HiveError('NOT_FOUND', found.error);
    return found;
  }

  private mouse(tab: Tab, x: number, y: number): void {
    const contents = tab.window.webContents;
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  async click(
    owner: BrowserOwner,
    id: string | undefined,
    target: { selector?: string; text?: string; x?: number; y?: number },
  ): Promise<string> {
    const tab = this.tab(owner, id);
    const at =
      target.selector || target.text
        ? await this.locate(tab, target)
        : target.x !== undefined && target.y !== undefined
          ? {
              x: Math.round(target.x),
              y: Math.round(target.y),
              label: `(${target.x}, ${target.y})`,
            }
          : null;
    if (!at) throw new HiveError('VALIDATION', 'Diga selector, text ou x e y.');
    this.mouse(tab, at.x, at.y);
    await this.settle(tab);
    return `Clicou em “${at.label}”. Página: ${tab.window.webContents.getURL()}`;
  }

  async type(
    owner: BrowserOwner,
    id: string | undefined,
    input: { selector?: string; text: string; submit?: boolean; clear?: boolean },
  ): Promise<string> {
    const tab = this.tab(owner, id);
    const contents = tab.window.webContents;
    if (input.selector) {
      const at = await this.locate(tab, { selector: input.selector });
      this.mouse(tab, at.x, at.y);
    }
    if (input.clear)
      await this.script(
        tab,
        `(() => { const el = document.activeElement; if (el && el.select) el.select(); })()`,
      );
    contents.focus();
    contents.insertText(input.text);
    if (input.submit) {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      contents.sendInputEvent({ type: 'char', keyCode: '\r' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
    await this.settle(tab);
    return `Digitou ${input.text.length} caractere(s)${input.submit ? ' e apertou Enter' : ''}.`;
  }

  async scroll(
    owner: BrowserOwner,
    id: string | undefined,
    input: { dy: number; selector?: string },
  ): Promise<string> {
    const tab = this.tab(owner, id);
    const position = await this.script<number>(
      tab,
      `(() => {
        const target = ${JSON.stringify(input.selector ?? null)};
        const element = target ? document.querySelector(target) : null;
        (element || window).scrollBy(0, ${Number(input.dy) || 0});
        return Math.round(element ? element.scrollTop : window.scrollY);
      })()`,
    );
    this.options.onChange();
    return `Rolou para a posição ${position}.`;
  }

  async screenshot(owner: BrowserOwner, id: string | undefined): Promise<BrowserShot> {
    const tab = this.tab(owner, id);
    const shot = await this.capture(tab);
    if (owner.key !== USER_OWNER.key) this.options.onEvidence?.(owner, shot);
    return shot;
  }

  private async capture(tab: Tab): Promise<BrowserShot> {
    let image = await withTimeout(
      tab.window.webContents.capturePage(),
      ACTION_TIMEOUT_MS,
      'O print',
    );
    const size = image.getSize();
    if (size.width > MAX_SHOT_WIDTH) image = image.resize({ width: MAX_SHOT_WIDTH });
    const final = image.getSize();
    return {
      dataUrl: image.toDataURL(),
      width: final.width,
      height: final.height,
      url: tab.window.webContents.getURL(),
      title: tab.window.webContents.getTitle(),
    };
  }

  /** A screenshot for the Browser page; never counted as an agent's evidence. */
  async preview(id: string): Promise<BrowserShot | null> {
    const tab = this.tabs.get(id);
    if (!tab || tab.window.isDestroyed()) return null;
    return this.capture(tab);
  }

  async inspect(owner: BrowserOwner, id: string | undefined, selector?: string): Promise<string> {
    const tab = this.tab(owner, id);
    return this.script<string>(
      tab,
      `(() => {
        const root = ${JSON.stringify(selector ?? null)} ? document.querySelector(${JSON.stringify(selector ?? '')}) : document.body;
        if (!root) return 'Elemento não encontrado.';
        const visible = (el) => el.offsetParent !== null || el === document.body;
        const pick = (el) => {
          if (el.id) return '#' + CSS.escape(el.id);
          const test = el.getAttribute('data-testid');
          if (test) return '[data-testid="' + test + '"]';
          const name = el.getAttribute('name');
          if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
          const aria = el.getAttribute('aria-label');
          if (aria) return el.tagName.toLowerCase() + '[aria-label="' + aria + '"]';
          return null;
        };
        const lines = ['Título: ' + document.title, 'URL: ' + location.href];
        const headings = [...root.querySelectorAll('h1, h2, h3')].filter(visible).slice(0, 20)
          .map((h) => h.tagName + ': ' + h.innerText.trim().slice(0, 100));
        if (headings.length) lines.push('', 'Títulos:', ...headings);
        const controls = [...root.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=tab], [role=checkbox], summary')]
          .filter(visible).slice(0, 80).map((el) => {
            const label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
            const type = el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '');
            const selector = pick(el);
            return '- ' + type + (label ? ' "' + label + '"' : '') + (selector ? '  →  ' + selector : '') + (el.disabled ? ' (desativado)' : '');
          });
        if (controls.length) lines.push('', 'Elementos interativos:', ...controls);
        lines.push('', 'Texto visível:', (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000));
        return lines.join('\\n');
      })()`,
    );
  }

  async console(owner: BrowserOwner, id: string | undefined): Promise<string[]> {
    return this.tab(owner, id).console.slice(-120);
  }

  async network(
    owner: BrowserOwner,
    id: string | undefined,
    failedOnly: boolean,
  ): Promise<string[]> {
    return this.tab(owner, id)
      .network.filter((entry) => !failedOnly || entry.failed)
      .slice(-80)
      .map((entry) => entry.line);
  }

  async evaluate(owner: BrowserOwner, id: string | undefined, expression: string): Promise<string> {
    const tab = this.tab(owner, id);
    if (!expression.trim()) throw new HiveError('VALIDATION', 'Diga a expressão.');
    const result = await this.script<string>(
      tab,
      `(async () => {
        try {
          const value = await (${expression});
          return JSON.stringify(value === undefined ? null : value, null, 2) ?? 'null';
        } catch (error) {
          return 'Erro: ' + (error && error.message ? error.message : String(error));
        }
      })()`,
    );
    return String(result).slice(0, 8_000);
  }

  async wait(
    owner: BrowserOwner,
    id: string | undefined,
    input: { selector?: string; text?: string; timeoutMs: number },
  ): Promise<string> {
    const tab = this.tab(owner, id);
    if (!input.selector && !input.text) {
      await pause(Math.min(input.timeoutMs, 30_000));
      return `Esperou ${Math.round(input.timeoutMs / 1000)} s.`;
    }
    const started = Date.now();
    while (Date.now() - started < input.timeoutMs) {
      const found = await this.script<boolean>(
        tab,
        `(() => {
          const selector = ${JSON.stringify(input.selector ?? null)};
          const text = ${JSON.stringify(input.text ?? null)};
          if (selector) { try { if (document.querySelector(selector)) return true; } catch { return false; } }
          if (text && document.body && document.body.innerText.includes(text)) return true;
          return false;
        })()`,
      ).catch(() => false);
      if (found) return `Apareceu depois de ${Date.now() - started} ms.`;
      await pause(250);
    }
    throw new HiveError(
      'TIMEOUT',
      `Não apareceu em ${Math.round(input.timeoutMs / 1000)} s: ${input.selector ?? input.text}`,
    );
  }

  async resize(
    owner: BrowserOwner,
    id: string | undefined,
    input: { device?: BrowserDevice; width?: number; height?: number },
  ): Promise<BrowserTabInfo> {
    const tab = this.tab(owner, id);
    const device = input.device ?? tab.device;
    const custom =
      input.width && input.height
        ? {
            width: Math.min(1920, Math.max(320, Math.round(input.width))),
            height: Math.min(1600, Math.max(320, Math.round(input.height))),
          }
        : undefined;
    this.applyDevice(tab, device, custom);
    // A new user agent only applies to a load; a reload makes the page see the device.
    tab.window.webContents.reload();
    await this.settle(tab);
    return this.info(tab);
  }

  async close(owner: BrowserOwner, id?: string): Promise<void> {
    const tab = this.tab(owner, id);
    tab.window.destroy();
    this.tabs.delete(tab.id);
    this.options.onChange();
  }

  async closeOwner(key: string): Promise<void> {
    for (const tab of [...this.tabs.values()])
      if (tab.owner.key === key) {
        if (!tab.window.isDestroyed()) tab.window.destroy();
        this.tabs.delete(tab.id);
      }
    this.paused.delete(key);
    this.approvedHosts.delete(key);
    this.lastTab.delete(key);
    this.options.onChange();
  }

  dispose(): void {
    for (const tab of this.tabs.values()) if (!tab.window.isDestroyed()) tab.window.destroy();
    this.tabs.clear();
  }
}
