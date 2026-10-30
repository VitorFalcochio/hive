import type { Grouping } from './model';

/**
 * Window preferences of the Nexus, kept on this machine. Storage may be unavailable (or
 * cleared); every read falls back to the defaults, so the canvas never depends on it. Where
 * things sit on the canvas is not here: that is the run's layout, kept by the main process.
 */
export interface CanvasPrefs {
  runId: string | null;
  grouping: Grouping;
  consoleOpen: boolean;
  consoleTab: ConsoleTab;
  consoleHeight: number;
  inspectorOpen: boolean;
}

export type ConsoleTab = 'logs' | 'terminal' | 'files' | 'tests' | 'events';

const KEY = 'hive.canvas.prefs';
const groupings: Grouping[] = ['workspace', 'agent', 'none'];

export const defaultPrefs: CanvasPrefs = {
  runId: null,
  grouping: 'workspace',
  consoleOpen: false,
  consoleTab: 'logs',
  consoleHeight: 240,
  inspectorOpen: true,
};

export function loadPrefs(): CanvasPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CanvasPrefs>;
    const prefs = { ...defaultPrefs, ...stored };
    return groupings.includes(prefs.grouping) ? prefs : { ...prefs, grouping: 'workspace' };
  } catch {
    return defaultPrefs;
  }
}

export function savePrefs(prefs: CanvasPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Only a convenience: the next window opens with the defaults.
  }
}
