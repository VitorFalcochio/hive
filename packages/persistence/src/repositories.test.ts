import { afterEach, expect, it } from 'vitest';
import type { Task } from '@hive/core';
import { HiveDatabase } from './database';
import { Repositories } from './repositories';

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function task(id: string, finishedAt: string | null, tokens: number): Task {
  return {
    id,
    runId: 'run',
    key: id,
    title: 'Tarefa',
    description: 'd',
    workerId: null,
    dependsOn: [],
    acceptanceCriteria: ['ok'],
    status: finishedAt ? 'completed' : 'running',
    workerState: 'idle',
    attempt: 0,
    branch: null,
    startCommit: null,
    worktreePath: null,
    result: finishedAt
      ? {
          summary: 'ok',
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          commit: null,
          commands: [],
          usage: { promptTokens: tokens, completionTokens: tokens / 10 },
        }
      : null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt,
  };
}

it('soma só os tokens das tarefas que terminaram a partir do horário dado', () => {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  repos.tasks.put(task('yesterday', '2026-10-20T23:00:00.000Z', 5_000));
  repos.tasks.put(task('today', '2026-10-21T09:00:00.000Z', 1_000));
  repos.tasks.put(task('later', '2026-10-21T15:00:00.000Z', 2_000));
  repos.tasks.put(task('running', null, 0));

  expect(repos.usageSince('2026-10-21T03:00:00.000Z')).toEqual({
    promptTokens: 3_000,
    completionTokens: 300,
  });
});

it('soma também as conversas com agentes no terminal', () => {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  repos.tasks.put(task('today', '2026-10-21T09:00:00.000Z', 1_000));
  const turn = (id: string, finishedAt: string, tokens: number) =>
    repos.chatTurns.put({
      id,
      workspaceId: 'ws',
      workerId: 'w',
      status: 'completed',
      promptTokens: tokens,
      completionTokens: tokens / 10,
      startedAt: finishedAt,
      finishedAt,
    });
  turn('yesterday', '2026-10-20T23:00:00.000Z', 9_000);
  turn('today', '2026-10-21T10:00:00.000Z', 500);

  expect(repos.usageSince('2026-10-21T03:00:00.000Z')).toEqual({
    promptTokens: 1_500,
    completionTokens: 150,
  });
});
