import type { AgentEvent, Task } from '@hive/core';

/**
 * One line of the Dialogue block: who said what to whom, as it really happened in the run.
 * Every line comes from a recorded fact (a task assigned, started, delivered or failed, a Hive
 * Teams action, a check or a replan); nothing is made up to fill the conversation.
 */
export interface DialogueMessage {
  id: string;
  at: string;
  /** Worker id of who speaks; null for Hive itself (checks, automatic retries). */
  from: string | null;
  /** Worker ids it is addressed to; empty for the whole team. */
  to: string[];
  kind: 'assign' | 'start' | 'deliver' | 'fail' | 'team' | 'flow' | 'replan';
  text: string;
}

const MAX_MESSAGES = 200;
const MAX_TEXT = 600;

const clip = (text: string, max = MAX_TEXT) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const DONE = new Set<Task['status']>(['completed', 'approved']);

/**
 * The conversation of a run, oldest first: the Queen handing out the plan, each agent starting
 * with what it received, delivering to those who wait on it (or saying why it could not), and
 * what Hive Teams, the flow checks and replanning said along the way. The newest
 * `MAX_MESSAGES` are kept.
 */
export function buildDialogue(input: {
  tasks: Task[];
  events: AgentEvent[];
  queenWorkerId: string | null;
}): DialogueMessage[] {
  const { events, queenWorkerId } = input;
  // An attempt of a task is not a task of its own: the task speaks for its attempts.
  const tasks = input.tasks.filter((task) => !task.candidateOf);
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const workersOf = (keys: string[]) => [
    ...new Set(keys.map((key) => byKey.get(key)?.workerId).filter((id): id is string => !!id)),
  ];
  const messages: DialogueMessage[] = [];
  for (const task of tasks) {
    const waiting = tasks.filter((item) => item.dependsOn.includes(task.key));
    if (task.workerId && task.workerId !== queenWorkerId)
      messages.push({
        id: `${task.id}:assign`,
        at: task.createdAt,
        from: queenWorkerId,
        to: [task.workerId],
        kind: 'assign',
        text: clip(
          `“${task.title}”${task.acceptanceCriteria[0] ? `. Pronto quando: ${task.acceptanceCriteria[0]}` : ''}`,
        ),
      });
    if (task.startedAt) {
      const received = task.dependsOn
        .map((key) => byKey.get(key))
        .filter((item): item is Task => !!item && DONE.has(item.status));
      messages.push({
        id: `${task.id}:start`,
        at: task.startedAt,
        from: task.workerId,
        to: workersOf(received.map((item) => item.key)),
        kind: 'start',
        text: clip(
          received.length
            ? `Começando “${task.title}” com o que recebi de ${received.map((item) => `“${item.title}”`).join(', ')}.`
            : `Começando “${task.title}”.`,
        ),
      });
    }
    if (task.finishedAt && DONE.has(task.status))
      messages.push({
        id: `${task.id}:deliver`,
        at: task.finishedAt,
        from: task.workerId,
        to: workersOf(waiting.map((item) => item.key)),
        kind: 'deliver',
        text: clip(
          task.result?.summary?.trim()
            ? `Entreguei “${task.title}”: ${task.result.summary}`
            : `Entreguei “${task.title}”.`,
        ),
      });
    else if (task.finishedAt && task.status === 'failed')
      messages.push({
        id: `${task.id}:fail`,
        at: task.finishedAt,
        from: task.workerId,
        to: workersOf(waiting.map((item) => item.key)),
        kind: 'fail',
        text: clip(`Não consegui terminar “${task.title}”${task.error ? `: ${task.error}` : '.'}`),
      });
  }
  for (const event of events) {
    const source = typeof event.data?.source === 'string' ? event.data.source : null;
    const kind: DialogueMessage['kind'] | null =
      event.type === 'team'
        ? 'team'
        : source === 'nexus-autopilot-recovery'
          ? 'replan'
          : source === 'flow'
            ? 'flow'
            : null;
    if (!kind) continue;
    const task = event.taskId ? tasks.find((item) => item.id === event.taskId) : undefined;
    messages.push({
      id: event.id,
      at: event.ts,
      // A replan speaks as the Queen; the flow and Hive Teams as whoever the event names, and
      // the flow as Hive itself when it names nobody.
      from: kind === 'replan' ? queenWorkerId : event.workerId,
      to: kind === 'flow' && task?.workerId ? [task.workerId] : [],
      kind,
      text: clip(event.message),
    });
  }
  return messages
    .filter((message) => message.at)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .slice(-MAX_MESSAGES);
}
