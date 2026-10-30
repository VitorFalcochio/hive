import type { CortexMemory, CortexNotification, Worker } from '@hive/core';
import type { CortexRepository } from '@hive/persistence';
import { newId, nowIso } from '@hive/shared';
import { conceptsOf, memoryText } from './embeddings';
import type { MemoryChange } from './ledger';

/** Kinds other agents build on; a change to a plain discovery does not interrupt anyone. */
const BINDING = new Set<CortexMemory['kind']>([
  'decision',
  'api_contract',
  'convention',
  'requirement',
]);

/** Topics per role, as in ranking: a binding change on one of them concerns that role. */
const roleTopics: Partial<Record<Worker['role'], string[]>> = {
  frontend: ['ui', 'api', 'auth', 'state', 'validation'],
  backend: ['api', 'database', 'auth', 'security', 'access', 'payment', 'messaging'],
  qa: ['test', 'requirement', 'validation'],
  architect: ['architecture', 'database', 'api', 'deploy', 'security'],
  reviewer: ['architecture', 'security', 'test'],
};

const changeLabels: Record<CortexNotification['change'], string> = {
  approved: 'nova memória aprovada',
  updated: 'memória atualizada',
  superseded: 'decisão substituída',
  revoked: 'memória revogada',
};

/**
 * Who should hear about a change: connected agents with Read (never the one who caused it) that
 * already used the memory, that it names as its audience, or (when it names nobody) whose role
 * works on what a binding memory is about. Notices wait for the agent's next task: nobody is
 * interrupted mid-work, and nothing goes to every agent by default.
 */
export function planNotifications(
  repo: CortexRepository,
  change: MemoryChange,
  workers: Map<string, Worker>,
): CortexNotification[] {
  const { node, memory, replaced } = change;
  if (!node.config.changeNotifications) return [];
  const chain = [
    memory.id,
    ...(replaced ? [replaced.id] : []),
    ...(memory.supersedes ? [memory.supersedes] : []),
  ];
  const concepts = conceptsOf(memoryText(memory));
  const notices: CortexNotification[] = [];
  const pending = repo.notifications.list('cortex_id = ? AND delivered = 0', node.id);
  for (const connection of node.connections) {
    if (!connection.permissions.read) continue;
    const worker = workers.get(connection.workerId);
    if (!worker || worker.role === 'queen') continue;
    if (worker.id === memory.author.workerId || worker.id === change.actor.workerId) continue;
    const seen = repo.memoriesSeenBy(node.id, worker.id);
    let reason: string | null = null;
    if (chain.some((id) => seen.has(id))) reason = 'Você já usou esta memória em uma tarefa.';
    else if (memory.audience.includes(worker.role as (typeof memory.audience)[number]))
      reason = 'A memória foi marcada como relevante para o seu papel.';
    else if (
      !memory.audience.length &&
      BINDING.has(memory.kind) &&
      (roleTopics[worker.role] ?? []).some((topic) => concepts.has(topic))
    )
      reason = 'O assunto faz parte do trabalho do seu papel.';
    if (!reason) continue;
    // One waiting notice per agent and memory chain: a later change replaces the earlier one.
    const earlier = pending.find(
      (notice) => notice.workerId === worker.id && chain.includes(notice.memoryId),
    );
    const notice: CortexNotification = {
      id: earlier?.id ?? newId('cxn'),
      cortexId: node.id,
      workspaceId: node.workspaceId,
      workerId: worker.id,
      memoryId: memory.id,
      change: change.change,
      reason,
      createdAt: nowIso(),
      deliveredAt: null,
      deliveredTaskId: null,
    };
    repo.notifications.put(notice);
    notices.push(notice);
  }
  if (notices.length)
    repo.log({
      cortexId: node.id,
      workspaceId: node.workspaceId,
      type: 'notified',
      actor: { kind: 'system', workerId: null, name: 'Cortex' },
      runId: null,
      taskId: null,
      message: `${changeLabels[change.change]}: “${memory.title}”. Aviso para ${notices.map((notice) => workers.get(notice.workerId)?.name ?? notice.workerId).join(', ')} na próxima tarefa.`,
      memoryIds: [memory.id],
      data: { workers: notices.map((notice) => notice.workerId), change: change.change },
    });
  return notices;
}

/** Waiting notices for an agent in a project, marked as handed over to this task. */
export function deliverNotifications(
  repo: CortexRepository,
  cortexIds: string[],
  workerId: string,
  taskId: string,
): { notice: CortexNotification; memory: CortexMemory | null }[] {
  if (!cortexIds.length) return [];
  const delivered: { notice: CortexNotification; memory: CortexMemory | null }[] = [];
  const at = nowIso();
  for (const notice of repo.notifications.list('worker_id = ? AND delivered = 0', workerId)) {
    if (!cortexIds.includes(notice.cortexId)) continue;
    const saved = repo.notifications.put({ ...notice, deliveredAt: at, deliveredTaskId: taskId });
    delivered.push({ notice: saved, memory: repo.memories.get(notice.memoryId) });
  }
  return delivered;
}

export const noticeLabel = (notice: CortexNotification) => changeLabels[notice.change];
