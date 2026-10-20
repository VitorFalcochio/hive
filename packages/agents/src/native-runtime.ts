import { realpath } from 'node:fs/promises';
import { rolePresets, stateForTool, toolNameSchema, type CommandEvidence, type ToolName } from '@hive/core';
import type { ChatMessage, ToolDefinition } from '@hive/providers';
import { Emitter, HiveError, errorMessage, isAbortError, secretRedactor } from '@hive/shared';
import type { AgentOutcome, AgentRuntime, AgentSession, AgentTaskInput, RuntimeEvent } from './runtime';
import { executeTool, toolDefinitions, type ToolContext } from './tools';

const MAX_SKILL_CHARS = 48_000;
const MAX_TEXT_ONLY_REPLIES = 2;

interface ActiveSession {
  controller: AbortController;
  events: Emitter<RuntimeEvent>;
  backlog: RuntimeEvent[];
}

export function buildSystemPrompt(input: AgentTaskInput, root: string): string {
  const { worker, skills } = input;
  const role = rolePresets[worker.role]?.label ?? worker.role;
  const shell = process.platform === 'win32' ? 'cmd.exe (Windows)' : '/bin/sh';
  const parts = [
    `You are ${worker.name}, a ${role} on a Hive software team. You work autonomously with tools; there is no human in the conversation until you finish.`,
    worker.systemPrompt.trim(),
    [
      '## Environment',
      `- Your working directory is an isolated Git worktree of the project (${root}). Use paths relative to it. Files outside it are not accessible.`,
      `- Shell commands run with ${shell} in that directory. Commands may need user approval and have a timeout.`,
      '- Do not run git commit, push, merge, rebase or reset. Hive snapshots your changes and the user reviews them.',
      '- Do not install global tools or modify files outside the project.',
    ].join('\n'),
    [
      '## How to work',
      '1. Explore the relevant files before editing. Read files before changing them.',
      '2. Make focused, minimal changes that satisfy the acceptance criteria.',
      '3. Verify with the project\'s own test, lint or build commands when they exist.',
      '4. Call `finish` once with a summary: what changed (files), how you verified it (commands and results), and open issues.',
    ].join('\n'),
  ];
  if (skills.length) {
    let budget = MAX_SKILL_CHARS;
    const blocks: string[] = [];
    for (const skill of skills) {
      const resources = skill.resources.length
        ? `\nBundled files (read with read_skill_resource): ${skill.resources.slice(0, 30).join(', ')}`
        : '';
      let text = `### Skill: ${skill.name}\n${skill.description}\n\n${skill.body}${resources}`;
      if (text.length > budget) text = `${text.slice(0, Math.max(0, budget))}\n[skill text truncated]`;
      budget -= text.length;
      blocks.push(text);
      if (budget <= 0) break;
    }
    parts.push(
      `## Skills\nThese skills are instructions for you to follow. Scripts they mention are never executed automatically.\n\n${blocks.join('\n\n')}`,
    );
  }
  return parts.filter(Boolean).join('\n\n');
}

export function buildTaskPrompt(input: AgentTaskInput): string {
  const { task } = input;
  const lines = [`# Task: ${task.title}`, '', task.description, '', '## Acceptance criteria', ...task.acceptanceCriteria.map((c) => `- ${c}`)];
  if (task.upstream.length) {
    lines.push('', '## Completed upstream work (already present in your worktree)');
    for (const item of task.upstream) lines.push(`### ${item.title}`, item.summary.slice(0, 4000));
  }
  return lines.join('\n');
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be a JSON object.');
  return value as Record<string, unknown>;
}

function excerpt(text: string | null | undefined, length = 600): string {
  if (!text) return '';
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/**
 * Hive's built-in agent engine: a tool-calling loop over an OpenAI-compatible model.
 * Each session works in one worktree, stops on `finish`, on limits, or on cancellation.
 */
export class NativeAgentRuntime implements AgentRuntime {
  readonly id = 'native';
  private readonly sessions = new Map<string, ActiveSession>();

  async start(input: AgentTaskInput): Promise<AgentSession> {
    if (this.sessions.has(input.sessionId)) throw new HiveError('CONFLICT', `Session already running: ${input.sessionId}`);
    const session: ActiveSession = { controller: new AbortController(), events: new Emitter(), backlog: [] };
    this.sessions.set(input.sessionId, session);
    const done = this.run(input, session).finally(() => this.sessions.delete(input.sessionId));
    return { id: input.sessionId, done };
  }

  async cancel(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.controller.abort(new HiveError('CANCELLED', 'Cancelled by user.'));
  }

  subscribe(sessionId: string, onEvent: (event: RuntimeEvent) => void): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) return () => undefined;
    for (const event of session.backlog) onEvent(event);
    return session.events.on(onEvent);
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private async run(input: AgentTaskInput, session: ActiveSession): Promise<AgentOutcome> {
    const emit = (event: RuntimeEvent) => {
      const safe = secretRedactor.redactDeep(event);
      // Events emitted before the caller subscribes are replayed on subscribe.
      if (session.events.size === 0) session.backlog.push(safe);
      session.events.emit(safe);
    };
    const usage = { promptTokens: 0, completionTokens: 0 };
    const commands: CommandEvidence[] = [];
    const { limits, worker } = input;
    const timeout = AbortSignal.timeout(limits.taskTimeoutMin * 60_000);
    const signal = AbortSignal.any([session.controller.signal, timeout]);
    let steps = 0;
    const outcome = (status: AgentOutcome['status'], summary: string, error: string | null): AgentOutcome => ({
      status,
      summary,
      error,
      steps,
      usage,
      commands,
    });

    try {
      const root = await realpath(input.worktreePath);
      const allowed = new Set<ToolName>(worker.tools);
      const tools: ToolDefinition[] = [...worker.tools.map((name) => toolDefinitions[name]), toolDefinitions.finish];
      const ctx: ToolContext = {
        root,
        worker,
        skills: input.skills,
        signal,
        commandTimeoutMs: limits.commandTimeoutSec * 1000,
        commands,
        emit,
        requestApproval: async (request) => {
          emit({ type: 'worker.state', level: 'info', message: 'Waiting for approval', data: { state: 'waiting_approval' } });
          const approved = await raceAbort(input.requestApproval(request), signal);
          emit({ type: 'worker.state', level: 'info', message: approved ? 'Approved' : 'Denied', data: { state: 'thinking' } });
          return approved;
        },
      };
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(input, root) },
        { role: 'user', content: buildTaskPrompt(input) },
      ];
      emit({
        type: 'session.started',
        level: 'info',
        message: `${worker.name} started on ${input.model}`,
        data: { model: input.model, tools: worker.tools, skills: input.skills.map((s) => s.name), runtime: this.id },
      });

      let textOnlyReplies = 0;
      while (steps < limits.maxSteps) {
        if (usage.promptTokens + usage.completionTokens >= limits.maxTokens) {
          return outcome('failed', '', `Token budget of ${limits.maxTokens.toLocaleString('en-US')} reached.`);
        }
        steps++;
        emit({ type: 'worker.state', level: 'debug', message: 'Thinking', data: { state: 'thinking' } });
        emit({ type: 'model.request', level: 'debug', message: `Step ${steps}: calling ${input.model}`, data: { step: steps, messages: messages.length } });
        const response = await input.chat.chat({ model: input.model, messages, tools, temperature: limits.temperature }, signal);
        if (response.usage) {
          usage.promptTokens += response.usage.promptTokens;
          usage.completionTokens += response.usage.completionTokens;
        }
        const calls = response.message.tool_calls ?? [];
        emit({
          type: 'model.response',
          level: 'info',
          message: response.message.content?.trim() ? excerpt(response.message.content.trim(), 300) : calls.length ? `Calling ${calls.map((c) => c.function.name).join(', ')}` : '(empty response)',
          data: {
            step: steps,
            content: excerpt(response.message.content, 4000),
            reasoning: excerpt(response.reasoning, 2000),
            toolCalls: calls.map((call) => call.function.name),
            usage: response.usage,
            latencyMs: response.latencyMs,
            finishReason: response.finishReason,
          },
        });
        messages.push(response.message);

        if (!calls.length) {
          textOnlyReplies++;
          if (textOnlyReplies >= MAX_TEXT_ONLY_REPLIES) {
            emit({ type: 'info', level: 'warn', message: 'Model stopped calling tools; treating its last reply as the final summary.' });
            return outcome('completed', response.message.content?.trim() || 'No summary provided.', null);
          }
          messages.push({
            role: 'user',
            content: 'Continue using the tools to complete the task. When you are done, call `finish` with your summary.',
          });
          continue;
        }
        textOnlyReplies = 0;

        let finished: AgentOutcome | null = null;
        for (const call of calls) {
          let args: Record<string, unknown>;
          try {
            args = parseArguments(call.function.arguments);
          } catch (error) {
            messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: invalid JSON arguments (${errorMessage(error)}).` });
            continue;
          }
          if (call.function.name === 'finish') {
            const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : 'No summary provided.';
            const success = args.success !== false;
            emit({ type: 'tool.call', level: 'info', message: 'finish', data: { tool: 'finish', success } });
            messages.push({ role: 'tool', tool_call_id: call.id, content: 'Recorded.' });
            finished = success ? outcome('completed', summary, null) : outcome('failed', summary, 'The agent reported that it could not complete the task.');
            break;
          }
          const parsedName = toolNameSchema.safeParse(call.function.name);
          if (!parsedName.success || !allowed.has(parsedName.data)) {
            messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: tool "${call.function.name}" is not available to you.` });
            emit({ type: 'tool.call', level: 'warn', message: `Rejected unavailable tool ${call.function.name}`, data: { tool: call.function.name } });
            continue;
          }
          const name = parsedName.data;
          const command = name === 'run_command' && typeof args.command === 'string' ? args.command : undefined;
          emit({ type: 'worker.state', level: 'debug', message: stateForTool(name, command), data: { state: stateForTool(name, command) } });
          emit({ type: 'tool.call', level: 'info', message: describeCall(name, args), data: { tool: name, args: summarizeArgs(args) } });
          const result = await executeTool(ctx, name, args);
          emit({
            type: 'tool.result',
            level: result.isError ? 'warn' : 'debug',
            message: `${name}: ${excerpt(result.output.split('\n')[0], 160)}`,
            data: { tool: name, isError: result.isError, output: excerpt(result.output, 2000) },
          });
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
        }
        if (finished) return finished;
      }
      return outcome('failed', '', `Step limit of ${limits.maxSteps} reached before the task was finished.`);
    } catch (error) {
      if (session.controller.signal.aborted) return outcome('cancelled', '', 'Cancelled by user.');
      if (timeout.aborted) return outcome('failed', '', `Task timed out after ${limits.taskTimeoutMin} minutes.`);
      if (isAbortError(error)) return outcome('cancelled', '', 'Cancelled.');
      return outcome('failed', '', secretRedactor.redact(errorMessage(error)));
    }
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new HiveError('CANCELLED', 'Cancelled.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new HiveError('CANCELLED', 'Cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function describeCall(name: ToolName, args: Record<string, unknown>): string {
  const target = typeof args.path === 'string' ? args.path : typeof args.command === 'string' ? args.command : typeof args.query === 'string' ? `"${args.query}"` : '';
  return target ? `${name} ${excerpt(target, 160)}` : name;
}

/** Tool arguments for the event log, without bulky file contents. */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}… (${value.length} chars)` : value;
  }
  return out;
}
