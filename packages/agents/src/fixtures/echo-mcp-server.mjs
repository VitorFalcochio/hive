// A tiny MCP server over stdio for the tests: newline-delimited JSON-RPC, no SDK needed.
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'echo',
    description: 'Repeats the text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'env', description: 'Reads HIVE_TEST_VALUE.', inputSchema: { type: 'object' } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object' } },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function call(name, args) {
  if (name === 'echo') return { content: [{ type: 'text', text: `eco: ${args.text}` }] };
  if (name === 'env')
    return { content: [{ type: 'text', text: process.env.HIVE_TEST_VALUE ?? '' }] };
  return { content: [{ type: 'text', text: 'quebrou' }], isError: true };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize':
      return reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      });
    case 'tools/list':
      return reply(message.id, { tools });
    case 'tools/call':
      return reply(message.id, call(message.params.name, message.params.arguments ?? {}));
    default:
      return process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } })}\n`,
      );
  }
});
