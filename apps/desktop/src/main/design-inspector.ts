import type { WebContents } from 'electron';

// Script injected into the Live Preview page (a local dev server). It stays inert until the
// Hive window sends { source: 'hive-design', type: 'enable' }. While enabled it highlights the
// element under the pointer, blocks clicks from navigating, and reports the clicked element
// to the parent window with postMessage.
export const DESIGN_INSPECTOR_SCRIPT = `(() => {
  if (window.__hiveDesign) return;
  const SOURCE = 'hive-design';
  const STYLE_KEYS = [
    'display', 'position', 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight',
    'lineHeight', 'margin', 'padding', 'borderRadius', 'width', 'height',
  ];
  const overlay = document.createElement('div');
  overlay.setAttribute('data-hive-design', 'overlay');
  overlay.style.cssText =
    'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483647;display:none;' +
    'border:2px solid #4cd6a0;background:rgba(76,214,160,0.12);box-sizing:border-box;';
  let enabled = false;

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
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      styles,
    };
  }

  function showOverlay(element) {
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
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
    window.parent.postMessage({ source: SOURCE, type: 'select', element: describe(element) }, '*');
  }

  function setEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      document.documentElement.appendChild(overlay);
      window.addEventListener('mousemove', onMove, true);
      for (const type of ['click', 'mousedown', 'mouseup', 'submit'])
        window.addEventListener(type, onBlock, true);
    } else {
      hideOverlay();
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
  });
  window.addEventListener('scroll', hideOverlay, true);
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
