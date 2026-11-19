import { createHash } from 'node:crypto';
import {
  rolePresets,
  workerRoleSchema,
  type ExecutionLimits,
  type ReviewComment,
  type Task,
  type TeamMessage,
  type TeamMessageKind,
  type TeamRequest,
  type TeamRequestKind,
  type TeamsSettings,
  type ToolName,
  type Worker,
  type WorkerRole,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { HiveError, nowIso } from '@hive/shared';
import type { Scheduler } from '../scheduler';
import { chooseTeamModel, type TeamModelProfile } from './models';

/** The parts of the Scheduler Hive Teams uses; everything it changes goes through them. */
export type TeamScheduler = Pick<Scheduler, 'addTask' | 'setDependency' | 'revise' | 'logTeam'>;

/** A deterministic id: the same parts always give the same id, which makes writes idempotent. */
export function teamId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`;
}

export interface SpawnInput {
  /** The leader's own name for this request; asking again with it returns the same agent. */
  key: string;
  name: string;
  role: WorkerRole;
  description?: string;
  model: TeamModelProfile;
  /** Defaults to the role's tools the leader also has. Asking for one the leader lacks is refused. */
  tools?: ToolName[];
  /** Must each be one of the leader's own auto-approved commands. */
  autoApproveCommands?: string[];
  mcpServers?: string[];
  limits?: Partial<
    Pick<ExecutionLimits, 'maxSteps' | 'maxTokens' | 'commandTimeoutSec' | 'taskTimeoutMin'>
  >;
}

export interface DelegateInput {
  key: string;
  /** A member of the leader's team. */
  agentId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** Keys of other delegations of the same leader this work waits for. */
  after?: string[];
}

export interface ReviewRequestInput {
  key: string;
  agentId: string;
  /** Keys of the leader's delegations to review. */
  of: string[];
  instructions: string;
}

export interface ReviewInput {
  verdict: 'approved' | 'changes_requested';
  summary: string;
  comments: {
    path: string;
    line: number;
    body: string;
    severity?: 'blocker' | 'major' | 'minor';
  }[];
}

const LEADING_ROLES = new Set(['lead', 'consolidate']);
const NOT_STARTED = new Set<Task['status']>(['pending', 'blocked']);

/**
 * Hive Teams: what lets a leader agent create other agents and give them work. It checks every
 * request against the global and per-team limits, never gives a member more than its leader
 * has, and turns what it accepts into ordinary agents and tasks of the same mission through the
 * Scheduler, so worktrees, reviews, QA, cancelling and resuming work as for any task.
 *
 * Every request and message has an id derived from who asked and the asker's own key for it:
 * asked again after a retry or a crash, it returns what was decided the first time.
 */
export class HiveTeams {
  constructor(
    private readonly options: {
      repos: Repositories;
      scheduler: TeamScheduler;
      /** Picks a configured provider and model for a member; defaults to Hive's own catalog. */
      chooseModel?: typeof chooseTeamModel;
    },
  ) {}

  private get repos() {
    return this.options.repos;
  }

  private settings(): TeamsSettings {
    return this.repos.getSettings().teams;
  }

  /* ------------------------------------------------------------ who is asking */

  /**
   * The leader behind a request: the running task it comes from and that task's agent. Only a
   * task in a leading role, while it runs, may ask; the caller never says who it is.
   */
  private caller(taskId: string): { task: Task; leader: Worker; lead: Task } {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (!task.team || !LEADING_ROLES.has(task.team.role))
      throw new HiveError('DENIED', 'Esta tarefa não lidera uma equipe do Hive Teams.');
    if (task.status !== 'running')
      throw new HiveError('CONFLICT', 'Só uma tarefa em execução pode fazer pedidos à equipe.');
    const leader = this.repos.workers.require(task.workerId ?? '', 'Agente');
    const lead = this.repos.tasks.require(task.team.leadTaskId, 'Tarefa');
    return { task, leader, lead };
  }

  private members(runId: string, leaderId: string): Worker[] {
    return this.repos.workers
      .list()
      .filter((worker) => worker.team?.runId === runId && worker.team.parentAgentId === leaderId);
  }

  private teamTasks(lead: Task): Task[] {
    return this.repos.tasks
      .list('run_id = ?', lead.runId)
      .filter((task) => task.team?.leadTaskId === lead.id && task.id !== lead.id);
  }

  /** Records a decision once; the same request asked again returns the first decision. */
  private decide(
    kind: TeamRequestKind,
    from: { task: Task; leader: Worker },
    key: string,
    input: Record<string, unknown>,
    work: (id: string) => { result: TeamRequest['result'] } | { reason: string },
  ): TeamRequest {
    const cleanKey = requestKey(key);
    const id = teamId('tr', from.task.runId, from.task.id, kind, cleanKey);
    const existing = this.repos.teamRequests.get(id);
    if (existing) return existing;
    // No database transaction around the work: it goes through the Scheduler, which may start
    // other tasks meanwhile. Each step is idempotent instead (derived ids and keys), and the
    // request is stored last, so a request cut short is completed, not duplicated, when asked again.
    let outcome: { result: TeamRequest['result'] } | { reason: string };
    try {
      outcome = work(id);
    } catch (error) {
      if (!(error instanceof HiveError)) throw error;
      outcome = { reason: error.message };
    }
    {
      const request: TeamRequest = {
        id,
        runId: from.task.runId,
        kind,
        key: cleanKey,
        requestedByAgentId: from.leader.id,
        requestedByTaskId: from.task.id,
        status: 'result' in outcome ? 'accepted' : 'rejected',
        reason: 'reason' in outcome ? outcome.reason : null,
        input,
        result: 'result' in outcome ? outcome.result : {},
        createdAt: nowIso(),
      };
      const stored = this.repos.teamRequests.insertOnce(request).entity;
      this.options.scheduler.logTeam(
        stored.runId,
        from.task.id,
        from.leader.id,
        stored.status === 'accepted' ? 'info' : 'warn',
        stored.status === 'accepted'
          ? describeRequest(kind, input)
          : `Pedido recusado (${describeRequest(kind, input)}): ${stored.reason}`,
        { requestId: stored.id, kind, status: stored.status },
      );
      return stored;
    }
  }

  /** Stores a message once, by its idempotency key. */
  message(
    input: Omit<TeamMessage, 'id' | 'createdAt' | 'payload'> & {
      payload?: Record<string, unknown>;
    },
  ): {
    message: TeamMessage;
    created: boolean;
  } {
    const { entity, created } = this.repos.teamMessages.insertOnce({
      ...input,
      payload: input.payload ?? {},
      id: teamId('tm', input.runId, input.idempotencyKey),
      createdAt: nowIso(),
    });
    return { message: entity, created };
  }

  /* ------------------------------------------------------------ creating agents */

  spawnAgent(callerTaskId: string, input: SpawnInput): TeamRequest {
    const from = this.caller(callerTaskId);
    const { task, leader } = from;
    return this.decide('spawn_agent', from, input.key, { ...input }, (requestId) => {
      const settings = this.settings();
      const depth = (leader.team?.depth ?? 0) + 1;
      if (depth > settings.maxDepth)
        return {
          reason: `A equipe já está no nível máximo (${settings.maxDepth}); quem foi criado por um líder não cria outros agentes.`,
        };
      const inRun = this.repos.workers.list().filter((worker) => worker.team?.runId === task.runId);
      if (inRun.length >= settings.maxAgentsPerRun)
        return {
          reason: `A missão já tem ${inRun.length} agentes criados pelo Hive Teams (limite ${settings.maxAgentsPerRun}).`,
        };
      const members = this.members(task.runId, leader.id);
      if (members.length >= settings.maxTeamSize)
        return {
          reason: `A equipe já tem ${members.length} membros (limite ${settings.maxTeamSize}).`,
        };
      const role = workerRoleSchema.safeParse(input.role);
      if (!role.success || role.data === 'queen')
        return { reason: `Papel inválido: ${String(input.role)}.` };
      if (!input.name?.trim()) return { reason: 'Dê um nome ao agente.' };

      const privileges = memberPrivileges(leader, role.data, input);
      if ('reason' in privileges) return privileges;
      const used = members.reduce((sum, member) => sum + member.limits.maxTokens, 0);
      const left = settings.teamTokenBudget - used;
      const maxTokens = input.limits?.maxTokens ?? Math.min(privileges.limits.maxTokens, left);
      if (maxTokens > left || maxTokens < 10_000)
        return {
          reason: `O orçamento da equipe não comporta: restam ${Math.max(0, left).toLocaleString('pt-BR')} tokens de ${settings.teamTokenBudget.toLocaleString('pt-BR')}.`,
        };

      const choice = (this.options.chooseModel ?? chooseTeamModel)(
        input.model ?? {},
        this.repos.providers.list(),
        (providerId) => this.repos.listModels(providerId),
        role.data,
        settings.freeOnly,
      );
      if (!choice.ok) return { reason: choice.reason };

      const preset = rolePresets[role.data];
      const now = nowIso();
      const agentId = teamId('w', requestId);
      const agent: Worker = {
        id: agentId,
        name: input.name.trim().slice(0, 60),
        role: role.data,
        beeColor: null,
        squad: [],
        description: (input.description ?? preset.description).slice(0, 500),
        providerId: choice.providerId,
        modelId: choice.modelId,
        // Skills are ways of working, not permissions: the role's own.
        skills: preset.skills,
        tools: privileges.tools,
        mcpServers: privileges.mcpServers,
        autoApproveCommands: privileges.autoApproveCommands,
        systemPrompt: preset.systemPrompt,
        limits: { ...privileges.limits, maxTokens },
        team: {
          runId: task.runId,
          parentAgentId: leader.id,
          createdByAgentId: leader.id,
          spawnRequestId: requestId,
          depth,
        },
        createdAt: now,
        updatedAt: now,
      };
      this.repos.workers.insertOnce(agent);
      this.message({
        runId: task.runId,
        idempotencyKey: `spawn:${requestId}`,
        kind: 'spawn',
        fromAgentId: leader.id,
        toAgentId: agentId,
        fromTaskId: task.id,
        toTaskId: null,
        subject: `Agente criado: ${agent.name}`,
        body: agent.description,
        payload: {
          role: agent.role,
          providerId: agent.providerId,
          modelId: agent.modelId,
          tools: agent.tools,
          limits: agent.limits,
        },
      });
      return { result: { agentId } };
    });
  }

  /* ------------------------------------------------------------ delegating */

  delegate(callerTaskId: string, input: DelegateInput): TeamRequest {
    const from = this.caller(callerTaskId);
    return this.decide('delegate_task', from, input.key, { ...input }, (requestId) =>
      this.createTeamTask(from, requestId, input.key, {
        agentId: input.agentId,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        after: input.after ?? [],
        role: 'member',
      }),
    );
  }

  requestReview(callerTaskId: string, input: ReviewRequestInput): TeamRequest {
    const from = this.caller(callerTaskId);
    return this.decide('request_review', from, input.key, { ...input }, (requestId) => {
      const reviewed = (input.of ?? []).map((key) =>
        this.delegationTask(from.task.runId, from.lead, key),
      );
      if (!reviewed.length || reviewed.some((task) => !task))
        return { reason: 'Diga quais delegações revisar, pelas chaves usadas em delegate_task.' };
      const tasks = reviewed as Task[];
      if (tasks.some((task) => task.workerId === input.agentId))
        return { reason: 'Quem fez o trabalho não pode revisá-lo; escolha outro membro.' };
      return this.createTeamTask(from, requestId, input.key, {
        agentId: input.agentId,
        title: `Revisar: ${tasks.map((task) => task.title).join(', ')}`.slice(0, 140),
        description: [
          input.instructions,
          '',
          'Você revisa o trabalho de outro membro da equipe; ele já está na sua worktree. Não edite arquivos.',
          'Termine chamando `submit_review` com o veredito (approved ou changes_requested), um resumo e comentários por arquivo e linha. Depois chame `finish`.',
        ].join('\n'),
        acceptanceCriteria: ['Veredito enviado com submit_review, com comentários verificáveis.'],
        after: input.of,
        role: 'review',
        reviewOf: tasks.map((task) => task.id),
      });
    });
  }

  /** The task a delegation of this leader created, by the leader's key for it. */
  private delegationTask(runId: string, lead: Task, key: string): Task | null {
    for (const task of this.teamTasks(lead)) {
      const request = task.team?.requestId
        ? this.repos.teamRequests.get(task.team.requestId)
        : null;
      if (request && request.runId === runId && request.key === requestKey(key)) return task;
    }
    return null;
  }

  private createTeamTask(
    from: { task: Task; leader: Worker; lead: Task },
    requestId: string,
    key: string,
    spec: {
      agentId: string;
      title: string;
      description: string;
      acceptanceCriteria: string[];
      after: string[];
      role: 'member' | 'review';
      reviewOf?: string[];
    },
  ): { result: TeamRequest['result'] } | { reason: string } {
    const { task, leader, lead } = from;
    const settings = this.settings();
    const member = this.members(task.runId, leader.id).find((worker) => worker.id === spec.agentId);
    if (!member)
      return {
        reason: 'Só membros da sua equipe recebem trabalho. Crie o agente com spawn_agent antes.',
      };
    if (
      this.teamTasks(lead).filter((item) => item.team?.role !== 'consolidate').length >=
      settings.maxDelegationsPerLead
    )
      return { reason: `A equipe já recebeu ${settings.maxDelegationsPerLead} tarefas (limite).` };
    const after: Task[] = [];
    for (const name of spec.after) {
      const found = this.delegationTask(task.runId, lead, name);
      if (!found) return { reason: `Delegação desconhecida em "after": ${name}.` };
      after.push(found);
    }
    const consolidation = this.pendingConsolidation(from);
    if ('reason' in consolidation) return consolidation;

    const newKey = taskKey(lead.key, key, requestId);
    const created =
      this.repos.tasks.list('run_id = ?', task.runId).find((item) => item.key === newKey) ??
      this.options.scheduler.addTask(
        task.runId,
        {
          key: newKey,
          title: spec.title.trim().slice(0, 140) || 'Tarefa da equipe',
          description: spec.description.trim().slice(0, 4_000) || spec.title,
          workerId: member.id,
          // Waits for the leader's session that asked: its contract or decisions are in that work.
          dependsOn: [task.key, ...after.map((item) => item.key)].slice(0, 10),
          acceptanceCriteria: (spec.acceptanceCriteria.length
            ? spec.acceptanceCriteria
            : ['Feito como pedido.']
          )
            .map((item) => item.slice(0, 400))
            .slice(0, 10),
        },
        {
          parentTaskId: task.id,
          team: {
            role: spec.role,
            leadTaskId: lead.id,
            requestId,
            ...(spec.reviewOf ? { reviewOf: spec.reviewOf } : {}),
          },
        },
      );
    if (!consolidation.task.dependsOn.includes(created.key))
      this.options.scheduler.setDependency(consolidation.task.id, created.id, true);
    this.message({
      runId: task.runId,
      idempotencyKey: `${spec.role === 'review' ? 'review_request' : 'delegation'}:${requestId}`,
      kind: spec.role === 'review' ? 'review_request' : 'delegation',
      fromAgentId: leader.id,
      toAgentId: member.id,
      fromTaskId: task.id,
      toTaskId: created.id,
      subject: created.title,
      body: created.description,
    });
    return { result: { agentId: member.id, taskId: created.id } };
  }

  /**
   * The leader's next session, which waits for its team's work: the one already waiting, or a
   * new one (up to the resume limit). What waited on the asking task waits on it instead, so the
   * rest of the mission (QA, say) sees the team's finished result, not the leader's first step.
   */
  private pendingConsolidation(from: {
    task: Task;
    leader: Worker;
    lead: Task;
  }): { task: Task } | { reason: string } {
    const { task, leader, lead } = from;
    const all = this.repos.tasks.list('run_id = ?', task.runId);
    const ours = all.filter(
      (item) => item.team?.role === 'consolidate' && item.team.leadTaskId === lead.id,
    );
    let next = ours.find((item) => NOT_STARTED.has(item.status) && item.id !== task.id);
    if (!next) {
      const resume = ours.reduce((max, item) => Math.max(max, item.team?.resume ?? 0), 0) + 1;
      if (resume > this.settings().maxLeaderResumes)
        return {
          reason: `O líder já foi retomado ${resume - 1} vezes (limite ${this.settings().maxLeaderResumes}). Conclua com o que a equipe entregou.`,
        };
      const key = taskKey(lead.key, `fim-${resume}`, teamId('c', lead.id, String(resume)));
      next =
        all.find((item) => item.key === key) ??
        this.options.scheduler.addTask(
          task.runId,
          {
            key,
            title: `Consolidar a equipe: ${lead.title}`.slice(0, 140),
            description: [
              `Você é ${leader.name}, líder desta equipe. Sua sessão anterior terminou depois de delegar; agora o trabalho da equipe está pronto e já na sua worktree.`,
              'Leia os resultados dos membros (acima) e as mensagens da equipe, confira o todo contra o objetivo original e, se faltar algo, delegue de novo (você será retomado outra vez).',
              'Quando estiver pronto, chame `report` com o resumo para a Queen e depois `finish`.',
              '',
              `Objetivo original:\n${lead.description}`,
            ]
              .join('\n')
              .slice(0, 4_000),
            workerId: leader.id,
            dependsOn: [task.key],
            acceptanceCriteria: lead.acceptanceCriteria.slice(0, 10),
          },
          {
            parentTaskId: lead.id,
            team: { role: 'consolidate', leadTaskId: lead.id, requestId: null, resume },
          },
        );
      for (const other of all) {
        if (
          other.id === next.id ||
          other.team?.leadTaskId === lead.id ||
          !NOT_STARTED.has(other.status)
        )
          continue;
        if (other.dependsOn.includes(task.key) && !other.dependsOn.includes(next.key))
          this.options.scheduler.setDependency(other.id, next.id, true);
      }
    }
    return { task: next };
  }

  /* ------------------------------------------------------------ reviews and reports */

  /**
   * A review task's verdict. It goes to the authors as feedback; with changes requested, each
   * reviewed task is sent back to its author through the usual revision, up to the round limit.
   * The same review of the same result is acted on once.
   */
  submitReview(
    reviewTaskId: string,
    input: ReviewInput,
  ): { revised: string[]; message: TeamMessage } {
    const review = this.repos.tasks.require(reviewTaskId, 'Tarefa');
    if (review.status !== 'running' || review.team?.role !== 'review')
      throw new HiveError('DENIED', 'Só uma tarefa de revisão em execução envia um veredito.');
    if (!['approved', 'changes_requested'].includes(input.verdict))
      throw new HiveError('VALIDATION', 'O veredito é approved ou changes_requested.');
    const comments = (input.comments ?? [])
      .filter((comment) => comment && typeof comment.path === 'string' && comment.body?.trim())
      .slice(0, 40)
      .map((comment): ReviewComment => ({
        path: comment.path.slice(0, 1_000),
        line: Math.max(1, Math.floor(Number(comment.line) || 1)),
        side: 'new',
        code: '',
        body: `${comment.severity ? `[${comment.severity}] ` : ''}${comment.body.trim()}`.slice(
          0,
          4_000,
        ),
      }));
    const revised: string[] = [];
    let first: TeamMessage | null = null;
    for (const targetId of review.team.reviewOf ?? []) {
      const target = this.repos.tasks.require(targetId, 'Tarefa');
      const round = target.revision?.round ?? 0;
      const { message, created } = this.message({
        runId: review.runId,
        // One verdict per review attempt and reviewed task, however many times it is sent.
        idempotencyKey: `feedback:${review.id}:a${review.attempt}:${target.id}`,
        kind: 'feedback',
        fromAgentId: review.workerId,
        toAgentId: target.workerId,
        fromTaskId: review.id,
        toTaskId: target.id,
        subject:
          input.verdict === 'approved'
            ? `Aprovado: ${target.title}`
            : `Mudanças pedidas: ${target.title}`,
        body: (input.summary ?? '').slice(0, 12_000),
        payload: { verdict: input.verdict, comments, round },
      });
      first ??= message;
      if (!created || input.verdict !== 'changes_requested') continue;
      if (round >= this.settings().maxReviewRounds) {
        this.options.scheduler.logTeam(
          review.runId,
          review.id,
          review.workerId,
          'warn',
          `${target.title} já passou por ${round} revisões (limite); o líder decide o que fazer.`,
        );
        continue;
      }
      if (target.status !== 'completed' || !target.result?.commit) continue;
      this.options.scheduler.revise(
        target.id,
        comments,
        `Revisão de ${this.agentName(review.workerId)}: ${input.summary ?? ''}`.slice(0, 4_000),
      );
      revised.push(target.id);
    }
    if (!first) throw new HiveError('VALIDATION', 'Esta revisão não tem tarefas para revisar.');
    return { revised, message: first };
  }

  /** A leader's report to the Queen; the same report of the same session is stored once. */
  report(
    callerTaskId: string,
    input: { summary: string; details?: Record<string, unknown> },
  ): TeamMessage {
    const { task, leader } = this.caller(callerTaskId);
    return this.message({
      runId: task.runId,
      idempotencyKey: `report:${task.id}:a${task.attempt}`,
      kind: 'report',
      fromAgentId: leader.id,
      toAgentId: null,
      fromTaskId: task.id,
      toTaskId: null,
      subject: `Relatório de ${leader.name}`,
      body: (input.summary ?? '').slice(0, 12_000),
      payload: input.details ?? {},
    }).message;
  }

  /** When a team task ends, its result goes to the leader as a message. */
  taskFinished(task: Task): void {
    if (!task.team || task.team.role === 'lead' || task.team.role === 'consolidate') return;
    const lead = this.repos.tasks.get(task.team.leadTaskId);
    if (!lead) return;
    this.message({
      runId: task.runId,
      idempotencyKey: `result:${task.id}:a${task.attempt}:r${task.revision?.round ?? 0}`,
      kind: 'report',
      fromAgentId: task.workerId,
      toAgentId: lead.workerId,
      fromTaskId: task.id,
      toTaskId: lead.id,
      subject: `${task.status === 'completed' ? 'Concluída' : task.status === 'failed' ? 'Falhou' : 'Cancelada'}: ${task.title}`,
      body: (task.result?.summary ?? task.error ?? '').slice(0, 12_000),
      payload: { status: task.status, files: task.result?.filesChanged.length ?? 0 },
    });
  }

  /** The messages an agent of a run has received, oldest first. */
  inbox(runId: string, agentId: string): TeamMessage[] {
    return this.repos.teamMessagesOf(runId).filter((message) => message.toAgentId === agentId);
  }

  private agentName(id: string | null): string {
    return (id && this.repos.workers.get(id)?.name) || 'revisor';
  }
}

/* ---------------------------------------------------------------- privileges */

/**
 * What a member may have: never more than its leader. Asking for a tool, an auto-approved
 * command, an MCP server or a limit beyond the leader's is refused, not silently trimmed, so
 * the leader knows; what is left unsaid defaults to the role's share of the leader's own.
 */
export function memberPrivileges(
  leader: Worker,
  role: WorkerRole,
  input: Pick<SpawnInput, 'tools' | 'autoApproveCommands' | 'mcpServers' | 'limits'>,
):
  | {
      tools: ToolName[];
      autoApproveCommands: string[];
      mcpServers: string[];
      limits: ExecutionLimits;
    }
  | { reason: string } {
  const preset = rolePresets[role];
  const tools = input.tools ?? preset.tools.filter((tool) => leader.tools.includes(tool));
  const extraTool = tools.find((tool) => !leader.tools.includes(tool));
  if (extraTool)
    return {
      reason: `A ferramenta ${extraTool} não está entre as do líder; um membro não recebe mais que o líder.`,
    };
  const commands = input.autoApproveCommands ?? [];
  const extraCommand = commands.find((command) => !leader.autoApproveCommands.includes(command));
  if (extraCommand)
    return { reason: `O comando "${extraCommand}" não é aprovado automaticamente para o líder.` };
  const servers = input.mcpServers ?? [];
  const extraServer = servers.find((server) => !leader.mcpServers.includes(server));
  if (extraServer)
    return { reason: `O servidor MCP ${extraServer} não está liberado para o líder.` };
  const limits: ExecutionLimits = { ...leader.limits };
  for (const name of ['maxSteps', 'maxTokens', 'commandTimeoutSec', 'taskTimeoutMin'] as const) {
    const asked = input.limits?.[name];
    if (asked === undefined) continue;
    if (!Number.isFinite(asked) || asked <= 0) return { reason: `Limite inválido: ${name}.` };
    if (asked > leader.limits[name])
      return {
        reason: `O limite ${name} pedido (${asked}) passa o do líder (${leader.limits[name]}).`,
      };
    limits[name] = Math.floor(asked);
  }
  return {
    tools: [...new Set(tools)],
    autoApproveCommands: [...new Set(commands)],
    mcpServers: [...new Set(servers)],
    limits,
  };
}

/* ---------------------------------------------------------------- helpers */

function requestKey(key: string): string {
  const value = String(key ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!value) throw new HiveError('VALIDATION', 'Dê uma chave curta ao pedido (ex.: "codex").');
  return value;
}

/** A task key that fits the plan rules (letters, digits, dashes; 40 characters) and is unique. */
function taskKey(leadKey: string, key: string, id: string): string {
  const slug = (text: string, size: number) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, size) || 't';
  return `${slug(leadKey, 14)}-${slug(key, 16)}-${id.slice(-6)}`.replace(/^-/, 't-').slice(0, 40);
}

function describeRequest(kind: TeamRequestKind, input: Record<string, unknown>): string {
  if (kind === 'spawn_agent') return `Criar o agente ${String(input.name ?? input.key)}`;
  if (kind === 'delegate_task') return `Delegar "${String(input.title ?? input.key)}"`;
  return `Pedir revisão de ${(input.of as string[] | undefined)?.join(', ') ?? ''}`;
}

export type { TeamMessageKind };
