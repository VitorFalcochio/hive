import { describe, expect, it } from 'vitest';
import {
  buildStyleInstruction,
  isSourceFile,
  styleChanges,
  textChange,
  toHex,
  type DesignElement,
} from './design';

const element: DesignElement = {
  tag: 'button',
  id: null,
  classes: ['btn', 'primary'],
  selector: 'div > button',
  text: 'Salvar',
  editableText: true,
  source: null,
  rect: { x: 0, y: 0, width: 80, height: 32 },
  styles: {
    color: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(47, 111, 79)',
    fontSize: '15px',
    padding: '10px 18px',
    margin: '0px',
    borderRadius: '8px',
    display: 'inline-block',
  },
};

describe('styleChanges', () => {
  it('keeps only the styles whose value was edited', () => {
    const changes = styleChanges(element, {
      color: '#000000',
      backgroundColor: 'rgb(47, 111, 79)',
      fontSize: '  18px ',
      padding: '',
    });
    expect(changes).toEqual([
      { property: 'color', from: 'rgb(255, 255, 255)', to: '#000000' },
      { property: 'fontSize', from: '15px', to: '18px' },
    ]);
  });

  it('treats a picked color equal to the current one as unchanged', () => {
    expect(styleChanges(element, { color: '#FFFFFF', backgroundColor: '#2f6f4f' })).toEqual([]);
  });

  it('ignores styles the editor does not expose', () => {
    expect(styleChanges(element, { display: 'flex' })).toEqual([]);
  });
});

describe('buildStyleInstruction', () => {
  it('describes the element, the requested values and the rules for the reply', () => {
    const text = buildStyleInstruction(
      element,
      [{ property: 'backgroundColor', from: 'rgb(47, 111, 79)', to: '#1d4ed8' }],
      'Mais contraste',
    );
    expect(text).toContain('<button class="btn primary">');
    expect(text).toContain('com o texto "Salvar"');
    expect(text).toContain('seletor no preview: div > button');
    expect(text).toContain('- background-color: rgb(47, 111, 79) → #1d4ed8');
    expect(text).toContain('Pedido adicional do usuário: Mais contraste');
    expect(text).toContain('Retorne o arquivo completo');
    expect(text).not.toContain('Troque o texto');
  });

  it('asks for the new text when it was edited', () => {
    const text = buildStyleInstruction(element, [], '', 'Enviar');
    expect(text).toContain('Troque o texto do elemento para: "Enviar"');
  });

  it('omits the change list when there is nothing to change', () => {
    const text = buildStyleInstruction(element, [], '');
    expect(text).not.toContain('Estilos a alterar');
    expect(text).not.toContain('Pedido adicional');
  });
});

describe('isSourceFile', () => {
  it('accepts component and style files only', () => {
    expect(isSourceFile('src/App.tsx')).toBe(true);
    expect(isSourceFile('styles/main.CSS')).toBe(true);
    expect(isSourceFile('public/logo.png')).toBe(false);
    expect(isSourceFile('package.json')).toBe(false);
  });
});

describe('textChange', () => {
  it('returns the new text only when it changed and can be edited', () => {
    expect(textChange(element, 'Enviar')).toBe('Enviar');
    expect(textChange(element, 'Salvar')).toBeNull();
    expect(textChange({ ...element, editableText: false }, 'Enviar')).toBeNull();
  });
});

describe('toHex', () => {
  it('converts the color formats the browser reports', () => {
    expect(toHex('rgb(47, 111, 79)')).toBe('#2f6f4f');
    expect(toHex('rgba(255, 0, 0, 0.5)')).toBe('#ff000080');
    expect(toHex('rgb(0 0 255 / 100%)')).toBe('#0000ff');
    expect(toHex('#ABC')).toBe('#aabbcc');
  });

  it('marks fully transparent colors and rejects unknown text', () => {
    expect(toHex('rgba(0, 0, 0, 0)')).toBe('transparent');
    expect(toHex('transparent')).toBe('transparent');
    expect(toHex('azul')).toBe('');
  });
});
