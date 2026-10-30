import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emptyCanvasLayout, type CanvasLayout } from '@hive/core';
import type { Grouping } from './model';

type Point = { x: number; y: number };
type Size = { width: number; height: number };
export type Note = CanvasLayout['notes'][number];
export type Frame = CanvasLayout['frames'][number];

/** Changes are written this long after the last one, and right away when the window closes. */
const SAVE_MS = 400;

export interface LayoutApi {
  persist: () => Promise<void>;
  reload: () => Promise<void>;
  layout: CanvasLayout;
  /** False until the stored layout arrived; nothing is saved before that. */
  ready: boolean;
  /** The last save failed; the layout still works and the next change tries again. */
  saveError: string;
  /** Keeps where nodes were moved to (a frame or note keeps its own place). */
  place: (mode: Grouping, positions: Record<string, Point>) => void;
  /** Locks (or unlocks) moved nodes, so "Reorganizar" leaves them where they are. */
  lock: (mode: Grouping, positions: Record<string, Point>, locked: boolean) => void;
  /** Gives moved nodes back to the automatic layout; locked ones stay unless `all`. */
  reset: (mode: Grouping, all: boolean) => void;
  setSize: (id: string, size: Size) => void;
  setMinimized: (id: string, minimized: boolean) => void;
  addAgent: (workerId: string) => void;
  removeAgent: (workerId: string) => void;
  addNote: (note: Note) => void;
  updateNote: (id: string, patch: Partial<Note>) => void;
  addFrame: (frame: Frame) => void;
  updateFrame: (id: string, patch: Partial<Frame>) => void;
  /** Removes notes and frames (and their sizes); other ids are ignored. */
  remove: (ids: string[]) => void;
}

/**
 * The spatial layer of one run's canvas. It is kept by the main process (in Hive's database) and
 * never read by the Queen or the scheduler: moving, resizing or grouping changes nothing in the
 * execution, and the execution never moves what the user fixed.
 */
export function useLayout(runId: string): LayoutApi {
  const [layout, setLayout] = useState<CanvasLayout>(emptyCanvasLayout);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState('');
  const pending = useRef<CanvasLayout | null>(null);
  const loaded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const writing = useRef<Promise<void>>(Promise.resolve());
  const editVersion = useRef(0);

  const persist = useCallback(() => {
    clearTimeout(timer.current);
    const value = pending.current;
    const version = editVersion.current;
    if (!value) return writing.current;
    pending.current = null;
    const operation = writing.current
      .catch(() => {})
      .then(async () => {
        try {
          await window.hive.invoke('canvas.layout.save', { runId, layout: value });
          setSaveError('');
        } catch (error) {
          if (editVersion.current === version) pending.current ??= value;
          setSaveError(error instanceof Error ? error.message : String(error));
          throw error;
        }
      });
    writing.current = operation;
    return operation;
  }, [runId]);
  const flush = useCallback(() => {
    void persist().catch(() => {});
  }, [persist]);
  const reload = useCallback(async () => {
    const version = editVersion.current;
    await persist();
    const stored = await window.hive.invoke('canvas.layout.get', runId);
    if (!pending.current && version === editVersion.current) {
      setLayout(stored ?? emptyCanvasLayout);
      loaded.current = true;
      setReady(true);
      setSaveError('');
    }
  }, [persist, runId]);

  useEffect(() => {
    let alive = true;
    loaded.current = false;
    setReady(false);
    void window.hive
      .invoke('canvas.layout.get', runId)
      .then((stored) => {
        if (!alive) return;
        setLayout(stored ?? emptyCanvasLayout);
        loaded.current = true;
        setReady(true);
        setSaveError('');
      })
      .catch((error: unknown) => {
        if (alive)
          setSaveError(
            `Não foi possível carregar o layout: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    window.addEventListener('beforeunload', flush);
    return () => {
      alive = false;
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [runId, flush]);

  const change = useCallback(
    (update: (current: CanvasLayout) => CanvasLayout) => {
      // Before the stored layout arrives, a change would be overwritten by it: ignore it.
      if (!loaded.current) return;
      setLayout((current) => {
        const next = update(current);
        if (next === current) return current;
        editVersion.current++;
        pending.current = next;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_MS);
        return next;
      });
    },
    [flush],
  );

  return useMemo<LayoutApi>(
    () => ({
      persist,
      reload,
      layout,
      ready,
      saveError,
      place: (mode, positions) =>
        change((current) => {
          // Notes and frames keep their own place; everything else is a pinned graph node.
          const notes = current.notes.map((note) =>
            positions[note.id] ? { ...note, ...round(positions[note.id]!) } : note,
          );
          const frames = current.frames.map((frame) =>
            positions[frame.id] ? { ...frame, ...round(positions[frame.id]!) } : frame,
          );
          const own = new Set([...notes, ...frames].map((item) => item.id));
          const pinned = { ...current.pinned[mode] };
          for (const [id, point] of Object.entries(positions))
            if (!own.has(id)) pinned[id] = { ...round(point), locked: pinned[id]?.locked };
          return { ...current, notes, frames, pinned: { ...current.pinned, [mode]: pinned } };
        }),
      lock: (mode, positions, locked) =>
        change((current) => {
          const pinned = { ...current.pinned[mode] };
          for (const [id, point] of Object.entries(positions))
            pinned[id] = { ...round(point), ...(locked ? { locked: true } : {}) };
          return { ...current, pinned: { ...current.pinned, [mode]: pinned } };
        }),
      reset: (mode, all) =>
        change((current) => {
          const kept = all
            ? {}
            : Object.fromEntries(
                Object.entries(current.pinned[mode] ?? {}).filter(([, point]) => point.locked),
              );
          return { ...current, pinned: { ...current.pinned, [mode]: kept } };
        }),
      setSize: (id, size) =>
        change((current) => ({
          ...current,
          sizes: {
            ...current.sizes,
            [id]: { width: Math.round(size.width), height: Math.round(size.height) },
          },
        })),
      setMinimized: (id, minimized) =>
        change((current) => {
          const others = current.minimized.filter((item) => item !== id);
          return { ...current, minimized: minimized ? [...others, id] : others };
        }),
      addAgent: (workerId) =>
        change((current) =>
          current.agents.includes(workerId)
            ? current
            : { ...current, agents: [...current.agents, workerId] },
        ),
      removeAgent: (workerId) =>
        change((current) => ({
          ...current,
          agents: current.agents.filter((item) => item !== workerId),
        })),
      addNote: (note) => change((current) => ({ ...current, notes: [...current.notes, note] })),
      updateNote: (id, patch) =>
        change((current) => ({
          ...current,
          notes: current.notes.map((note) => (note.id === id ? { ...note, ...patch } : note)),
        })),
      addFrame: (frame) =>
        change((current) => ({ ...current, frames: [...current.frames, frame] })),
      updateFrame: (id, patch) =>
        change((current) => ({
          ...current,
          frames: current.frames.map((frame) => (frame.id === id ? { ...frame, ...patch } : frame)),
        })),
      remove: (ids) =>
        change((current) => {
          const gone = new Set(ids);
          if (
            !current.notes.some((n) => gone.has(n.id)) &&
            !current.frames.some((f) => gone.has(f.id))
          )
            return current;
          const sizes = { ...current.sizes };
          for (const id of ids) delete sizes[id];
          return {
            ...current,
            sizes,
            notes: current.notes.filter((note) => !gone.has(note.id)),
            frames: current.frames.filter((frame) => !gone.has(frame.id)),
          };
        }),
    }),
    [layout, ready, saveError, change, persist, reload],
  );
}

const round = (point: Point): Point => ({ x: Math.round(point.x), y: Math.round(point.y) });

/** A short id for notes and frames; they live only in the layout. */
export const localId = (prefix: 'note' | 'frame') =>
  `${prefix}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
