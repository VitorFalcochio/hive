import {
  NativeAgentRuntime,
  type AgentOutcome,
  type AgentRuntime,
  type RuntimeEvent,
} from '@hive/agents';
import {
  isSafeCommand,
  workerStateSchema,
  type ActiveChat,
  type Worker,
  type Workspace,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import type { ResolvedSkill } from '@hive/skills';
import { HiveError, newId, nowIso } from '@hive/shared';

/** One request the user typed and the agent's reply, kept for the next turns. */
export interface Exchange {
  request: string;
  reply: string;
}

export type ApprovalAnswer = 'yes' | 'no' | 'always';

export interface TurnHandlers {
  onEvent: (event: RuntimeEvent) => void;
  /** Asks the user, in the terminal, whether a command may run. */
  approve: (command: string) => Promise<ApprovalAnswer>;
}

/** Earlier exchanges the agent is reminded of; older ones are dropped to keep prompts small. */
const MAX_EXCHANGES = 6;

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

export function turnDescription(request: string, history: Exchange[]): string {
  // Models drift into English after an English system prompt; the request sets the language.
  const language = '(Reply in the language of this message.)';
  if (!history.length) return `${request}\n\n${language}`;
  const earlier = history
    .slice(-MAX_EXCHANGES)
    .map((item) => `User: ${clip(item.request, 1_500)}\nYou: ${clip(item.reply, 2_000)}`)
    .join('\n\n');
  return `Earlier in this conversation:\n\n${earlier}\n\nThe user now says:\n\n${request}\n\n${language}`;
}

/**
 * Conversations with an agent from a terminal: each request is one run of the agent, directly
 * in the project folder, with the user watching and answering command approvals.
 */
export class TerminalAgents {
  private readonly runtime: AgentRuntime;
  private readonly active = new Map<string, ActiveChat>();

  constructor(
    private readonly deps: {
      repos: Repositories;
      chatFor: (providerId: string) => ChatClient;
      resolveSkills: (names: string[]) => Promise<ResolvedSkill[]>;
      onWorkerChanged: (workerId: string) => void;
      /** Agents started or stopped work, or switched between working and waiting. */
      onChange: () => void;
      runtime?: AgentRuntime;
    },
  ) {
    this.runtime = deps.runtime ?? new NativeAgentRuntime();
  }

  /** Requests being answered right now, for the bees in the status bar. */
  activeChats(): ActiveChat[] {
    return [...this.active.values()];
  }

  async turn(
    workspace: Workspace,
    workerId: string,
    request: string,
    history: Exchange[],
    handlers: TurnHandlers,
    signal: AbortSignal,
  ): Promise<AgentOutcome> {
    const worker = this.deps.repos.workers.require(workerId, 'Agente');
    if (!worker.providerId || !worker.modelId)
      throw new HiveError(
        'VALIDATION',
        `Escolha um provedor e um modelo para ${worker.name} na tela Agentes.`,
      );
    const model = { providerId: worker.providerId, modelId: worker.modelId };
    const sessionId = newId('chat');
    const startedAt = nowIso();
    const chat: ActiveChat = {
      id: sessionId,
      workspaceId: workspace.id,
      workerId: worker.id,
      title: clip(request.split('\n')[0]!.trim(), 80),
      state: 'thinking',
    };
    this.active.set(sessionId, chat);
    this.deps.onChange();
    // Only a switch between working and waiting (approval, provider) changes the status bar.
    const waiting = (state: string) => state === 'waiting_approval' || state === 'waiting_provider';
    const onEvent = (event: RuntimeEvent) => {
      handlers.onEvent(event);
      if (event.type !== 'worker.state') return;
      const state = workerStateSchema.safeParse(event.data?.state);
      if (!state.success) return;
      const flipped = waiting(state.data) !== waiting(chat.state);
      chat.state = state.data;
      if (flipped) this.deps.onChange();
    };
    let outcome: AgentOutcome | null = null;
    try {
      outcome = await this.run(
        sessionId,
        workspace,
        worker,
        model,
        request,
        history,
        handlers,
        onEvent,
        signal,
      );
      return outcome;
    } finally {
      this.active.delete(sessionId);
      // The tokens count in the status bar's daily meter, like those of missions.
      if (outcome)
        this.deps.repos.chatTurns.put({
          id: sessionId,
          workspaceId: workspace.id,
          workerId: worker.id,
          status: outcome.status,
          promptTokens: outcome.usage.promptTokens,
          completionTokens: outcome.usage.completionTokens,
          startedAt,
          finishedAt: nowIso(),
        });
      this.deps.onChange();
    }
  }

  private async run(
    sessionId: string,
    workspace: Workspace,
    worker: Worker,
    model: { providerId: string; modelId: string },
    request: string,
    history: Exchange[],
    handlers: TurnHandlers,
    onEvent: (event: RuntimeEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentOutcome> {
    const session = await this.runtime.start({
      sessionId,
      task: {
        title: clip(request.split('\n')[0]!.trim(), 80),
        description: turnDescription(request, history),
        acceptanceCriteria: [],
        upstream: [],
      },
      worker,
      model: model.modelId,
      chat: this.deps.chatFor(model.providerId),
      worktreePath: workspace.path,
      place: 'project',
      skills: await this.deps.resolveSkills(worker.skills),
      limits: worker.limits,
      requestApproval: ({ command }) => this.approve(worker.id, command, handlers),
    });
    const unsubscribe = this.runtime.subscribe(sessionId, onEvent);
    const cancel = () => void this.runtime.cancel(sessionId);
    if (signal.aborted) cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      return await session.done;
    } finally {
      unsubscribe();
      signal.removeEventListener('abort', cancel);
    }
  }

  /** The same policy as missions; "always" adds the command to the agent's allow list. */
  private async approve(workerId: string, command: string, handlers: TurnHandlers) {
    const { commandApproval } = this.deps.repos.getSettings();
    if (commandApproval === 'all' || (commandApproval === 'safe' && isSafeCommand(command)))
      return true;
    const answer = await handlers.approve(command);
    if (answer === 'always') {
      const worker = this.deps.repos.workers.require(workerId, 'Agente');
      if (!worker.autoApproveCommands.includes(command)) {
        this.deps.repos.workers.put({
          ...worker,
          autoApproveCommands: [...worker.autoApproveCommands, command],
          updatedAt: nowIso(),
        });
        this.deps.onWorkerChanged(worker.id);
      }
    }
    return answer !== 'no';
  }
}
