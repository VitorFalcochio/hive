import type { Plan, Task, Worker } from '@hive/core';

// Agent comparison: the same objective runs once per selected agent, each in its own worktree.
// The first candidate applied is merged; the others are discarded (or cancelled while running).
export const CANDIDATE_PREFIX = 'candidate-';
export const MIN_CANDIDATES = 2;
export const MAX_CANDIDATES = 6;
const MAX_OBJECTIVE_CHARS = 4_000;

export const isCandidate = (task: Pick<Task, 'key'>) => task.key.startsWith(CANDIDATE_PREFIX);

/** One task per selected agent, with no dependencies, so they all start together. */
export function buildComparisonPlan(objective: string, workers: Worker[]): Plan {
  if (workers.length < MIN_CANDIDATES || workers.length > MAX_CANDIDATES)
    throw new Error(`Escolha de ${MIN_CANDIDATES} a ${MAX_CANDIDATES} agentes para comparar.`);
  const description = objective.trim();
  if (description.length > MAX_OBJECTIVE_CHARS)
    throw new Error('Para comparar agentes, o objetivo deve ter até 4.000 caracteres.');
  return {
    notes: 'Comparação: a mesma tarefa executada por cada agente escolhido.',
    tasks: workers.map((worker, index) => ({
      key: `${CANDIDATE_PREFIX}${index + 1}`,
      title: `Candidato: ${worker.name}`.slice(0, 140),
      description,
      workerId: worker.id,
      dependsOn: [],
      acceptanceCriteria: ['Atender ao objetivo descrito na missão.'],
    })),
  };
}

const runningStatuses = new Set<Task['status']>([
  'pending',
  'blocked',
  'running',
  'waiting_approval',
]);

/** Applies the chosen candidate and discards the rest, so only one change reaches the project. */
export async function applyCandidate(chosen: Task, candidates: Task[]): Promise<void> {
  await window.hive.invoke('task.approve', chosen.id);
  await discardOthers(chosen.id, candidates);
}

/** Discards every candidate that has not been applied yet. */
export async function discardCandidates(candidates: Task[]): Promise<void> {
  await discardOthers(null, candidates);
}

async function discardOthers(keepId: string | null, candidates: Task[]): Promise<void> {
  for (const other of candidates) {
    if (other.id === keepId || other.status === 'approved' || other.status === 'rejected') continue;
    if (other.status === 'completed') await window.hive.invoke('task.reject', other.id);
    else if (runningStatuses.has(other.status)) await window.hive.invoke('task.cancel', other.id);
  }
}

export interface CandidateSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  commandsPassed: number;
  commandsRun: number;
}

export function summarizeCandidate(task: Task): CandidateSummary | null {
  const result = task.result;
  if (!result) return null;
  return {
    filesChanged: result.filesChanged.length,
    insertions: result.insertions,
    deletions: result.deletions,
    commandsPassed: result.commands.filter((command) => command.exitCode === 0 && !command.timedOut)
      .length,
    commandsRun: result.commands.length,
  };
}
