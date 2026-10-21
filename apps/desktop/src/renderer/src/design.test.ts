import { describe, expect, it } from 'vitest';
import { parseDesignElement } from './design';

const element = {
  tag: 'button',
  id: 'save',
  classes: ['primary'],
  selector: '#save',
  text: 'Salvar',
  rect: { x: 10, y: 20, width: 80, height: 32 },
  styles: { color: 'rgb(255, 255, 255)', display: 'inline-block', ignored: 42 },
};

describe('parseDesignElement', () => {
  it('accepts a well-formed select message and keeps only string styles', () => {
    const parsed = parseDesignElement({ source: 'hive-design', type: 'select', element });
    expect(parsed).toEqual({
      ...element,
      styles: { color: 'rgb(255, 255, 255)', display: 'inline-block' },
    });
  });

  it('rejects messages from other sources or types', () => {
    expect(parseDesignElement({ source: 'other', type: 'select', element })).toBeNull();
    expect(parseDesignElement({ source: 'hive-design', type: 'enable' })).toBeNull();
    expect(parseDesignElement(null)).toBeNull();
    expect(parseDesignElement('hive-design')).toBeNull();
  });

  it('rejects malformed element data', () => {
    const broken = { ...element, rect: { x: 1, y: 2, width: Number.NaN, height: 3 } };
    expect(
      parseDesignElement({ source: 'hive-design', type: 'select', element: broken }),
    ).toBeNull();
    const badClasses = { ...element, classes: [1] };
    expect(
      parseDesignElement({ source: 'hive-design', type: 'select', element: badClasses }),
    ).toBeNull();
  });
});
