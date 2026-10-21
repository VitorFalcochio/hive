import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
} from 'electron';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INVOKE_CHANNEL,
  PUSH_CHANNEL,
  ipcContract,
  type IpcChannel,
  type IpcResult,
} from '@hive/core';
import { HiveDatabase } from '@hive/persistence';
import { HiveError, errorMessage, secretRedactor } from '@hive/shared';
import { DesktopService } from './service';
import { attachDesignInspector } from './design-inspector';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.HIVE_DATA_DIR || app.getPath('userData'));
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'session'));
let database: HiveDatabase | undefined;
let desktopService: DesktopService | undefined;
let tray: Tray | undefined;
let quitting = false;
let awakeBlocker: number | null = null;
let hiddenNoticeShown = false;

// A 32 px amber hexagon, embedded so the tray needs no file next to the bundle.
const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA3ElEQVR4nO2XzQ3DIAyFGaEjZJQcPEhHYYOMkpPPHSEjMAInzq0qgVRZBkqBPFXK4Z3y40/ye8aYwGSQghbvBVgC0yNqORPgFpi2wPQU2uKzqQD3wOSV4kk+vjMcYA1MR6Gw1BG/6QZ493ZvKCy11/xR6rPtKCxlc/7I9dkNLJ7kNH9oAC0/9RVTahoGkGKXi+U0gNzgSYNpGoD7MlprxUM/A9iGAVNK0AVwAfwvADyG8EEkBRvFn5pyGMGPY4NeSKSxICuZFi3IUqr5A7KWS3/ALibSH5Cr2VDBAV7lkEk8CCI28wAAAABJRU5ErkJggg==';

const shiftLabels: Partial<Record<string, string>> = {
  review: 'pronta para revisão',
  completed: 'concluída',
  failed: 'falhou',
  cancelled: 'cancelada',
};

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

function showWindow() {
  const window = mainWindow();
  if (!window) return void createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title,
    body,
    icon: nativeImage.createFromDataURL(TRAY_ICON),
  });
  notification.on('click', showWindow);
  notification.show();
}

/**
 * Tray, sleep blocker and tooltip follow the shift. The tray also stays while the window is
 * hidden, so a paused shift never leaves Hive running with no way back to it.
 */
function syncShift() {
  const service = desktopService;
  if (!service) return;
  const settings = service.repos.getSettings().autopilot;
  const queued = settings.enabled ? service.autopilot.queue().length : 0;
  if (queued && settings.keepAwake) {
    awakeBlocker ??= powerSaveBlocker.start('prevent-app-suspension');
  } else if (awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
  const hidden = !mainWindow()?.isVisible();
  if (!settings.enabled && !hidden) {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
    tray.on('click', showWindow);
  }
  tray.setToolTip(
    settings.enabled
      ? `Hive · Modo Turno: ${queued} missão(ões) na fila`
      : 'Hive · Modo Turno pausado',
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir o Hive', click: showWindow },
      {
        label: settings.enabled ? 'Pausar o Modo Turno' : 'Retomar o Modo Turno',
        click: () => void service.invoke('autopilot.setEnabled', !settings.enabled),
      },
      { type: 'separator' },
      {
        label: 'Sair do Hive',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 650,
    title: 'Hive',
    backgroundColor: '#08090a',
    // The renderer draws its own title bar; Windows/Linux keep native controls on top of it.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: '#08090a', symbolColor: '#8a8f98', height: 38 } }),
    show: false,
    webPreferences: {
      preload: path.join(directory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  attachDesignInspector(window.webContents);
  // The renderer blocks unload while the editor has unsaved files; let the user decide.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Sair sem salvar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Alterações não salvas',
      message: 'Há arquivos com alterações não salvas no editor.',
      detail: 'Se sair agora, essas alterações serão perdidas.',
    });
    if (choice === 0) event.preventDefault();
  });
  // With the shift on, closing the window only hides it; the tray brings it back or quits.
  window.on('close', (event) => {
    const settings = desktopService?.repos.getSettings().autopilot;
    if (quitting || !settings?.enabled || !settings.runInBackground) return;
    event.preventDefault();
    window.hide();
    syncShift();
    if (!hiddenNoticeShown) {
      hiddenNoticeShown = true;
      notify(
        'O Hive continua trabalhando',
        'O Modo Turno segue na bandeja do Windows. Clique no ícone para abrir ou sair.',
      );
    }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(directory, '../renderer/index.html'));
}

// One Hive per data folder: a second launch (e.g. while it runs in the tray) focuses the first.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', showWindow);
// Windows shows notifications only for an app with an identity.
if (process.platform === 'win32')
  app.setAppUserModelId(app.isPackaged ? 'com.hive.desktop' : process.execPath);

app
  .whenReady()
  .then(async () => {
    if (!primaryInstance) return;
    await mkdir(dataDir, { recursive: true });
    database = new HiveDatabase(path.join(dataDir, 'hive.sqlite'));
    const service = new DesktopService(database, dataDir, (push) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send(PUSH_CHANNEL, push);
      if (push.kind === 'changed' && ['autopilot', 'settings', 'run'].includes(push.entity))
        syncShift();
    });
    service.onShiftFinished = (item) =>
      notify(
        `Missão ${shiftLabels[item.status] ?? item.status}`,
        item.error ? `${item.missionTitle}: ${item.error}` : item.missionTitle,
      );
    // Design Mode notes keep a small picture of the element; wide ones are scaled down.
    service.capturePage = async (rect) => {
      const window = mainWindow();
      if (!window) return null;
      const image = await window.webContents.capturePage({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      if (image.isEmpty()) return null;
      const { width } = image.getSize();
      return (width > 480 ? image.resize({ width: 480, quality: 'good' }) : image).toDataURL();
    };
    desktopService = service;
    syncShift();
    ipcMain.handle(
      INVOKE_CHANNEL,
      async (event, channel: string, input: unknown): Promise<IpcResult<unknown>> => {
        try {
          const owner = BrowserWindow.fromWebContents(event.sender);
          if (!owner || event.senderFrame !== event.sender.mainFrame)
            throw new Error('Origem IPC inválida.');
          if (!Object.hasOwn(ipcContract, channel)) throw new Error('Canal IPC desconhecido.');
          const known = channel as IpcChannel;
          const valid = ipcContract[known].input.parse(input);
          return { ok: true, value: await service.invoke(known, valid) };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: error instanceof HiveError ? error.code : 'INTERNAL',
              message: secretRedactor.redact(errorMessage(error)),
            },
          };
        }
      },
    );
    await createWindow();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) void createWindow();
    });
  })
  .catch((error) => {
    console.error(error);
    dialog.showErrorBox('Não foi possível iniciar o Hive', errorMessage(error));
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => {
  if (awakeBlocker !== null) powerSaveBlocker.stop(awakeBlocker);
  tray?.destroy();
  desktopService?.dispose();
  database?.close();
});
