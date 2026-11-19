// A stand-in for the Claude Code CLI in tests. It speaks the same `-p --output-format
// stream-json` protocol (one JSON message per line: system init, assistant turns with
// tool_use blocks, user turns with tool_result blocks, a final result) and records what it was
// started with, so tests check Hive's side without a network or a Claude account.
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
const record = process.env.FAKE_CLAUDE_RECORD;

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(
    JSON.stringify({ loggedIn: true, authMethod: process.env.FAKE_CLAUDE_AUTH ?? 'claude.ai' }),
  );
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
if (record)
  writeFileSync(
    record,
    JSON.stringify({
      args,
      prompt,
      cwd: process.cwd(),
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    }),
  );

const session = args[args.indexOf('--session-id') + 1];
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
out({
  type: 'system',
  subtype: 'init',
  session_id: session,
  model: 'claude-test',
  tools: ['Write', 'Bash'],
});

if (mode === 'hang') {
  appendFileSync(record ?? path.join(process.cwd(), 'hang.pid'), '');
  setInterval(() => undefined, 1_000);
} else if (mode === 'crash') {
  process.stderr.write('falha interna simulada\n');
  process.exit(3);
} else {
  const file = path.join(process.cwd(), 'hello.txt');
  out({
    type: 'assistant',
    session_id: session,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Vou criar o arquivo.' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'Write',
          input: { file_path: file, content: 'oi\n' },
        },
      ],
    },
  });
  writeFileSync(file, 'oi\n');
  out({
    type: 'user',
    session_id: session,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'File created' }],
    },
  });
  process.stdout.write('isto não é json\n');
  out({
    type: 'assistant',
    session_id: session,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'npm test' } }],
    },
  });
  out({
    type: 'user',
    session_id: session,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: [{ type: 'text', text: '1 passed' }],
          is_error: false,
        },
      ],
    },
  });
  out(
    mode === 'max-turns'
      ? {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          num_turns: 2,
          session_id: session,
          usage: { input_tokens: 10, output_tokens: 2 },
        }
      : {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Criei hello.txt e rodei npm test.',
          num_turns: 2,
          duration_ms: 1234,
          total_cost_usd: 0.01,
          session_id: session,
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
          },
        },
  );
}
