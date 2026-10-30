import { useCallback, useEffect, useRef, useState } from 'react';
import type { CortexOverview } from '@hive/core';

export interface CortexState {
  /** Null until the first answer arrives. */
  blocks: CortexOverview[] | null;
  error: string;
  reload: () => Promise<void>;
}

/**
 * The Cortex blocks of the run's project. They belong to the project, not the run, so another
 * mission of the same project shows the same blocks, connections and memories.
 */
export function useCortex(runId: string): CortexState {
  const [blocks, setBlocks] = useState<CortexOverview[] | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try {
      const list = await window.hive.invoke('cortex.list', runId);
      if (!alive.current) return;
      setBlocks(list ?? []);
      setError('');
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [runId]);
  useEffect(() => {
    alive.current = true;
    setBlocks(null);
    void reload();
    // Pushes come in bursts (a proposal logs, notifies and changes counts); one reload covers them.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.hive.subscribe((push) => {
      if (push.kind !== 'changed' || (push.entity !== 'cortex' && push.entity !== 'worker')) return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 120);
    });
    return () => {
      alive.current = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [reload]);
  return { blocks, error, reload };
}
