import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

// Read-only static server for the project's HTML pages, similar to VS Code's Live Server.
// It serves the project root on 127.0.0.1 only, so pages can use root-relative paths.
export interface StaticServer {
  /** Project root served by this instance. */
  root: string;
  origin: string;
  close(): Promise<void>;
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Resolves a URL path to a file inside the root, or null when it is missing or outside. */
async function resolveFile(root: string, urlPath: string): Promise<string | null> {
  const decoded = decodeURIComponent(urlPath);
  const candidate = path.resolve(root, `.${decoded}`);
  if (!isInside(root, candidate)) return null;
  const info = await stat(candidate).catch(() => null);
  if (!info) return null;
  const target = info.isDirectory() ? path.join(candidate, 'index.html') : candidate;
  // Symlinks inside the project must not lead outside it.
  const real = await realpath(target).catch(() => null);
  if (!real || !isInside(root, real)) return null;
  return real;
}

export async function startStaticServer(root: string): Promise<StaticServer> {
  const realRoot = await realpath(root);
  const server: Server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    let file: string | null;
    try {
      const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
      file = await resolveFile(realRoot, pathname);
    } catch {
      response.writeHead(400).end('Caminho inválido.');
      return;
    }
    if (!file) {
      response
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Não encontrado.');
      return;
    }
    response.writeHead(200, {
      'content-type': contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      // Pages are reloaded after every save, so the browser must never reuse an old copy.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file)
      .on('error', () => response.destroy())
      .pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Não foi possível abrir a porta local.');

  return {
    root: realRoot,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
