import { describe, expect, it } from 'vitest';
import type { AgentTaskInput } from './runtime';
import { buildTaskPrompt } from './native-runtime';

const task: AgentTaskInput['task'] = {
  title: 'Tela de login',
  description: 'Criar a tela.',
  acceptanceCriteria: ['Mostra erro de senha'],
  upstream: [],
};

describe('buildTaskPrompt', () => {
  it('has no review section on a first attempt', () => {
    expect(buildTaskPrompt({ task } as AgentTaskInput)).not.toContain('Review of your previous');
  });

  it('gives the agent each line comment, the general note and its previous summary', () => {
    const prompt = buildTaskPrompt({
      task: {
        ...task,
        review: {
          round: 2,
          previousSummary: 'Criei o formulário.',
          note: 'Siga o tema escuro.',
          comments: [
            {
              path: 'src/Login.tsx',
              line: 12,
              side: 'new',
              code: '  <button>OK</button>',
              body: 'Troque para Entrar.',
            },
            {
              path: 'src/old.css',
              line: 3,
              side: 'old',
              code: 'color: red;',
              body: 'Não apague isso.',
            },
          ],
        },
      },
    } as AgentTaskInput);
    expect(prompt).toContain('## Review of your previous result (round 2)');
    expect(prompt).toContain('do not start over');
    expect(prompt).toContain('Criei o formulário.');
    expect(prompt).toContain('- src/Login.tsx:12 `<button>OK</button>`: Troque para Entrar.');
    expect(prompt).toContain('- src/old.css:3 (removed line) `color: red;`: Não apague isso.');
    expect(prompt).toContain('Siga o tema escuro.');
  });
});
