import type { CandidateScore, Task } from '@hive/core';

/**
 * "Várias tentativas": a task runs as several candidates, each an ordinary task of the run (own
 * worktree, approvals, retries, recovery) on a different model. These are the pure parts: making
 * a candidate and choosing the best one.
 */

/** A model a candidate runs on. */
export interface CandidateModel {
  providerId: string;
  modelId: string;
}

/** Unique within the run and safe in a branch name. */
export function candidateKey(parentKey: string, round: number, number: number): string {
  return `${parentKey}-r${round}t${number}`;
}

/** A new candidate of `parent`: its work, its agent and its dependencies, on `model`. */
export function newCandidate(
  parent: Task,
  id: string,
  round: number,
  number: number,
  model: CandidateModel,
  at: string,
): Task {
  return {
    id,
    runId: parent.runId,
    key: candidateKey(parent.key, round, number),
    title: `${parent.title} · tentativa ${number}`,
    description: parent.description,
    workerId: parent.workerId,
    // The same dependencies, so each candidate starts from the same results the task would.
    dependsOn: parent.dependsOn,
    acceptanceCriteria: parent.acceptanceCriteria,
    status: 'pending',
    workerState: 'idle',
    attempt: 0,
    branch: null,
    startCommit: null,
    worktreePath: null,
    result: null,
    error: null,
    createdAt: at,
    startedAt: null,
    finishedAt: null,
    ...(parent.boosted ? { boosted: true } : {}),
    parentTaskId: parent.id,
    candidateOf: { parentTaskId: parent.id, round, number, ...model },
  };
}

const passed = (score: CandidateScore | undefined) =>
  score?.checks.filter((check) => check.ok).length ?? 0;

const label = (task: Task) =>
  `tentativa ${task.candidateOf?.number ?? '?'} (${task.candidateOf?.modelId ?? 'modelo?'})`;

/**
 * The best candidate of a round: among those that completed, the one that passed the most project
 * checks; then one that changed something over one that did not; then the first to finish.
 */
export function pickWinner(
  candidates: Task[],
  scores: CandidateScore[],
): { winner: Task | null; reason: string } {
  const scoreOf = (task: Task) => scores.find((score) => score.taskId === task.id);
  const completed = candidates
    .filter((task) => task.status === 'completed')
    .sort(
      (a, b) =>
        passed(scoreOf(b)) - passed(scoreOf(a)) ||
        Number(!!b.result?.commit) - Number(!!a.result?.commit) ||
        (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') ||
        (a.candidateOf?.number ?? 0) - (b.candidateOf?.number ?? 0),
    );
  const winner = completed[0] ?? null;
  if (!winner)
    return {
      winner: null,
      reason: `Nenhuma das ${candidates.length} tentativas terminou bem.`,
    };
  const checked = scores.some((score) => score.checks.length > 0);
  if (!checked)
    return {
      winner,
      reason:
        completed.length === 1
          ? `Só a ${label(winner)} terminou bem.`
          : `Sem verificações do projeto para comparar; ficou a ${label(winner)}, a primeira a concluir${winner.result?.commit ? ' com alterações' : ''}.`,
    };
  const others = candidates
    .filter((task) => task.id !== winner.id)
    .sort((a, b) => (a.candidateOf?.number ?? 0) - (b.candidateOf?.number ?? 0))
    .map((task) => {
      const score = scoreOf(task);
      if (task.status !== 'completed') return `tentativa ${task.candidateOf?.number} não terminou`;
      return `tentativa ${task.candidateOf?.number} passou em ${passed(score)} de ${score?.checks.length ?? 0}`;
    });
  const total = scoreOf(winner)?.checks.length ?? 0;
  return {
    winner,
    reason:
      `A ${label(winner)} passou em ${passed(scoreOf(winner))} de ${total} verificação(ões) do projeto` +
      (others.length ? `; ${others.join('; ')}.` : '.'),
  };
}

/** Why a round produced nothing: each candidate's error, briefly. */
export function failureSummary(candidates: Task[]): string {
  const lines = [...candidates]
    .sort((a, b) => (a.candidateOf?.number ?? 0) - (b.candidateOf?.number ?? 0))
    .map((task) => `- ${label(task)}: ${(task.error ?? task.status).slice(0, 300)}`);
  return `Nenhuma das ${candidates.length} tentativas deu certo.\n${lines.join('\n')}`;
}
