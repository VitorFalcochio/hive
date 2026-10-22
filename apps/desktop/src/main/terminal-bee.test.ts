import { describe, expect, it } from 'vitest';
import { BEE_COLUMNS, BEE_ROWS, beeLines, besideBee } from './terminal-bee';

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const visible = (line: string) => line.replace(ansi, '');

describe('abelha no terminal', () => {
  it('desenha a abelha em meio-blocos, com a cor do corpo', () => {
    const lines = beeLines({ body: '#22d3ee' });
    expect(lines).toHaveLength(BEE_ROWS);
    for (const line of lines) expect([...visible(line)]).toHaveLength(BEE_COLUMNS);
    expect(lines.join('')).toContain('34;211;238');
  });

  it('bate as asas e põe a coroa na Queen', () => {
    expect(beeLines({ wingsUp: true })).not.toEqual(beeLines());
    expect(beeLines({ crowned: true }).join('')).toContain('255;226;122');
  });

  it('põe o texto ao lado da abelha', () => {
    const rows = besideBee(beeLines(), ['', 'Frontend']);
    expect(rows).toHaveLength(BEE_ROWS);
    expect(visible(rows[1]!)).toMatch(/ {3}Frontend$/);
  });
});
