import type { Mission, Run, Task, Worker } from '@hive/core';

/**
 * Consolidated run report built only from recorded facts (task results, commands, diffs).
 * It is deterministic on purpose: no model is asked to describe what happened.
 */
export function buildRunReport(mission: Mission, run: Run, tasks: Task[], workers: Worker[]): string {
  const names = new Map(workers.map((worker) => [worker.id, worker.name]));
  const count = (status: Task['status']) => tasks.filter((task) => task.status === status).length;
  const lines = [
    `# ${mission.title}`,
    '',
    `Run \`${run.id}\` · base \`${run.baseBranch}\` @ \`${run.baseCommit.slice(0, 10)}\``,
    '',
    `Tasks: ${tasks.length} · completed ${count('completed')} · approved ${count('approved')} · failed ${count('failed')} · cancelled ${count('cancelled')} · rejected ${count('rejected')} · not started ${count('pending') + count('blocked')}`,
    '',
  ];
  let prompt = 0;
  let completion = 0;
  for (const task of tasks) {
    const result = task.result;
    prompt += result?.usage.promptTokens ?? 0;
    completion += result?.usage.completionTokens ?? 0;
    lines.push(`## ${task.title} — ${task.status}`);
    lines.push(`Worker: ${task.workerId ? (names.get(task.workerId) ?? task.workerId) : 'unassigned'} · attempt ${task.attempt}${task.branch ? ` · branch \`${task.branch}\`` : ''}`);
    if (task.error) lines.push('', `Error: ${task.error}`);
    if (result) {
      if (result.summary) lines.push('', result.summary);
      if (result.filesChanged.length) {
        lines.push('', `Files (${result.filesChanged.length}, +${result.insertions} −${result.deletions}):`);
        for (const file of result.filesChanged.slice(0, 40)) lines.push(`- ${file.status} ${file.path}`);
      }
      if (result.commands.length) {
        lines.push('', 'Commands:');
        for (const command of result.commands) {
          lines.push(`- \`${command.command}\` → ${command.timedOut ? 'timed out' : `exit ${command.exitCode ?? '?'}`}`);
        }
      }
    }
    lines.push('');
  }
  lines.push(`Token usage reported by providers: ${prompt.toLocaleString('en-US')} prompt / ${completion.toLocaleString('en-US')} completion.`);
  const branches = tasks.filter((task) => task.branch && (task.status === 'approved' || task.status === 'completed'));
  if (branches.length) {
    lines.push('', 'To integrate approved work, review and merge the task branches yourself, for example:');
    for (const task of branches) lines.push(`    git merge --no-ff ${task.branch}`);
  }
  return lines.join('\n');
}
