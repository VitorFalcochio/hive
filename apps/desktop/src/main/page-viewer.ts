import { BrowserWindow, session } from 'electron';
import { isLocalUrl, type PageView, type PageViewer } from '@hive/agents';
import { HiveError, errorMessage } from '@hive/shared';

const LOAD_TIMEOUT_MS = 30_000;
/** Time for client-side rendering and late requests after the load event. */
const SETTLE_MS = 1_200;
const MAX_CONSOLE_LINES = 30;
/** Each screenshot is resent with the conversation, so wide ones are scaled down. */
const MAX_IMAGE_WIDTH = 1280;
const PARTITION = 'hive-agent-view';

/** Console lines of each open page by webContents id; one listener serves the whole session. */
const logs = new Map<number, string[]>();
let listening = false;

function watchRequests(): void {
  if (listening) return;
  listening = true;
  session.fromPartition(PARTITION).webRequest.onCompleted((details) => {
    const log = details.webContentsId === undefined ? null : logs.get(details.webContentsId);
    if (log && details.statusCode >= 400 && details.resourceType !== 'mainFrame')
      log.push(`HTTP ${details.statusCode} for ${details.url}`);
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new HiveError('CANCELLED', 'Cancelled.'));
      },
      { once: true },
    );
  });
}

/**
 * Opens a local page in a hidden window that has no access to Hive (own session, sandboxed,
 * no preload), screenshots it and collects what it logged. The page may not navigate away from
 * this computer or open other windows.
 */
export const viewLocalPage: PageViewer = async ({ url, width, height, signal }) => {
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  const { webContents } = window;
  const console: string[] = [];
  const contentsId = webContents.id;
  logs.set(contentsId, console);
  watchRequests();
  let status: number | null = null;
  webContents.on('console-message', (event) => {
    if (event.level !== 'error' && event.level !== 'warning') return;
    // Electron's own advice to app developers, logged into every page while unpackaged.
    if (event.message.includes('Electron Security Warning')) return;
    const where = event.sourceId
      ? ` (${event.sourceId.replace(/^https?:\/\/[^/]+/, '')}:${event.lineNumber})`
      : '';
    console.push(`${event.level}: ${event.message.slice(0, 500)}${where}`);
  });
  webContents.on('did-navigate', (_event, _url, code) => {
    status = code || null;
  });
  webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame && code !== -3) console.push(`failed to load ${failedUrl}: ${description}`);
  });
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, target) => {
    if (!isLocalUrl(new URL(target))) event.preventDefault();
  });
  const stop = () => window.destroy();
  signal.addEventListener('abort', stop, { once: true });
  try {
    try {
      await Promise.race([
        window.loadURL(url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the page took over 30 s to load')), LOAD_TIMEOUT_MS),
        ),
      ]);
    } catch (error) {
      if (signal.aborted) throw new HiveError('CANCELLED', 'Cancelled.');
      const reason = errorMessage(error);
      throw new HiveError(
        'VALIDATION',
        `Could not open ${url}: ${reason}.${/REFUSED/.test(reason) ? ' Is the dev server running? Start it with run_command first.' : ''}`,
      );
    }
    await wait(SETTLE_MS, signal);
    let image = await webContents.capturePage();
    if (image.isEmpty()) throw new HiveError('INTERNAL', 'The page rendered nothing to capture.');
    if (image.getSize().width > MAX_IMAGE_WIDTH)
      image = image.resize({ width: MAX_IMAGE_WIDTH, quality: 'good' });
    const view: PageView = {
      title: webContents.getTitle(),
      dataUrl: image.toDataURL(),
      status,
      console: console.slice(-MAX_CONSOLE_LINES),
    };
    return view;
  } finally {
    logs.delete(contentsId);
    signal.removeEventListener('abort', stop);
    if (!window.isDestroyed()) window.destroy();
  }
};
