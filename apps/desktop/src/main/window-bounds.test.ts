import { describe, expect, it } from 'vitest';
import { parsePlacement, restoreBounds } from './window-bounds';

const minimum = { width: 860, height: 560 };
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

describe('posição da janela do Nexus', () => {
  it('volta para o mesmo lugar, inclusive no segundo monitor', () => {
    const saved = { x: 2100, y: 80, width: 1400, height: 900 };
    expect(restoreBounds(saved, [primary, right], minimum)).toEqual(saved);
  });

  it('abre centralizada quando o monitor onde estava foi desconectado', () => {
    expect(restoreBounds({ x: 2100, y: 80, width: 1400, height: 900 }, [primary], minimum)).toBe(
      null,
    );
  });

  it('encolhe e traz para dentro uma janela maior que a tela', () => {
    expect(
      restoreBounds({ x: 1500, y: -20, width: 3000, height: 2000 }, [primary], minimum),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('ignora posições salvas inválidas', () => {
    expect(parsePlacement(null)).toBeNull();
    expect(parsePlacement('{')).toBeNull();
    expect(parsePlacement('{"bounds":{"x":0,"y":0,"width":-5,"height":3}}')).toBeNull();
    expect(
      parsePlacement('{"bounds":{"x":1,"y":2,"width":900,"height":600},"maximized":true}'),
    ).toEqual({ bounds: { x: 1, y: 2, width: 900, height: 600 }, maximized: true });
  });
});
