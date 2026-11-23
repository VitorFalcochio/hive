import { access } from 'node:fs/promises';
import type { AgentMemory, AgentOutcome, AgentRuntime, RuntimeEvent } from '@hive/agents';
import {
  isSafeCommand,
  MAX_CHAT_STEPS,
  workerStateSchema,
  type ActiveChat,
  type AgentChat,
  type AgentChatApproval,
  type AgentChatMessage,
  type AgentChatMode,
  type AgentChatState,
  type AgentChatStep,
  type HivePush,
  type Worker,
  type Workspace,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import type { ResolvedSkill } from '@hive/skills';
import { HiveError, clipText, errorMessage, newId, nowIso } from '@hive/shared';
import { turnDescription, type Exchange } from './terminal-agents';
import { describeTool } from './terminal-ui';

/** How often a working reply is saved and pushed at most; the end is always sent at once. */
const FLUSH_MS = 150;
/** Earlier messages read back to remind the agent of the conversation. */
const HISTORY_MESSAGES = 12;
const NEW_TITLE = 'Nova conversa';

/** Said to the agent before each request, so it knows what the mode allows. */
const MODE_NOTES: Record<AgentChatMode, string> = {
  conversation:
    'Mode: conversation. Answer by reading the project when it helps. You only have read-only tools: do not try to edit files or run commands. If the user asks for changes, explain what you would do and suggest switching to execution mode.',
  execution:
    "Mode: execution. Do the task for real in the project folder: look at the relevant code first, plan briefly when the task is not trivial, make the changes, validate them with the project's tests, lint or build when they exist, and end with a short summary of the files you changed and how you validated them.",
};

export interface AgentChatsDeps {
  repos: Repositories;
  /** Hive's own engine; `runtimeFor` may pick another for an agent (Claude Code). */
  runtime: AgentRuntime;
  runtimeFor: (worker: Worker) => AgentRuntime | null;
  /** The agent's model client, with its fallbacks; `notify` reports a switch. */
  chatForWorker: (worker: Worker, notify: (message: string) => void) => ChatClient;
  resolveSkills: (names: string[]) => Promise<ResolvedSkill[]>;
  /** Nectar memory for a request; null when the agent has no Read on any block of the project. */
  prepareMemory?: (context: {
    workspaceId: string;
    worker: Worker;
    request: string;
  }) => Promise<{ memory: AgentMemory; summary: string } | null>;
  /** `git status` of the project folder, to tell which files a reply changed. */
  gitStatus?: (root: string) => Promise<{ path: string; status: string }[]>;
  push: (push: HivePush) => void;
  onWorkerChanged: (workerId: string) => void;
  /** Agents started or stopped work, or switched between working and waiting. */
  onChange: () => void;
}

interface Running {
  chat: AgentChat;
  mode: AgentChatMode;
  workerName: string;
  message: AgentChatMessage;
  active: ActiveChat;
  approval: (AgentChatApproval & { resolve: (allowed: boolean) => void }) | null;
  /** Paths the agent wrote through its tools, beside what `git status` shows. */
  touched: Set<string>;
  cancelled: boolean;
  cancel: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

/** Files whose `git status` line differs between before and after, in both directions. */
export function changedBetween(
  before: { path: string; status: string }[],
  after: { path: string; status: string }[],
): string[] {
  const was = new Map(before.map((item) => [item.path, item.status]));
  const now = new Map(after.map((item) => [item.path, item.status]));
  const changed = new Set<string>();
  for (const [file, status] of now) if (was.get(file) !== status) changed.add(file);
  for (const file of was.keys()) if (!now.has(file)) changed.add(file);
  return [...changed];
}

/** Earlier finished exchanges of a conversation, as the agent is reminded of them. */
export function exchangesOf(messages: AgentChatMessage[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (let index = 0; index < messages.length - 1; index++) {
    const request = messages[index]!;
    const reply = messages[index + 1]!;
    if (request.role !== 'user' || reply.role !== 'agent' || reply.status === 'running') continue;
    const answer =
      reply.content ||
      (reply.error ? `(This reply ${reply.status}: ${clip(reply.error, 300)})` : '');
    exchanges.push({ request: request.content, reply: answer });
    index++;
  }
  return exchanges;
}

/**
 * Direct Agent Chat: the user talks to one agent of the team, in one project, without a
 * mission or the Queen. Every request is one run of the agent on Hive's own runtime, in the
 * project folder (`place: 'project'`, like the terminal `agents` command), with the agent's
 * prompt, model, skills, limits and the same command approvals as missions. A conversation
 * only reads; an execution may edit and run commands, one at a time per project.
 */
export class AgentChats {
  private readonly running = new Map<string, Running>();

  constructor(private readonly deps: AgentChatsDeps) {
    // A reply left running by a previous session never finished: it is not shown as done.
    deps.repos.interruptAgentChats(nowIso());
  }

  /** Replies being written right now, for the bees in the status bar. */
  activeChats(): ActiveChat[] {
    return [...this.running.values()].map((entry) => ({ ...entry.active }));
  }

  list(workspaceId: string, workerId: string): AgentChat[] {
    return this.deps.repos.agentChats.list(
      'workspace_id = ? AND worker_id = ?',
      workspaceId,
      workerId,
    );
  }

  create(workspaceId: string, workerId: string): AgentChat {
    this.deps.repos.workspaces.require(workspaceId, 'Projeto');
    this.deps.repos.workers.require(workerId, 'Agente');
    const now = nowIso();
    return this.deps.repos.agentChats.put({
      id: newId('agentchat'),
      workspaceId,
      workerId,
      title: NEW_TITLE,
      createdAt: now,
      updatedAt: now,
    });
  }

  delete(chatId: string): void {
    this.cancel(chatId);
    this.deps.repos.agentChats.delete(chatId);
  }

  messages(
    chatId: string,
    limit = 50,
    before?: string,
  ): { messages: AgentChatMessage[]; more: boolean } {
    this.chat(chatId);
    const page = this.deps.repos.agentChatPage(chatId, limit, before);
    // A reply being written is sent as it is now, not as last saved.
    const live = this.running.get(chatId)?.message;
    return live
      ? {
          ...page,
          messages: page.messages.map((message) => (message.id === live.id ? live : message)),
        }
      : page;
  }

  state(chatId: string): AgentChatState {
    this.chat(chatId);
    const entry = this.running.get(chatId);
    return {
      chatId,
      running: !!entry,
      approval: entry?.approval ? { id: entry.approval.id, command: entry.approval.command } : null,
    };
  }

  /** Starts the agent on a request; it works in the background and reports by push. */
  async send(
    chatId: string,
    text: string,
    mode: AgentChatMode,
  ): Promise<{ user: AgentChatMessage; agent: AgentChatMessage }> {
    const { repos } = this.deps;
    const chat = this.chat(chatId);
    if (this.running.has(chatId))
      throw new HiveError(
        'CONFLICT',
        'O agente ainda está respondendo nesta conversa. Aguarde ou interrompa.',
      );
    const workspace = repos.workspaces.get(chat.workspaceId);
    if (!workspace)
      throw new HiveError('NOT_FOUND', 'O projeto desta conversa foi removido do Hive.');
    try {
      await access(workspace.path);
    } catch {
      throw new HiveError(
        'VALIDATION',
        `A pasta do projeto não está acessível: ${workspace.path}. Verifique se ela existe e foi aberta neste computador.`,
      );
    }
    const worker = repos.workers.get(chat.workerId);
    if (!worker) throw new HiveError('NOT_FOUND', 'Este agente foi removido da equipe.');
    if (!worker.providerId || !worker.modelId)
      throw new HiveError(
        'VALIDATION',
        `Escolha um provedor e um modelo para ${worker.name} em Agentes → Gerenciar agentes.`,
      );
    const provider = repos.providers.get(worker.providerId);
    if (!provider)
      throw new HiveError(
        'VALIDATION',
        `O provedor de ${worker.name} foi removido. Escolha outro em Agentes → Gerenciar agentes.`,
      );
    if (!provider.enabled)
      throw new HiveError(
        'VALIDATION',
        `O provedor ${provider.name} está desligado. Ligue-o em Provedores ou troque o modelo do agente.`,
      );
    if (mode === 'execution') {
      // Two executions in one folder would edit the same files with nobody coordinating.
      const busy = [...this.running.values()].find(
        (entry) => entry.chat.workspaceId === workspace.id && entry.mode === 'execution',
      );
      if (busy)
        throw new HiveError(
          'CONFLICT',
          `${busy.workerName} já está executando uma tarefa neste projeto. Aguarde ou interrompa antes de iniciar outra execução.`,
        );
    }

    const history = exchangesOf(repos.agentChatPage(chatId, HISTORY_MESSAGES).messages);
    const runtime = this.deps.runtimeFor(worker) ?? this.deps.runtime;
    const now = nowIso();
    const user = repos.agentChatMessages.put({
      id: newId('msg'),
      chatId,
      role: 'user',
      mode,
      content: text,
      status: 'completed',
      error: null,
      model: null,
      steps: [],
      droppedSteps: 0,
      changedFiles: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      createdAt: now,
      finishedAt: now,
    });
    const agent = repos.agentChatMessages.put({
      ...user,
      id: newId('msg'),
      role: 'agent',
      content: '',
      status: 'running',
      model: {
        providerId: provider.id,
        providerName: provider.name,
        modelId: worker.modelId,
        runtime: runtime.id,
      },
      finishedAt: null,
    });
    const updated = repos.agentChats.put({
      ...chat,
      title: chat.title === NEW_TITLE ? clip(text.split('\n')[0]!.trim(), 80) : chat.title,
      updatedAt: now,
    });
    const entry: Running = {
      chat: updated,
      mode,
      workerName: worker.name,
      message: agent,
      active: {
        id: agent.id,
        workspaceId: workspace.id,
        workerId: worker.id,
        title: clip(text.split('\n')[0]!.trim(), 80),
        state: 'thinking',
        direct: chatId,
      },
      approval: null,
      touched: new Set(),
      cancelled: false,
      cancel: null,
      timer: undefined,
    };
    this.running.set(chatId, entry);
    this.deps.onChange();
    void this.execute(entry, workspace, worker, runtime, text, history);
    return { user, agent };
  }

  cancel(chatId: string): void {
    const entry = this.running.get(chatId);
    if (!entry) return;
    entry.cancelled = true;
    entry.approval?.resolve(false);
    entry.cancel?.();
  }

  /** Stops every reply in a project, e.g. when its tab is closed or it is removed. */
  cancelWorkspace(workspaceId: string): void {
    for (const [chatId, entry] of this.running)
      if (entry.chat.workspaceId === workspaceId) this.cancel(chatId);
  }

  approve(chatId: string, approvalId: string, answer: 'yes' | 'no' | 'always'): void {
    const entry = this.running.get(chatId);
    const pending = entry?.approval;
    if (!entry || !pending || pending.id !== approvalId)
      throw new HiveError('NOT_FOUND', 'Este pedido de aprovação já foi respondido ou expirou.');
    if (answer === 'always') {
      const worker = this.deps.repos.workers.get(entry.active.workerId);
      if (worker && !worker.autoApproveCommands.includes(pending.command)) {
        this.deps.repos.workers.put({
          ...worker,
          autoApproveCommands: [...worker.autoApproveCommands, pending.command],
          updatedAt: nowIso(),
        });
        this.deps.onWorkerChanged(worker.id);
      }
    }
    pending.resolve(answer !== 'no');
  }

  /** On quit: stops every reply and records it as interrupted, not finished. */
  dispose(): void {
    for (const [chatId, entry] of this.running) {
      this.cancel(chatId);
      clearTimeout(entry.timer);
      this.deps.repos.agentChatMessages.put({
        ...entry.message,
        status: 'interrupted',
        error: 'O Hive foi fechado enquanto o agente trabalhava.',
        finishedAt: nowIso(),
      });
    }
    this.running.clear();
  }

  /* ------------------------------------------------------------------ internals */

  private chat(chatId: string): AgentChat {
    const chat = this.deps.repos.agentChats.get(chatId);
    if (!chat) throw new HiveError('NOT_FOUND', 'Conversa não encontrada.');
    return chat;
  }

  private async execute(
    entry: Running,
    workspace: Workspace,
    worker: Worker,
    runtime: AgentRuntime,
    request: string,
    history: Exchange[],
  ): Promise<void> {
    const sessionId = entry.message.id;
    let unsubscribe = () => {};
    let outcome: AgentOutcome;
    let before: { path: string; status: string }[] | null = null;
    try {
      let memory: AgentMemory | undefined;
      if (this.deps.prepareMemory)
        try {
          const prepared = await this.deps.prepareMemory({
            workspaceId: workspace.id,
            worker,
            request,
          });
          if (prepared) {
            memory = prepared.memory;
            this.step(entry, { kind: 'memory', label: prepared.summary, status: 'ok' });
          }
        } catch (error) {
          this.step(entry, {
            kind: 'warn',
            label: `Nectar indisponível; seguindo sem memória: ${clip(errorMessage(error), 200)}`,
            status: 'error',
          });
        }
      if (entry.mode === 'execution' && this.deps.gitStatus)
        before = await this.deps.gitStatus(workspace.path).catch((error: unknown) => {
          this.step(entry, {
            kind: 'warn',
            label: `Não foi possível ler o git status: ${clip(errorMessage(error), 200)}`,
            status: 'error',
          });
          return null;
        });
      if (entry.cancelled) throw new HiveError('CANCELLED', 'Interrompido antes de começar.');
      const session = await runtime.start({
        sessionId,
        task: {
          title: clip(request.split('\n')[0]!.trim(), 80),
          description: `${MODE_NOTES[entry.mode]}\n\n${turnDescription(request, history)}`,
          acceptanceCriteria: [],
          upstream: [],
        },
        worker,
        model: worker.modelId!,
        chat: this.deps.chatForWorker(worker, (message) =>
          this.step(entry, { kind: 'warn', label: message, status: 'ok' }),
        ),
        worktreePath: workspace.path,
        place: 'project',
        readOnly: entry.mode === 'conversation',
        skills: await this.deps.resolveSkills(worker.skills),
        limits: worker.limits,
        ...(memory ? { memory } : {}),
        requestApproval: ({ command }) => this.requestApproval(entry, command),
      });
      unsubscribe = runtime.subscribe(sessionId, (event) => this.onEvent(entry, event));
      entry.cancel = () => void runtime.cancel(sessionId);
      if (entry.cancelled) entry.cancel();
      outcome = await session.done;
    } catch (error) {
      outcome = {
        status: entry.cancelled ? 'cancelled' : 'failed',
        summary: '',
        error: entry.cancelled ? 'Interrompido pelo usuário.' : errorMessage(error),
        steps: 0,
        usage: { promptTokens: 0, completionTokens: 0 },
        commands: [],
      };
    } finally {
      unsubscribe();
    }
    let changed: string[] = [];
    if (before && this.deps.gitStatus)
      changed = changedBetween(before, await this.deps.gitStatus(workspace.path).catch(() => []));
    this.finish(entry, outcome, changed);
  }

  private finish(entry: Running, outcome: AgentOutcome, changed: string[]): void {
    const { repos } = this.deps;
    const finishedAt = nowIso();
    const status = entry.cancelled && outcome.status !== 'completed' ? 'cancelled' : outcome.status;
    const files = [...new Set([...entry.touched, ...changed])].sort().slice(0, 500);
    entry.approval?.resolve(false);
    entry.approval = null;
    entry.message = {
      ...entry.message,
      status,
      content: clipText(
        outcome.summary.trim() ||
          (status === 'completed' ? 'O agente terminou sem escrever uma resposta.' : ''),
        200_000,
      ),
      error:
        status === 'completed'
          ? null
          : clip(
              outcome.error ??
                (status === 'cancelled' ? 'Interrompido pelo usuário.' : 'O agente falhou.'),
              4_000,
            ),
      steps: entry.message.steps.map((step) =>
        step.status === 'running'
          ? { ...step, status: status === 'completed' ? 'ok' : 'error' }
          : step,
      ),
      changedFiles: files,
      usage: outcome.usage,
      finishedAt,
    };
    clearTimeout(entry.timer);
    this.running.delete(entry.chat.id);
    this.flush(entry);
    repos.agentChats.put({ ...entry.chat, updatedAt: finishedAt });
    // The tokens count in the status bar's daily meter, like those of missions and terminals.
    repos.chatTurns.put({
      id: entry.message.id,
      workspaceId: entry.chat.workspaceId,
      workerId: entry.active.workerId,
      status,
      promptTokens: outcome.usage.promptTokens,
      completionTokens: outcome.usage.completionTokens,
      startedAt: entry.message.createdAt,
      finishedAt,
    });
    this.deps.onChange();
  }

  private async requestApproval(entry: Running, command: string): Promise<boolean> {
    if (entry.mode === 'conversation') {
      this.step(entry, {
        kind: 'approval',
        label: `Recusado no modo Conversa: ${clip(command, 200)}`,
        status: 'error',
      });
      return false;
    }
    if (entry.cancelled) return false;
    const { commandApproval } = this.deps.repos.getSettings();
    if (commandApproval === 'all' || (commandApproval === 'safe' && isSafeCommand(command))) {
      this.step(entry, {
        kind: 'approval',
        label: `Liberado automaticamente (${commandApproval === 'all' ? 'todos os comandos' : 'comando seguro'}): ${clip(command, 200)}`,
        status: 'ok',
      });
      return true;
    }
    const id = newId('approval');
    this.step(entry, {
      kind: 'approval',
      label: `Aguardando sua aprovação: ${clip(command, 300)}`,
      status: 'running',
    });
    const at = entry.message.steps.length - 1;
    const allowed = await new Promise<boolean>((resolve) => {
      entry.approval = { id, command, resolve };
      this.flush(entry);
    });
    entry.approval = null;
    const step = entry.message.steps[at];
    if (step?.kind === 'approval' && step.status === 'running')
      entry.message.steps[at] = {
        ...step,
        label: `${allowed ? 'Aprovado' : 'Negado'}: ${clip(command, 300)}`,
        status: allowed ? 'ok' : 'error',
      };
    this.flush(entry);
    return allowed;
  }

  private onEvent(entry: Running, event: RuntimeEvent): void {
    const data = event.data ?? {};
    const tool = typeof data.tool === 'string' ? data.tool : null;
    switch (event.type) {
      case 'worker.state': {
        const state = workerStateSchema.safeParse(data.state);
        if (!state.success) return;
        const waiting = (value: string) =>
          value === 'waiting_approval' || value === 'waiting_provider';
        const flipped = waiting(state.data) !== waiting(entry.active.state);
        entry.active.state = state.data;
        if (flipped) this.deps.onChange();
        return;
      }
      case 'tool.call': {
        if (tool === 'finish') return;
        const args =
          data.args && typeof data.args === 'object' ? (data.args as Record<string, unknown>) : {};
        if ((tool === 'write_file' || tool === 'replace_in_file') && typeof args.path === 'string')
          entry.touched.add(args.path);
        this.step(entry, {
          kind: 'tool',
          label: tool && !data.soldier && data.args ? describeTool(tool, args) : event.message,
          status: 'running',
        });
        return;
      }
      case 'tool.result': {
        const failed = data.isError === true || event.level === 'warn' || event.level === 'error';
        const steps = entry.message.steps;
        for (let index = steps.length - 1; index >= 0; index--) {
          const step = steps[index]!;
          if (step.kind !== 'tool' || step.status !== 'running') continue;
          steps[index] = {
            ...step,
            status: failed ? 'error' : 'ok',
            detail: clip(typeof data.output === 'string' ? data.output : event.message, 2_000),
          };
          this.schedule(entry);
          return;
        }
        if (failed) this.step(entry, { kind: 'warn', label: event.message, status: 'error' });
        return;
      }
      case 'file.changed':
        if (typeof data.path === 'string') entry.touched.add(data.path);
        return;
      case 'model.response': {
        // Text said on the way, beside tool calls; the final answer comes with the outcome.
        const content = typeof data.content === 'string' ? data.content.trim() : '';
        const calls = Array.isArray(data.toolCalls) ? data.toolCalls.length : 0;
        if (content && calls) this.step(entry, { kind: 'note', label: content, status: 'ok' });
        return;
      }
      case 'memory':
        this.step(entry, { kind: 'memory', label: event.message, status: 'ok' });
        return;
      case 'error':
        this.step(entry, { kind: 'error', label: event.message, status: 'error' });
        return;
      default:
        if (event.level === 'warn' || event.level === 'error')
          this.step(entry, {
            kind: event.level === 'error' ? 'error' : 'warn',
            label: event.message,
            status: event.level === 'error' ? 'error' : 'ok',
          });
    }
  }

  private step(entry: Running, step: Omit<AgentChatStep, 'at'>): void {
    const steps = entry.message.steps;
    if (steps.length >= MAX_CHAT_STEPS) {
      steps.shift();
      entry.message.droppedSteps++;
    }
    steps.push({ ...step, label: clip(step.label, 400), at: nowIso() });
    this.schedule(entry);
  }

  private schedule(entry: Running): void {
    entry.timer ??= setTimeout(() => {
      entry.timer = undefined;
      if (this.running.get(entry.chat.id) === entry) this.flush(entry);
    }, FLUSH_MS);
  }

  /** Saves the reply and pushes it to the window. */
  private flush(entry: Running): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const message = this.deps.repos.agentChatMessages.put({
      ...entry.message,
      steps: [...entry.message.steps],
    });
    this.deps.push({
      kind: 'agentChat',
      chatId: entry.chat.id,
      workspaceId: entry.chat.workspaceId,
      message,
      approval: entry.approval ? { id: entry.approval.id, command: entry.approval.command } : null,
    });
  }
}
