import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '@hive/shared';

/**
 * Hive's answer to Claude Code's permission prompts, through the CLI's documented
 * `--permission-prompt-tool`: Claude Code calls an MCP tool before any action that would need
 * permission, and the tool replies `{"behavior":"allow","updatedInput":…}` or
 * `{"behavior":"deny","message":…}`. The tool is served here, over MCP Streamable HTTP on
 * 127.0.0.1, so every request reaches the same approval flow as Hive's own agents.
 *
 * Each session gets its own secret token; a request without a known token is refused, so no
 * other local process can approve anything.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type PermissionHandler = (
  tool: string,
  input: Record<string, unknown>,
) => Promise<PermissionDecision>;

/** The tool's name as Claude Code addresses it: `mcp__<server>__<tool>`. */
export const PERMISSION_TOOL = 'mcp__hive__approve';
const MAX_BODY = 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Pedido grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export class ClaudeCodePermissions {
  private http: HttpServer | null = null;
  private url: Promise<string> | null = null;
  private readonly handlers = new Map<string, PermissionHandler>();

  /** Starts listening on first use, on a free port of 127.0.0.1. */
  private listen(): Promise<string> {
    this.url ??= new Promise((resolve, reject) => {
      const http = createServer((req, res) => {
        void this.serve(req, res).catch((error: unknown) => {
          console.error('Permissões do Claude Code:', error);
          if (!res.headersSent) res.writeHead(500).end();
        });
      });
      http.on('error', reject);
      http.listen(0, '127.0.0.1', () => {
        this.http = http;
        resolve(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
      });
    });
    return this.url;
  }

  private handlerFor(req: IncomingMessage): PermissionHandler | null {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    for (const [known, handler] of this.handlers) {
      const a = Buffer.from(known);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return handler;
    }
    return null;
  }

  private async serve(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const handler = this.handlerFor(req);
    if (!handler) return void res.writeHead(401).end();
    // Stateless: nothing streams back to the client outside a request.
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) return void res.writeHead(405).end();
    const body = await readBody(req);
    const server = new Server({ name: 'hive', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'approve',
          description:
            'Asks the Hive user whether Claude Code may use a tool. Called by Claude Code itself.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_use_id: { type: 'string' },
            },
            required: ['tool_name', 'input'],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {};
      let decision: PermissionDecision;
      try {
        decision = await handler(
          typeof args.tool_name === 'string' ? args.tool_name : 'ferramenta',
          isObject(args.input) ? args.input : {},
        );
      } catch (error) {
        // An approval that could not be asked is a refusal, and Claude Code is told why.
        decision = {
          behavior: 'deny',
          message: `Hive não conseguiu pedir aprovação: ${errorMessage(error)}`,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * A token for one session and the `--mcp-config` JSON that points Claude Code at it.
   * `release` forgets the token once the session ends.
   */
  async register(handler: PermissionHandler): Promise<{ config: string; release: () => void }> {
    const url = await this.listen();
    const token = randomBytes(24).toString('hex');
    this.handlers.set(token, handler);
    const config = JSON.stringify({
      mcpServers: { hive: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
    });
    return { config, release: () => this.handlers.delete(token) };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    const http = this.http;
    this.http = null;
    this.url = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
