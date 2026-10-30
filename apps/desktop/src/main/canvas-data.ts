import {
  usageCost,
  type CanvasRunSummary,
  type CanvasSnapshot,
  type CanvasTerminal,
  type CanvasWorker,
  type Worker,
  type RunDetail,
  type RunStatus,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { nowIso } from '@hive/shared';

/** Runs offered in the Nexus picker; older ones stay in the main window's history. */
const MAX_RUNS = 60;
const LIVE: ReadonlySet<RunStatus> = new Set(['planning', 'running']);

/**
 * Recent runs of every project, the ones at work first. The canvas is its own window, so it is
 * not tied to the project in front in the main window.
 */
export function canvasRuns(repos: Repositories): CanvasRunSummary[] {
  const workspaces = new Map(repos.workspaces.list().map((item) => [item.id, item]));
  return repos.runs
    .list()
    .filter((run) => workspaces.has(run.workspaceId))
    .sort(
      (a, b) =>
        Number(LIVE.has(b.status)) - Number(LIVE.has(a.status)) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, MAX_RUNS)
    .map((run) => {
      const tasks = repos.tasks.list('run_id = ?', run.id);
      return {
        runId: run.id,
        missionId: run.missionId,
        missionTitle: repos.missions.get(run.missionId)?.title ?? run.missionId,
        workspaceId: run.workspaceId,
        workspaceName: workspaces.get(run.workspaceId)?.name ?? '',
        status: run.status,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        tasks: {
          total: tasks.length,
          done: tasks.filter((task) => ['completed', 'approved'].includes(task.status)).length,
          running: tasks.filter((task) => ['running', 'waiting_approval'].includes(task.status))
            .length,
          failed: tasks.filter((task) => task.status === 'failed').length,
        },
      };
    });
}

export function canvasSnapshot(
  repos: Repositories,
  detail: RunDetail,
  state: { planning: boolean; queue: string[]; terminals: CanvasTerminal[] },
): CanvasSnapshot {
  const { run, tasks } = detail;
  const workspace = repos.workspaces.get(run.workspaceId);
  const workers = repos.workers
    .list()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((worker) => canvasWorker(repos, worker));
  const usage: CanvasSnapshot['usage'] = {};
  for (const task of tasks) {
    if (!task.result) continue;
    const worker = task.workerId ? repos.workers.get(task.workerId) : null;
    // The result does not say which model produced it; the session that did, does. Without
    // that event the cost is unknown rather than guessed from the agent's current model.
    const [session] = repos.queryEvents({ taskId: task.id, types: ['session.started'], limit: 1 });
    const modelId = typeof session?.data?.model === 'string' ? session.data.model : null;
    const model = worker?.providerId && modelId ? repos.getModel(worker.providerId, modelId) : null;
    usage[task.id] = {
      ...task.result.usage,
      costUsd: model ? usageCost(model, task.result.usage) : null,
    };
  }
  const position = state.queue.indexOf(run.id);
  return {
    detail,
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    workers,
    usage,
    planning: state.planning || run.status === 'planning',
    queuePosition: position < 0 ? null : position,
    terminals: state.terminals,
    at: nowIso(),
  };
}

/** What the canvas may know about an agent: no prompt, tools, limits or secrets. */
export function canvasWorker(repos: Repositories, worker: Worker): CanvasWorker {
  return {
    id: worker.id,
    name: worker.name,
    role: worker.role,
    beeColor: worker.beeColor,
    providerId: worker.providerId,
    providerName: worker.providerId ? (repos.providers.get(worker.providerId)?.name ?? null) : null,
    modelId: worker.modelId,
  };
}
