import { app, BrowserWindow, dialog, ipcMain } from 'electron';
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
import { errorMessage, secretRedactor } from '@hive/shared';
import { DesktopService } from './service';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.HIVE_DATA_DIR || app.getPath('userData'));
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'session'));
let database: HiveDatabase | undefined;

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
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(directory, '../renderer/index.html'));
}

app
  .whenReady()
  .then(async () => {
    await mkdir(dataDir, { recursive: true });
    database = new HiveDatabase(path.join(dataDir, 'hive.sqlite'));
    const service = new DesktopService(database, dataDir, (push) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send(PUSH_CHANNEL, push);
    });
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
            error: { code: 'INTERNAL', message: secretRedactor.redact(errorMessage(error)) },
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
app.on('will-quit', () => database?.close());
