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

it('só fala de líderes de equipe quando o Hive Teams está ligado', async () => {
  const { buildPlanPrompt } = await import('./queen');
  const request = {
    objective: 'Criar uma API de tarefas',
    title: 'API',
    workers: [],
    projectContext: '',
    chat: {} as never,
    model: 'm',
    queen: { systemPrompt: 'Você é a Queen.' } as never,
  };
  const off = String(buildPlanPrompt(request)[0]!.content);
  const on = String(buildPlanPrompt({ ...request, teams: true })[0]!.content);
  expect(off).not.toContain('Hive Teams');
  expect(off).not.toContain('"lead"');
  expect(on).toContain('Hive Teams is on');
  expect(on).toContain('"lead": true');
  // A plan with a lead task is valid; one without stays valid as always.
  const plan = (lead?: boolean) => ({
    notes: 'n',
    tasks: [
      {
        key: 'api',
        title: 'API',
        description: 'd',
        workerId: null,
        dependsOn: [],
        acceptanceCriteria: ['ok'],
        ...(lead === undefined ? {} : { lead }),
      },
    ],
  });
  expect(validatePlan(plan(true), new Set()).plan?.tasks[0]?.lead).toBe(true);
  expect(validatePlan(plan(), new Set()).plan?.tasks[0]?.lead).toBeUndefined();
});

it('a Queen chama especialistas só quando a missão pede', async () => {
  const { buildPlanPrompt } = await import('./queen');
  const prompt = String(
    buildPlanPrompt({
      objective: 'Corrigir o login',
      title: 'Login',
      workers: [],
      projectContext: '',
      chat: {} as never,
      model: 'm',
      queen: { systemPrompt: 'Você é a Queen.' } as never,
    })[0]!.content,
  );
  expect(prompt).toContain('never just because they exist');
  for (const role of [
    'explorer',
    'debugger',
    'security',
    'database',
    'performance',
    'integration',
    'requirements',
  ])
    expect(prompt).toContain(role);
});

it('pede contrato primeiro, esqueleto num projeto do zero, integração final e comandos de verificação', async () => {
  const { buildPlanPrompt } = await import('./queen');
  const messages = buildPlanPrompt({
    objective: 'Criar um app desktop do zero',
    title: 'App',
    workers: [],
    projectContext: '',
    chat: {} as never,
    model: 'm',
    queen: { systemPrompt: 'Você é a Queen.' } as never,
  });
  const system = String(messages[0]!.content);
  expect(system).toContain('Contract first');
  expect(system).toContain('started from scratch');
  expect(system).toContain('The last task integrates');
  expect(String(messages[1]!.content)).toContain('"verify"');
  // "verify" is optional: older plans stay valid, and a plan with it keeps it.
  const tasks = [
    {
      key: 'a',
      title: 'A',
      description: 'A',
      workerId: null,
      dependsOn: [],
      acceptanceCriteria: ['ok'],
    },
  ];
  expect(validatePlan({ notes: 'n', tasks }, new Set()).plan).not.toBeNull();
  expect(
    validatePlan({ notes: 'n', tasks, verify: ['npm run build'] }, new Set()).plan?.verify,
  ).toEqual(['npm run build']);
});
