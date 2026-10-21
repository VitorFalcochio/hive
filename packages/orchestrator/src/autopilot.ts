import type { Run, RunStatus } from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { errorMessage, nowIso, secretRedactor } from '@hive/shared';

/** What the shift did with one queued mission, newest first in the history. */
export interface AutopilotHistoryItem {
  runId: string;
  missionTitle: string;
  status: RunStatus;
  /** Why the mission stopped early (planning or start failed); null when it ran. */
  error: string | null;
  finishedAt: string;
}

export interface AutopilotOptions {
  repos: Repositories;
  /** Asks the Queen for a plan; the run ends in `awaiting_plan_approval` or throws. */
  plan: (runId: string) => Promise<void>;
  /** Starts or resumes a planned run (Scheduler.start). */
  start: (runId: string) => void;
  onChange: () => void;
  /** Called once per mission the shift finished, for notifications. */
  onFinished?: (item: AutopilotHistoryItem) => void;
}

const QUEUE_KEY = 'autopilotQueue';
const HISTORY_KEY = 'autopilotHistory';
const HISTORY_LIMIT = 50;
const FINISHED: ReadonlySet<RunStatus> = new Set(['review', 'completed', 'failed', 'cancelled']);

/**
 * Shift mode: works through a queue of missions one at a time, planning each with the Queen and
 * running it without waiting for anyone. The queue lives in the database, so a restart picks up
 * where it stopped: a run interrupted by the restart is resumed once.
 */
export class Autopilot {
  /** Runs started (or resumed) by this process. A finished status on one of them means done. */
  private readonly startedHere = new Set<string>();
  private ticking = false;
  private again = false;

  constructor(private readonly options: AutopilotOptions) {}

  private get repos() {
    return this.options.repos;
  }

  get enabled(): boolean {
    return this.repos.getSettings().autopilot.enabled;
  }

  queue(): string[] {
    return this.readList(QUEUE_KEY).filter((id) => this.repos.runs.get(id) !== null);
  }

  history(): AutopilotHistoryItem[] {
    const raw = this.repos.getValue(HISTORY_KEY);
    if (!raw) return [];
    try {
      const items: unknown = JSON.parse(raw);
      return Array.isArray(items) ? (items as AutopilotHistoryItem[]) : [];
    } catch {
      return [];
    }
  }

  /** The queued mission being planned or run right now, if any. */
  current(): string | null {
    const head = this.queue()[0];
    const run = head ? this.repos.runs.get(head) : null;
    return run && this.enabled && ['planning', 'running'].includes(run.status) ? run.id : null;
  }

  /** True while the shift owns this run, so the scheduler must not wait for a person. */
  isUnattended(runId: string): boolean {
    return this.enabled && this.queue().includes(runId);
  }

  enqueue(runId: string): void {
    const run = this.repos.runs.require(runId, 'Execução');
    const queue = this.queue();
    if (!queue.includes(run.id)) this.saveQueue([...queue, run.id]);
    this.options.onChange();
    this.tick();
  }

  dequeue(runId: string): void {
    this.saveQueue(this.queue().filter((id) => id !== runId));
    this.startedHere.delete(runId);
    this.options.onChange();
  }

  /** Moves a waiting mission up (-1) or down (+1). The mission in progress stays first. */
  move(runId: string, offset: -1 | 1): void {
    const queue = this.queue();
    const from = queue.indexOf(runId);
    const to = from + offset;
    const locked = this.current() ? 1 : 0;
    if (from < locked || to < locked || to >= queue.length) return;
    [queue[from], queue[to]] = [queue[to]!, queue[from]!];
    this.saveQueue(queue);
    this.options.onChange();
  }

  /**
   * Advances the queue. Safe to call often (on every run change): calls made while a step is
   * in progress are folded into one more pass when it ends.
   */
  tick(): void {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    void this.advance()
      .catch((error: unknown) => console.error('Modo Turno:', errorMessage(error)))
      .finally(() => {
        this.ticking = false;
        if (this.again) {
          this.again = false;
          this.tick();
        }
      });
  }

  private async advance(): Promise<void> {
    // Each pass either waits on the head of the queue or removes it and looks at the next one.
    while (this.enabled) {
      const runId = this.queue()[0];
      if (!runId) return;
      const run = this.repos.runs.require(runId, 'Execução');
      if (run.status === 'planning' || run.status === 'running') return;
      if (FINISHED.has(run.status) && this.startedHere.has(run.id)) {
        this.finish(run, null);
        continue;
      }
      try {
        await this.step(run);
      } catch (error) {
        this.finish(this.repos.runs.require(runId, 'Execução'), errorMessage(error));
      }
      const after = this.repos.runs.get(runId);
      if (after && (after.status === 'running' || after.status === 'planning')) return;
    }
  }

  /** One move for a run at the head of the queue that is neither planning nor running. */
  private async step(run: Run): Promise<void> {
    const hasPlan = this.repos.tasks.list('run_id = ?', run.id).length > 0;
    // Already reviewed or completed before the shift saw it: nothing left to run.
    if (run.status === 'completed' || (run.status === 'review' && !this.hasUnfinished(run.id))) {
      this.finish(run, null);
      return;
    }
    if (!hasPlan) {
      await this.options.plan(run.id);
      this.options.onChange();
    }
    // A fresh plan, or a run a restart interrupted: the scheduler resumes unfinished tasks.
    this.startedHere.add(run.id);
    this.options.start(run.id);
    this.options.onChange();
  }

  private hasUnfinished(runId: string): boolean {
    return this.repos.tasks
      .list('run_id = ?', runId)
      .some((task) => ['pending', 'blocked', 'failed', 'cancelled'].includes(task.status));
  }

  private finish(run: Run, error: string | null): void {
    const item: AutopilotHistoryItem = {
      runId: run.id,
      missionTitle: this.repos.missions.get(run.missionId)?.title ?? run.missionId,
      status: error ? 'failed' : run.status,
      error: error ? secretRedactor.redact(error) : null,
      finishedAt: nowIso(),
    };
    this.repos.setValue(
      HISTORY_KEY,
      JSON.stringify([item, ...this.history()].slice(0, HISTORY_LIMIT)),
    );
    this.saveQueue(this.queue().filter((id) => id !== run.id));
    this.startedHere.delete(run.id);
    this.options.onChange();
    this.options.onFinished?.(item);
  }

  private readList(key: string): string[] {
    const raw = this.repos.getValue(key);
    if (!raw) return [];
    try {
      const ids: unknown = JSON.parse(raw);
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private saveQueue(ids: string[]): void {
    this.repos.setValue(QUEUE_KEY, JSON.stringify([...new Set(ids)]));
  }
}
