import { expect, it } from 'vitest';
import { extractJson, validatePlan } from './queen';

it('lê JSON em bloco Markdown e detecta ciclos antes da execução', () => {
  const value = extractJson(
    'Plano:\n```json\n{"notes":"ok","tasks":[{"key":"a","title":"A","description":"A","workerId":null,"dependsOn":["b"],"acceptanceCriteria":["A pronto"]},{"key":"b","title":"B","description":"B","workerId":null,"dependsOn":["a"],"acceptanceCriteria":["B pronto"]}]}\n```',
  );
  const result = validatePlan(value, new Set());
  expect(result.plan).toBeNull();
  expect(result.errors.some((error) => error.includes('cycle'))).toBe(true);
});
