import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServer } from '@hive/core';
import type { ToolDefinition } from '@hive/providers';
import { HiveError, errorMessage } from '@hive/shared';

/** The first `npx some-server` downloads the package, which can take a while. */
const CONNECT_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 180_000;
/** Every tool definition is resent on each step; a server with hundreds of tools would swamp it. */
const MAX_TOOLS_PER_SERVER = 40;
const MAX_DESCRIPTION = 1_000;
const STDERR_TAIL = 2_000;

export interface McpTool {
  server: McpServer;
  /** The tool's own name on its server. */
  name: string;
  /** What the model calls it: `mcp__<server>__<tool>`, at most 64 characters. */
  qualified: string;
  definition: ToolDefinition;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
  images: { mime: string; data: string }[];
}

/** Function names the OpenAI-style APIs accept. */
export function qualifiedToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

function transportFor(
  server: McpServer,
  cwd: string,
): { transport: Transport; stderr: () => string } {
  if (server.transport === 'http') {
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new HiveError('VALIDATION', `MCP server "${server.name}" has an invalid URL.`);
    }
    return {
      transport: new StreamableHTTPClientTransport(url, {
        requestInit: { headers: server.headers },
      }),
      stderr: () => '',
    };
  }
  if (!server.command.trim())
    throw new HiveError('VALIDATION', `MCP server "${server.name}" has no command.`);
  const transport = new StdioClientTransport({
    command: server.command.trim(),
    args: server.args,
    env: { ...getDefaultEnvironment(), ...server.env },
    cwd,
    stderr: 'pipe',
  });
  // Servers log to stderr; the tail explains a server that dies while starting.
  let tail = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });
  return { transport, stderr: () => tail.trim() };
}

function toolDefinition(server: McpServer, qualified: string, tool: McpListedTool): ToolDefinition {
  const schema = tool.inputSchema ?? {};
  return {
    type: 'function',
    function: {
      name: qualified,
      description: `[MCP ${server.name}] ${(tool.description ?? tool.title ?? tool.name).slice(0, MAX_DESCRIPTION)}`,
      parameters: { ...schema, type: 'object', properties: schema.properties ?? {} },
    },
  };
}

interface McpListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; [key: string]: unknown };
}

/** The text an MCP tool result reads as, with images handed back separately. */
export function formatMcpContent(content: unknown): Pick<McpCallResult, 'text' | 'images'> {
  const images: McpCallResult['images'] = [];
  const parts = (Array.isArray(content) ? content : []).map((part: Record<string, unknown>) => {
    switch (part.type) {
      case 'text':
        return String(part.text ?? '');
      case 'image':
        images.push({ mime: String(part.mimeType), data: String(part.data) });
        return `[image ${String(part.mimeType)}]`;
      case 'resource': {
        const resource = (part.resource ?? {}) as Record<string, unknown>;
        return typeof resource.text === 'string'
          ? `${String(resource.uri)}\n${resource.text}`
          : `[resource ${String(resource.uri)}]`;
      }
      case 'resource_link':
        return `[resource ${String(part.uri)}${part.name ? ` "${String(part.name)}"` : ''}]`;
      default:
        return `[${String(part.type)} content]`;
    }
  });
  return { text: parts.join('\n'), images };
}

interface Connection {
  server: McpServer;
  client: Client;
}

/**
 * The MCP servers one agent session talks to. They are started with the session and closed
 * with it, so a task never leaves a server running and each worktree gets its own.
 */
export class McpSession {
  private constructor(
    private readonly connections: Connection[],
    readonly tools: McpTool[],
    /** Servers that could not be reached, with the reason, for the activity log. */
    readonly failures: { server: string; error: string }[],
  ) {}

  static async open(servers: McpServer[], cwd: string, signal: AbortSignal): Promise<McpSession> {
    const connections: Connection[] = [];
    const tools: McpTool[] = [];
    const failures: { server: string; error: string }[] = [];
    const taken = new Set<string>();
    const settled = await Promise.allSettled(
      servers.map(async (server) => {
        const { transport, stderr } = transportFor(server, cwd);
        const client = new Client({ name: 'hive', version: '0.1.0' });
        try {
          await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS });
          const listed: McpListedTool[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, { signal });
            listed.push(...(page.tools as McpListedTool[]));
            cursor = page.nextCursor;
          } while (cursor && listed.length < MAX_TOOLS_PER_SERVER);
          return { server, client, listed: listed.slice(0, MAX_TOOLS_PER_SERVER) };
        } catch (error) {
          await client.close().catch(() => undefined);
          const log = stderr();
          throw new Error(log ? `${errorMessage(error)}\n${log}` : errorMessage(error), {
            cause: error,
          });
        }
      }),
    );
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push({ server: servers[index]!.name, error: errorMessage(result.reason) });
        return;
      }
      const { server, client, listed } = result.value;
      connections.push({ server, client });
      for (const tool of listed) {
        const qualified = qualifiedToolName(server.name, tool.name);
        if (taken.has(qualified)) continue;
        taken.add(qualified);
        tools.push({
          server,
          name: tool.name,
          qualified,
          definition: toolDefinition(server, qualified, tool),
        });
      }
    });
    return new McpSession(connections, tools, failures);
  }

  async call(
    tool: McpTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult> {
    const connection = this.connections.find(({ server }) => server.id === tool.server.id);
    if (!connection)
      throw new HiveError('NOT_FOUND', `MCP server "${tool.server.name}" is closed.`);
    const result = await connection.client.callTool(
      { name: tool.name, arguments: args },
      undefined,
      {
        signal,
        timeout: CALL_TIMEOUT_MS,
      },
    );
    const { text, images } = formatMcpContent(result.content);
    const structured =
      !text.trim() && result.structuredContent
        ? JSON.stringify(result.structuredContent, null, 2)
        : '';
    return { text: text || structured || '(no output)', isError: result.isError === true, images };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.connections.map(({ client }) => client.close()));
  }
}

/** Connects to one server and lists its tools, for the "Testar" button in Settings. */
export async function probeMcpServer(
  server: McpServer,
  cwd: string,
): Promise<{ tools: { name: string; description: string }[] }> {
  const session = await McpSession.open([server], cwd, AbortSignal.timeout(CONNECT_TIMEOUT_MS));
  try {
    if (session.failures.length) throw new HiveError('VALIDATION', session.failures[0]!.error);
    return {
      tools: session.tools.map((tool) => ({
        name: tool.name,
        description: tool.definition.function.description.replace(/^\[MCP [^\]]+\] /, ''),
      })),
    };
  } finally {
    await session.close();
  }
}
