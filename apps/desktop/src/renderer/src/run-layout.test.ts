import { describe, expect, it } from 'vitest';
import { closePane, leaf, leaves, replaceContent, setRatio, splitPane } from './run-layout';

const terminal = (sessionId: string) => leaf({ kind: 'terminal', sessionId });

describe('painéis da tela Rodar', () => {
  it('divide um painel à direita e abaixo, mantendo a ordem de leitura', () => {
    const a = terminal('a');
    const b = terminal('b');
    const c = terminal('c');
    let tree = splitPane(a, a.id, 'row', b);
    tree = splitPane(tree, b.id, 'column', c);
    expect(leaves(tree).map((item) => item.id)).toEqual([a.id, b.id, c.id]);
    expect(tree).toMatchObject({
      type: 'split',
      direction: 'row',
      second: { direction: 'column' },
    });
  });

  it('ao fechar, o vizinho ocupa o espaço; o último painel deixa a árvore vazia', () => {
    const a = terminal('a');
    const b = terminal('b');
    const c = terminal('c');
    const tree = splitPane(splitPane(a, a.id, 'row', b), b.id, 'column', c);
    const closed = closePane(tree, b.id)!;
    expect(leaves(closed).map((item) => item.id)).toEqual([a.id, c.id]);
    expect(closePane(a, a.id)).toBeNull();
  });

  it('limita o tamanho e troca o conteúdo de um painel', () => {
    const a = terminal('a');
    const b = terminal('b');
    const tree = splitPane(a, a.id, 'row', b);
    if (tree.type !== 'split') throw new Error('esperava uma divisão');
    expect(setRatio(tree, tree.id, 0.99)).toMatchObject({ ratio: 0.85 });
    expect(setRatio(tree, tree.id, 0)).toMatchObject({ ratio: 0.15 });
    const swapped = replaceContent(tree, b.id, { kind: 'preview' });
    expect(leaves(swapped)[1]!.content).toEqual({ kind: 'preview' });
    expect(leaves(tree)[1]!.content).toEqual({ kind: 'terminal', sessionId: 'b' });
  });
});
