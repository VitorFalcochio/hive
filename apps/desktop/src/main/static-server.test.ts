import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStaticServer, type StaticServer } from './static-server';

let project: string;
let outside: string;
let server: StaticServer;

beforeAll(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'hive-static-'));
  project = path.join(base, 'project');
  outside = path.join(base, 'secret.txt');
  await mkdir(path.join(project, 'site', 'about'), { recursive: true });
  await writeFile(path.join(project, 'site', 'index.html'), '<h1>Início</h1>');
  await writeFile(path.join(project, 'site', 'about', 'index.html'), '<h1>Sobre</h1>');
  await writeFile(path.join(project, 'site', 'app.css'), 'h1 { color: red; }');
  await writeFile(outside, 'segredo');
  await symlink(outside, path.join(project, 'link.txt')).catch(() => undefined);
  server = await startStaticServer(project);
});

afterAll(async () => {
  await server.close();
  await rm(path.dirname(project), { recursive: true, force: true });
});

/** Raw request, so paths such as /../ reach the server unchanged. */
function send(method: string, target: string) {
  const url = new URL(server.origin);
  return new Promise<{ status: number; type: string | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: target, method },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              type: response.headers['content-type'],
              body,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

describe('static preview server', () => {
  it('serves HTML pages with root-relative paths and no-store caching', async () => {
    const response = await send('GET', '/site/index.html');
    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html; charset=utf-8');
    expect(response.body).toBe('<h1>Início</h1>');
  });

  it('serves the index of a folder', async () => {
    const response = await send('GET', '/site/about/');
    expect(response.status).toBe(200);
    expect(response.body).toBe('<h1>Sobre</h1>');
  });

  it('serves other project assets with their content type', async () => {
    const response = await send('GET', '/site/app.css');
    expect(response.type).toBe('text/css; charset=utf-8');
    expect(response.body).toBe('h1 { color: red; }');
  });

  it('never serves files outside the project, including encoded traversal', async () => {
    expect((await send('GET', '/../secret.txt')).status).toBe(404);
    expect((await send('GET', '/%2e%2e/secret.txt')).status).toBe(404);
    expect((await send('GET', '/link.txt')).status).toBe(404);
  });

  it('answers 404 for missing files and 405 for writes', async () => {
    expect((await send('GET', '/nao-existe.html')).status).toBe(404);
    expect((await send('POST', '/site/index.html')).status).toBe(405);
  });

  it('rejects malformed URL encoding', async () => {
    expect((await send('GET', '/%E0%A4%A')).status).toBe(400);
  });
});
