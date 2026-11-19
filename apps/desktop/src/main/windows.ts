import { BrowserWindow, dialog, screen, type WebContents } from 'electron';
import path from 'node:path';
import { PUSH_CHANNEL, type HivePush } from '@hive/core';
import { parsePlacement, restoreBounds, type WindowPlacement } from './window-bounds';
import { boundForIpc } from './ipc-guard';
import { log } from './logger';

/** The windows that talk to the main process. Hidden helper windows (view_page) are not one. */
export type WindowRole = 'main' | 'canvas';

export interface WindowManagerOptions {
  /** Folder of the built main script; preload and renderer sit next to it. */
  directory: string;
  icon: string;
  loadValue: (key: string) => string | null;
  saveValue: (key: string, value: string) => void;
  /** Which pushes the canvas window gets; the main window gets them all. */
  canvasReceives: (push: HivePush) => boolean;
}

const CANVAS_STATE = 'canvasWindow';
const CANVAS_MINIMUM = { width: 860, height: 560 };
const BACKGROUND = '#08090a';

/**
 * Keeps track of Hive's windows by role instead of by creation order, so a second window (the
 * Nexus) or a hidden helper never gets mistaken for the main one.
 */
export class WindowManager {
  private main: BrowserWindow | null = null;
  private canvas: BrowserWindow | null = null;

  constructor(private readonly options: WindowManagerOptions) {}

  /** Options every Hive window shares: isolated, sandboxed, no Node in the page. */
  webPreferences(): Electron.WebPreferences {
    return {
      preload: path.join(this.options.directory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    };
  }

  /** The renderer draws its own title bar; Windows/Linux keep native controls on top of it. */
  titleBar(height = 38): Electron.BrowserWindowConstructorOptions {
    return {
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: 12 } }
        : { titleBarOverlay: { color: BACKGROUND, symbolColor: '#8a8f98', height } }),
    };
  }

  /** Loads one of the renderer's pages from the dev server or from the packaged files. */
  async load(window: BrowserWindow, page: 'index' | 'canvas'): Promise<void> {
    const devServer = process.env.ELECTRON_RENDERER_URL;
    if (devServer) await window.loadURL(page === 'index' ? devServer : `${devServer}/${page}.html`);
    else await window.loadFile(path.join(this.options.directory, `../renderer/${page}.html`));
  }

  /** No pop-ups and no navigating away from Hive's own page. */
  private lockDown(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    this.watch(window);
  }

  /**
   * A window that stops answering, crashes or logs an error leaves a trace in the log, and a
   * frozen one can be reloaded from a dialog instead of having to kill Hive from the Task
   * Manager. Reloading only restarts the page; missions run in the main process and go on.
   */
  private watch(window: BrowserWindow): void {
    const name = () => (window.isDestroyed() ? 'janela' : window.getTitle() || 'janela');
    let asking = false;
    window.webContents.on('console-message', (details) => {
      if (details.level !== 'error') return;
      log(
        'error',
        'renderer',
        `${name()}: ${details.message} (${details.sourceId}:${details.lineNumber})`,
      );
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      log(
        'error',
        'renderer',
        `${name()}: processo da interface terminou (${details.reason}, código ${details.exitCode}).`,
      );
      if (window.isDestroyed() || details.reason === 'clean-exit') return;
      void dialog
        .showMessageBox(window, {
          type: 'error',
          buttons: ['Recarregar a interface', 'Fechar'],
          defaultId: 0,
          title: 'A interface do Hive parou',
          message: 'A interface do Hive parou de funcionar.',
          detail: `Motivo: ${details.reason}. As missões continuam no processo principal. Detalhes ficam no log (pasta logs dos dados do Hive).`,
        })
        .then(({ response }) => {
          if (window.isDestroyed()) return;
          if (response === 0) window.webContents.reload();
          else window.close();
        });
    });
    window.on('unresponsive', () => {
      log('warn', 'renderer', `${name()}: a interface não responde.`);
      if (asking || window.isDestroyed()) return;
      asking = true;
      void dialog
        .showMessageBox({
          type: 'warning',
          buttons: ['Esperar', 'Recarregar a interface'],
          defaultId: 0,
          cancelId: 0,
          title: 'O Hive não responde',
          message: 'A interface do Hive não está respondendo.',
          detail:
            'As missões continuam no processo principal. Recarregar reinicia só a tela; nada é perdido além de texto ainda não salvo.',
        })
        .then(({ response }) => {
          asking = false;
          if (response === 1 && !window.isDestroyed()) {
            log('warn', 'renderer', `${name()}: recarregada pelo usuário.`);
            window.webContents.forcefullyCrashRenderer();
            window.webContents.reload();
          }
        });
    });
    window.on('responsive', () => log('info', 'renderer', `${name()}: voltou a responder.`));
  }

  registerMain(window: BrowserWindow): void {
    this.main = window;
    this.lockDown(window);
    window.on('closed', () => {
      if (this.main === window) this.main = null;
      // The canvas only looks at what the main window runs; it does not keep Hive open alone.
      this.canvas?.close();
    });
  }

  mainWindow(): BrowserWindow | null {
    return this.main && !this.main.isDestroyed() ? this.main : null;
  }

  canvasWindow(): BrowserWindow | null {
    return this.canvas && !this.canvas.isDestroyed() ? this.canvas : null;
  }

  roleOf(contents: WebContents): WindowRole | null {
    if (this.mainWindow()?.webContents === contents) return 'main';
    if (this.canvasWindow()?.webContents === contents) return 'canvas';
    return null;
  }

  /** Pushes reach every Hive window; `navigate` is meant for the main one only. */
  broadcast(input: HivePush): void {
    const { value: push, clipped } = boundForIpc(input);
    if (clipped)
      log('warn', 'ipc', `Aviso ${input.kind}: ${clipped} texto(s) grande(s) demais cortado(s).`);
    this.mainWindow()?.webContents.send(PUSH_CHANNEL, push);
    const canvas = this.canvasWindow();
    if (canvas && push.kind !== 'navigate' && this.options.canvasReceives(push))
      canvas.webContents.send(PUSH_CHANNEL, push);
  }

  /** Opens the Nexus, or brings the one already open to the front. */
  openCanvas(): BrowserWindow {
    const existing = this.canvasWindow();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const placement = parsePlacement(this.options.loadValue(CANVAS_STATE));
    const bounds = placement
      ? restoreBounds(
          placement.bounds,
          screen.getAllDisplays().map((display) => display.workArea),
          CANVAS_MINIMUM,
        )
      : null;
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      ...bounds,
      minWidth: CANVAS_MINIMUM.width,
      minHeight: CANVAS_MINIMUM.height,
      title: 'Hive · Workspace',
      icon: this.options.icon,
      backgroundColor: BACKGROUND,
      ...this.titleBar(38),
      show: false,
      webPreferences: this.webPreferences(),
    });
    this.canvas = window;
    window.removeMenu();
    this.lockDown(window);
    if (bounds && placement?.maximized) window.maximize();

    // Bounds are saved shortly after the user stops moving or resizing, and once more on close.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = undefined;
      if (window.isDestroyed()) return;
      const state: WindowPlacement = {
        bounds: window.getNormalBounds(),
        maximized: window.isMaximized(),
      };
      this.options.saveValue(CANVAS_STATE, JSON.stringify(state));
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 400);
    };
    window.on('resize', later);
    window.on('move', later);
    window.on('maximize', later);
    window.on('unmaximize', later);
    window.on('close', save);
    window.on('closed', () => {
      clearTimeout(timer);
      if (this.canvas === window) this.canvas = null;
    });
    window.once('ready-to-show', () => window.show());
    void this.load(window, 'canvas').catch((error: unknown) =>
      console.error('Não foi possível abrir o Workspace:', error),
    );
    return window;
  }
}
