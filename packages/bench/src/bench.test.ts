import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { benchTasks } from './tasks';
import { applySolution, changedFiles, grade, prepareWorkdir } from './workspace';

// The bench is only worth something if every check fails on the untouched fixture (the task is
// real) and passes with the reference solution (the task is doable and the check is fair).
describe('Hive Bench: as tarefas são reais e possíveis', () => {
  for (const task of benchTasks) {
    it(`${task.id} (nível ${task.level})`, { timeout: 60_000 }, async () => {
      const dir = await prepareWorkdir(task.id);
      try {
        const before = await grade(task.id, dir);
        expect(before.passed, 'a verificação deveria falhar no projeto original').toBe(false);
        expect(before.noRegressions).toBe(true);
        await applySolution(task.id, dir);
        const after = await grade(task.id, dir);
        expect(after.passed, after.output).toBe(true);
        expect(after.noRegressions, after.output).toBe(true);
        expect((await changedFiles(dir)).length).toBeGreaterThan(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
