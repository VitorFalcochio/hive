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
  canvasChannels,
  ipcContract,
  type IpcChannel,
  type IpcResult,
} from '@hive/core';
import { HiveDatabase } from '@hive/persistence';
import { HiveError, errorMessage, secretRedactor } from '@hive/shared';
import { DesktopService } from './service';
import { attachDesignInspector } from './design-inspector';
import { viewLocalPage } from './page-viewer';
import { WindowManager } from './windows';
import { applyPendingRestore, backupName, backupsDir, createBackup } from './backup';
import { boundForIpc } from './ipc-guard';
import { log, logFile, startLog } from './logger';
import { describeOversized, findOversized, repairOversized } from './oversized';
import { Updater } from './updater';
import appIcon from '../../resources/icon.png?asset';
import trayIcon from '../../resources/tray.png?asset';
import trayIcon2x from '../../resources/tray@2x.png?asset';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.HIVE_DATA_DIR || app.getPath('userData'));
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'session'));
try {
  startLog(dataDir);
} catch (error) {
  console.error('Não foi possível abrir o log do Hive:', error);
}
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit')
    log(
      'error',
      'electron',
      `Processo ${details.type} terminou: ${details.reason} (código ${details.exitCode}).`,
    );
});

/**
 * Records big enough to freeze the app (see oversized.ts) are reported before anything loads
 * them, and shrunk only after a backup and the user's yes. Saying no still opens Hive: every
 * text sent to a window is bounded anyway, the screens just stay slower on those records.
 */
/** False when the user chose to quit. */
async function checkOversized(current: HiveDatabase): Promise<boolean> {
  const records = findOversized(current);
  if (!records.length) return true;
  const summary = describeOversized(records);
  log(
    'warn',
    'dados',
    `Registros grandes demais encontrados.
${summary}`,
  );
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Fazer backup e reduzir', 'Abrir sem reduzir', 'Sair'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Hive · dados grandes demais',
    message: 'Alguns registros do Hive estão grandes demais e podem travar a interface.',
    detail: `${summary}

Costumam ser saídas de comandos guardadas por inteiro numa falha. “Fazer backup e reduzir” guarda uma cópia completa em Backups e encurta só esses textos, mantendo o começo e o fim. Nada mais muda.

“Abrir sem reduzir” mantém esses textos, e as telas os mostram cortados. O relatório e o resumo das execuções continuam sendo recalculados pelo Hive como sempre, já no tamanho limitado.`,
  });
  if (response === 2) {
    log('info', 'dados', 'O usuário saiu sem alterar os registros.');
    return false;
  }
  if (response === 1) {
    log('info', 'dados', 'O usuário abriu o Hive sem reduzir os registros.');
    return true;
  }
  const target = path.join(backupsDir(dataDir), backupName('manual'));
  await createBackup(current, dataDir, target, app.getVersion());
  log('info', 'dados', `Backup criado antes da redução: ${target}`);
  repairOversized(current, records);
  log('info', 'dados', `${records.length} registro(s) reduzido(s).`);
  return true;
}
let database: HiveDatabase | undefined;
let desktopService: DesktopService | undefined;
let tray: Tray | undefined;
let quitting = false;
let awakeBlocker: number | null = null;
let hiddenNoticeShown = false;
const windows = new WindowManager({
  directory,
  icon: appIcon,
  loadValue: (key) => desktopService?.repos.getValue(key) ?? null,
  // The canvas sees the output of its own terminals only, and no file-watch noise.
  canvasReceives: (push) =>
    push.kind === 'files' || push.kind === 'update' || push.kind === 'agentChat'
      ? false
      : push.kind === 'terminal'
        ? !!desktopService?.isCanvasTerminal(
            push.event.type === 'output' ? push.event.sessionId : push.event.session.id,
          )
        : true,
  saveValue: (key, value) => desktopService?.repos.setValue(key, value),
});

const shiftLabels: Partial<Record<string, string>> = {
  review: 'pronta para revisão',
  completed: 'concluída',
  failed: 'falhou',
  cancelled: 'cancelada',
};

function mainWindow(): BrowserWindow | null {
  return windows.mainWindow();
}

function showWindow() {
  const window = mainWindow();
  if (!window) return void createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** The tray hexagon, with a sharper copy for high-DPI screens. */
function trayImage() {
  const image = nativeImage.createFromPath(trayIcon);
  image.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(trayIcon2x).toPNG(),
  });
  return image;
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title,
    body,
    icon: appIcon,
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
    tray = new Tray(trayImage());
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
    icon: appIcon,
    backgroundColor: '#08090a',
    ...windows.titleBar(),
    show: false,
    webPreferences: windows.webPreferences(),
  });
  windows.registerMain(window);
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
  await windows.load(window, 'index');
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
    // A restore staged before the restart replaces the data now, before anything opens it.
    const restored = await applyPendingRestore(dataDir, async (target) => {
      const current = new HiveDatabase(path.join(dataDir, 'hive.sqlite'));
      try {
        await createBackup(current, dataDir, target, app.getVersion());
      } finally {
        current.close();
      }
    }).catch((error: unknown) => {
      dialog.showErrorBox(
        'Não foi possível restaurar o backup',
        `${errorMessage(error)}\n\nO Hive abre com os dados de antes.`,
      );
      return false;
    });
    database = new HiveDatabase(path.join(dataDir, 'hive.sqlite'));
    const proceed = await checkOversized(database).catch((error: unknown) => {
      log('error', 'dados', 'Verificação de registros grandes falhou:', error);
      dialog.showErrorBox(
        'Não foi possível reduzir os registros',
        `${errorMessage(error)}

O Hive abre com os dados como estavam. Detalhes no log: ${logFile() ?? 'indisponível'}`,
      );
      return true;
    });
    if (!proceed) {
      quitting = true;
      app.quit();
      return;
    }
    const service = new DesktopService(database, dataDir, (push) => {
      windows.broadcast(push);
      if (push.kind === 'changed' && ['autopilot', 'settings', 'run'].includes(push.entity))
        syncShift();
    });
    service.onShiftFinished = (item) =>
      notify(
        `Missão ${shiftLabels[item.status] ?? item.status}`,
        item.error ? `${item.missionTitle}: ${item.error}` : item.missionTitle,
      );
    // Design Mode notes keep a small picture of the element; wide ones are scaled down.
    service.viewPage = viewLocalPage;
    service.openCanvas = () => void windows.openCanvas();
    service.showRun = (runId) => {
      showWindow();
      windows.broadcast({ kind: 'navigate', runId });
    };
    service.addProvider = () => {
      showWindow();
      windows.broadcast({ kind: 'navigate', page: 'add-provider' });
    };
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
    const updater = new Updater((state) => windows.broadcast({ kind: 'update', state }));
    updater.onReady = (version) =>
      notify(
        `Hive ${version} pronto para instalar`,
        'A atualização entra quando você fechar o Hive. Para instalar agora, use Configurações → Atualizações.',
      );
    service.updater = updater;
    service.restart = () => {
      quitting = true;
      app.relaunch();
      app.quit();
    };
    updater.setAutomatic(service.repos.getSettings().updates.auto);
    service.startAutoBackups();
    desktopService = service;
    await service
      .installBuiltinSkills()
      .catch((error: unknown) => console.error('Skills de fábrica indisponíveis:', error));
    // Without them the terminals still work, only `agents` and `hive` are missing.
    await service
      .enableTerminalCommands()
      .catch((error: unknown) => console.error('Comandos do terminal indisponíveis:', error));
    syncShift();
    ipcMain.handle(
      INVOKE_CHANNEL,
      async (event, channel: string, input: unknown): Promise<IpcResult<unknown>> => {
        try {
          const role = windows.roleOf(event.sender);
          if (!role || event.senderFrame !== event.sender.mainFrame)
            throw new Error('Origem IPC inválida.');
          if (!Object.hasOwn(ipcContract, channel)) throw new Error('Canal IPC desconhecido.');
          const known = channel as IpcChannel;
          // The canvas window reads runs and uses the scheduler's own guarded actions, no more.
          if (role === 'canvas' && !canvasChannels.has(known))
            throw new Error('Canal IPC não permitido nesta janela.');
          const valid = ipcContract[known].input.parse(input);
          if (role === 'canvas' && known.startsWith('terminal.')) {
            const target = typeof valid === 'string' ? valid : (valid as { id: string }).id;
            if (!service.isCanvasTerminal(target))
              throw new Error('Este terminal não foi aberto pelo Workspace.');
          }
          const result = boundForIpc(await service.invoke(known, valid));
          if (result.clipped)
            log('warn', 'ipc', `${known}: ${result.clipped} texto(s) grande(s) demais cortado(s).`);
          return { ok: true, value: result.value };
        } catch (error) {
          // Expected refusals (validation, conflicts) are the user's to read; anything else is
          // a defect and goes to the log with its stack.
          if (!(error instanceof HiveError) || error.code === 'INTERNAL')
            log('error', 'ipc', `${channel}:`, error);
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
    if (restored)
      notify(
        'Backup restaurado',
        'Os dados do backup já estão em uso. A cópia anterior ficou em Backups.',
      );
    app.on('activate', () => {
      if (!mainWindow()) void createWindow();
    });
  })
  .catch((error) => {
    log('error', 'app', 'Falha ao iniciar:', error);
    dialog.showErrorBox(
      'Não foi possível iniciar o Hive',
      `${errorMessage(error)}

Detalhes no log: ${logFile() ?? 'indisponível'}`,
    );
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => {
  log('info', 'app', 'Hive encerrando.');
  if (awakeBlocker !== null) powerSaveBlocker.stop(awakeBlocker);
  tray?.destroy();
  desktopService?.dispose();
  database?.close();
});
