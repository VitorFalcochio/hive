import type { WebContents } from 'electron';

// Script injected into the Live Preview page (a local dev server). It stays inert until the
// Hive window sends { source: 'hive-design', type: 'enable' }. While enabled it highlights the
// element under the pointer, blocks clicks from navigating, and reports the clicked element
// to the parent window with postMessage. 'apply' previews styles and text on the selected
// element and 'reset' undoes those previews; neither touches the project files.
export const DESIGN_INSPECTOR_SCRIPT = `(() => {
  if (window.__hiveDesign) return;
  const SOURCE = 'hive-design';
  const STYLE_KEYS = [
    'display', 'position', 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight',
    'lineHeight', 'margin', 'padding', 'borderRadius', 'width', 'height', 'fontStyle',
    'textDecorationLine', 'textAlign',
  ];
  const overlay = document.createElement('div');
  overlay.setAttribute('data-hive-design', 'overlay');
  overlay.style.cssText =
    'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483647;display:none;' +
    'border:2px solid #4cd6a0;background:rgba(76,214,160,0.12);box-sizing:border-box;';
  const selectedBox = document.createElement('div');
  selectedBox.setAttribute('data-hive-design', 'selected');
  selectedBox.style.cssText =
    'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;display:none;' +
    'outline:2px solid #6ea8fe;outline-offset:1px;box-sizing:border-box;';
  let enabled = false;
  let selected = null;
  // Inline style and text of each previewed element as the page had them, for 'reset'.
  const originals = new Map();

  function selectorOf(element) {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
        : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : element.tagName.toLowerCase();
  }

  // Only elements without child elements have their text edited, so markup is never lost.
  const textEditable = (element) => element.children.length === 0;

  // Dev builds of some frameworks record where an element was written. Absent in production.
  function sourceOf(element) {
    try {
      // React up to 18 keeps the JSX location on the element's own fiber (React 19 does not),
      // which is more precise than a component file found on an ancestor.
      const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
      for (let fiber = key ? element[key] : null; fiber; fiber = fiber.return) {
        const source = fiber._debugSource;
        if (source && source.fileName)
          return { file: String(source.fileName), line: Number(source.lineNumber) || null };
      }
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const svelte = node.__svelte_meta;
        if (svelte && svelte.loc && svelte.loc.file)
          return { file: String(svelte.loc.file), line: Number(svelte.loc.line) || null };
        const vue = node.__vueParentComponent;
        if (vue && vue.type && vue.type.__file) return { file: String(vue.type.__file), line: null };
      }
    } catch {
      // A page may define getters that throw; the source is only a hint.
    }
    return null;
  }

  function describe(element) {
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const styles = {};
    for (const key of STYLE_KEYS) styles[key] = computed[key];
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: Array.from(element.classList).slice(0, 6),
      selector: selectorOf(element),
      text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      editableText: textEditable(element) && (element.textContent || '').trim().length <= 160,
      source: sourceOf(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      styles,
    };
  }

  function place(box, element) {
    const rect = element.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  function showOverlay(element) {
    place(overlay, element);
  }

  function placeSelected() {
    if (selected && enabled && selected.isConnected) place(selectedBox, selected);
    else selectedBox.style.display = 'none';
  }

  // Each 'apply' carries the full edit, so the element is restored first and edits never stack.
  function apply(styles, text) {
    if (!selected) return;
    if (!originals.has(selected))
      originals.set(selected, { style: selected.style.cssText, text: selected.textContent });
    const original = originals.get(selected);
    selected.style.cssText = original.style;
    for (const [key, value] of Object.entries(styles || {})) {
      if (typeof value === 'string' && STYLE_KEYS.includes(key)) selected.style[key] = value;
    }
    if (textEditable(selected))
      selected.textContent = typeof text === 'string' ? text : original.text;
    placeSelected();
  }

  function reset() {
    for (const [element, original] of originals) {
      element.style.cssText = original.style;
      if (textEditable(element)) element.textContent = original.text;
    }
    originals.clear();
    placeSelected();
  }

  function hideOverlay() {
    overlay.style.display = 'none';
  }

  function realTarget(event) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    return element && element !== document.documentElement ? element : null;
  }

  function onMove(event) {
    const element = realTarget(event);
    if (element) showOverlay(element);
    else hideOverlay();
  }

  function onBlock(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== 'click') return;
    const element = realTarget(event);
    if (!element) return;
    showOverlay(element);
    selected = element;
    placeSelected();
    window.parent.postMessage({ source: SOURCE, type: 'select', element: describe(element) }, '*');
  }

  function setEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      document.documentElement.appendChild(overlay);
      document.documentElement.appendChild(selectedBox);
      window.addEventListener('mousemove', onMove, true);
      for (const type of ['click', 'mousedown', 'mouseup', 'submit'])
        window.addEventListener(type, onBlock, true);
    } else {
      hideOverlay();
      selected = null;
      placeSelected();
      window.removeEventListener('mousemove', onMove, true);
      for (const type of ['click', 'mousedown', 'mouseup', 'submit'])
        window.removeEventListener(type, onBlock, true);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === 'enable') setEnabled(true);
    if (data.type === 'disable') setEnabled(false);
    if (data.type === 'apply' && enabled) apply(data.styles, data.text);
    if (data.type === 'reset') reset();
  });
  window.addEventListener('scroll', () => { hideOverlay(); placeSelected(); }, true);
  window.addEventListener('resize', placeSelected);
  window.__hiveDesign = true;
})();`;

// Only the user's own local servers get the inspector, matching the renderer's preview check.
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

// Injects the inspector into each embedded preview frame once its document is ready.
// Top-level pages (the Hive UI itself) are never touched.
export function attachDesignInspector(contents: WebContents): void {
  contents.on('frame-created', (_event, details) => {
    const frame = details.frame;
    if (!frame?.parent) return;
    frame.on('dom-ready', () => {
      if (!isLocalPreviewUrl(frame.url)) return;
      frame.executeJavaScript(DESIGN_INSPECTOR_SCRIPT).catch(() => {
        // The frame may have navigated or closed; the next load injects it again.
      });
    });
  });
}
