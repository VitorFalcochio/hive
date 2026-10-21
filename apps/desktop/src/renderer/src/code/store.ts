import { create } from 'zustand';
import type { AiTextEdit } from './monaco';

/** A file tab edits the workspace file; diff tabs compare two versions of one file. */
export type Tab =
  | { id: string; kind: 'file'; path: string }
  | { id: string; kind: 'diff'; path: string; source: 'working' }
  | { id: string; kind: 'diff'; path: string; source: 'task'; taskId: string; taskTitle: string };

export interface Group {
  tabs: Tab[];
  active: string | null;
}

/** A reviewed AI edit waiting in the assistant panel, e.g. one requested from the Design Mode. */
export interface AiProposal extends AiTextEdit {
  summary: string;
  proposedContent: string;
}

export interface EditorSelection {
  path: string;
  startOffset: number;
  endOffset: number;
  text: string;
}

/** The editor state of one project, kept while another project is in front. */
export interface ProjectSnapshot {
  groups: Group[];
  focused: number;
  dirty: Record<string, boolean>;
  conflicts: Record<string, boolean>;
  selection: EditorSelection | null;
  pendingProposal: AiProposal | null;
}

const blankProject = (): ProjectSnapshot => ({
  groups: [{ tabs: [], active: null }],
  focused: 0,
  dirty: {},
  conflicts: {},
  selection: null,
  pendingProposal: null,
});

interface CodeState extends ProjectSnapshot {
  /** Project whose state is in front (its id), or null before any project is open. */
  project: string | null;
  /** Projects in the background. The focused project's state is not stored here. */
  snapshots: Record<string, ProjectSnapshot>;
  switchTo(project: string | null): void;
  dropProject(project: string): void;
  groups: Group[];
  focused: number;
  /** Paths with unsaved edits. */
  dirty: Record<string, boolean>;
  /** Paths changed on disk while they had unsaved edits. */
  conflicts: Record<string, boolean>;
  selection: EditorSelection | null;
  open(tab: Tab, group?: number): void;
  close(id: string, group: number): void;
  activate(id: string, group: number): void;
  focus(group: number): void;
  split(): void;
  setDirty(path: string, dirty: boolean): void;
  setConflict(path: string, conflict: boolean): void;
  setSelection(selection: EditorSelection | null): void;
  pendingProposal: AiProposal | null;
  setPendingProposal(proposal: AiProposal | null): void;
  /** Drop tabs of files that no longer exist (deleted or renamed elsewhere). */
  forget(path: string): void;
}

export const fileTab = (path: string): Tab => ({ id: `file:${path}`, kind: 'file', path });
export const workingDiffTab = (path: string): Tab => ({
  id: `diff:working:${path}`,
  kind: 'diff',
  path,
  source: 'working',
});
export const taskDiffTab = (taskId: string, taskTitle: string, path: string): Tab => ({
  id: `diff:task:${taskId}:${path}`,
  kind: 'diff',
  path,
  source: 'task',
  taskId,
  taskTitle,
});

export const tabTitle = (tab: Tab) => tab.path.split('/').pop() ?? tab.path;

export const useCode = create<CodeState>((set) => ({
  ...blankProject(),
  project: null,
  snapshots: {},
  switchTo: (project) =>
    set((state) => {
      if (project === state.project) return {};
      const snapshots = { ...state.snapshots };
      if (state.project) {
        snapshots[state.project] = {
          groups: state.groups,
          focused: state.focused,
          dirty: state.dirty,
          conflicts: state.conflicts,
          selection: state.selection,
          pendingProposal: state.pendingProposal,
        };
      }
      const next = (project && snapshots[project]) || blankProject();
      if (project) delete snapshots[project];
      return { ...next, project, snapshots };
    }),
  dropProject: (project) =>
    set((state) => {
      if (!state.snapshots[project]) return {};
      const snapshots = { ...state.snapshots };
      delete snapshots[project];
      return { snapshots };
    }),
  groups: [{ tabs: [], active: null }],
  focused: 0,
  dirty: {},
  conflicts: {},
  selection: null,
  pendingProposal: null,
  setPendingProposal: (proposal) => set({ pendingProposal: proposal }),
  open: (tab, group) =>
    set((state) => {
      const index = Math.min(group ?? state.focused, state.groups.length - 1);
      const groups = state.groups.map((item, i) =>
        i !== index
          ? item
          : {
              tabs: item.tabs.some((existing) => existing.id === tab.id)
                ? item.tabs
                : [...item.tabs, tab],
              active: tab.id,
            },
      );
      return { groups, focused: index };
    }),
  close: (id, group) =>
    set((state) => {
      const target = state.groups[group];
      if (!target) return state;
      const position = target.tabs.findIndex((tab) => tab.id === id);
      const tabs = target.tabs.filter((tab) => tab.id !== id);
      const active =
        target.active === id ? (tabs[Math.max(0, position - 1)]?.id ?? null) : target.active;
      let groups = state.groups.map((item, i) => (i === group ? { tabs, active } : item));
      // An empty second group collapses the split.
      if (!tabs.length && groups.length > 1) groups = groups.filter((_, i) => i !== group);
      return { groups, focused: Math.min(state.focused, groups.length - 1) };
    }),
  activate: (id, group) =>
    set((state) => ({
      groups: state.groups.map((item, i) => (i === group ? { ...item, active: id } : item)),
      focused: group,
    })),
  focus: (group) => set({ focused: group }),
  split: () =>
    set((state) => {
      if (state.groups.length > 1) return state;
      const current = state.groups[0]!;
      const tab = current.tabs.find((item) => item.id === current.active);
      return {
        groups: [current, { tabs: tab ? [tab] : [], active: tab?.id ?? null }],
        focused: 1,
      };
    }),
  setDirty: (path, dirty) =>
    set((state) =>
      !!state.dirty[path] === dirty ? state : { dirty: { ...state.dirty, [path]: dirty } },
    ),
  setConflict: (path, conflict) =>
    set((state) =>
      !!state.conflicts[path] === conflict
        ? state
        : { conflicts: { ...state.conflicts, [path]: conflict } },
    ),
  setSelection: (selection) =>
    set((state) => {
      const current = state.selection;
      if (
        current?.path === selection?.path &&
        current?.startOffset === selection?.startOffset &&
        current?.endOffset === selection?.endOffset &&
        current?.text === selection?.text
      )
        return state;
      return { selection };
    }),
  forget: (path) =>
    set((state) => {
      let groups = state.groups.map((group) => {
        const tabs = group.tabs.filter((tab) => tab.path !== path || tab.kind !== 'file');
        return {
          tabs,
          active: tabs.some((tab) => tab.id === group.active)
            ? group.active
            : (tabs[0]?.id ?? null),
        };
      });
      if (groups.length > 1 && !groups[1]!.tabs.length) groups = [groups[0]!];
      return {
        groups,
        focused: Math.min(state.focused, groups.length - 1),
        selection: state.selection?.path === path ? null : state.selection,
      };
    }),
}));

const hasDirty = (dirty: Record<string, boolean>) => Object.values(dirty).some(Boolean);

/** Unsaved edits in any open project, including the ones in the background. */
export const hasUnsavedChanges = () => {
  const state = useCode.getState();
  return (
    hasDirty(state.dirty) || Object.values(state.snapshots).some((item) => hasDirty(item.dirty))
  );
};

export const projectHasUnsavedChanges = (project: string) => {
  const state = useCode.getState();
  if (state.project === project) return hasDirty(state.dirty);
  return hasDirty(state.snapshots[project]?.dirty ?? {});
};
