import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiveDatabase, Repositories } from '@hive/persistence';
import type { AgentEvent, Task } from '@hive/core';
import { LiveResults } from './live-result';

const at = '2026-10-29T12:00:00.000Z';
const databases: HiveDatabase[] = [];
const roots: string[] = [];
const projections: LiveResults[] = [];
afterEach(() => {
  for (const projection of projections.splice(0)) projection.dispose();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    if (
      path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith('hive-result-')
    )
      throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

function setup(file = ':memory:') {
  const db = new HiveDatabase(file);
  databases.push(db);
  const repos = new Repositories(db);
  repos.missions.put({
    id: 'm',
    workspaceId: 'w',
    title: 'Login',
    objective: 'Implementar login',
    createdAt: at,
  });
  repos.runs.put({
    id: 'r',
    missionId: 'm',
    workspaceId: 'w',
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
  const task: Task = {
    id: 't',
    runId: 'r',
    key: 'api',
    title: 'API login',
    description: '',
    workerId: null,
    dependsOn: [],
    acceptanceCriteria: [],
    status: 'running',
    workerState: 'coding',
    attempt: 1,
    branch: 'hive/r/api',
    startCommit: 'abc',
    worktreePath: '/worktree',
    result: null,
    error: null,
    createdAt: at,
    startedAt: at,
    finishedAt: null,
  };
  repos.tasks.put(task);
  const notify = vi.fn();
  const results = new LiveResults(repos, notify);
  projections.push(results);
  const append = (
    id: string,
    type: AgentEvent['type'],
    data: AgentEvent['data'],
    patch: Partial<AgentEvent> = {},
  ) => {
    const event: AgentEvent = {
      id,
      ts: at,
      workspaceId: 'w',
      runId: 'r',
      taskId: 't',
      workerId: null,
      type,
      level: 'info',
      message: id,
      data,
      ...patch,
    };
    repos.appendEvent(event);
    return event;
  };
  return { db, repos, results, append, task, notify };
}

describe('Resultado Vivo persistido', () => {
  it('agrega incrementalmente eventos reais, mantém evidências e ignora duplicados', () => {
    const { results, repos, append, notify } = setup();
    expect(results.refresh('r').tests).toEqual([]);
    const file = append('file', 'file.changed', { path: 'src/auth.ts', action: 'created' });
    append('start', 'command.started', { command: 'npm test' });
    repos.appendEvent(file);
    const live = results.refresh('r');
    expect(live.eventCount).toBe(2);
    expect(live.files).toMatchObject([{ path: 'src/auth.ts', evidence: 'event:file' }]);
    expect(live.tests).toMatchObject([{ status: 'running' }]);
    expect(live.summary).toContain('0 aprovado(s)');
    append('end', 'command.finished', {
      command: 'npm test',
      exitCode: 0,
      outputTail: '3 tests passed',
    });
    const passed = results.refresh('r');
    expect(passed.tests).toMatchObject([{ status: 'passed', evidence: 'event:end' }]);
    expect(passed.tests).toHaveLength(1);
    const calls = notify.mock.calls.length;
    expect(results.refresh('r')).toEqual(passed);
    expect(notify).toHaveBeenCalledTimes(calls);
    expect(repos.resultEvents('r', { limit: 1 }).hasMore).toBe(true);
    expect(
      repos.resultEvents('r', { after: live.cursor }).events.map((item) => item.event.id),
    ).toEqual(['end']);
  });

  it('sem evidência não valida testes, nem transforma texto livre em alteração', () => {
    const { results, append } = setup();
    append('claim', 'info', null, { message: 'Todos os testes passaram; alterei 9 arquivos.' });
    append('unknown', 'command.finished', { command: 'npm test' });
    append('failure', 'command.finished', { command: 'npm run lint', exitCode: 1 });
    append('masked', 'command.finished', { command: 'npm test || true', exitCode: 0 });
    append('claim-command', 'command.finished', { command: 'echo "tests passed"', exitCode: 0 });
    const report = results.refresh('r');
    expect(report.files).toEqual([]);
    expect(report.tests.map((test) => test.status)).toEqual(['unverified', 'failed', 'unverified']);
    expect(report.risks.join(' ')).toContain('Teste falhou');
    expect(report.updates.find((update) => update.eventId === 'unknown')?.verified).toBe(false);
  });

  it('processa mais de uma página sem duplicar testes e preserva falhas por timeout', () => {
    const { repos, results, append, task } = setup();
    append('start', 'command.started', { command: 'npm test' });
    for (let index = 0; index < 505; index++) append(`line-${index}`, 'info', null);
    append('finish', 'command.finished', { command: 'npm test', exitCode: 0 });
    append('timeout', 'command.finished', { command: 'npm run lint', exitCode: 0, timedOut: true });
    repos.tasks.put({
      ...task,
      status: 'completed',
      result: {
        summary: 'ok',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        commit: null,
        commands: [
          { command: 'npm test', exitCode: 0, durationMs: 1, timedOut: false, outputTail: '' },
        ],
        usage: { promptTokens: 0, completionTokens: 0 },
      },
    });
    const report = results.refresh('r');
    expect(report.eventCount).toBe(508);
    expect(report.tests).toHaveLength(2);
    expect(report.tests.map((test) => test.status)).toEqual(['passed', 'failed']);
  });

  it('isola falhas da projeção e mantém o estado real da missão', async () => {
    vi.useFakeTimers();
    const { repos, results } = setup();
    vi.spyOn(repos, 'saveLiveResult').mockImplementation(() => {
      throw new Error('Disk failure');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    results.schedule('r');
    await vi.advanceTimersByTimeAsync(600);
    expect(repos.runs.get('r')?.status).toBe('running');
    expect(results.context('r')).toContain('indisponível');
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('agrupa bursts em segundo plano sem depender do Canvas nem do modelo', async () => {
    vi.useFakeTimers();
    const { results, append, repos, notify } = setup();
    append('one', 'file.changed', { path: 'a.ts' });
    results.schedule('r');
    results.schedule('r');
    results.schedule('r');
    expect(repos.getLiveResult('r')).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(notify).toHaveBeenCalledOnce();
    expect(repos.getLiveResult('r')?.files[0]?.path).toBe('a.ts');
    expect(repos.runs.get('r')?.status).toBe('running');
  });

  it('isola missões e impede uma janela antiga de substituir notas novas', () => {
    const { repos, results, append } = setup();
    const note = repos.saveMissionNote(
      'm',
      '# Pessoal\n- [ ] Rever login\n```ts\nconst x = 1;\n```',
      0,
    );
    append('one', 'file.changed', { path: 'a.ts' });
    results.refresh('r');
    expect(repos.getMissionNote('m')).toEqual(note);
    expect(() => repos.saveMissionNote('m', 'versão antiga', 0)).toThrow(/outra janela/);
    expect(repos.getMissionNote('m')).toEqual(note);
    repos.missions.put({
      id: 'other',
      workspaceId: 'w',
      title: 'Outra',
      objective: 'x',
      createdAt: at,
    });
    expect(repos.getMissionNote('other').text).toBe('');
    expect(results.context('r')).not.toContain('# Pessoal');
    expect(() => repos.getMissionNote('missing')).toThrow();
  });

  it('restaura histórico, relatório, notas e layout após fechar e reiniciar o banco', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hive-result-'));
    roots.push(root);
    const file = path.join(root, 'hive.db');
    const { db, repos, results, append } = setup(file);
    append('one', 'file.changed', { path: 'persist.ts' });
    const report = results.refresh('r');
    const note = repos.saveMissionNote('m', 'Não apagar', 0);
    repos.setValue(
      'canvasLayout:r',
      JSON.stringify({
        pinned: { workspace: { 'result:m': { x: 900, y: 230 } } },
        sizes: { 'result:m': { width: 400, height: 250 } },
      }),
    );
    results.dispose();
    projections.splice(projections.indexOf(results), 1);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = new HiveDatabase(file);
    databases.push(reopened);
    const restored = new Repositories(reopened);
    const restarted = new LiveResults(restored, vi.fn());
    projections.push(restarted);
    expect(restarted.refresh('r')).toEqual(report);
    expect(restored.getMissionNote('m')).toEqual(note);
    expect(restored.resultEvents('r').events.map((item) => item.event.id)).toEqual(['one']);
    expect(JSON.parse(restored.getValue('canvasLayout:r')!).pinned.workspace['result:m']).toEqual({
      x: 900,
      y: 230,
    });
  });
});
