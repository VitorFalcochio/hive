import { realpath } from 'node:fs/promises';
import {
  callableSoldiers,
  commandMatchesAllowList,
  rolePresets,
  soldierPresets,
  soldierWrites,
  stateForTool,
  toolNameSchema,
  type CommandEvidence,
  type ExecutionLimits,
  type McpServer,
  type SoldierRole,
  type ToolName,
  type Worker,
} from '@hive/core';
import {
  ProviderError,
  withRetries,
  type ChatClient,
  type ChatMessage,
  type ContentPart,
  type RetryNotice,
  type ToolDefinition,
} from '@hive/providers';
import { Emitter, HiveError, errorMessage, isAbortError, secretRedactor } from '@hive/shared';
import type {
  AgentOutcome,
  AgentRuntime,
  AgentSession,
  AgentTaskInput,
  RuntimeEvent,
} from './runtime';
import { McpSession, type McpTool } from './mcp';
import {
  executeTool,
  toolDefinitions,
  truncate,
  type ToolContext,
  type ToolImage,
  type ToolOutcome,
} from './tools';
import type { PageViewer } from './web';

const MAX_SKILL_CHARS = 48_000;
const MAX_TEXT_ONLY_REPLIES = 2;
/** Images are resent on every step, so only the latest ones stay attached. */
const MAX_ATTACHED_IMAGES = 2;
/**
 * The whole conversation is sent again on every step, so a file read early on is paid for at
 * each step after it. Outputs older than this many steps are cut down to their beginning.
 */
const KEEP_FULL_STEPS = 3;
const COMPACT_OVER_CHARS = 1_500;
const COMPACT_TO_CHARS = 400;
const COMPACTED = '\n[… older output shortened to save tokens; call the tool again if you need it]';
/** A soldier's job is one focused piece of the task, so her loop is short. */
const SOLDIER_MAX_STEPS = 15;
/** Reports go back into the captain's prompt, which is resent on every step. */
const SOLDIER_REPORT_CHARS = 2_500;
const WRAP_UP_PROMPT =
  'The token budget for this task is almost used up. Do not call any more tools. Reply now with a final summary: what you did, what you found or changed, and what is still missing.';

interface ActiveSession {
  controller: AbortController;
  events: Emitter<RuntimeEvent>;
  backlog: RuntimeEvent[];
}

export function buildSystemPrompt(input: AgentTaskInput, root: string): string {
  const { worker, skills } = input;
  const role = rolePresets[worker.role]?.label ?? worker.role;
  const shell = process.platform === 'win32' ? 'cmd.exe (Windows)' : '/bin/sh';
  // 'project': the user talks to the agent from a terminal and watches it work in their folder.
  const live = input.place === 'project';
  // Every word here is paid on every step, so the terminal prompt is kept short.
  const parts = live
    ? [
        `You are ${worker.name}, ${role} on a Hive team, talking with the user in a terminal. They see each tool call you make.`,
        worker.systemPrompt.trim(),
        [
          '## Rules',
          `- Project folder: ${root}. Paths are relative to it and edits apply at once. Shell: ${shell}; commands may need the user's approval.`,
          '- No git commit, push, merge, rebase or reset unless asked. No global installs.',
          '- Questions and small talk: answer in plain text without tools. A plain-text reply ends your turn.',
          "- Work: read before editing, keep changes small, check with the project's tests or build when they exist, then reply with the answer itself (what changed, how you checked). Be brief: they saw the steps.",
          "- Reply in the user's language. Images opened with read_file are shown to you: look at them, do not script pixel analysis.",
        ].join('\n'),
      ]
    : [
        `You are ${worker.name}, a ${role} on a Hive software team. You work autonomously with tools; there is no human in the conversation until you finish.`,
        worker.systemPrompt.trim(),
        [
          '## Environment',
          `- Your working directory is an isolated Git worktree of the project (${root}). Use paths relative to it. Files outside it are not accessible.`,
          `- Shell commands run with ${shell} in that directory. Commands may need user approval and have a timeout.`,
          '- Do not run git commit, push, merge, rebase or reset. Hive snapshots your changes and the user reviews them.',
          '- Do not install global tools or modify files outside the project.',
          '- Images opened with read_file (screenshots, mockups, icons) are shown to you when your model sees images: look at them rather than analysing pixels with scripts.',
        ].join('\n'),
        [
          '## How to work',
          '1. Explore the relevant files before editing. Read files before changing them.',
          '2. Make focused, minimal changes that satisfy the acceptance criteria.',
          "3. Verify with the project's own test, lint or build commands when they exist.",
          '4. Call `finish` once with a summary: what changed (files), how you verified it (commands and results), and open issues.',
        ].join('\n'),
      ];
  parts.push(buildSquadPrompt(callableSoldiers(worker)));
  if (skills.length) {
    let budget = MAX_SKILL_CHARS;
    const blocks: string[] = [];
    for (const skill of skills) {
      const resources = skill.resources.length
        ? `\nBundled files (read with read_skill_resource): ${skill.resources.slice(0, 30).join(', ')}`
        : '';
      let text = `### Skill: ${skill.name}\n${skill.description}\n\n${skill.body}${resources}`;
      if (text.length > budget)
        text = `${text.slice(0, Math.max(0, budget))}\n[skill text truncated]`;
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
  const lines = [`# Task: ${task.title}`, '', task.description];
  if (task.acceptanceCriteria.length)
    lines.push('', '## Acceptance criteria', ...task.acceptanceCriteria.map((c) => `- ${c}`));
  if (task.upstream.length) {
    lines.push('', '## Completed upstream work (already present in your worktree)');
    for (const item of task.upstream) lines.push(`### ${item.title}`, item.summary.slice(0, 4000));
  }
  if (task.review) {
    const { review } = task;
    lines.push(
      '',
      `## Review of your previous result (round ${review.round})`,
      'Your previous work on this task is already in the worktree. The user reviewed its diff and asks for the changes below. Make them, keep everything else you did, and do not start over.',
    );
    if (review.previousSummary)
      lines.push('', 'Your previous summary:', review.previousSummary.slice(0, 2000));
    if (review.comments.length) {
      lines.push('', 'Comments on specific lines (the code shown is the line as it was):');
      for (const comment of review.comments) {
        const where = `${comment.path}:${comment.line}${comment.side === 'old' ? ' (removed line)' : ''}`;
        lines.push(`- ${where} \`${comment.code.trim().slice(0, 200)}\`: ${comment.body}`);
      }
    }
    if (review.note.trim()) lines.push('', 'General note from the user:', review.note.trim());
  }
  return lines.join('\n');
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Arguments must be a JSON object.');
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
export interface NativeRuntimeOptions {
  /** The MCP servers configured in Settings, read again whenever a session starts. */
  mcpServers?: () => McpServer[];
  /** Opens local pages for view_page; the tool is left out without it. */
  viewPage?: PageViewer;
}

export class NativeAgentRuntime implements AgentRuntime {
  readonly id = 'native';
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(private readonly options: NativeRuntimeOptions = {}) {}

  async start(input: AgentTaskInput): Promise<AgentSession> {
    if (this.sessions.has(input.sessionId))
      throw new HiveError('CONFLICT', `Session already running: ${input.sessionId}`);
    const session: ActiveSession = {
      controller: new AbortController(),
      events: new Emitter(),
      backlog: [],
    };
    this.sessions.set(input.sessionId, session);
    const done = this.run(input, session).finally(() => this.sessions.delete(input.sessionId));
    return { id: input.sessionId, done };
  }

  async cancel(sessionId: string): Promise<void> {
    this.sessions
      .get(sessionId)
      ?.controller.abort(new HiveError('CANCELLED', 'Cancelled by user.'));
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
    const progress = { steps: 0 };
    const outcome = (
      status: AgentOutcome['status'],
      summary: string,
      error: string | null,
    ): AgentOutcome => ({
      status,
      summary,
      error,
      steps: progress.steps,
      usage,
      commands,
    });

    let mcp: McpSession | null = null;
    try {
      const root = await realpath(input.worktreePath);
      const env: LoopEnv = { chat: input.chat, limits, signal, usage };
      const ctx: ToolContext = {
        root,
        worker,
        skills: input.skills,
        signal,
        commandTimeoutMs: limits.commandTimeoutSec * 1000,
        commands,
        emit,
        vision: true,
        ...(this.options.viewPage ? { viewPage: this.options.viewPage } : {}),
        requestApproval: async (request) => {
          emit({
            type: 'worker.state',
            level: 'info',
            message: 'Waiting for approval',
            data: { state: 'waiting_approval' },
          });
          const approved = await raceAbort(input.requestApproval(request), signal);
          emit({
            type: 'worker.state',
            level: 'info',
            message: approved ? 'Approved' : 'Denied',
            data: { state: 'thinking' },
          });
          return approved;
        },
      };
      const squad = callableSoldiers(worker);
      mcp = await openMcp(this.options.mcpServers?.() ?? [], worker, root, signal, emit);
      const own = offeredTools(worker.tools, ctx);
      const tools: ToolDefinition[] = [
        ...own.map((name) => toolDefinitions[name]),
        ...(squad.length ? [callSoldiersDefinition(squad.map(({ soldier }) => soldier.role))] : []),
        ...(mcp?.tools.map((tool) => tool.definition) ?? []),
        toolDefinitions.finish,
      ];
      emit({
        type: 'session.started',
        level: 'info',
        message: `${worker.name} started on ${input.model}`,
        data: {
          model: input.model,
          tools: own,
          mcpTools: mcp?.tools.map((tool) => tool.qualified) ?? [],
          skills: input.skills.map((s) => s.name),
          squad: squad.map(({ soldier }) => soldier.role),
          runtime: this.id,
        },
      });
      const result = await runLoop(env, {
        model: input.model,
        messages: [
          { role: 'system', content: buildSystemPrompt(input, root) },
          { role: 'user', content: buildTaskPrompt(input) },
        ],
        tools,
        allowed: new Set<ToolName>(own),
        ctx,
        maxSteps: limits.maxSteps,
        textEnds: input.place === 'project',
        progress,
        extraTools: {
          ...(squad.length
            ? { call_soldiers: (args) => callSoldiers(env, ctx, { input, root, squad }, args) }
            : {}),
          ...(mcp ? mcpHandlers(mcp, ctx) : {}),
        },
      });
      return outcome(result.status, result.summary, result.error);
    } catch (error) {
      if (session.controller.signal.aborted) return outcome('cancelled', '', 'Cancelled by user.');
      if (timeout.aborted)
        return outcome('failed', '', `Task timed out after ${limits.taskTimeoutMin} minutes.`);
      if (isAbortError(error)) return outcome('cancelled', '', 'Cancelled.');
      return outcome('failed', '', secretRedactor.redact(errorMessage(error)));
    } finally {
      await mcp?.close();
    }
  }
}

/** What every loop of one session shares: the provider, the limits and the token count. */
interface LoopEnv {
  chat: ChatClient;
  limits: ExecutionLimits;
  signal: AbortSignal;
  /** Summed over the captain and all her soldiers; the token budget applies to the total. */
  usage: { promptTokens: number; completionTokens: number };
}

interface LoopOptions {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  allowed: Set<ToolName>;
  /** Its `emit` is where this loop's events go. */
  ctx: ToolContext;
  maxSteps: number;
  /** A plain-text reply is the final answer instead of a nudge to keep using tools. */
  textEnds: boolean;
  progress: { steps: number };
  /**
   * Tools the loop does not run itself, by name. A plain string is the tool message content;
   * an outcome can carry an image too and reports its own events.
   */
  extraTools?: Record<string, (args: Record<string, unknown>) => Promise<string | ToolOutcome>>;
}

type LoopResult = Pick<AgentOutcome, 'summary' | 'error'> & { status: 'completed' | 'failed' };

/**
 * One agent's tool-calling loop: it ends on `finish`, on a final plain-text reply, on the token
 * budget (after a last summary) or on the step limit. Provider errors and aborts are thrown.
 */
async function runLoop(env: LoopEnv, loop: LoopOptions): Promise<LoopResult> {
  const { chat, limits, signal, usage } = env;
  const { messages, tools, allowed, ctx, progress } = loop;
  const emit = (event: RuntimeEvent) => ctx.emit(event);
  const done = (status: LoopResult['status'], summary: string, error: string | null) => ({
    status,
    summary,
    error,
  });
  let textOnlyReplies = 0;
  // The prompt is resent in full on every step, so the budget is close when the next step
  // would pass it. Then the agent is asked for its final summary without tools.
  let wrappingUp = false;
  let lastPromptTokens = 0;
  let steps = 0;
  while (steps < loop.maxSteps) {
    const used = usage.promptTokens + usage.completionTokens;
    if (!wrappingUp && used + lastPromptTokens >= limits.maxTokens) {
      wrappingUp = true;
      emit({
        type: 'info',
        level: 'warn',
        message: `Perto do limite de ${limits.maxTokens.toLocaleString('en-US')} tokens; pedindo o resumo final.`,
      });
      messages.push({ role: 'user', content: WRAP_UP_PROMPT });
    }
    steps++;
    progress.steps++;
    emit({
      type: 'worker.state',
      level: 'debug',
      message: 'Thinking',
      data: { state: 'thinking' },
    });
    emit({
      type: 'model.request',
      level: 'debug',
      message: `Step ${steps}: calling ${loop.model}`,
      data: { step: steps, messages: messages.length },
    });
    // Rate limits and provider hiccups are waited out, not failed: the agent keeps its
    // progress and tries again until the task's own time limit.
    let waited = false;
    const onRetry = (notice: RetryNotice) => {
      waited = true;
      emit({
        type: 'worker.state',
        level: 'debug',
        message: 'Waiting for the provider',
        data: { state: 'waiting_provider' },
      });
      emit({
        type: 'info',
        level: 'warn',
        message: `${providerTrouble(notice.error)} Nova tentativa em ${formatDelay(notice.delayMs)} (tentativa ${notice.attempt}).`,
        data: { error: excerpt(errorMessage(notice.error), 300), delayMs: notice.delayMs },
      });
    };
    const request = async () => {
      const response = await withRetries(
        () =>
          chat.chat(
            {
              model: loop.model,
              messages,
              tools: wrappingUp ? undefined : tools,
              temperature: limits.temperature,
            },
            signal,
          ),
        { signal, onRetry },
      );
      if (waited) {
        waited = false;
        emit({
          type: 'worker.state',
          level: 'info',
          message: 'O provedor voltou a responder.',
          data: { state: 'thinking' },
        });
      }
      return response;
    };
    let response;
    try {
      response = await request();
    } catch (error) {
      // A model without vision rejects the request outright. The images are taken out and
      // the step is retried once; from then on images are described instead of sent.
      if (!ctx.vision || !hasImages(messages) || !isRejection(error)) throw error;
      ctx.vision = false;
      dropImages(messages, 0, 'The image could not be shown: your model does not accept images.');
      emit({
        type: 'info',
        level: 'warn',
        message: `O modelo ${loop.model} não aceita imagens; seguindo sem elas.`,
        data: { error: excerpt(errorMessage(error), 300) },
      });
      response = await request();
    }
    if (response.usage) {
      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      lastPromptTokens = response.usage.promptTokens;
    }
    const calls = response.message.tool_calls ?? [];
    emit({
      type: 'model.response',
      level: 'info',
      message: response.message.content?.trim()
        ? excerpt(response.message.content.trim(), 300)
        : calls.length
          ? `Calling ${calls.map((c) => c.function.name).join(', ')}`
          : '(empty response)',
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

    if (wrappingUp) {
      const text = response.message.content?.trim() || 'Nenhum resumo foi produzido.';
      return done(
        'completed',
        `${text}\n\n_Encerrado ao atingir o limite de ${limits.maxTokens.toLocaleString('en-US')} tokens._`,
        null,
      );
    }

    if (!calls.length) {
      // In a terminal conversation a plain-text reply is the answer; insisting on tools
      // would only buy a second, paid step that repeats it.
      const text = response.message.content?.trim();
      if (loop.textEnds && text) return done('completed', text, null);
      textOnlyReplies++;
      if (textOnlyReplies >= MAX_TEXT_ONLY_REPLIES) {
        emit({
          type: 'info',
          level: 'warn',
          message: 'Model stopped calling tools; treating its last reply as the final summary.',
        });
        return done('completed', text || 'No summary provided.', null);
      }
      messages.push({
        role: 'user',
        content:
          'Continue using the tools to complete the task. When you are done, call `finish` with your summary.',
      });
      continue;
    }
    textOnlyReplies = 0;

    let finished: LoopResult | null = null;
    const images: ToolImage[] = [];
    for (const call of calls) {
      let args: Record<string, unknown>;
      try {
        args = parseArguments(call.function.arguments);
      } catch (error) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Error: invalid JSON arguments (${errorMessage(error)}).`,
        });
        continue;
      }
      if (call.function.name === 'finish') {
        const summary =
          typeof args.summary === 'string' && args.summary.trim()
            ? args.summary.trim()
            : 'No summary provided.';
        const success = args.success !== false;
        emit({
          type: 'tool.call',
          level: 'info',
          message: 'finish',
          data: { tool: 'finish', success },
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Recorded.' });
        finished = success
          ? done('completed', summary, null)
          : done('failed', summary, 'The agent reported that it could not complete the task.');
        break;
      }
      const extra = loop.extraTools?.[call.function.name];
      if (extra) {
        const result = await extra(args);
        if (typeof result !== 'string') {
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
          if (result.image) images.push(result.image);
          continue;
        }
        const output = result;
        // Its successes are already in the log as the soldiers' own events; a refusal is not.
        if (output.startsWith('Error:'))
          emit({
            type: 'tool.result',
            level: 'warn',
            message: `${call.function.name}: ${excerpt(output, 160)}`,
            data: { tool: call.function.name, isError: true, output: excerpt(output, 2000) },
          });
        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        continue;
      }
      const parsedName = toolNameSchema.safeParse(call.function.name);
      if (!parsedName.success || !allowed.has(parsedName.data)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Error: tool "${call.function.name}" is not available to you.`,
        });
        emit({
          type: 'tool.call',
          level: 'warn',
          message: `Rejected unavailable tool ${call.function.name}`,
          data: { tool: call.function.name },
        });
        continue;
      }
      const name = parsedName.data;
      const command =
        name === 'run_command' && typeof args.command === 'string' ? args.command : undefined;
      emit({
        type: 'worker.state',
        level: 'debug',
        message: stateForTool(name, command),
        data: { state: stateForTool(name, command) },
      });
      emit({
        type: 'tool.call',
        level: 'info',
        message: describeCall(name, args),
        data: { tool: name, args: summarizeArgs(args) },
      });
      const result = await executeTool(ctx, name, args);
      emit({
        type: 'tool.result',
        level: result.isError ? 'warn' : 'debug',
        message: `${name}: ${excerpt(result.output.split('\n')[0], 160)}`,
        data: {
          tool: name,
          isError: result.isError,
          output: excerpt(result.output, 2000),
          ...(result.image ? { image: result.image.path } : {}),
        },
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
      if (result.image) images.push(result.image);
    }
    if (finished) return finished;
    compactToolOutputs(messages, KEEP_FULL_STEPS);
    // Tool messages carry text only, so the images follow them in a user message.
    if (images.length) {
      messages.push({
        role: 'user',
        content: images.flatMap((image): ContentPart[] => [
          { type: 'text', text: `Image ${image.path}:` },
          { type: 'image_url', image_url: { url: image.dataUrl } },
        ]),
      });
      dropImages(
        messages,
        MAX_ATTACHED_IMAGES,
        'An image was shown here earlier and is no longer attached; read the file again to look at it.',
      );
    }
  }
  return done('failed', '', `Step limit of ${loop.maxSteps} reached before the task was finished.`);
}

/* ---------------------------------------------------------------- Squad */

type CallableSoldier = ReturnType<typeof callableSoldiers>[number];

function callSoldiersDefinition(roles: SoldierRole[]): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'call_soldiers',
      description:
        'Send soldier bees from your squad to do part of the work, and wait for their reports. Soldiers in one call work in parallel; at most one of them may edit files or run commands.',
      parameters: {
        type: 'object',
        properties: {
          assignments: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: roles },
                instruction: {
                  type: 'string',
                  description:
                    'Self-contained: the soldier sees nothing else. Say the goal, the files involved and what to report.',
                },
              },
              required: ['role', 'instruction'],
            },
          },
        },
        required: ['assignments'],
      },
    },
  };
}

/** The squad section of the captain's prompt; empty when she has no soldier to call. */
export function buildSquadPrompt(squad: CallableSoldier[]): string {
  if (!squad.length) return '';
  return [
    '## Your squad',
    'You are the captain of these soldier bees. Call them with `call_soldiers` only when it beats doing the work yourself (a broad exploration, a long edit, a test run); do small things yourself. Call several at once only for independent work: they run in parallel. Each sees only your instruction and answers with a short report.',
    ...squad.map(({ soldier }) => `- ${soldier.role}: ${soldierPresets[soldier.role].brief}`),
  ].join('\n');
}

export function buildSoldierPrompt(
  captain: Worker,
  role: SoldierRole,
  root: string,
  place: AgentTaskInput['place'],
): string {
  const shell = process.platform === 'win32' ? 'cmd.exe (Windows)' : '/bin/sh';
  const where =
    place === 'project'
      ? `the user's project folder (${root}); edits apply at once`
      : `an isolated Git worktree of the project (${root})`;
  return [
    `You are the ${role} bee in ${captain.name}'s squad on a Hive software team: you ${soldierPresets[role].brief}`,
    'Your captain gives you one instruction and reads only your final report, not your steps.',
    [
      '## Rules',
      `- You work in ${where}. Paths are relative to it. Shell: ${shell}; commands may need approval.`,
      '- No git commit, push, merge, rebase or reset. No global installs.',
      '- Do only what the instruction asks. Read files before changing them.',
      '- When done, reply with your report (or call `finish`): under 200 words, with file paths, exact command results and anything still open.',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * The assignments as smaller models send them: a list, the list as a JSON string, or a single
 * `{ role, instruction }` without the list.
 */
function readAssignments(args: Record<string, unknown>): unknown[] {
  let value = args.assignments;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value as unknown[];
  if (value && typeof value === 'object') return [value];
  return 'role' in args ? [args] : [];
}

/**
 * Runs the soldiers the captain called, in parallel, and returns their reports as one tool
 * result. Bad calls come back as an error for the captain to fix; a soldier that fails is
 * reported, not thrown, unless the whole session was stopped.
 */
async function callSoldiers(
  env: LoopEnv,
  ctx: ToolContext,
  captain: { input: AgentTaskInput; root: string; squad: CallableSoldier[] },
  args: Record<string, unknown>,
): Promise<string> {
  const { input, root, squad } = captain;
  const raw = readAssignments(args);
  const assignments: { member: CallableSoldier; instruction: string }[] = [];
  for (const item of raw) {
    const { role, instruction } = (item ?? {}) as Record<string, unknown>;
    const member = squad.find(({ soldier }) => soldier.role === role);
    if (!member)
      return `Error: "${String(role)}" is not in your squad. Available: ${squad.map(({ soldier }) => soldier.role).join(', ')}.`;
    if (typeof instruction !== 'string' || !instruction.trim())
      return `Error: the assignment for ${member.soldier.role} needs an instruction.`;
    if (assignments.some((other) => other.member === member))
      return `Error: ${member.soldier.role} was called twice; give her one instruction.`;
    assignments.push({ member, instruction: instruction.trim() });
  }
  if (!assignments.length) return 'Error: call at least one soldier.';
  if (assignments.filter(({ member }) => soldierWrites(member.soldier.role)).length > 1)
    return 'Error: at most one soldier that edits files or runs commands per call; call the others afterwards.';

  const labels = assignments.map(({ member }) => soldierPresets[member.soldier.role].label);
  ctx.emit({
    type: 'tool.call',
    level: 'info',
    message: `Convocou ${labels.join(', ')}`,
    data: { tool: 'call_soldiers', soldiers: assignments.map(({ member }) => member.soldier.role) },
  });

  const reports = await Promise.all(
    assignments.map(async ({ member, instruction }) => {
      const { soldier, tools } = member;
      const label = soldierPresets[soldier.role].label;
      const emit = (event: RuntimeEvent) =>
        ctx.emit({
          ...event,
          message: `${label}: ${event.message}`,
          data: { ...event.data, soldier: soldier.role },
        });
      const model = soldier.modelId ?? input.model;
      emit({
        type: 'info',
        level: 'info',
        message: `começou em ${model}`,
        data: { phase: 'start', instruction: excerpt(instruction, 600), model },
      });
      let result: LoopResult;
      try {
        result = await runLoop(env, {
          model,
          messages: [
            {
              role: 'system',
              content: buildSoldierPrompt(input.worker, soldier.role, root, input.place),
            },
            { role: 'user', content: instruction },
          ],
          tools: [
            ...offeredTools(tools, ctx).map((name) => toolDefinitions[name]),
            toolDefinitions.finish,
          ],
          allowed: new Set(offeredTools(tools, ctx)),
          ctx: { ...ctx, emit },
          maxSteps: Math.min(env.limits.maxSteps, SOLDIER_MAX_STEPS),
          textEnds: true,
          progress: { steps: 0 },
        });
      } catch (error) {
        if (env.signal.aborted) throw error;
        result = { status: 'failed', summary: '', error: errorMessage(error) };
      }
      emit({
        type: 'info',
        level: result.status === 'completed' ? 'info' : 'warn',
        message: result.status === 'completed' ? 'terminou' : `falhou: ${result.error ?? ''}`,
        data: { phase: 'end', status: result.status },
      });
      const body = [result.summary && excerpt(result.summary, SOLDIER_REPORT_CHARS), result.error]
        .filter(Boolean)
        .join('\n');
      return `## ${soldier.role} (${result.status})\n${body || 'No report.'}`;
    }),
  );
  return reports.join('\n\n');
}

/** The tools this environment can actually run: view_page needs a page viewer. */
function offeredTools(tools: ToolName[], ctx: ToolContext): ToolName[] {
  return tools.filter((name) => name !== 'view_page' || ctx.viewPage);
}

/** The agent's MCP servers, started for this session; ones that fail are logged and skipped. */
async function openMcp(
  servers: McpServer[],
  worker: Worker,
  root: string,
  signal: AbortSignal,
  emit: (event: RuntimeEvent) => void,
): Promise<McpSession | null> {
  const chosen = servers.filter(
    (server) => server.enabled && worker.mcpServers.includes(server.id),
  );
  if (!chosen.length) return null;
  const session = await McpSession.open(chosen, root, signal);
  for (const failure of session.failures)
    emit({
      type: 'info',
      level: 'warn',
      message: `Servidor MCP ${failure.server} indisponível: ${excerpt(failure.error.split('\n')[0], 200)}`,
      data: { mcp: failure.server, error: excerpt(failure.error, 2000) },
    });
  return session;
}

/**
 * How an MCP call reads where commands are approved, so the same rules cover it: an agent's
 * allow-list entry `mcp github *` or the shift's safe list lets it through without asking.
 */
export function mcpCommand(
  tool: Pick<McpTool, 'server' | 'name'>,
  args: Record<string, unknown>,
): string {
  return `mcp ${tool.server.name} ${tool.name} ${JSON.stringify(args)}`.slice(0, 2000);
}

function mcpHandlers(
  mcp: McpSession,
  ctx: ToolContext,
): Record<string, (args: Record<string, unknown>) => Promise<ToolOutcome>> {
  return Object.fromEntries(
    mcp.tools.map((tool) => [
      tool.qualified,
      async (args: Record<string, unknown>): Promise<ToolOutcome> => {
        const label = `${tool.server.name} · ${tool.name}`;
        ctx.emit({
          type: 'tool.call',
          level: 'info',
          message: `MCP ${label}`,
          data: { tool: tool.qualified, mcp: tool.server.name, args: summarizeArgs(args) },
        });
        const command = mcpCommand(tool, args);
        const allowed =
          tool.server.approval === 'auto' ||
          commandMatchesAllowList(command, ctx.worker.autoApproveCommands) ||
          (await ctx.requestApproval({ command }));
        if (!allowed)
          return {
            output:
              'The user denied this MCP call. Do not retry it; continue without it or explain in finish.',
            isError: true,
          };
        let outcome: ToolOutcome;
        try {
          const result = await mcp.call(tool, args, ctx.signal);
          const image = ctx.vision ? result.images[0] : undefined;
          outcome = {
            output: truncate(result.text),
            isError: result.isError,
            ...(image
              ? {
                  image: {
                    path: label,
                    mime: image.mime,
                    dataUrl: `data:${image.mime};base64,${image.data}`,
                  },
                }
              : {}),
          };
        } catch (error) {
          if (ctx.signal.aborted) throw new HiveError('CANCELLED', 'Cancelled.');
          outcome = { output: `Error: ${errorMessage(error)}`, isError: true };
        }
        ctx.emit({
          type: 'tool.result',
          level: outcome.isError ? 'warn' : 'debug',
          message: `${label}: ${excerpt(outcome.output.split('\n')[0], 160)}`,
          data: {
            tool: tool.qualified,
            isError: outcome.isError,
            output: excerpt(outcome.output, 2000),
          },
        });
        return outcome;
      },
    ]),
  );
}

/**
 * Shortens long tool outputs from before the last `keep` steps (a step is one assistant
 * message with tool calls). Each output is shortened once, so later prompts stay identical
 * from there on and providers that cache prompt prefixes keep their cache.
 */
export function compactToolOutputs(messages: ChatMessage[], keep: number): void {
  let steps = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.tool_calls?.length) steps++;
    // Walking backwards, `steps` counts the steps newer than this output.
    if (steps < keep || message.role !== 'tool') continue;
    if (message.content.length <= COMPACT_OVER_CHARS || message.content.endsWith(COMPACTED))
      continue;
    messages[index] = {
      ...message,
      content: message.content.slice(0, COMPACT_TO_CHARS) + COMPACTED,
    };
  }
}

function hasImages(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url'),
  );
}

/** Replaces all but the `keep` most recent images with `note`. */
function dropImages(messages: ChatMessage[], keep: number, note: string): void {
  let kept = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const parts = [...message.content];
    for (let part = parts.length - 1; part >= 0; part--) {
      if (parts[part]!.type !== 'image_url') continue;
      if (kept < keep) kept++;
      else parts[part] = { type: 'text', text: note };
    }
    messages[index] = { role: 'user', content: parts };
  }
}

/**
 * Whether the provider turned the request itself down, as models without vision do with images,
 * rather than failing over keys, limits or availability.
 */
function isRejection(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.status === null) return false;
  return (
    error.status >= 400 && error.status < 500 && ![401, 403, 404, 408, 429].includes(error.status)
  );
}

/** What is wrong with the provider, in the words the task card shows. */
function providerTrouble(error: unknown): string {
  if (error instanceof ProviderError) {
    if (error.status === 429) return 'Limite de uso do provedor atingido (429).';
    if (error.status === null) return 'O provedor não respondeu.';
    return `O provedor falhou (${error.status}).`;
  }
  return 'O provedor demorou demais para responder.';
}

function formatDelay(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
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
  const target =
    typeof args.path === 'string'
      ? args.path
      : typeof args.command === 'string'
        ? args.command
        : typeof args.query === 'string'
          ? `"${args.query}"`
          : '';
  return target ? `${name} ${excerpt(target, 160)}` : name;
}

/** Tool arguments for the event log, without bulky file contents. */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] =
      typeof value === 'string' && value.length > 300
        ? `${value.slice(0, 300)}… (${value.length} chars)`
        : value;
  }
  return out;
}
