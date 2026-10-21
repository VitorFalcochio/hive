// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DESIGN_INSPECTOR_SCRIPT, isLocalPreviewUrl } from '../../main/design-inspector';

// jsdom has no layout or CSS.escape; the inspector only needs them to describe elements.
let hit: Element | null = null;
let parentPost = vi.fn();

beforeAll(() => {
  if (!('CSS' in globalThis)) {
    Object.defineProperty(globalThis, 'CSS', { value: { escape: (value: string) => value } });
  }
  document.elementFromPoint = () => hit;
  // The script runs once per page, like in a real preview; each test swaps the parent mock.
  const parent = { postMessage: (...args: unknown[]) => parentPost(...args) };
  Object.defineProperty(window, 'parent', { configurable: true, value: parent });
  new Function(DESIGN_INSPECTOR_SCRIPT)();
});

afterEach(() => {
  sendToPage({ source: 'hive-design', type: 'disable' });
  document.body.innerHTML = '';
  hit = null;
  parentPost = vi.fn();
});

// The inspector accepts control messages only from its parent window.
function sendToPage(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window.parent }));
}

function click(element: Element) {
  hit = element;
  return element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('design inspector script', () => {
  it('stays silent until the parent enables it', () => {
    document.body.innerHTML = '<button id="save">Salvar</button>';
    try {
      click(document.getElementById('save')!);
      expect(parentPost).not.toHaveBeenCalled();
    } finally {
      sendToPage({ source: 'hive-design', type: 'disable' });
    }
  });

  it('reports the clicked element and blocks navigation while enabled', () => {
    document.body.innerHTML = '<nav><a class="link primary" href="/docs">Documentação</a></nav>';
    try {
      sendToPage({ source: 'hive-design', type: 'enable' });
      const link = document.querySelector('a')!;
      const continued = click(link);
      expect(continued).toBe(false);
      expect(parentPost).toHaveBeenCalledTimes(1);
      const [message, targetOrigin] = parentPost.mock.calls[0]!;
      expect(targetOrigin).toBe('*');
      expect(message).toMatchObject({
        source: 'hive-design',
        type: 'select',
        element: {
          tag: 'a',
          id: null,
          classes: ['link', 'primary'],
          text: 'Documentação',
          selector: 'nav > a',
        },
      });
      expect(Object.keys(message.element.styles)).toContain('color');
    } finally {
      sendToPage({ source: 'hive-design', type: 'disable' });
    }
  });

  it('stops reporting after it is disabled', () => {
    document.body.innerHTML = '<p>Texto</p>';
    try {
      sendToPage({ source: 'hive-design', type: 'enable' });
      sendToPage({ source: 'hive-design', type: 'disable' });
      click(document.querySelector('p')!);
      expect(parentPost).not.toHaveBeenCalled();
    } finally {
      sendToPage({ source: 'hive-design', type: 'disable' });
    }
  });

  it('ignores control messages that do not come from the parent window', () => {
    document.body.innerHTML = '<p>Texto</p>';
    try {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'hive-design', type: 'enable' },
          source: null,
        }),
      );
      click(document.querySelector('p')!);
      expect(parentPost).not.toHaveBeenCalled();
    } finally {
      sendToPage({ source: 'hive-design', type: 'disable' });
    }
  });
});

describe('isLocalPreviewUrl', () => {
  it('accepts loopback http and https URLs', () => {
    expect(isLocalPreviewUrl('http://localhost:5173/')).toBe(true);
    expect(isLocalPreviewUrl('https://127.0.0.1:3000/app')).toBe(true);
  });

  it('rejects remote hosts, other protocols and invalid text', () => {
    expect(isLocalPreviewUrl('https://example.com/')).toBe(false);
    expect(isLocalPreviewUrl('file:///etc/passwd')).toBe(false);
    expect(isLocalPreviewUrl('javascript:alert(1)')).toBe(false);
    expect(isLocalPreviewUrl('not a url')).toBe(false);
  });
});
