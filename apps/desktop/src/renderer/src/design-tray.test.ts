import { describe, expect, it } from 'vitest';
import { planSchema } from '@hive/core';
import { buildDesignTask, designPlan, noteLines, type DesignNote } from './design-tray';

const note = (overrides: Partial<DesignNote> = {}): DesignNote => ({
  id: 'n1',
  element: {
    tag: 'button',
    id: null,
    classes: ['btn', 'primary'],
    selector: 'header > button',
    text: 'Salvar',
  },
  file: { path: 'src/Header.tsx', line: 4 },
  changes: [{ property: 'backgroundColor', from: 'rgb(0, 0, 255)', to: '#22c55e' }],
  newText: 'Enviar',
  comment: 'Deixe mais destacado',
  image: null,
  ...overrides,
});

describe('noteLines', () => {
  it('lists the text change, each style and the request', () => {
    expect(noteLines(note())).toEqual([
      'Texto: "Salvar" → "Enviar"',
      'background-color: rgb(0, 0, 255) → #22c55e',
      'Pedido: Deixe mais destacado',
    ]);
  });
});

describe('buildDesignTask', () => {
  it('names each element, its likely file and the changes', () => {
    const task = buildDesignTask(
      [note(), note({ id: 'n2', file: null, changes: [], newText: null })],
      'http://localhost:5173/',
    );
    expect(task.title).toBe('Ajustes de design (2 itens)');
    expect(task.included).toBe(2);
    expect(task.description).toContain('http://localhost:5173/');
    expect(task.description).toContain(
      '1. <button class="btn primary"> com o texto "Salvar" (seletor: header > button)',
    );
    expect(task.description).toContain('Arquivo provável: src/Header.tsx:4');
    expect(task.description).toContain('   - background-color: rgb(0, 0, 255) → #22c55e');
    expect(task.description).toContain('Arquivo: desconhecido');
  });

  it('stays within the task size and says how many notes were left out', () => {
    const notes = Array.from({ length: 40 }, (_, index) =>
      note({ id: `n${index}`, comment: 'x'.repeat(300) }),
    );
    const task = buildDesignTask(notes, '');
    expect(task.description.length).toBeLessThanOrEqual(4_000);
    expect(task.included).toBeLessThan(40);
    expect(task.description).toContain(`${40 - task.included} anotação(ões) não couberam`);
  });

  it('builds a plan the main process accepts', () => {
    const plan = designPlan(buildDesignTask([note()], ''), null);
    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(plan.tasks[0]?.title).toBe('Ajustes de design (1 item)');
  });
});
