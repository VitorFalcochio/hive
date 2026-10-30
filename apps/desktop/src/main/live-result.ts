import { collectResultFacts, resultEventTypes, resultUpdate, type LiveResult } from '@hive/core';
import type { Repositories } from '@hive/persistence';

/** Main-process projection. It runs without a canvas window and never calls the scheduler/model. */
export class LiveResults {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly repos: Repositories,
    private readonly notify: (runId: string) => void,
  ) {}

  schedule(runId: string): void {
    if (this.timers.has(runId)) return;
    this.timers.set(
      runId,
      setTimeout(() => {
        this.timers.delete(runId);
        // A documentation failure must never fail a running mission. The next read retries.
        try {
          this.refresh(runId);
        } catch (error) {
          console.error('Resultado Vivo:', error);
        }
      }, 600),
    );
  }

  refresh(runId: string): LiveResult {
    const run = this.repos.runs.require(runId, 'Execução');
    const mission = this.repos.missions.require(run.missionId, 'Missão');
    const tasks = this.repos.tasks.list('run_id = ?', runId);
    const previous = this.repos.getLiveResult(runId);
    let cursor = previous?.cursor ?? 0;
    let eventCount = previous?.eventCount ?? 0;
    let changeCount = previous?.changeCount ?? 0;
    let updates = previous?.updates ?? [];
    let facts = { files: previous?.files ?? [], tests: previous?.tests ?? [] };
    let more = true;
    while (more) {
      const page = this.repos.resultEvents(runId, { after: cursor, limit: 500 });
      const relevant = page.events
        .map((item) => item.event)
        .filter(
          (event) =>
            resultEventTypes.has(event.type) || event.level === 'error' || event.level === 'warn',
        );
      facts = collectResultFacts(tasks, relevant, facts, false);
      updates = updates.concat(relevant.map(resultUpdate)).slice(-50);
      eventCount += page.events.length;
      changeCount += relevant.length;
      cursor = page.events.at(-1)?.cursor ?? cursor;
      more = page.hasMore;
    }
    facts = collectResultFacts(tasks, [], facts);
    const names = (statuses: string[]) =>
      tasks
        .filter((task) => statuses.includes(task.status))
        .map((task) => `${task.key}: ${task.title} [task:${task.id}]`);
    const completed = names(['completed', 'approved']);
    const active = names(['running', 'waiting_approval']);
    const remaining = names(['pending', 'blocked', 'failed', 'cancelled', 'rejected']);
    const risks = [
      ...updates
        .filter((update) => update.level === 'error' || update.level === 'warn')
        .slice(-5)
        .map(
          (update) =>
            `Ocorrência registrada; verificar resolução: ${update.text} [event:${update.eventId}]`,
        ),
      ...(run.error ? [`Execução: ${run.error}`] : []),
      ...tasks
        .filter(
          (task) =>
            task.error ||
            ['failed', 'blocked', 'waiting_approval', 'rejected'].includes(task.status),
        )
        .map((task) => `${task.key}: ${task.error ?? task.status} [task:${task.id}]`),
      ...facts.tests
        .filter((test) => test.status === 'failed')
        .map((test) => `Teste falhou: ${test.command} [${test.evidence}]`),
    ];
    const next = tasks
      .filter((task) => ['pending', 'blocked'].includes(task.status))
      .map(
        (task) =>
          `${task.key}: ${task.dependsOn.length ? `aguarda ${task.dependsOn.join(', ')}` : 'aguarda execução pelo motor'} [task:${task.id}]`,
      );
    const summary = `${mission.objective}\n\n${completed.length}/${tasks.length} tarefas concluídas; ${active.length} em andamento; ${remaining.length} por concluir. ${facts.files.length} arquivo(s) registrado(s). ${facts.tests.length ? `Testes/verificações: ${facts.tests.filter((test) => test.status === 'passed').length} aprovado(s), ${facts.tests.filter((test) => test.status === 'failed').length} falhou(ram), ${facts.tests.filter((test) => test.status === 'running').length} em execução, ${facts.tests.filter((test) => test.status === 'unverified').length} não verificado(s).` : 'Testes não executados: nenhuma evidência registrada.'} Estado do motor: ${run.status}.`;
    const result: LiveResult = {
      version: 1,
      runId,
      missionId: mission.id,
      cursor,
      eventCount,
      changeCount,
      updatedAt: previous?.updatedAt ?? null,
      mode: 'deterministic',
      summary,
      completed,
      active,
      remaining,
      risks,
      next,
      ...facts,
      updates,
    };
    if (JSON.stringify(previous) !== JSON.stringify(result)) {
      result.updatedAt = new Date().toISOString();
      this.repos.saveLiveResult(result);
      this.notify(runId);
    }
    return result;
  }

  /** Bounded selective context for the Queen; manual notes are never read. */
  context(runId: string): string {
    try {
      const result = this.refresh(runId);
      return `Resultado Vivo: run:${runId}, cursor:${result.cursor}. Fonte: registros do motor; agregação determinística.\n${result.summary.slice(0, 1600)}\n${result.risks.slice(0, 3).join('\n').slice(0, 600)}`;
    } catch {
      return `Resultado Vivo indisponível para run:${runId}. Consulte os registros do motor; não presuma progresso ou validação.`;
    }
  }

  dispose(): void {
    for (const [runId, timer] of this.timers) {
      clearTimeout(timer);
      try {
        this.refresh(runId);
      } catch {
        /* Deleted missions need no projection. */
      }
    }
    this.timers.clear();
  }
}
