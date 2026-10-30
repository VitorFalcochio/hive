import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

it('entrega o layout do Canvas como stylesheet na página, sem depender de injeção JavaScript', async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, preTransformRequests: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const origin = server.resolvedUrls!.local[0]!;
  const page = await (await fetch(new URL('canvas.html', origin))).text();
  const href = /<link\s+rel="stylesheet"\s+href="([^"]*canvas\.css[^"]*)"/.exec(page)?.[1];
  expect(href).toBeTruthy();
  const response = await fetch(new URL(href!, origin), { headers: { Accept: 'text/css' } });
  expect(response.headers.get('content-type')).toContain('text/css');
  const css = await response.text();
  expect(css).toMatch(/\.nc-shell\s*\{[^}]*display:\s*grid/);
  expect(css).toMatch(/\.nc-shell\s*\{[^}]*height:\s*100vh/);
  expect(css).toContain('.nc-flow');
  expect(css).toContain('.nc-live-result');
}, 15_000);
