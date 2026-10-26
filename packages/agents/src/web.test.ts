import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandEvidence, Worker } from '@hive/core';
import { executeTool, type ToolContext } from './tools';
import { htmlToText, isLocalUrl, type PageViewer } from './web';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/docs') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<html><head><title>Docs &amp; API</title><style>p{}</style></head><body><h2>Instalar</h2><p>Rode <code>npm i</code>.</p><script>alert(1)</script><a href="https://exemplo.com/guia">Guia</a></body></html>',
      );
    } else if (request.url === '/logo.png') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/plain');
      response.end('não achei');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function context(viewPage?: PageViewer): ToolContext {
  return {
    root: process.cwd(),
    worker: { autoApproveCommands: [] } as unknown as Worker,
    skills: [],
    signal: new AbortController().signal,
    commandTimeoutMs: 10_000,
    requestApproval: async () => false,
    emit: () => undefined,
    commands: [] as CommandEvidence[],
    vision: true,
    ...(viewPage ? { viewPage } : {}),
  };
}

describe('htmlToText', () => {
  it('mantém o texto, títulos e links e descarta scripts e estilos', () => {
    const text = htmlToText(
      '<head><title>A &amp; B</title><style>.x{}</style></head><h1>Título</h1><ul><li>um</li><li>dois</li></ul><script>roubar()</script><a href="/x">link</a> &#233;',
    );
    expect(text).toBe('# A & B\n\n# Título\n\n- um\n- dois\n\n[link](/x) é');
  });
});

describe('isLocalUrl', () => {
  it('aceita só este computador', () => {
    for (const url of [
      'http://localhost:5173',
      'http://127.0.0.1/',
      'http://[::1]:3000',
      'http://app.localhost',
    ])
      expect(isLocalUrl(new URL(url)), url).toBe(true);
    for (const url of [
      'https://exemplo.com',
      'http://192.168.0.10',
      'http://localhost.exemplo.com',
    ])
      expect(isLocalUrl(new URL(url)), url).toBe(false);
  });
});

describe('web_fetch', () => {
  it('lê uma página como texto', async () => {
    const result = await executeTool(context(), 'web_fetch', { url: `${base}/docs` });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('(HTTP 200, text/html)');
    expect(result.output).toContain('# Docs & API');
    expect(result.output).toContain('## Instalar');
    expect(result.output).toContain('[Guia](https://exemplo.com/guia)');
    expect(result.output).not.toContain('alert');
  });

  it('não despeja binários e marca erros HTTP', async () => {
    const image = await executeTool(context(), 'web_fetch', { url: `${base}/logo.png` });
    expect(image.output).toContain('not text');
    const missing = await executeTool(context(), 'web_fetch', { url: `${base}/nada` });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('não achei');
  });

  it('recusa o que não é http', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://exemplo.com', 'exemplo.com']) {
      const result = await executeTool(context(), 'web_fetch', { url });
      expect(result.isError, url).toBe(true);
    }
  });
});

describe('view_page', () => {
  const viewer: PageViewer = async ({ url, width }) => ({
    title: `Página ${width}`,
    dataUrl: 'data:image/png;base64,AAAA',
    status: 200,
    console: [`error: falhou em ${url}`],
  });

  it('mostra o print e o console da página local', async () => {
    const result = await executeTool(context(viewer), 'view_page', {
      url: 'http://localhost:5173/',
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('"Página 1280"');
    expect(result.output).toContain('- error: falhou em http://localhost:5173/');
    expect(result.image?.dataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('só abre páginas deste computador', async () => {
    const result = await executeTool(context(viewer), 'view_page', { url: 'https://exemplo.com' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('web_fetch');
  });

  it('avisa quando não há navegador disponível', async () => {
    const result = await executeTool(context(), 'view_page', { url: 'http://localhost:3000' });
    expect(result.isError).toBe(true);
  });
});
