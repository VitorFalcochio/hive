import { app } from 'electron';
import type { UpdateState } from '@hive/core';
import { errorMessage } from '@hive/shared';

type AutoUpdater = (typeof import('electron-updater'))['autoUpdater'];

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Keeps the installed Hive up to date from GitHub Releases (see electron-builder.yml).
 * A new version downloads in the background and installs when Hive quits, or right away
 * when the user asks. Development runs and the portable build have no installer to update.
 */
export class Updater {
  private updater: AutoUpdater | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private firstCheck: ReturnType<typeof setTimeout> | undefined;
  private current: UpdateState;
  onReady?: (version: string) => void;

  constructor(private readonly publish: (state: UpdateState) => void) {
    this.current = !app.isPackaged
      ? { status: 'disabled', reason: 'dev' }
      : process.env.PORTABLE_EXECUTABLE_DIR
        ? { status: 'disabled', reason: 'portable' }
        : { status: 'idle' };
  }

  get state(): UpdateState {
    return this.current;
  }

  private set(state: UpdateState) {
    this.current = state;
    this.publish(state);
  }

  private get enabled() {
    return this.current.status !== 'disabled';
  }

  /** Loaded only in the installed app: development and tests never touch electron-updater. */
  private async load(): Promise<AutoUpdater> {
    if (this.updater) return this.updater;
    // A CommonJS package: depending on how the bundle loads it, the API is on `default`.
    const loaded = (await import('electron-updater')) as typeof import('electron-updater') & {
      default?: typeof import('electron-updater');
    };
    const autoUpdater = loaded.default?.autoUpdater ?? loaded.autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () =>
      this.set({ status: 'none', checkedAt: new Date().toISOString() }),
    );
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version, percent: 0 }),
    );
    autoUpdater.on('download-progress', (progress) => {
      const version = this.current.status === 'downloading' ? this.current.version : '';
      this.set({ status: 'downloading', version, percent: Math.round(progress.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version });
      this.onReady?.(info.version);
    });
    autoUpdater.on('error', (error) => this.set({ status: 'error', message: errorMessage(error) }));
    this.updater = autoUpdater;
    return autoUpdater;
  }

  /** Turns the periodic check on or off; a manual check works either way. */
  setAutomatic(automatic: boolean): void {
    clearTimeout(this.firstCheck);
    clearInterval(this.timer);
    this.firstCheck = this.timer = undefined;
    if (!automatic || !this.enabled) return;
    this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  async check(): Promise<UpdateState> {
    // A finished download stays ready; checking again would only fetch it twice.
    if (!this.enabled || this.current.status === 'ready') return this.current;
    if (this.current.status === 'checking' || this.current.status === 'downloading')
      return this.current;
    try {
      await (await this.load()).checkForUpdates();
    } catch (error) {
      this.set({ status: 'error', message: errorMessage(error) });
    }
    return this.current;
  }

  install(): void {
    if (this.current.status !== 'ready' || !this.updater) return;
    // Silent install, then Hive opens again in the new version.
    this.updater.quitAndInstall(true, true);
  }

  dispose(): void {
    clearTimeout(this.firstCheck);
    clearInterval(this.timer);
  }
}
