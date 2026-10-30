// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('splits a summary into headings, lists, paragraphs and code', () => {
    const blocks = parseMarkdown(
      [
        '## Feito',
        'Criei o arquivo',
        'com o mapa.',
        '',
        '- **Python** (`voice.py`): áudio',
        '  continua aqui',
        '- Skills',
        '1. Primeiro',
        '```',
        'npm test',
        '```',
      ].join('\n'),
    );

    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Feito' },
      { kind: 'paragraph', text: 'Criei o arquivo com o mapa.' },
      {
        kind: 'list',
        ordered: false,
        items: ['**Python** (`voice.py`): áudio continua aqui', 'Skills'],
      },
      { kind: 'list', ordered: true, items: ['Primeiro'] },
      { kind: 'code', text: 'npm test' },
    ]);
  });
});

describe('parseMarkdown tables', () => {
  it('reads a pipe table, skipping its rule line', () => {
    expect(
      parseMarkdown('| Camada | Arquivos |\n|--------|:--------:|\n| Main | `main.js` |'),
    ).toEqual([{ kind: 'table', head: ['Camada', 'Arquivos'], rows: [['Main', '`main.js`']] }]);
  });
});

describe('Markdown', () => {
  it('renderiza checklists sem alterar o texto e mantém blocos de código', () => {
    const { container } = render(
      <Markdown source={'# Notas\n- [ ] Revisar\n- [x] Implementar\n```ts\nconst x = 1;\n```'} />,
    );
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...boxes].map((box) => [box.checked, box.disabled])).toEqual([
      [false, true],
      [true, true],
    ]);
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1;');
  });
  it('draws bold, italic and code instead of their marks, and never HTML', () => {
    const { container } = render(
      <Markdown source={'**Python** usa `edge-tts` e _encerrou_ <img src=x onerror=alert(1)>'} />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('Python');
    expect(container.querySelector('code')?.textContent).toBe('edge-tts');
    expect(container.querySelector('em')?.textContent).toBe('encerrou');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('**');
  });
});
