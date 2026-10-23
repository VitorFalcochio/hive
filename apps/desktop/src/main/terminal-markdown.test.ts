import { describe, expect, it } from 'vitest';
import { cleanTerminalOutput } from './terminal';
import { parseInline, renderMarkdown, textWidth } from './terminal-markdown';

const plain = (markdown: string, width = 60) =>
  renderMarkdown(markdown, width).map((line) => cleanTerminalOutput(line));

describe('Markdown no terminal', () => {
  it('tira os marcadores e estiliza negrito e código', () => {
    const lines = renderMarkdown('**2. Type-check** (`tsc --noEmit`): ✅**PASSOU**', 80);
    expect(cleanTerminalOutput(lines[0]!)).toBe('2. Type-check (tsc --noEmit): ✅PASSOU');
    expect(lines[0]).toContain('\x1b[1m2. Type-check');
  });

  it('não confunde snake_case nem asteriscos soltos com ênfase', () => {
    const text = (markdown: string) =>
      parseInline(markdown)
        .map((segment) => segment.text)
        .join('');
    expect(text('use max_tokens_total e 2 * 3 = 6')).toBe('use max_tokens_total e 2 * 3 = 6');
    expect(text('_Encerrado ao atingir o limite._')).toBe('Encerrado ao atingir o limite.');
    expect(text('veja [o guia](https://x.dev)')).toBe('veja o guia (https://x.dev)');
  });

  it('quebra por palavra sem passar da largura e mantém o recuo das listas', () => {
    const lines = plain(
      '- **Infra:** **7/10** (lint missing, models fake e mais um monte de texto que não cabe numa linha só)',
      40,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.startsWith('• Infra: 7/10')).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith('  ')).toBe(true);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(40);
  });

  it('junta as linhas de um parágrafo e separa os blocos', () => {
    expect(plain('## Resumo final\nprimeira linha\ncontinua aqui\n\n1. um\n2. dois')).toEqual([
      'Resumo final',
      'primeira linha continua aqui',
      '',
      '1. um',
      '2. dois',
    ]);
  });

  it('desenha blocos de código, citações e linhas', () => {
    expect(plain('```bash\nnpm run lint   # se existir\n```\n> nota\n\n---', 30)).toEqual([
      '│ npm run lint   # se existir',
      '│ nota',
      '',
      '─'.repeat(30),
    ]);
  });

  it('alinha tabelas e vira lista quando não cabem', () => {
    const markdown = '| Item | Nota |\n|---|---|\n| Código | 9/10 |\n| Infra | 7/10 |';
    expect(plain(markdown)).toEqual([
      'Item   │ Nota',
      '─'.repeat(13),
      'Código │ 9/10',
      'Infra  │ 7/10',
    ]);
    expect(plain(markdown, 10)[0]).toBe('• Item:');
  });

  it('corta palavras maiores que a linha', () => {
    const lines = plain('C:\\projetos\\crew.os\\src\\providers\\model-router.ts', 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(20);
  });
});
