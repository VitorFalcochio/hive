import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, CanvasRunSummary, CanvasSnapshot, HivePush } from '@hive/core';

export type Connection = 'connecting' | 'live' | 'disconnected';

/** Events kept in memory per run; older ones are still in the database and in the main window. */
export const MAX_EVENTS = 3_000;
const HISTORY = 1_500;
/** Bursts of scheduler changes cost one reload. */
const RELOAD_MS = 250;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000];

const RELOADS: ReadonlySet<string> = new Set([
  'run',
  'task',
  'approval',
  'worker',
  'mission',
  'provider',
  'autopilot',
]);

const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface CanvasData {
  snapshot: CanvasSnapshot | null;
  events: AgentEvent[];
  connection: Connection;
  /** Why the last read failed; cleared by the next one that works. */
  error: string;
  /** The selected run no longer exists (its mission was deleted). */
  missing: boolean;
  reload: () => void;
}

/**
 * The run as the engine sees it. The window listens before it reads, so nothing that happens
 * while the snapshot and history load is lost, and events seen twice are applied once. It never
 * runs anything itself: every change comes from the main process.
 */
/** Recent runs of every project for the picker, refreshed when the engine reports changes. */
export function useCanvasRuns(): CanvasRunSummary[] | null {
  const [runs, setRuns] = useState<CanvasRunSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void window.hive
        .invoke('canvas.runs')
        .then((list) => alive && setRuns(list))
        .catch(() => alive && setRuns((current) => current ?? []));
    load();
    const off = window.hive.subscribe((push) => {
      if (push.kind !== 'changed' || !RELOADS.has(push.entity)) return;
      timer ??= setTimeout(() => {
        timer = undefined;
        if (alive) load();
      }, RELOAD_MS * 4);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, []);
  return runs;
}

export function useCanvasData(runId: string | null): CanvasData {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState('');
  const [missing, setMissing] = useState(false);
  const reloadRef = useRef<() => void>(() => undefined);

  // One run: snapshot, event history and live updates.
  useEffect(() => {
    setSnapshot(null);
    setEvents([]);
    setMissing(false);
    setError('');
    if (!runId) {
      setConnection('live');
      return;
    }
    setConnection('connecting');
    let alive = true;
    let loaded = false;
    let attempt = 0;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const seen = new Set<string>();
    let pending: AgentEvent[] = [];

    // Live events are applied once per frame, so a chatty agent costs one render per frame.
    const flush = () => {
      frame = 0;
      if (!alive || !pending.length) return;
      const batch = pending;
      pending = [];
      setEvents((current) => {
        const next = current.concat(batch);
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };
    const accept = (event: AgentEvent) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      pending.push(event);
      if (loaded && !frame) frame = requestAnimationFrame(flush);
    };

    const readSnapshot = async () => {
      try {
        const value = await window.hive.invoke('canvas.snapshot', runId);
        if (!alive) return;
        attempt = 0;
        setSnapshot(value);
        setConnection('live');
        setError('');
      } catch (failure) {
        if (!alive) return;
        if (errorCode(failure) === 'NOT_FOUND') {
          setMissing(true);
          setConnection('live');
          return;
        }
        setConnection('disconnected');
        setError(errorText(failure));
        clearTimeout(retryTimer);
        retryTimer = setTimeout(
          () => void readSnapshot(),
          RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)],
        );
      }
    };
    const scheduleReload = () => {
      reloadTimer ??= setTimeout(() => {
        reloadTimer = undefined;
        if (alive) void readSnapshot();
      }, RELOAD_MS);
    };
    reloadRef.current = () => {
      setConnection((current) => (current === 'disconnected' ? 'connecting' : current));
      void readSnapshot();
    };

    const off = window.hive.subscribe((push: HivePush) => {
      if (!alive) return;
      if (push.kind === 'event') {
        if (push.event.runId !== runId) return;
        accept(push.event);
        // Task state changes are also stored; the snapshot catches up with them.
        if (push.event.type === 'task.status' || push.event.type === 'run.status') scheduleReload();
      } else if (push.kind === 'changed' && RELOADS.has(push.entity)) scheduleReload();
    });

    void readSnapshot();
    void window.hive
      .invoke('events.query', { runId, limit: HISTORY })
      .catch(() => [] as AgentEvent[])
      .then((history) => {
        if (!alive) return;
        // History first, then what arrived while it loaded.
        const live = pending;
        pending = [];
        for (const event of history) accept(event);
        for (const event of live) pending.push(event);
        loaded = true;
        flush();
      });

    return () => {
      alive = false;
      clearTimeout(reloadTimer);
      clearTimeout(retryTimer);
      cancelAnimationFrame(frame);
      off();
    };
  }, [runId]);

  const reload = useCallback(() => reloadRef.current(), []);
  return { snapshot, events, connection, error, missing, reload };
}
