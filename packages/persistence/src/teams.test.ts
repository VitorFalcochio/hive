import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultLimits,
  defaultTeamsSettings,
  taskSchema,
  workerInputSchema,
  workerSchema,
  type TeamMessage,
} from '@hive/core';
import { HiveDatabase, SCHEMA_VERSION } from './database';
import { Repositories } from './repositories';

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function repositories() {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  const at = '2026-01-01T00:00:00.000Z';
  repos.workspaces.put({
    id: 'ws',
    name: 'p',
    path: '/p',
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  repos.missions.put({ id: 'm', workspaceId: 'ws', title: 'M', objective: 'o', createdAt: at });
  repos.runs.put({
    id: 'run',
    missionId: 'm',
    workspaceId: 'ws',
    status: 'running',
    baseBranch: 'main',
    baseCommit: 'abc',
    queenWorkerId: null,
    planNotes: null,
    report: null,
    error: null,
    createdAt: at,
    finishedAt: null,
  });
  return repos;
}

const oldWorker = {
  id: 'w1',
  name: 'Dev',
  role: 'backend',
  description: '',
  providerId: 'p',
  modelId: 'm',
  skills: [],
  tools: ['read_file'],
  autoApproveCommands: [],
  systemPrompt: '',
  limits: defaultLimits,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const oldTask = {
  id: 't1',
  runId: 'run',
  key: 'a',
  title: 'A',
  description: 'd',
  workerId: 'w1',
  dependsOn: [],
  acceptanceCriteria: ['ok'],
  status: 'completed',
  workerState: 'completed',
  attempt: 1,
  branch: 'hive/x',
  startCommit: null,
  worktreePath: null,
  result: null,
  error: null,
  createdAt: '2026-01-01',
  startedAt: null,
  finishedAt: null,
};

const message = (key: string, patch: Partial<TeamMessage> = {}): TeamMessage => ({
  id: `tm_${key}`,
  runId: 'run',
  idempotencyKey: key,
  kind: 'feedback',
  fromAgentId: 'nemotron',
  toAgentId: 'codex',
  fromTaskId: 'review',
  toTaskId: 'impl',
  subject: 'Revisão',
  body: 'Falta validar o título.',
  payload: { verdict: 'changes_requested' },
  createdAt: '2026-01-01T00:00:01.000Z',
  ...patch,
});

describe('Hive Teams: compatibilidade', () => {
  it('agentes e tarefas salvos antes do Hive Teams continuam válidos e iguais', () => {
    expect(workerSchema.parse(oldWorker).team).toBeUndefined();
    const task = taskSchema.parse(oldTask);
    expect(task.team).toBeUndefined();
    expect(task.parentTaskId).toBeUndefined();
  });

  it('configurações salvas antes do Hive Teams recebem os limites padrão', () => {
    const repos = repositories();
    const { teams, ...older } = repos.getSettings();
    expect(teams).toEqual(defaultTeamsSettings);
    databases[0]!.run(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(older),
    );
    expect(repos.getSettings().teams).toEqual(defaultTeamsSettings);
  });

  it('a interface não consegue marcar um agente como criado pelo Hive Teams', () => {
    const input = workerInputSchema.parse({
      ...oldWorker,
      team: {
        runId: 'run',
        parentAgentId: 'x',
        createdByAgentId: 'x',
        spawnRequestId: 'r',
        depth: 1,
      },
    });
    expect('team' in input).toBe(false);
  });

  it('um banco existente ganha as tabelas novas sem perder nada', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'hive-teams-db-')), 'hive.sqlite');
    const before = new HiveDatabase(file);
    const repos = new Repositories(before);
    repos.workers.put(workerSchema.parse(oldWorker));
    before.db.exec('DROP TABLE team_messages; DROP TABLE team_requests;');
    before.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    before.close();

    const after = new HiveDatabase(file);
    databases.push(after);
    const reopened = new Repositories(after);
    expect(reopened.workers.require('w1', 'Agente').name).toBe('Dev');
    expect(reopened.teamMessages.list()).toEqual([]);
    expect(after.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('Hive Teams: idempotência persistente', () => {
  it('a mesma mensagem enviada de novo não é gravada outra vez nem alterada', () => {
    const repos = repositories();
    const first = repos.teamMessages.insertOnce(message('review-1'));
    const again = repos.teamMessages.insertOnce(message('review-1', { body: 'texto diferente' }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.entity.body).toBe('Falta validar o título.');
    expect(repos.teamMessagesOf('run')).toHaveLength(1);
  });

  it('as mensagens de uma missão saem na ordem em que foram enviadas', () => {
    const repos = repositories();
    repos.teamMessages.insertOnce(message('b', { createdAt: '2026-01-01T00:00:02.000Z' }));
    repos.teamMessages.insertOnce(message('a', { createdAt: '2026-01-01T00:00:01.000Z' }));
    repos.teamMessages.insertOnce(message('c', { createdAt: '2026-01-01T00:00:02.000Z' }));
    expect(repos.teamMessagesOf('run').map((m) => m.idempotencyKey)).toEqual(['a', 'b', 'c']);
  });

  it('pedidos de criação também são gravados uma vez só', () => {
    const repos = repositories();
    const request = {
      id: 'tr_1',
      runId: 'run',
      kind: 'spawn_agent' as const,
      key: 'codex',
      requestedByAgentId: 'claude',
      requestedByTaskId: 'lead',
      status: 'accepted' as const,
      reason: null,
      input: { role: 'backend' },
      result: { agentId: 'w_codex' },
      createdAt: '2026-01-01',
    };
    expect(repos.teamRequests.insertOnce(request).created).toBe(true);
    expect(
      repos.teamRequests.insertOnce({ ...request, result: { agentId: 'outro' } }),
    ).toMatchObject({
      created: false,
      entity: { result: { agentId: 'w_codex' } },
    });
  });
});
