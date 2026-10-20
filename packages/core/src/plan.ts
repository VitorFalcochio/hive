import type { Plan, PlanTask, Task, TaskStatus } from './domain';

export interface PlanIssue {
  path: string;
  message: string;
}

/** Structural checks the Zod schema cannot express: unique keys, known deps and no cycles. */
export function checkPlanGraph(plan: Plan, knownWorkerIds?: ReadonlySet<string>): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const keys = new Set<string>();
  plan.tasks.forEach((task, index) => {
    if (keys.has(task.key))
      issues.push({ path: `tasks.${index}.key`, message: `Duplicate key "${task.key}".` });
    keys.add(task.key);
    if (task.workerId && knownWorkerIds && !knownWorkerIds.has(task.workerId)) {
      issues.push({
        path: `tasks.${index}.workerId`,
        message: `Unknown worker "${task.workerId}".`,
      });
    }
  });
  plan.tasks.forEach((task, index) => {
    for (const dep of task.dependsOn) {
      if (dep === task.key)
        issues.push({
          path: `tasks.${index}.dependsOn`,
          message: 'A task cannot depend on itself.',
        });
      else if (!keys.has(dep))
        issues.push({ path: `tasks.${index}.dependsOn`, message: `Unknown dependency "${dep}".` });
    }
  });
  const cycle = findCycle(plan.tasks);
  if (cycle) issues.push({ path: 'tasks', message: `Dependency cycle: ${cycle.join(' → ')}` });
  return issues;
}

export function findCycle(tasks: Pick<PlanTask, 'key' | 'dependsOn'>[]): string[] | null {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    const mark = state.get(key);
    if (mark === 'done') return null;
    if (mark === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };
  for (const task of tasks) {
    const found = visit(task.key);
    if (found) return found;
  }
  return null;
}

/** Statuses after which a dependency's output can be built upon. */
export const satisfiedStatuses: ReadonlySet<TaskStatus> = new Set(['completed', 'approved']);
export const terminalStatuses: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'approved',
  'failed',
  'cancelled',
  'rejected',
]);
export const activeStatuses: ReadonlySet<TaskStatus> = new Set(['running', 'waiting_approval']);

/** Tasks whose dependencies are all satisfied and that have not started yet. */
export function readyTasks(tasks: Task[]): Task[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  return tasks.filter(
    (task) =>
      (task.status === 'pending' || task.status === 'blocked') &&
      task.dependsOn.every((dep) => {
        const found = byKey.get(dep);
        return found !== undefined && satisfiedStatuses.has(found.status);
      }),
  );
}

/** A pending task is blocked for good when one of its dependencies ended without success. */
export function isBlockedByFailure(task: Task, tasks: Task[]): boolean {
  const byKey = new Map(tasks.map((item) => [item.key, item]));
  return task.dependsOn.some((dep) => {
    const found = byKey.get(dep);
    return (
      !found ||
      found.status === 'failed' ||
      found.status === 'cancelled' ||
      found.status === 'rejected'
    );
  });
}

/** Group task keys into dependency layers, for the plan graph. */
export function dependencyLayers(tasks: Pick<PlanTask, 'key' | 'dependsOn'>[]): string[][] {
  const known = new Set(tasks.map((task) => task.key));
  const remaining = new Map(tasks.map((task) => [task.key, task.dependsOn]));
  const layers: string[][] = [];
  const placed = new Set<string>();
  while (remaining.size) {
    // Unknown dependencies are reported by checkPlanGraph; here they must not stall layering.
    const layer = [...remaining.entries()]
      .filter(([, deps]) => deps.every((dep) => placed.has(dep) || !known.has(dep)))
      .map(([key]) => key);
    if (!layer.length) {
      layers.push([...remaining.keys()]);
      break;
    }
    for (const key of layer) {
      remaining.delete(key);
      placed.add(key);
    }
    layers.push(layer);
  }
  return layers;
}
