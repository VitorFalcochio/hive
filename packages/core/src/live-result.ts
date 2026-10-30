import type { AgentEvent, Task } from './domain';
import { looksLikeTestCommand } from './state';

export interface MissionNote {
  missionId: string;
  text: string;
  revision: number;
  updatedAt: string | null;
}

export interface ResultFile {
  path: string;
  status: string;
  taskId: string;
  evidence: string;
  commit: string | null;
  worktree: string | null;
}

export interface ResultTest {
  id: string;
  taskId: string;
  command: string;
  status: 'running' | 'passed' | 'failed' | 'unverified';
  exitCode: number | null;
  output: string;
  evidence: string;
}

export interface ResultUpdate {
  level: AgentEvent['level'];
  eventId: string;
  ts: string;
  taskId: string | null;
  workerId: string | null;
  text: string;
  verified: boolean;
}

/** Generated data has no notes field and no write path to manual content. */
export interface LiveResult {
  version: 1;
  runId: string;
  missionId: string;
  cursor: number;
  eventCount: number;
  changeCount: number;
  updatedAt: string | null;
  mode: 'deterministic';
  summary: string;
  completed: string[];
  active: string[];
  remaining: string[];
  risks: string[];
  next: string[];
  files: ResultFile[];
  tests: ResultTest[];
  updates: ResultUpdate[];
}

export interface ResultEventPage {
  events: { cursor: number; event: AgentEvent }[];
  hasMore: boolean;
}

function checkStatus(
  command: string,
  exitCode: number | null,
  timedOut: boolean,
): ResultTest['status'] {
  if (timedOut || (exitCode !== null && exitCode !== 0)) return 'failed';
  // Shell fallbacks/pipelines can mask a failed check with a successful final command.
  if (exitCode === null || /\|\||[;|]/.test(command)) return 'unverified';
  return 'passed';
}

export const resultEventTypes: ReadonlySet<string> = new Set([
  'run.status',
  'task.status',
  'file.changed',
  'command.started',
  'command.finished',
  'approval.requested',
  'approval.resolved',
  'git',
  'plan',
  'error',
]);

/** Narrative is a literal, attributable observation, never a model's inference. */
export function resultUpdate(event: AgentEvent): ResultUpdate {
  const data = event.data;
  let text = event.message;
  let verified = false;
  if (event.type === 'file.changed' && typeof data?.path === 'string') {
    text = `Arquivo ${data.path}: ${typeof data.action === 'string' ? data.action : 'modificado'}.`;
    verified = true;
  } else if (
    (event.type === 'command.started' || event.type === 'command.finished') &&
    typeof data?.command === 'string'
  ) {
    const test = looksLikeTestCommand(data.command);
    const code = typeof data.exitCode === 'number' ? data.exitCode : null;
    text =
      event.type === 'command.started'
        ? `${test ? 'Teste/verificação' : 'Comando'} iniciado: ${data.command}`
        : `${test ? 'Teste/verificação' : 'Comando'} finalizado: ${data.command}. ${data.timedOut === true ? 'Tempo esgotado.' : code === null ? 'Resultado não verificado.' : `Código de saída: ${code}.`}`;
    verified = event.type === 'command.started' || code !== null || data.timedOut === true;
  } else if (event.type === 'task.status' || event.type === 'run.status') {
    verified = typeof data?.status === 'string';
    if (verified)
      text = `${event.type === 'task.status' ? 'Tarefa' : 'Execução'}: ${data!.status}. ${event.message}`;
  } else if (event.type === 'git' && data?.action === 'merged' && typeof data.branch === 'string') {
    text = `Merge concluído em ${data.branch}${typeof data.commit === 'string' ? ` (commit ${data.commit})` : ''}.`;
    verified = true;
  }
  return {
    level: event.level,
    eventId: event.id,
    ts: event.ts,
    taskId: event.taskId,
    workerId: event.workerId,
    text,
    verified,
  };
}

/** Only command execution and Git/task records qualify as test/file evidence. */
export function collectResultFacts(
  tasks: Task[],
  events: AgentEvent[],
  previous?: Pick<LiveResult, 'files' | 'tests'>,
  settled = true,
): { files: ResultFile[]; tests: ResultTest[] } {
  const files = new Map(
    (previous?.files ?? []).map((file) => [`${file.taskId}:${file.path}`, { ...file }]),
  );
  const tests: ResultTest[] = (previous?.tests ?? []).map((test) => ({ ...test }));
  const open = new Map<string, ResultTest>();
  for (const test of tests)
    if (test.status === 'running') open.set(`${test.taskId}:${test.command}`, test);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (!event.taskId) continue;
    const task = byId.get(event.taskId);
    const data = event.data;
    if (event.type === 'file.changed' && typeof data?.path === 'string') {
      const prior = files.get(`${event.taskId}:${data.path}`);
      files.set(`${event.taskId}:${data.path}`, {
        path: data.path,
        status:
          prior?.status === 'created' && data.action === 'modified'
            ? 'created'
            : typeof data.action === 'string'
              ? data.action
              : 'modified',
        taskId: event.taskId,
        evidence: `event:${event.id}`,
        commit: null,
        worktree: task?.worktreePath ?? null,
      });
    }
    if (
      (event.type !== 'command.started' && event.type !== 'command.finished') ||
      typeof data?.command !== 'string' ||
      !looksLikeTestCommand(data.command)
    )
      continue;
    const key = `${event.taskId}:${data.command}`;
    if (event.type === 'command.started') {
      const test: ResultTest = {
        id: event.id,
        taskId: event.taskId,
        command: data.command,
        status: 'running',
        exitCode: null,
        output: '',
        evidence: `event:${event.id}`,
      };
      tests.push(test);
      open.set(key, test);
    } else {
      const test = open.get(key) ?? {
        id: event.id,
        taskId: event.taskId,
        command: data.command,
        status: 'unverified' as const,
        exitCode: null,
        output: '',
        evidence: `event:${event.id}`,
      };
      if (!open.has(key)) tests.push(test);
      test.exitCode = typeof data.exitCode === 'number' ? data.exitCode : null;
      test.status = checkStatus(data.command, test.exitCode, data.timedOut === true);
      test.output = typeof data.outputTail === 'string' ? data.outputTail : '';
      test.evidence = `event:${event.id}`;
      open.delete(key);
    }
  }
  for (const task of tasks) {
    if (!settled) continue;
    // An interrupted command has no successful exit evidence.
    if (settled && !['running', 'waiting_approval'].includes(task.status))
      for (const test of tests)
        if (test.taskId === task.id && test.status === 'running') test.status = 'unverified';
    if (!task.result || ['running', 'waiting_approval'].includes(task.status)) continue;
    for (const file of task.result.filesChanged)
      files.set(`${task.id}:${file.path}`, {
        ...file,
        taskId: task.id,
        evidence: `task:${task.id}:attempt:${task.attempt}`,
        commit: task.result.commit,
        worktree: task.worktreePath,
      });
    task.result.commands.forEach((command, index) => {
      if (
        !looksLikeTestCommand(command.command) ||
        tests.some(
          (test) =>
            test.taskId === task.id &&
            test.command === command.command &&
            test.exitCode === command.exitCode &&
            test.status !== 'running',
        )
      )
        return;
      tests.push({
        id: `${task.id}:${task.attempt}:${index}`,
        taskId: task.id,
        command: command.command,
        status: checkStatus(command.command, command.exitCode, command.timedOut),
        exitCode: command.exitCode,
        output: command.outputTail,
        evidence: `task:${task.id}:attempt:${task.attempt}:command:${index}`,
      });
    });
  }
  return { files: [...files.values()], tests };
}
