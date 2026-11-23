import { app, dialog, Notification, safeStorage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ipcContract,
  rolePresets,
  defaultLimits,
  defaultSettings,
  recommendedModelCandidates,
  formatCost,
  usageCost,
  type AutopilotStatus,
  type CanvasLayout,
  type CanvasTerminal,
  canvasLayoutSchema,
  settingsSchema,
  emptyCanvasLayout,
  type DashboardSummary,
  type ExecutionLimits,
  type RecommendedSetup,
  type BackupInfo,
  type HivePush,
  type IpcChannel,
  type IpcInput,
  type ProviderKind,
  type Run,
  type RunDetail,
  type WorkerRole,
  type Workspace,
} from '@hive/core';
import { HiveDatabase, Repositories, SCHEMA_VERSION } from '@hive/persistence';
import { FlowEngine } from './flow-engine';
import {
  ChatGPTPlanClient,
  ChatGPTSession,
  GatedClient,
  OpenAICompatibleClient,
  ProviderGate,
  revokeChatGPT,
  signInWithChatGPT,
  workerCompatibilityIssues,
  type ChatClient,
  type ChatGPTCredentials,
  type ChatGPTRegistration,
} from '@hive/providers';
import { newId, nowIso, maskSecret, secretRedactor, HiveError, errorMessage } from '@hive/shared';
import {
  git,
  hiveCommitFlags,
  inspectRepository,
  listWorktrees,
  statusPorcelain,
} from '@hive/workspace';
import {
  Autopilot,
  HiveTeams,
  Scheduler,
  planMission,
  teamToolsFor,
  validatePlan,
  type AutopilotHistoryItem,
} from '@hive/orchestrator';
import {
  ClaudeCodePlanClient,
  ClaudeCodePermissions,
  ClaudeCodeRuntime,
  findClaudeCode,
  NativeAgentRuntime,
  probeMcpServer,
  type AgentRuntime,
  type PageViewer,
} from '@hive/agents';
import { SkillForgeAdapter, builtinSkillNames, retiredSkillReplacements } from '@hive/skills';
import { FileService } from './files';
import { TerminalManager } from './terminal';
import { TerminalAgents } from './terminal-agents';
import { AgentChats } from './agent-chats';
import { HiveTerminalApp } from './terminal-ui';
import { startControlServer, writeCommandShims, type ControlServer } from './control-server';
import { assistCode } from './code-assistant';
import { describeProject } from './project-context';
import { startStaticServer, type StaticServer } from './static-server';
import { locateElement } from './locate';
import { canvasRuns, canvasSnapshot, canvasWorker } from './canvas-data';
import { LiveResults } from './live-result';
import { CanvasQueen } from './canvas-queen';
import { NexusAutopilot } from './nexus-autopilot';
import { CortexService } from './cortex';
import { ModelRouter } from './model-router';
import type { RouteSwitch } from '@hive/providers';
import type { Updater } from './updater';
import {
  autoBackupDue,
  backupName,
  backupsDir,
  cancelRestore,
  createBackup,
  listBackups,
  prune,
  resolveBackup,
  stageRestore,
} from './backup';

/** Local midnight as an ISO time: "today" for the token meter is the user's calendar day. */
function startOfToday(): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

export class DesktopService {
  readonly repos: Repositories;
  readonly liveResults: LiveResults;
  /** Claude Code's permission prompts become Hive approvals through this local MCP server. */
  private readonly claudePermissions = new ClaudeCodePermissions();
  private claudeRuntime: ClaudeCodeRuntime | undefined;
  private readonly claudeClients = new Map<string, ClaudeCodePlanClient>();
  readonly canvasQueen: CanvasQueen;
  readonly nexusAutopilot: NexusAutopilot;
  readonly cortex: CortexService;
  readonly router: ModelRouter;
  readonly scheduler: Scheduler;
  /** Hive Teams: leaders' requests for agents, delegations and reviews (off unless enabled). */
  readonly teams: HiveTeams;
  private readonly flow: FlowEngine;
  readonly autopilot: Autopilot;
  readonly terminals: TerminalManager;
  /** Direct Agent Chat: conversations with one agent, without a mission or the Queen. */
  readonly agentChats: AgentChats;
  /** Set by the app shell to notify the user when the shift finishes a mission. */
  onShiftFinished?: (item: AutopilotHistoryItem) => void;
  /** Set by the app shell: a PNG data URL of part of the window, for Design Mode notes. */
  capturePage?: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<string | null>;
  /** Set by the app shell: opens a local page in a hidden window for the agents' view_page. */
  viewPage?: PageViewer;
  /** Set by the app shell: opens (or focuses) the Nexus window. */
  openCanvas?: () => void;
  /** Set by the app shell: brings the main window forward with a run open. */
  showRun?: (runId: string) => void;
  addProvider?: () => void;
  /** Set by the app shell: app updates (absent in tests). */
  updater?: Updater;
  /** Set by the app shell: quits and opens Hive again (applies a staged restore). */
  restart?: () => void;
  private backupTimer: ReturnType<typeof setInterval> | undefined;
  private firstBackup: ReturnType<typeof setTimeout> | undefined;
  private backingUp: Promise<BackupInfo> | null = null;
  private readonly runtime: AgentRuntime;
  private readonly planning = new Set<string>();
  /** One per provider, shared by everything that calls it. */
  private readonly gates = new Map<string, ProviderGate>();
  /** Signed-in ChatGPT accounts by provider; one per provider so refreshes never race. */
  private readonly chatgptSessions = new Map<string, ChatGPTSession>();
  private shiftTimer: ReturnType<typeof setTimeout> | undefined;
  // Each open project keeps its own watcher and preview server, so switching tabs loses nothing.
  private readonly fileServices = new Map<string, FileService>();
  private readonly previewServers = new Map<string, StaticServer>();
  private control: ControlServer | null = null;
  /** Terminals the Nexus opened: the only ones it may type into, resize or stop. */
  private readonly canvasTerminals = new Map<
    string,
    Omit<CanvasTerminal, 'session'> & { runId: string }
  >();
  private terminalAgents: TerminalAgents | null = null;

  constructor(
    private readonly database: HiveDatabase,
    private readonly dataDir: string,
    private readonly push: (push: HivePush) => void,
    runtime?: AgentRuntime,
  ) {
    this.repos = new Repositories(database);
    // ChatGPT providers used to be named after the old preset label; drop the "(sua assinatura)".
    for (const provider of this.repos.providers.list())
      if (provider.kind === 'chatgpt' && provider.name === 'ChatGPT (sua assinatura)')
        this.repos.providers.put({ ...provider, name: 'ChatGPT' });
    this.router = new ModelRouter({
      repos: this.repos,
      chatFor: (providerId) => this.chatClient(providerId),
      refreshCatalog: async (providerId) => {
        const models = await this.client(providerId).listModels();
        this.repos.replaceModels(providerId, models);
        this.repos.providers.put({
          ...this.repos.providers.require(providerId, 'Provedor'),
          modelsFetchedAt: nowIso(),
        });
        this.changed('provider', providerId);
        return models;
      },
    });
    this.cortex = new CortexService({
      repos: this.repos,
      embeddingsFor: (providerId) => this.client(providerId),
      chatFor: (providerId) => this.chatClient(providerId),
      onChange: (cortexId) => this.changed('cortex', cortexId),
      onEvent: (event) => {
        this.push({ kind: 'event', event });
        if (event.runId) this.liveResults.schedule(event.runId);
      },
    });
    this.liveResults = new LiveResults(this.repos, (runId) =>
      this.push({ kind: 'changed', entity: 'result', id: runId }),
    );
    this.canvasQueen = new CanvasQueen({
      repos: this.repos,
      layout: (runId) => this.canvasLayout(runId),
      chatFor: (providerId) => this.chatClient(providerId),
      invoke: (channel, input) => this.invoke(channel, input),
      planning: (runId) => this.planning.has(runId),
      resultContext: (runId) => this.liveResults.context(runId),
      onEvent: (event) => {
        this.push({ kind: 'event', event });
        this.liveResults.schedule(event.runId!);
      },
    });
    this.nexusAutopilot = new NexusAutopilot({
      repos: this.repos,
      layout: (runId) => this.canvasLayout(runId),
      chatFor: (providerId) => this.chatClient(providerId),
      invoke: (channel, input) => this.invoke(channel, input),
      resultContext: (runId) => this.liveResults.context(runId),
      cortex: this.cortex,
      onEvent: (event) => {
        this.push({ kind: 'event', event });
        this.liveResults.schedule(event.runId!);
      },
      reroute: (taskId, keys, note) => this.scheduler.reroute(taskId, keys, note),
      refresh: (runId) => this.scheduler.refresh(runId),
      onChange: (runId) => this.changed('autopilot', runId),
    });
    this.runtime =
      runtime ??
      new NativeAgentRuntime({
        mcpServers: () => this.repos.getSettings().mcpServers,
        viewPage: (request) => {
          if (!this.viewPage)
            throw new HiveError('VALIDATION', 'view_page is not available right now.');
          return this.viewPage(request);
        },
      });
    this.scheduler = new Scheduler({
      repos: this.repos,
      runtime: this.runtime,
      chatFor: (providerId) => this.chatClient(providerId),
      resolveSkills: (names) => this.skills().resolve(names),
      // Outside the user's repository, on the same drive as Hive's data.
      worktreeRoot: (workspace) => path.join(this.dataDir, 'worktrees', workspace.id),
      onEvent: (event) => {
        this.push({ kind: 'event', event });
        if (event.runId) this.liveResults.schedule(event.runId);
      },
      onChange: (entity, id) => this.changed(entity, id),
      unattended: (runId) => this.autopilot.isUnattended(runId),
      onTaskFailed: (run, task) => this.nexusAutopilot.detect(run, task),
      holds: (task) => this.nexusAutopilot.holds(task),
      prepareMemory: (context) => this.cortex.prepareTask(context),
      chatForWorker: (worker, notify) =>
        this.router.clientFor(worker, (change) =>
          notify(describeSwitch(change), switchData(change)),
        ),
      teamTools: ({ task, worker }) => teamToolsFor(this.teams, this.repos, { task, worker }),
      // "Várias tentativas": a different free model per attempt, compared by the project's checks.
      candidateModels: (worker, count) => this.router.alternatives(worker, count),
      checkCandidate: async ({ run, task }) => {
        const workspace = this.repos.workspaces.require(run.workspaceId, 'Projeto');
        if (!task.result?.commit) return [];
        const commands = await this.flow.verificationCommands(workspace.path);
        return this.flow.checkCommit(workspace, task.result.commit, commands);
      },
      onTaskFinished: (_run, task) => this.teams.taskFinished(task),
      // An agent on the Claude Code provider runs its tasks on Claude Code itself.
      runtimeFor: (worker) =>
        worker.providerId && this.repos.providers.get(worker.providerId)?.kind === 'claude-code'
          ? this.claudeCode()
          : null,
    });
    this.teams = new HiveTeams({ repos: this.repos, scheduler: this.scheduler });
    // The same engines, model routing, skills, Nectar and approval rules as mission tasks.
    this.agentChats = new AgentChats({
      repos: this.repos,
      runtime: this.runtime,
      runtimeFor: (worker) =>
        worker.providerId && this.repos.providers.get(worker.providerId)?.kind === 'claude-code'
          ? this.claudeCode()
          : null,
      chatForWorker: (worker, notify) =>
        this.router.clientFor(worker, (change) => notify(describeSwitch(change))),
      resolveSkills: async (names) => (await this.skills().resolve(names)).skills,
      prepareMemory: (context) => this.cortex.prepareChat(context),
      gitStatus: (root) => statusPorcelain(root),
      push: (push) => this.push(push),
      onWorkerChanged: (id) => this.changed('worker', id),
      onChange: () => this.changed('chat'),
    });
    this.flow = new FlowEngine({
      repos: this.repos,
      layout: (runId) => this.canvasLayout(runId),
      worktreeRoot: (workspaceId) => path.join(this.dataDir, 'worktrees', workspaceId),
      // The task goes back to its agent with the note, and the run resumes for it.
      revise: (taskId, note) => this.scheduler.revise(taskId, [], note),
      approve: (taskId) => this.scheduler.approve(taskId),
      start: async (runId) => {
        const run = this.repos.runs.require(runId, 'Execução');
        if (run.status === 'running' || run.status === 'planning') return;
        // Without a plan, the shift plans it first and then runs it.
        if (!this.repos.tasks.list('run_id = ?', runId).length) this.autopilot.enqueue(runId);
        else this.scheduler.start(runId);
      },
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      onChange: (runId) => this.push({ kind: 'changed', entity: 'run', id: runId }),
      log: (runId, text, level = 'info') => {
        const run = this.repos.runs.get(runId);
        if (!run) return;
        const event = {
          id: newId('event'),
          ts: nowIso(),
          workspaceId: run.workspaceId,
          runId,
          taskId: null,
          workerId: null,
          type: 'info' as const,
          level,
          message: text,
          data: { source: 'flow' },
        };
        this.repos.appendEvent(event);
        this.push({ kind: 'event', event });
      },
    });
    this.flow.start();
    this.autopilot = new Autopilot({
      repos: this.repos,
      plan: async (runId) => {
        const run = this.repos.runs.require(runId, 'Execução');
        const queen =
          (run.queenWorkerId ? this.repos.workers.get(run.queenWorkerId) : null) ??
          this.repos.workers
            .list()
            .find((worker) => worker.role === 'queen' && worker.providerId && worker.modelId);
        if (!queen)
          throw new HiveError(
            'VALIDATION',
            'Configure um provedor e modelo para a Queen na aba Agentes.',
          );
        await this.planRun(runId, queen.id);
      },
      start: (runId) => this.scheduler.start(runId),
      onChange: () => this.changed('autopilot'),
      onFinished: (item) => this.onShiftFinished?.(item),
    });
    if (this.repos.getValue('seeded') !== '1') {
      for (const role of [
        'queen',
        'architect',
        'frontend',
        'backend',
        'qa',
        'reviewer',
      ] as WorkerRole[]) {
        const preset = rolePresets[role];
        this.repos.workers.put({
          id: newId('worker'),
          name: preset.label,
          role,
          beeColor: null,
          squad: [],
          description: preset.description,
          providerId: null,
          modelId: null,
          skills: [],
          tools: preset.tools,
          autoApproveCommands: [],
          mcpServers: [],
          systemPrompt: preset.systemPrompt,
          limits: { ...defaultLimits },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
      this.repos.setValue('seeded', '1');
    }
    this.raiseLimits();
    this.detachWorkers();
    // Projects from before the default Nectar get theirs once; new ones get it when opened.
    for (const workspace of this.repos.workspaces.list()) this.cortex.ensureDefault(workspace.id);
    const replan = this.recoverPlanning();
    this.nexusAutopilot.recoverInterrupted();
    for (const run of this.repos.runs.list()) this.liveResults.schedule(run.id);
    this.terminals = new TerminalManager((event) => this.push({ kind: 'terminal', event }));
    // Interrupted work is saved and resumed first; then a shift that was on picks its queue back up.
    void this.scheduler
      .recover()
      .then((resumed) => {
        for (const runId of replan)
          void this.planRun(runId, this.repos.runs.require(runId, 'Execução').queenWorkerId!).catch(
            (error: unknown) =>
              console.warn('Não foi possível refazer o plano interrompido:', errorMessage(error)),
          );
        const total = resumed.length + replan.length;
        if (total && Notification.isSupported())
          new Notification({
            title: 'Missões retomadas',
            body:
              total === 1
                ? 'O Hive fechou no meio de uma missão e continuou de onde ela parou.'
                : `O Hive fechou no meio de ${total} missões e continuou de onde elas pararam.`,
          }).show();
      })
      .catch((error: unknown) =>
        console.error('Recuperação das missões interrompidas falhou:', errorMessage(error)),
      )
      .finally(() => this.advanceShift());
  }

  /**
   * A plan the Queen was making when Hive closed is asked for again, so the mission does not stay
   * stopped. The shift re-plans its own missions; a run whose Queen is unknown waits for the user.
   * Returns the runs to plan again once recovery is done.
   */
  private recoverPlanning(): string[] {
    const replan: string[] = [];
    for (const run of this.repos.runs.list()) {
      if (run.status !== 'planning') continue;
      this.repos.runs.put({
        ...run,
        status: 'failed',
        error: 'O aplicativo fechou durante o planejamento. Gere o plano novamente.',
      });
      if (run.queenWorkerId && !this.autopilot.isUnattended(run.id)) replan.push(run.id);
    }
    return replan;
  }

  /** Honey given today and in all; "today" starts at local midnight, like the token meter. */
  private honey(): { today: number; total: number } {
    let stored = { day: '', today: 0, total: 0 };
    try {
      stored = { ...stored, ...(JSON.parse(this.repos.getValue('honey') ?? '{}') as object) };
    } catch {
      // A damaged counter starts over; it is only a tally.
    }
    return {
      today: stored.day === startOfToday() ? stored.today : 0,
      total: stored.total,
    };
  }

  private countHoney() {
    const { today, total } = this.honey();
    this.repos.setValue(
      'honey',
      JSON.stringify({ day: startOfToday(), today: today + 1, total: total + 1 }),
    );
    // The boost itself announces the task change, which refreshes the status bar.
  }

  /**
   * Once: agents and settings made with the old, tight limits (400 mil tokens, 40 steps) get
   * the roomy ones. A limit the user already set higher stays.
   */
  private raiseLimits() {
    if (this.repos.getValue('limitsRaised') === '1') return;
    const raise = (limits: ExecutionLimits): ExecutionLimits => ({
      ...limits,
      maxSteps: Math.max(limits.maxSteps, defaultLimits.maxSteps),
      maxTokens: Math.max(limits.maxTokens, defaultLimits.maxTokens),
      commandTimeoutSec: Math.max(limits.commandTimeoutSec, defaultLimits.commandTimeoutSec),
      taskTimeoutMin: Math.max(limits.taskTimeoutMin, defaultLimits.taskTimeoutMin),
    });
    for (const worker of this.repos.workers.list())
      this.repos.workers.put({ ...worker, limits: raise(worker.limits), updatedAt: nowIso() });
    const settings = this.repos.getSettings();
    this.repos.saveSettings({
      ...settings,
      defaultLimits: raise(settings.defaultLimits),
      runTokenBudget: 0,
      dailyTokenBudget: Math.max(settings.dailyTokenBudget, defaultSettings.dailyTokenBudget),
    });
    this.repos.setValue('limitsRaised', '1');
  }

  /**
   * Puts the skills that ship with Hive in the library and on the agents whose role uses them.
   * Each skill only once: one the user deleted, or took off an agent, stays that way.
   */
  async installBuiltinSkills(): Promise<void> {
    let done: string[] = [];
    try {
      done = JSON.parse(this.repos.getValue('builtinSkills') ?? '[]') as string[];
    } catch {
      // A damaged list just installs again; skills already in the library are kept.
    }
    const fresh = builtinSkillNames.filter((name) => !done.includes(name));
    if (!fresh.length) return;
    await this.skills().installBuiltins(fresh);
    for (const worker of this.repos.workers.list()) {
      const added = rolePresets[worker.role].skills.filter(
        (name) => fresh.includes(name) && !worker.skills.includes(name),
      );
      if (!added.length) continue;
      this.repos.workers.put({
        ...worker,
        skills: [...worker.skills, ...added],
        updatedAt: nowIso(),
      });
      this.changed('worker', worker.id);
    }
    this.repos.setValue('builtinSkills', JSON.stringify([...done, ...fresh]));
    this.changed('skill');
    await this.retireOldSkills();
  }

  /**
   * Hive's first built-in skills gave way to fuller ones (Superpowers, Addy Osmani, Anthropic).
   * Once: agents that had an old one get its replacements, and library copies the user never
   * edited are removed. An edited copy is the user's and stays, still on its agents.
   */
  private async retireOldSkills(): Promise<void> {
    if (this.repos.getValue('retiredSkills') === '1') return;
    const names = Object.keys(retiredSkillReplacements);
    const removed = new Set(await this.skills().removeRetired(names));
    for (const worker of this.repos.workers.list()) {
      if (!worker.skills.some((name) => removed.has(name))) continue;
      const skills = [
        ...new Set(
          worker.skills.flatMap((name) =>
            removed.has(name) ? (retiredSkillReplacements[name] ?? []) : [name],
          ),
        ),
      ];
      this.repos.workers.put({ ...worker, skills, updatedAt: nowIso() });
      this.changed('worker', worker.id);
    }
    this.repos.setValue('retiredSkills', '1');
    this.changed('skill');
  }

  /**
   * Gives Hive's terminals the `agents` and `hive` commands: a local endpoint they call, and
   * the command scripts on their PATH. Terminals opened before this keep working without them.
   */
  async enableTerminalCommands(): Promise<void> {
    const agents = new TerminalAgents({
      repos: this.repos,
      runtime: this.runtime,
      chatFor: (providerId) => this.chatClient(providerId),
      resolveSkills: async (names) => (await this.skills().resolve(names)).skills,
      onWorkerChanged: (id) => this.changed('worker', id),
      onChange: () => this.changed('chat'),
      // Shown live, not stored: the terminal already keeps the conversation.
      onActivity: (chat, event) =>
        this.push({
          kind: 'event',
          event: {
            id: newId('event'),
            ts: nowIso(),
            workspaceId: chat.workspaceId,
            runId: null,
            taskId: null,
            workerId: chat.workerId,
            type: event.type,
            level: event.level,
            message: event.message,
            data: { ...event.data, chat: chat.id, title: chat.title },
          },
        }),
    });
    this.terminalAgents = agents;
    this.control = await startControlServer(({ terminalId, command, argument, write, end }) => {
      const terminal = this.terminals.describe(terminalId);
      if (!terminal) throw new HiveError('NOT_FOUND', 'Este terminal não é do Hive.');
      const workspace = this.repos.workspaces.require(terminal.workspaceId, 'Projeto');
      let detachInput = () => {};
      const app = new HiveTerminalApp(
        {
          write,
          end: () => {
            detachInput();
            end();
          },
          size: () => this.terminals.describe(terminalId) ?? terminal,
        },
        {
          workspace,
          workers: () => this.repos.workers.list(),
          turn: (workerId, request, history, handlers, signal) =>
            agents.turn(workspace, workerId, request, history, handlers, signal),
          cost: (workerId, usage) => {
            const worker = this.repos.workers.get(workerId);
            if (!worker?.providerId || !worker.modelId) return null;
            const model = this.repos.getModel(worker.providerId, worker.modelId) ?? {
              id: worker.modelId,
              pricing: null,
            };
            const usd = usageCost(model, usage);
            return usd === null ? null : formatCost(usd);
          },
        },
      );
      detachInput = this.terminals.attach(terminalId, (data) => app.input(data));
      const fromCanvas = this.canvasTerminals.get(terminalId);
      app.start(
        command === 'hive' && argument !== 'agents' ? 'help' : 'agents',
        // A conversation opened from an agent's window on the canvas starts with that agent.
        fromCanvas?.kind === 'chat' ? (fromCanvas.workerId ?? undefined) : undefined,
      );
      return () => {
        detachInput();
        app.dispose();
      };
    });
    const binDir = path.join(this.dataDir, 'bin');
    await writeCommandShims(binDir);
    this.terminals.enableCommands({
      binDir,
      env: { HIVE_CONTROL: this.control.url, HIVE_TOKEN: this.control.token },
    });
  }

  /** A backup in the backups folder; automatic ones also prune the oldest. One at a time. */
  async backup(kind: 'auto' | 'manual'): Promise<BackupInfo> {
    while (this.backingUp) await this.backingUp.catch(() => undefined);
    const dir = backupsDir(this.dataDir);
    const name = backupName(kind);
    this.backingUp = (async () => {
      await createBackup(this.database, this.dataDir, path.join(dir, name), app.getVersion());
      if (kind === 'auto') await prune(dir, 'auto', this.repos.getSettings().backup.keep);
      const info = (await listBackups(dir)).find((item) => item.name === name);
      if (!info) throw new HiveError('INTERNAL', 'O backup não foi gravado.');
      return info;
    })();
    try {
      return await this.backingUp;
    } finally {
      this.backingUp = null;
    }
  }

  /** Checks every hour whether the daily automatic backup is due. */
  startAutoBackups(): void {
    const tick = async () => {
      if (!this.repos.getSettings().backup.auto) return;
      if (!(await autoBackupDue(backupsDir(this.dataDir)))) return;
      await this.backup('auto');
    };
    const safeTick = () =>
      void tick().catch((error: unknown) =>
        console.error('Backup automático falhou:', errorMessage(error)),
      );
    clearInterval(this.backupTimer);
    clearTimeout(this.firstBackup);
    this.firstBackup = setTimeout(safeTick, 60_000);
    this.backupTimer = setInterval(safeTick, 60 * 60 * 1000);
  }

  /** Agents moved to the Claude Code provider get its default model, untested. */
  private async assignClaudeCode(
    providerId: string,
    workerIds: string[] | null,
  ): Promise<RecommendedSetup> {
    if (!this.repos.listModels(providerId).length) {
      this.repos.replaceModels(providerId, await this.client(providerId).listModels());
      this.repos.providers.put({
        ...this.repos.providers.require(providerId, 'Provedor'),
        modelsFetchedAt: nowIso(),
      });
    }
    const workers = this.repos.workers
      .list()
      .filter((worker) => !workerIds || workerIds.includes(worker.id));
    if (workerIds && workers.length !== workerIds.length)
      throw new HiveError('NOT_FOUND', 'Agente não encontrado.');
    const result: RecommendedSetup = { assignments: [], unavailable: [] };
    for (const worker of workers) {
      this.repos.workers.put({ ...worker, providerId, modelId: 'default', updatedAt: nowIso() });
      result.assignments.push({ workerId: worker.id, workerName: worker.name, modelId: 'default' });
    }
    this.changed('worker');
    return result;
  }

  /** The Claude Code engine, made on first use with the executable found then. */
  private claudeCode(): ClaudeCodeRuntime {
    this.claudeRuntime ??= new ClaudeCodeRuntime({
      executable: findClaudeCode() ?? 'claude',
      permissions: this.claudePermissions,
    });
    return this.claudeRuntime;
  }

  dispose(): void {
    this.agentChats.dispose();
    const stopped = this.scheduler.shutdown();
    if (stopped) console.warn(`Encerrando: ${stopped} sessão(ões) de agente interrompida(s).`);
    void this.claudePermissions.close();
    this.flow.dispose();
    this.canvasQueen.dispose();
    this.nexusAutopilot.dispose();
    this.liveResults.dispose();
    clearTimeout(this.shiftTimer);
    this.shiftTimer = undefined;
    clearInterval(this.backupTimer);
    clearTimeout(this.firstBackup);
    this.updater?.dispose();
    void this.control?.close();
    this.terminals.dispose();
    this.files.dispose();
    for (const service of this.fileServices.values()) service.dispose();
    for (const server of this.previewServers.values()) void server.close();
  }

  /** One static server per project; reused while the project stays open. */
  private async servePreview(root: string): Promise<StaticServer> {
    const running = this.previewServers.get(root);
    if (running) return running;
    const server = await startStaticServer(root);
    this.previewServers.set(root, server);
    return server;
  }

  /** Opens a Git repository as a project tab and focuses it. */
  private async openRepository(folder: string): Promise<Workspace> {
    const repo = await inspectRepository(folder);
    const previous = this.repos.workspaces.list().find((item) => item.path === repo.root);
    const workspace = this.repos.workspaces.put({
      id: previous?.id ?? newId('ws'),
      name: path.basename(repo.root),
      path: repo.root,
      defaultBranch: repo.branch ?? 'main',
      createdAt: previous?.createdAt ?? nowIso(),
      lastOpenedAt: nowIso(),
    });
    this.saveOpenedWorkspaceIds([...this.openedWorkspaceIds(), workspace.id]);
    this.repos.setValue('activeWorkspace', workspace.id);
    this.cortex.ensureDefault(workspace.id);
    this.changed('workspace', workspace.id);
    return workspace;
  }

  /**
   * Makes a plain folder a local Git repository: the files already there become the first
   * commit. Nothing is pushed anywhere, so no GitHub account or remote is needed.
   */
  private async initializeRepository(folder: string): Promise<Workspace> {
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory())
      throw new HiveError('NOT_FOUND', 'A pasta escolhida não existe mais.');
    await git(folder, ['init', '-q', '-b', 'main']);
    // .gitignore keeps dependency folders out of the first commit.
    await git(folder, ['add', '-A'], { timeoutMs: 600_000 });
    const email = await git(folder, ['config', 'user.email'], { allowFailure: true });
    const identity = email.code === 0 && email.stdout.trim() ? [] : hiveCommitFlags;
    await git(
      folder,
      [...identity, 'commit', '-q', '--allow-empty', '-m', 'Projeto iniciado no Hive'],
      {
        timeoutMs: 600_000,
      },
    );
    return this.openRepository(folder);
  }

  /** File access for the project in the focused tab. */
  get files(): FileService {
    return this.filesFor(this.active());
  }

  private filesFor(workspace: Workspace | null): FileService {
    const key = workspace?.id ?? '';
    const existing = this.fileServices.get(key);
    if (existing) return existing;
    const service = new FileService(
      () => workspace?.path ?? null,
      (paths) => this.push({ kind: 'files', workspaceId: key, paths }),
    );
    service.watch();
    this.fileServices.set(key, service);
    return service;
  }

  /** Projects open as tabs. Stored as ids, in order; closed projects are dropped. */
  private openedWorkspaceIds(): string[] {
    const raw = this.repos.getValue('openWorkspaces');
    let ids: unknown;
    try {
      ids = raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids)].filter(
      (id): id is string => typeof id === 'string' && this.repos.workspaces.get(id) !== null,
    );
  }

  private saveOpenedWorkspaceIds(ids: string[]): void {
    this.repos.setValue('openWorkspaces', JSON.stringify([...new Set(ids)]));
  }

  private changed(
    entity: Extract<HivePush, { kind: 'changed' }>['entity'],
    id: string | null = null,
  ) {
    this.push({ kind: 'changed', entity, id });
    if (id && entity === 'run') {
      this.liveResults.schedule(id);
      const run = this.repos.runs.get(id);
      if (run) this.flow.onRun(run);
    }
    if (id && entity === 'task') {
      const task = this.repos.tasks.get(id);
      if (task) {
        this.liveResults.schedule(task.runId);
        this.flow.onTask(task);
      }
    }
    if (entity === 'run' || entity === 'settings') this.advanceShift();
  }

  /**
   * Deferred, so the shift never re-enters the scheduler while it is still updating a run, and
   * merged, so a burst of changes costs one look at the queue.
   */
  private advanceShift(): void {
    this.shiftTimer ??= setTimeout(() => {
      this.shiftTimer = undefined;
      this.autopilot.tick();
    }, 0);
  }

  private autopilotStatus(): AutopilotStatus {
    return {
      enabled: this.autopilot.enabled,
      currentRunId: this.autopilot.current(),
      queue: this.autopilot.queue().map((runId) => {
        const run = this.repos.runs.require(runId, 'Execução');
        const tasks = this.repos.tasks.list('run_id = ?', runId);
        return {
          runId,
          missionId: run.missionId,
          missionTitle: this.repos.missions.get(run.missionId)?.title ?? run.missionId,
          workspaceName: this.repos.workspaces.get(run.workspaceId)?.name ?? '',
          status: run.status,
          tasks: {
            total: tasks.length,
            done: tasks.filter((task) => ['completed', 'approved'].includes(task.status)).length,
            failed: tasks.filter((task) => task.status === 'failed').length,
          },
        };
      }),
      history: this.autopilot.history(),
    };
  }

  /** Asks the Queen for a plan; used by the mission page and by the shift. */
  private async planRun(runId: string, queenWorkerId: string): Promise<RunDetail> {
    if (this.planning.has(runId))
      throw new HiveError('CONFLICT', 'Esta execução já está sendo planejada.');
    const { run, mission } = this.runDetail(runId);
    if (run.status === 'running')
      throw new HiveError('CONFLICT', 'Cancele a execução antes de gerar um novo plano.');
    const queen = this.repos.workers.require(queenWorkerId, 'Queen');
    if (queen.role !== 'queen' || !queen.providerId || !queen.modelId)
      throw new HiveError(
        'VALIDATION',
        'Configure um provedor e modelo para a Queen na aba Agentes.',
      );
    const workspace = this.repos.workspaces.require(run.workspaceId, 'Workspace');
    this.planning.add(runId);
    this.repos.runs.put({ ...run, status: 'planning', queenWorkerId, error: null });
    this.changed('run', runId);
    try {
      const checks = await this.flow.commands(workspace.path);
      const result = await planMission({
        title: mission.title,
        objective: mission.objective,
        // Agents Hive Teams created belong to their own mission; the Queen plans with the team.
        workers: this.repos.workers.list().filter((worker) => !worker.team),
        teams: this.repos.getSettings().teams.enabled,
        projectContext:
          (await describeProject(workspace.path, {
            name: workspace.name,
            branch: run.baseBranch,
          })) +
          (checks.length
            ? `\n\nFluxo do Hive: depois de cada tarefa, o Hive roda "${checks[0]}" no resultado do agente; se falhar, a tarefa volta para ele com o erro. Planeje tarefas que deixem ${checks.map((command) => `"${command}"`).join(', ')} passando e cite esses comandos nos critérios de aceite.`
            : '') +
          '\n\n' +
          this.liveResults.context(runId) +
          (await this.queenMemory(run, queen.id, [mission.title, mission.objective].join(' - '))),
        queen,
        skills: (await this.skills().resolve(queen.skills)).skills,
        model: queen.modelId,
        chat: this.router.clientFor(queen, (change) =>
          this.logRun(run, queen.id, describeSwitch(change), switchData(change)),
        ),
        signal: AbortSignal.timeout(180_000),
      });
      const detail = this.setPlan(runId, result.plan);
      void this.scaffoldFlow(runId);
      return detail;
    } catch (error) {
      const failure = this.modelFailure(queen.modelId, error);
      this.repos.runs.put({ ...run, queenWorkerId, status: 'failed', error: failure });
      this.changed('run', runId);
      throw error instanceof HiveError ? new HiveError(error.code, failure) : error;
    } finally {
      this.planning.delete(runId);
    }
  }

  /**
   * After the Queen plans, the blocks every mission wants on its canvas without asking: the
   * project's Nectar (created with the team if the project has none yet), a Tokens card above
   * the agent windows, and a card for each provider the team uses, left of the Queen, so the
   * lines show who runs on what. A canvas that already has a Tokens card or provider cards keeps
   * its own.
   */
  private scaffoldBlocks(runId: string): void {
    try {
      const run = this.repos.runs.get(runId);
      if (!run) return;
      this.cortex.ensureDefault(run.workspaceId);
      const layout = this.canvasLayout(runId);
      // Over the first agent window: the Queen's column is 220 wide, then a 76 × 1.4 gap.
      const meters = layout.meters.length
        ? layout.meters
        : [{ id: `tokens:auto-${runId}`, x: 326, y: -250 }];
      const providers = layout.providers.length ? layout.providers : this.teamProviders(run);
      if (meters === layout.meters && providers === layout.providers) return;
      this.repos.setValue(
        `canvasLayout:${runId}`,
        JSON.stringify({ ...layout, meters, providers }),
      );
      this.push({ kind: 'changed', entity: 'layout', id: runId });
    } catch {
      // Only a convenience: the plan stands without it.
    }
  }

  /**
   * One provider card per provider the run's Queen and agents use, the Queen's first and then
   * the most used, folded to its logo in a staggered column left of the Queen.
   */
  private teamProviders(run: Run): CanvasLayout['providers'] {
    const uses = new Map<string, number>();
    const workerIds = [
      ...(run.queenWorkerId ? [run.queenWorkerId] : []),
      ...this.repos.tasks
        .list('run_id = ?', run.id)
        .map((task) => task.workerId)
        .filter((id): id is string => !!id),
    ];
    for (const workerId of workerIds) {
      const providerId = this.repos.workers.get(workerId)?.providerId;
      if (providerId && this.repos.providers.get(providerId))
        uses.set(providerId, (uses.get(providerId) ?? 0) + 1);
    }
    const queenProvider = run.queenWorkerId
      ? this.repos.workers.get(run.queenWorkerId)?.providerId
      : null;
    return [...uses.entries()]
      .sort(([a, countA], [b, countB]) =>
        a === queenProvider ? -1 : b === queenProvider ? 1 : countB - countA,
      )
      .slice(0, 8)
      .map(([providerId], index) => ({
        id: `provider:auto-${run.id}-${index}`,
        x: -230 - (index % 2) * 130,
        y: -60 + index * 105,
        providerId,
      }));
  }

  /**
   * After the Queen plans, the flow around the team: each agent's work is checked with the
   * project's own command, a failure goes back to that agent with the error, what passes waits
   * for your approval, and the end of the mission is notified. Only on a canvas without flow
   * blocks, so it never overrides a flow the user built.
   */
  private async scaffoldFlow(runId: string): Promise<void> {
    this.scaffoldBlocks(runId);
    try {
      const layout = this.canvasLayout(runId);
      const run = this.repos.runs.get(runId);
      if (!run || layout.flow.length) return;
      const workspace = this.repos.workspaces.require(run.workspaceId, 'Projeto');
      const agents = [
        ...new Set(
          this.repos.tasks
            .list('run_id = ?', runId)
            .map((task) => task.workerId)
            .filter((id): id is string => !!id),
        ),
      ];
      if (!agents.length) return;
      const [command] = await this.flow.commands(workspace.path);
      // Right of where the agents sit, when the user has placed them; otherwise a fixed column.
      const placed = Object.values(layout.pinned)
        .flatMap((points) => Object.entries(points))
        .filter(([id]) => id.startsWith('agent:'))
        .map(([, point]) => point.x);
      const x = placed.length ? Math.max(...placed) + 460 : 980;
      const key = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const flow: CanvasLayout['flow'] = [];
      const links: CanvasLayout['links'] = [];
      const approval = {
        id: `flow:${key()}`,
        x: x + 340,
        y: 60,
        kind: 'approval' as const,
        auto: false,
      };
      if (command) {
        const check = {
          id: `flow:${key()}`,
          x,
          y: 40,
          kind: 'check' as const,
          command,
          retries: 1,
        };
        flow.push(check);
        for (const agent of agents)
          links.push(
            { id: `link:${key()}`, source: `agent:${agent}`, target: check.id, port: 'out' },
            { id: `link:${key()}`, source: check.id, target: `agent:${agent}`, port: 'fail' },
          );
        links.push({ id: `link:${key()}`, source: check.id, target: approval.id, port: 'pass' });
      } else
        for (const agent of agents)
          links.push({
            id: `link:${key()}`,
            source: `agent:${agent}`,
            target: approval.id,
            port: 'out',
          });
      flow.push(approval);
      if (run.queenWorkerId) {
        const notify = { id: `flow:${key()}`, x: x + 340, y: 280, kind: 'notify' as const };
        flow.push(notify);
        links.push({
          id: `link:${key()}`,
          source: `agent:${run.queenWorkerId}`,
          target: notify.id,
          port: 'out',
        });
      }
      this.repos.setValue(
        `canvasLayout:${runId}`,
        JSON.stringify({ ...layout, flow, links: [...layout.links, ...links] }),
      );
      this.push({ kind: 'changed', entity: 'layout', id: runId });
      const event = {
        id: newId('event'),
        ts: nowIso(),
        workspaceId: run.workspaceId,
        runId,
        taskId: null,
        workerId: run.queenWorkerId,
        type: 'info' as const,
        level: 'info' as const,
        message: command
          ? `A Queen montou o fluxo: cada entrega passa por "${command}", falhas voltam ao agente, e o que passar espera a sua aprovação.`
          : 'A Queen montou o fluxo: cada entrega espera a sua aprovação.',
        data: { source: 'flow' },
      };
      this.repos.appendEvent(event);
      this.push({ kind: 'event', event });
    } catch {
      // The flow is a help, never a reason for planning to fail.
    }
  }

  /** A line in a run's live log that is not about one task (the Queen while she plans). */
  private logRun(
    run: RunDetail['run'],
    workerId: string,
    message: string,
    data: Record<string, unknown>,
  ) {
    const event = {
      id: newId('event'),
      ts: nowIso(),
      workspaceId: run.workspaceId,
      runId: run.id,
      taskId: null,
      workerId,
      type: 'info' as const,
      level: 'warn' as const,
      message,
      data,
    };
    this.repos.appendEvent(event);
    this.push({ kind: 'event', event });
  }

  /** Nectar knowledge for the Queen's plan, when she is connected with Read; never blocks planning. */
  private async queenMemory(run: RunDetail['run'], queenId: string, objective: string) {
    try {
      const context = await this.cortex.planningContext(run, queenId, objective);
      return context ? ['', '', context].join(String.fromCharCode(10)) : '';
    } catch {
      return '';
    }
  }

  private active() {
    const id = this.repos.getValue('activeWorkspace');
    return id ? this.repos.workspaces.get(id) : null;
  }

  private skills() {
    const settings = this.repos.getSettings();
    return new SkillForgeAdapter({
      catalogPath: settings.skillforgeCatalogPath,
      libraryDir: path.join(this.dataDir, 'skills'),
      cliValidation: settings.skillforgeCliValidation,
      nodeCommand: {
        command: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    });
  }

  /**
   * The client agents talk through: every call to one provider, from any task, soldier or
   * terminal, goes through the same gate, so together they stay under its rate limit.
   */
  private chatClient(providerId: string): ChatClient {
    let gate = this.gates.get(providerId);
    if (!gate) this.gates.set(providerId, (gate = new ProviderGate()));
    return new GatedClient(this.client(providerId), gate);
  }

  private client(
    providerId: string,
  ): OpenAICompatibleClient | ChatGPTPlanClient | ClaudeCodePlanClient {
    const provider = this.repos.providers.require(providerId, 'Provedor');
    if (!provider.enabled) throw new HiveError('PROVIDER', 'O provedor está desativado.');
    if (provider.kind === 'claude-code') {
      // One per provider, so the sign-in check is cached between calls.
      let client = this.claudeClients.get(providerId);
      if (!client)
        this.claudeClients.set(
          providerId,
          (client = new ClaudeCodePlanClient({
            providerId,
            executable: findClaudeCode() ?? 'claude',
          })),
        );
      return client;
    }
    if (provider.kind === 'chatgpt')
      return new ChatGPTPlanClient(
        providerId,
        this.chatgptSession(providerId),
        fetch,
        provider.baseUrl,
      );
    return new OpenAICompatibleClient({
      providerId,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey: this.decryptSecret(providerId),
    });
  }

  private decryptSecret(providerId: string): string | null {
    const secret = this.repos.getSecret(providerId);
    try {
      return secret ? safeStorage.decryptString(Buffer.from(secret.ciphertext)) : null;
    } catch {
      // Keys are encrypted with the Windows account; a backup from another one cannot read them.
      const provider = this.repos.providers.require(providerId, 'Provedor');
      throw new HiveError(
        'PROVIDER',
        `Não foi possível ler a credencial de “${provider.name}”. Isso acontece com backups vindos de outro computador ou usuário do Windows. Cadastre-a novamente em Provedores.`,
      );
    }
  }

  /* ------------------------------------------------------------ Sign in with ChatGPT */

  /** Stable, opaque id of this Hive install, required by the ChatGPT registration. */
  private chatgptHostId(): string {
    let hostId = this.repos.getValue('chatgpt.hostId');
    if (!hostId) {
      hostId = `urn:uuid:${randomUUID()}`;
      this.repos.setValue('chatgpt.hostId', hostId);
    }
    return hostId;
  }

  /** The account registration kept across sign-outs, so signing in again reuses it. */
  private chatgptRegistration(providerId: string): ChatGPTRegistration | null {
    const raw = this.repos.getValue(`chatgpt.registration.${providerId}`);
    try {
      return raw ? (JSON.parse(raw) as ChatGPTRegistration) : null;
    } catch {
      return null;
    }
  }

  private chatgptCredentials(providerId: string): ChatGPTCredentials | null {
    const raw = this.decryptSecret(providerId);
    try {
      return raw ? (JSON.parse(raw) as ChatGPTCredentials) : null;
    } catch {
      return null;
    }
  }

  private chatgptSession(providerId: string): ChatGPTSession {
    const cached = this.chatgptSessions.get(providerId);
    if (cached) return cached;
    const credentials = this.chatgptCredentials(providerId);
    if (!credentials)
      throw new HiveError('PROVIDER_AUTH', 'Entre com a sua conta do ChatGPT em Provedores.');
    const session = new ChatGPTSession(credentials, (next) => this.storeChatGPT(providerId, next));
    this.chatgptSessions.set(providerId, session);
    return session;
  }

  /** Saves a token set (encrypted, like an API key), or forgets it when the session ended. */
  private storeChatGPT(providerId: string, credentials: ChatGPTCredentials | null) {
    const provider = this.repos.providers.get(providerId);
    if (!provider) return;
    if (!credentials) {
      this.chatgptSessions.delete(providerId);
      this.repos.deleteSecret(providerId);
      this.repos.providers.put({
        ...provider,
        hasCredential: false,
        credentialHint: null,
        lastTest: null,
      });
      this.changed('provider', providerId);
      return;
    }
    const hint = credentials.email ? `ChatGPT · ${credentials.email}` : 'ChatGPT';
    this.repos.putSecret(providerId, safeStorage.encryptString(JSON.stringify(credentials)), hint);
    if (!provider.hasCredential || provider.credentialHint !== hint) {
      this.repos.providers.put({ ...provider, hasCredential: true, credentialHint: hint });
      this.changed('provider', providerId);
    }
  }

  /** Ends a ChatGPT session; false when OpenAI could not confirm the revocation. */
  private async signOutChatGPT(providerId: string): Promise<boolean> {
    let credentials: ChatGPTCredentials | null = null;
    try {
      credentials = this.chatgptCredentials(providerId);
    } catch {
      // unreadable: nothing to revoke from here
    }
    this.chatgptSessions.delete(providerId);
    return credentials ? revokeChatGPT(credentials) : true;
  }

  private runDetail(id: string): RunDetail {
    const run = this.repos.runs.require(id, 'Execução');
    return {
      run,
      mission: this.repos.missions.require(run.missionId, 'Missão'),
      tasks: this.repos.tasks.list('run_id = ?', id),
      approvals: this.repos.approvals.list('run_id = ?', id),
    };
  }

  private setPlan(runId: string, value: IpcInput<'run.setPlan'>['plan']) {
    const detail = this.runDetail(runId);
    const { plan, errors } = validatePlan(
      value,
      new Set(this.repos.workers.list().map((worker) => worker.id)),
    );
    if (!plan) throw new HiveError('VALIDATION', errors.join('\n'));
    this.repos.transaction(() => {
      for (const task of detail.tasks) this.repos.tasks.delete(task.id);
      for (const { lead, ...task } of plan.tasks) {
        const id = newId('task');
        this.repos.tasks.put({
          ...task,
          // Hive Teams: the Queen made this task's agent the leader of a team.
          ...(lead ? { team: { role: 'lead' as const, leadTaskId: id, requestId: null } } : {}),
          id,
          runId,
          status: 'pending',
          workerState: 'idle',
          attempt: 0,
          branch: null,
          startCommit: null,
          worktreePath: null,
          result: null,
          error: null,
          createdAt: nowIso(),
          startedAt: null,
          finishedAt: null,
        });
      }
      this.repos.runs.put({
        ...detail.run,
        status: 'awaiting_plan_approval',
        planNotes: plan.notes,
        error: null,
      });
    });
    this.changed('run', runId);
    return this.runDetail(runId);
  }

  async invoke(channel: IpcChannel, input: unknown): Promise<unknown> {
    const parse = <C extends IpcChannel>(key: C) =>
      ipcContract[key].input.parse(input) as IpcInput<C>;
    switch (channel) {
      case 'app.info':
        return {
          version: app.getVersion(),
          platform: process.platform,
          electron: process.versions.electron,
          node: process.versions.node,
          dataDir: this.dataDir,
          secretStorage: {
            available: safeStorage.isEncryptionAvailable(),
            backend:
              process.platform === 'linux'
                ? safeStorage.getSelectedStorageBackend()
                : process.platform,
          },
        };
      case 'app.openExternal': {
        const url = new URL(parse(channel));
        if (!['https:', 'http:'].includes(url.protocol))
          throw new HiveError('VALIDATION', 'Use um endereço HTTP ou HTTPS.');
        return shell.openExternal(url.toString());
      }
      case 'settings.get':
        return this.repos.getSettings();
      case 'settings.update': {
        const current = this.repos.getSettings();
        const update = parse(channel);
        const result = this.repos.saveSettings(settingsSchema.parse({ ...current, ...update }));
        this.updater?.setAutomatic(result.updates.auto);
        this.changed('settings');
        return result;
      }
      case 'backup.overview': {
        const dir = backupsDir(this.dataDir);
        return { dir, items: await listBackups(dir) };
      }
      case 'backup.create':
        return this.backup('manual');
      case 'backup.export': {
        const selected = await dialog.showSaveDialog({
          title: 'Exportar backup do Hive',
          defaultPath: path.join(
            app.getPath('documents'),
            backupName('manual').replace('manual', 'hive'),
          ),
          filters: [{ name: 'Backup do Hive', extensions: ['hive-backup'] }],
        });
        if (selected.canceled || !selected.filePath) return null;
        await createBackup(this.database, this.dataDir, selected.filePath, app.getVersion());
        return selected.filePath;
      }
      case 'backup.restore': {
        const { name } = parse(channel);
        let file: string;
        if (name) file = resolveBackup(backupsDir(this.dataDir), name);
        else {
          const selected = await dialog.showOpenDialog({
            title: 'Restaurar backup do Hive',
            properties: ['openFile'],
            filters: [{ name: 'Backup do Hive', extensions: ['hive-backup'] }],
          });
          if (selected.canceled || !selected.filePaths[0]) return false;
          file = selected.filePaths[0];
        }
        const meta = await stageRestore(this.dataDir, file, SCHEMA_VERSION);
        const choice = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Restaurar e reiniciar', 'Cancelar'],
          defaultId: 1,
          cancelId: 1,
          title: 'Restaurar backup',
          message: `Restaurar o backup de ${new Date(meta.createdAt).toLocaleString('pt-BR')}?`,
          detail:
            'Missões, agentes, provedores, configurações, memórias do Nectar e skills voltam ao estado do backup, e o Hive reinicia. Uma cópia dos dados atuais fica guardada em Backups, para desfazer se precisar.\n\nChaves de API só funcionam no mesmo usuário do Windows em que o backup foi feito.',
        });
        if (choice.response !== 0) {
          await cancelRestore(this.dataDir);
          return false;
        }
        setTimeout(() => this.restart?.(), 100);
        return true;
      }
      case 'backup.openFolder': {
        const dir = backupsDir(this.dataDir);
        await mkdir(dir, { recursive: true });
        const failure = await shell.openPath(dir);
        if (failure) throw new HiveError('INTERNAL', failure);
        return;
      }
      case 'update.status':
        return this.updater?.state ?? { status: 'disabled', reason: 'dev' };
      case 'update.check':
        return this.updater ? this.updater.check() : { status: 'disabled', reason: 'dev' };
      case 'update.install':
        return this.updater?.install();
      case 'workspace.list':
        return this.repos.workspaces.list();
      case 'workspace.active':
        return this.active();
      case 'workspace.pick': {
        const selected = await dialog.showOpenDialog({
          title: 'Selecionar pasta do projeto',
          properties: ['openDirectory'],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        const folder = selected.filePaths[0];
        try {
          return { status: 'opened', workspace: await this.openRepository(folder) };
        } catch (error) {
          // A plain folder is offered for initialization instead of failing.
          if (error instanceof HiveError && error.code === 'NOT_A_GIT_REPO')
            return { status: 'needs-init', path: folder, name: path.basename(folder) };
          throw error;
        }
      }
      case 'workspace.initialize':
        return this.initializeRepository(parse(channel).path);
      case 'workspace.activate': {
        const workspace = this.repos.workspaces.require(parse(channel), 'Workspace');
        await inspectRepository(workspace.path);
        this.saveOpenedWorkspaceIds([...this.openedWorkspaceIds(), workspace.id]);
        this.repos.setValue('activeWorkspace', workspace.id);
        this.changed('workspace', workspace.id);
        return workspace;
      }
      case 'workspace.tabs': {
        // Projects from before tabs existed: the focused project opens as the first tab.
        const active = this.active();
        const ids = this.openedWorkspaceIds();
        if (active && !ids.includes(active.id)) this.saveOpenedWorkspaceIds([...ids, active.id]);
        return this.openedWorkspaceIds()
          .map((id) => this.repos.workspaces.get(id))
          .filter((item): item is Workspace => item !== null);
      }
      case 'workspace.close': {
        const id = parse(channel);
        const remaining = this.openedWorkspaceIds().filter((item) => item !== id);
        this.saveOpenedWorkspaceIds(remaining);
        const closed = this.repos.workspaces.get(id);
        this.fileServices.get(id)?.dispose();
        this.fileServices.delete(id);
        if (closed) {
          await this.previewServers.get(closed.path)?.close();
          this.previewServers.delete(closed.path);
        }
        // Running commands of the closed project stop with its tab, and so do its agents' replies.
        this.agentChats.cancelWorkspace(id);
        for (const session of this.terminals.list(id))
          if (session.status === 'running' || session.status === 'stopping')
            this.terminals.stop(session.id);
        if (this.repos.getValue('activeWorkspace') === id)
          this.repos.setValue('activeWorkspace', remaining[0] ?? null);
        this.changed('workspace', id);
        return;
      }
      case 'workspace.remove': {
        const id = parse(channel);
        this.agentChats.cancelWorkspace(id);
        this.repos.workspaces.delete(id);
        if (this.repos.getValue('activeWorkspace') === id)
          this.repos.setValue('activeWorkspace', null);
        this.files.watch();
        this.changed('workspace', id);
        return;
      }
      case 'workspace.status': {
        const workspace = this.repos.workspaces.require(parse(channel), 'Workspace');
        const [repo, changed, worktrees] = await Promise.all([
          inspectRepository(workspace.path),
          statusPorcelain(workspace.path),
          listWorktrees(workspace.path),
        ]);
        return {
          workspace,
          branch: repo.branch,
          head: repo.head,
          clean: changed.length === 0,
          changedFiles: changed.length,
          worktrees,
        };
      }
      case 'provider.list':
        return this.repos.providers.list();
      case 'provider.save': {
        const value = parse(channel);
        const previous = value.id ? this.repos.providers.require(value.id, 'Provedor') : null;
        const result = this.repos.providers.put({
          ...value,
          id: previous?.id ?? newId('provider'),
          hasCredential: previous?.hasCredential ?? false,
          credentialHint: previous?.credentialHint ?? null,
          lastTest: null,
          modelsFetchedAt: null,
          createdAt: previous?.createdAt ?? nowIso(),
        });
        this.repos.deleteModels(result.id);
        this.changed('provider', result.id);
        return result;
      }
      case 'provider.delete': {
        const id = parse(channel);
        if (this.repos.providers.get(id)?.kind === 'chatgpt') {
          await this.signOutChatGPT(id);
          this.repos.setValue(`chatgpt.registration.${id}`, null);
        }
        this.repos.providers.delete(id);
        this.repos.deleteSecret(id);
        this.repos.deleteModels(id);
        this.detachWorkers();
        this.changed('provider', id);
        this.changed('worker');
        return;
      }
      case 'provider.setKey': {
        const { providerId, key } = parse(channel);
        if (!safeStorage.isEncryptionAvailable())
          throw new HiveError(
            'SECRET_STORE',
            'O armazenamento seguro do sistema não está disponível.',
          );
        const provider = this.repos.providers.require(providerId, 'Provedor');
        if (provider.kind === 'chatgpt')
          throw new HiveError('VALIDATION', 'O ChatGPT não usa chave: entre com a sua conta.');
        if (provider.kind === 'claude-code')
          throw new HiveError(
            'VALIDATION',
            'O Claude Code não usa chave: ele usa o login do Claude Code instalado.',
          );
        secretRedactor.register(key);
        const hint = maskSecret(key);
        this.repos.putSecret(providerId, safeStorage.encryptString(key), hint);
        const result = this.repos.providers.put({
          ...provider,
          hasCredential: true,
          credentialHint: hint,
          lastTest: null,
        });
        this.changed('provider', providerId);
        return result;
      }
      case 'provider.clearKey': {
        const id = parse(channel);
        const provider = this.repos.providers.require(id, 'Provedor');
        const revoked = provider.kind === 'chatgpt' ? await this.signOutChatGPT(id) : true;
        this.repos.deleteSecret(id);
        const result = this.repos.providers.put({
          ...provider,
          hasCredential: false,
          credentialHint: null,
          lastTest: revoked
            ? null
            : {
                ok: false,
                message:
                  'Saída não confirmada pela OpenAI. Para garantir, desconecte o Hive nas configurações do ChatGPT.',
                at: nowIso(),
                latencyMs: null,
              },
        });
        this.changed('provider', id);
        return result;
      }
      case 'provider.chatgptSignIn': {
        const id = parse(channel);
        const provider = this.repos.providers.require(id, 'Provedor');
        if (provider.kind !== 'chatgpt')
          throw new HiveError(
            'VALIDATION',
            'Este provedor usa chave de API, não login do ChatGPT.',
          );
        if (!safeStorage.isEncryptionAvailable())
          throw new HiveError(
            'SECRET_STORE',
            'O armazenamento seguro do sistema não está disponível.',
          );
        const credentials = await signInWithChatGPT({
          hostId: this.chatgptHostId(),
          appName: 'Hive',
          registration: this.chatgptRegistration(id),
          openBrowser: (url) => shell.openExternal(url),
        });
        const registration: ChatGPTRegistration = {
          clientId: credentials.clientId,
          sub: credentials.sub,
          email: credentials.email,
        };
        this.repos.setValue(`chatgpt.registration.${id}`, JSON.stringify(registration));
        this.chatgptSessions.delete(id);
        this.storeChatGPT(id, credentials);
        const result = this.repos.providers.put({
          ...this.repos.providers.require(id, 'Provedor'),
          lastTest: null,
        });
        this.changed('provider', id);
        return result;
      }
      case 'provider.models': {
        const { providerId, refresh } = parse(channel);
        if (!refresh) return this.repos.listModels(providerId);
        const models = await this.client(providerId).listModels();
        this.repos.replaceModels(providerId, models);
        this.repos.providers.put({
          ...this.repos.providers.require(providerId, 'Provedor'),
          modelsFetchedAt: nowIso(),
        });
        this.changed('provider', providerId);
        return models;
      }
      case 'mcp.test': {
        const server = parse(channel);
        // Started where agents start it, so relative paths in its arguments resolve the same.
        const workspace = this.active();
        return probeMcpServer(server, workspace?.path ?? app.getPath('home'));
      }
      case 'provider.test': {
        const id = parse(channel);
        let result;
        try {
          const client = this.client(id);
          const test = await client.testConnection();
          result = {
            ok: true,
            message: `${test.modelCount} modelos disponíveis.`,
            at: nowIso(),
            latencyMs: test.latencyMs,
          };
          // Claude Code has no key: the account it is signed in with is the credential.
          if (client instanceof ClaudeCodePlanClient) {
            const account = await client.account();
            this.repos.providers.put({
              ...this.repos.providers.require(id, 'Provedor'),
              hasCredential: true,
              credentialHint: `Claude.ai · ${account.email ?? 'sua conta'}`,
            });
          }
        } catch (error) {
          if (this.repos.providers.get(id)?.kind === 'claude-code')
            this.repos.providers.put({
              ...this.repos.providers.require(id, 'Provedor'),
              hasCredential: false,
              credentialHint: null,
            });
          result = {
            ok: false,
            message: secretRedactor.redact(errorMessage(error)),
            at: nowIso(),
            latencyMs: null,
          };
        }
        this.repos.providers.put({
          ...this.repos.providers.require(id, 'Provedor'),
          lastTest: result,
        });
        this.changed('provider', id);
        return result;
      }
      case 'provider.testModel': {
        const { providerId, modelId } = parse(channel);
        try {
          const test = await this.client(providerId).testModel(modelId);
          return {
            ok: true,
            message: `${modelId} respondeu em ${test.latencyMs} ms.`,
            at: nowIso(),
            latencyMs: test.latencyMs,
          };
        } catch (error) {
          return {
            ok: false,
            message: this.modelFailure(modelId, error),
            at: nowIso(),
            latencyMs: null,
          };
        }
      }
      case 'worker.list':
        return this.repos.workers.list();
      case 'worker.applyRecommended':
        return this.applyRecommended(parse(channel).providerId);
      case 'worker.autoConfigure': {
        const { workerId, providerId } = parse(channel);
        return this.applyRecommended(providerId, [workerId]);
      }
      case 'worker.save': {
        const value = parse(channel);
        const previous = value.id ? this.repos.workers.require(value.id, 'Agente') : null;
        if (value.providerId) this.repos.providers.require(value.providerId, 'Provedor');
        const result = this.repos.workers.put({
          ...value,
          beeColor: value.beeColor ?? null,
          squad: value.squad ?? [],
          mcpServers: value.mcpServers ?? previous?.mcpServers ?? [],
          // A Hive Teams agent stays one when the user edits it.
          ...(previous?.team ? { team: previous.team } : {}),
          id: previous?.id ?? newId('worker'),
          createdAt: previous?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        });
        if (!previous) this.cortex.connectNewWorker(result.id);
        this.changed('worker', result.id);
        return result;
      }
      case 'worker.delete': {
        const id = parse(channel);
        this.repos.workers.delete(id);
        this.changed('worker', id);
        return;
      }
      case 'worker.routes':
        return this.router.plan(this.repos.workers.require(parse(channel), 'Agente'));
      case 'worker.compatibility': {
        const worker = this.repos.workers.require(parse(channel), 'Agente');
        return workerCompatibilityIssues(
          worker,
          worker.providerId ? this.repos.providers.get(worker.providerId) : null,
          worker.providerId && worker.modelId
            ? this.repos.getModel(worker.providerId, worker.modelId)
            : null,
        );
      }
      case 'skill.list':
        return this.skills().list();
      case 'skill.get': {
        const value = parse(channel);
        return this.skills().get(value.name, value.source);
      }
      case 'skill.validate': {
        const value = parse(channel);
        return this.skills().validate(value.name, value.source);
      }
      case 'skill.validateDraft':
        return this.skills().validateDraft(parse(channel));
      case 'skill.saveLocal': {
        const { raw, originalName } = parse(channel);
        const result = await this.skills().saveLocal(raw, originalName);
        // A renamed skill keeps its place on the agents that use it.
        if (originalName && originalName !== result.name) {
          for (const worker of this.repos.workers.list()) {
            if (!worker.skills.includes(originalName)) continue;
            this.repos.workers.put({
              ...worker,
              skills: worker.skills.map((name) => (name === originalName ? result.name : name)),
              updatedAt: nowIso(),
            });
            this.changed('worker', worker.id);
          }
        }
        this.changed('skill');
        return result;
      }
      case 'skill.deleteLocal': {
        const name = parse(channel);
        await this.skills().deleteLocal(name);
        for (const worker of this.repos.workers.list()) {
          if (!worker.skills.includes(name)) continue;
          this.repos.workers.put({
            ...worker,
            skills: worker.skills.filter((skill) => skill !== name),
            updatedAt: nowIso(),
          });
          this.changed('worker', worker.id);
        }
        this.changed('skill');
        return;
      }
      case 'skill.restore': {
        const result = await this.skills().restoreBuiltin(parse(channel));
        this.changed('skill');
        return result;
      }
      case 'skill.install': {
        const result = await this.skills().install(parse(channel));
        this.changed('skill');
        return result;
      }
      case 'skill.pickCatalog': {
        const selected = await dialog.showOpenDialog({
          title: 'Catálogo SkillForge',
          properties: ['openDirectory'],
        });
        if (selected.canceled || !selected.filePaths[0]) return this.repos.getSettings();
        const folder = selected.filePaths[0];
        // A folder of projects instead of skills would list every project as a broken skill.
        if (!(await SkillForgeAdapter.hasSkills(folder)))
          throw new HiveError(
            'VALIDATION',
            'Nenhuma skill nessa pasta. Escolha uma pasta com subpastas que tenham um SKILL.md.',
          );
        const result = this.repos.saveSettings({
          ...this.repos.getSettings(),
          skillforgeCatalogPath: folder,
        });
        this.changed('skill');
        return result;
      }
      case 'mission.list':
        return this.missionList(parse(channel).workspaceId);
      case 'mission.pin': {
        const { id: missionId, pinned } = parse(channel);
        this.setMissionPinned(missionId, pinned);
        return;
      }
      case 'mission.create': {
        const value = parse(channel);
        const workspace = this.active();
        if (!workspace) throw new HiveError('VALIDATION', 'Selecione um repositório primeiro.');
        return this.createMission(workspace, value.title, value.objective);
      }
      case 'mission.get': {
        const id = parse(channel);
        return {
          mission: this.repos.missions.require(id, 'Missão'),
          runs: this.repos.runs.list('mission_id = ?', id),
        };
      }
      case 'run.get':
        return this.runDetail(parse(channel));
      case 'run.setPlan': {
        const value = parse(channel);
        if (this.planning.has(value.runId))
          throw new HiveError('CONFLICT', 'Aguarde o planejamento atual.');
        if (this.repos.runs.require(value.runId, 'Execução').status === 'running')
          throw new HiveError('CONFLICT', 'Cancele a execução antes de alterar o plano.');
        return this.setPlan(value.runId, value.plan);
      }
      case 'run.plan': {
        const { runId, queenWorkerId } = parse(channel);
        return this.planRun(runId, queenWorkerId);
      }
      case 'run.start':
        this.scheduler.start(parse(channel));
        return this.runDetail(parse(channel));
      case 'run.cancel':
        this.scheduler.cancelRun(parse(channel));
        return this.runDetail(parse(channel));
      case 'task.cancel':
        return this.scheduler.cancelTask(parse(channel));
      case 'task.retry':
        return this.scheduler.retry(parse(channel));
      case 'task.boost': {
        const { id: taskId, boosted } = parse(channel);
        const before = this.repos.tasks.get(taskId)?.boosted ?? false;
        const task = this.scheduler.boost(taskId, boosted);
        if (boosted && !before) this.countHoney();
        return task;
      }
      case 'task.revise': {
        const { taskId, comments, note } = parse(channel);
        return this.scheduler.revise(taskId, comments, note);
      }
      case 'task.approve':
        return this.scheduler.approve(parse(channel));
      case 'task.reject':
        return this.scheduler.reject(parse(channel));
      case 'task.diff': {
        const id = parse(channel);
        const task = this.repos.tasks.require(id, 'Tarefa');
        const { base, result } = await this.scheduler.diff(id);
        return {
          taskId: id,
          branch: task.branch,
          base,
          files: result?.files ?? [],
          patch: result?.patch ?? '',
          truncated: result?.truncated ?? false,
        };
      }
      case 'task.list': {
        const { runId } = parse(channel);
        return (runId ? this.repos.tasks.list('run_id = ?', runId) : this.repos.tasks.list()).map(
          (task) => ({
            ...task,
            missionTitle:
              this.repos.missions.get(this.repos.runs.get(task.runId)?.missionId ?? '')?.title ??
              '',
          }),
        );
      }
      case 'approval.resolve': {
        const { approvalId, approve, remember } = parse(channel);
        return this.scheduler.resolveApproval(approvalId, approve, remember);
      }
      case 'approval.pending':
        return this.repos.approvals.list("status = 'pending'");
      case 'events.query':
        return this.repos.queryEvents(parse(channel));
      case 'fs.list':
        return this.files.list(parse(channel).path);
      case 'fs.files':
        return this.files.files();
      case 'design.locate': {
        const workspace = this.active();
        if (!workspace) throw new HiveError('VALIDATION', 'Selecione um projeto primeiro.');
        return locateElement(workspace.path, parse(channel));
      }
      case 'design.capture':
        return this.capturePage ? this.capturePage(parse(channel)) : null;
      case 'fs.search': {
        const { query, ...options } = parse(channel);
        return this.files.search(query, options);
      }
      case 'preview.serve': {
        const workspace = this.active();
        if (!workspace)
          throw new HiveError('VALIDATION', 'Selecione um projeto antes de abrir uma página.');
        const { path: relative } = parse(channel);
        if (!/\.html?$/i.test(relative))
          throw new HiveError('VALIDATION', 'Escolha um arquivo .html para abrir no preview.');
        await this.files.absolute(relative);
        const server = await this.servePreview(workspace.path);
        const encoded = relative.split('/').map(encodeURIComponent).join('/');
        return { url: `${server.origin}/${encoded}` };
      }
      case 'fs.read':
        return this.files.read(parse(channel).path);
      case 'fs.image':
        return this.files.image(parse(channel).path);
      case 'fs.write': {
        const value = parse(channel);
        return this.files.write(value.path, value.content, value.expectedMtimeMs);
      }
      case 'fs.create': {
        const value = parse(channel);
        return this.files.create(value.path, value.kind);
      }
      case 'fs.rename': {
        const value = parse(channel);
        return this.files.rename(value.from, value.to);
      }
      case 'fs.trash':
        // The recycle bin keeps deletions recoverable.
        return shell.trashItem(await this.files.absolute(parse(channel).path));
      case 'git.status':
        return this.files.gitStatus();
      case 'git.fileDiff':
        return this.files.workingDiff(parse(channel).path);
      case 'git.branches':
        return this.files.branches();
      case 'git.checkout':
        await this.files.checkout(parse(channel));
        this.changed('workspace', this.active()?.id ?? null);
        return;
      case 'task.fileDiff': {
        const { taskId, path: file } = parse(channel);
        const task = this.repos.tasks.require(taskId, 'Tarefa');
        if (!task.startCommit || !task.result?.commit)
          throw new HiveError('VALIDATION', 'Esta tarefa não tem alterações.');
        const run = this.repos.runs.require(task.runId, 'Execução');
        const workspace = this.repos.workspaces.require(run.workspaceId, 'Workspace');
        return this.files.commitDiff(workspace.path, task.startCommit, task.result.commit, file);
      }
      case 'terminal.list': {
        const workspace = this.active();
        return workspace ? this.terminals.list(workspace.id) : [];
      }
      case 'terminal.start': {
        const workspace = this.active();
        if (!workspace)
          throw new HiveError('VALIDATION', 'Selecione um projeto antes de executar.');
        const value = parse(channel);
        return this.terminals.start(
          workspace.id,
          workspace.path,
          value.command,
          value.cwd,
          value.cols && value.rows ? { cols: value.cols, rows: value.rows } : undefined,
        );
      }
      case 'terminal.input': {
        const { id: terminalId, data } = parse(channel);
        return this.terminals.write(terminalId, data);
      }
      case 'terminal.resize': {
        const { id: terminalId, cols, rows } = parse(channel);
        return this.terminals.resize(terminalId, cols, rows);
      }
      case 'terminal.stop':
        return this.terminals.stop(parse(channel));
      case 'terminal.clear':
        return this.terminals.clear(parse(channel));
      case 'agentChat.list': {
        const { workspaceId, workerId } = parse(channel);
        return this.agentChats.list(workspaceId, workerId);
      }
      case 'agentChat.create': {
        const { workspaceId, workerId } = parse(channel);
        return this.agentChats.create(workspaceId, workerId);
      }
      case 'agentChat.delete':
        return this.agentChats.delete(parse(channel));
      case 'agentChat.messages': {
        const { chatId, before, limit } = parse(channel);
        return this.agentChats.messages(chatId, limit, before);
      }
      case 'agentChat.state':
        return this.agentChats.state(parse(channel));
      case 'agentChat.send': {
        const { chatId, text, mode } = parse(channel);
        return this.agentChats.send(chatId, text, mode);
      }
      case 'agentChat.cancel':
        return this.agentChats.cancel(parse(channel));
      case 'agentChat.approve': {
        const { chatId, approvalId, answer } = parse(channel);
        return this.agentChats.approve(chatId, approvalId, answer);
      }
      case 'code.assist': {
        const value = parse(channel);
        if (!this.active())
          throw new HiveError('VALIDATION', 'Selecione um projeto antes de usar a IA no código.');
        await this.files.absolute(value.path);
        const worker = this.repos.workers.require(value.workerId, 'Agente');
        if (!worker.providerId || !worker.modelId)
          throw new HiveError('VALIDATION', 'Configure o provedor e o modelo deste agente.');
        return assistCode(
          this.chatClient(worker.providerId),
          { ...worker, providerId: worker.providerId, modelId: worker.modelId },
          value,
        );
      }
      case 'dashboard.summary': {
        const workspace = this.active();
        const recentMissions = this.missionList(workspace?.id ?? null).slice(0, 8);
        const runs = workspace ? this.repos.runs.list('workspace_id = ?', workspace.id) : [];
        const summary: DashboardSummary = {
          workspace,
          recentMissions,
          activeTasks: runs
            .flatMap((run) => this.repos.tasks.list('run_id = ?', run.id))
            .filter((task) => task.status === 'running' || task.status === 'waiting_approval')
            .map((task) => ({
              ...task,
              workerName: this.repos.workers.get(task.workerId ?? '')?.name ?? null,
            })),
          activeChats: [
            ...(this.terminalAgents?.activeChats() ?? []),
            ...this.agentChats.activeChats(),
          ],
          pendingApprovals: this.repos.approvals.list("status = 'pending'"),
          providers: this.repos.providers.list(),
          recentRuns: runs.slice(0, 8).map((run) => ({
            ...run,
            missionTitle: this.repos.missions.get(run.missionId)?.title ?? run.missionId,
          })),
          workers: this.repos.workers.list().length,
          usage: this.repos.usageTotals(workspace?.id ?? null),
          today: {
            ...this.repos.usageSince(startOfToday()),
            budget: this.repos.getSettings().dailyTokenBudget,
          },
          honey: this.honey(),
        };
        return summary;
      }
      case 'window.openCanvas':
        if (!this.openCanvas)
          throw new HiveError('VALIDATION', 'O Workspace não está disponível agora.');
        return this.openCanvas();
      case 'window.addProvider':
        return this.addProvider?.();
      case 'window.showRun': {
        const runId = parse(channel);
        this.repos.runs.require(runId, 'Execução');
        return this.showRun?.(runId);
      }
      case 'canvas.runs':
        return canvasRuns(this.repos);
      case 'canvas.queen.propose':
        return this.canvasQueen.propose(ipcContract['canvas.queen.propose'].input.parse(input));
      case 'canvas.queen.apply': {
        const { runId, proposalId } = parse(channel);
        return this.canvasQueen.apply(runId, proposalId);
      }
      case 'canvas.queen.cancel': {
        const { runId, proposalId } = parse(channel);
        this.canvasQueen.cancel(runId, proposalId);
        return;
      }
      case 'canvas.autopilot.current':
        return this.nexusAutopilot.list(parse(channel));
      case 'canvas.autopilot.propose':
        return this.nexusAutopilot.propose(
          ipcContract['canvas.autopilot.propose'].input.parse(input),
        );
      case 'canvas.autopilot.revise': {
        const { runId, planId, draft, changeSummary } = parse(channel);
        return this.nexusAutopilot.revise(runId, planId, draft, changeSummary);
      }
      case 'canvas.autopilot.apply': {
        const { runId, planId, start } = parse(channel);
        const applied = await this.nexusAutopilot.apply(runId, planId, start);
        await this.scaffoldFlow(runId);
        return applied;
      }
      case 'canvas.autopilot.recovery.apply': {
        const { runId, recoveryId } = parse(channel);
        return this.nexusAutopilot.applyRecovery(runId, recoveryId);
      }
      case 'canvas.autopilot.recovery.dismiss': {
        const { runId, recoveryId } = parse(channel);
        return this.nexusAutopilot.dismissRecovery(runId, recoveryId);
      }
      case 'canvas.autopilot.recovery.retry': {
        const { runId, recoveryId } = parse(channel);
        return this.nexusAutopilot.retryRecovery(runId, recoveryId);
      }
      case 'canvas.autopilot.cancel': {
        const { runId, planId } = parse(channel);
        this.nexusAutopilot.cancel(runId, planId);
        return;
      }
      case 'canvas.snapshot': {
        const runId = parse(channel);
        return canvasSnapshot(this.repos, this.runDetail(runId), {
          planning: this.planning.has(runId),
          queue: this.autopilot.queue(),
          terminals: this.canvasTerminalsOf(runId),
          recoveries: this.nexusAutopilot.recoveries(runId),
          flow: this.flow.state(runId),
        });
      }
      case 'usage.today': {
        const since = startOfToday();
        const rows = this.repos.liveUsageSince(since);
        const byWorker = rows
          .map((row) => ({
            workerId: row.workerId,
            name: row.workerId
              ? (this.repos.workers.get(row.workerId)?.name ?? 'Agente removido')
              : 'Outros',
            tokens: row.promptTokens + row.completionTokens,
          }))
          .filter((row) => row.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens);
        return {
          promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
          completionTokens: rows.reduce((sum, row) => sum + row.completionTokens, 0),
          budget: this.repos.getSettings().dailyTokenBudget,
          byWorker,
          since,
        };
      }
      case 'canvas.layout.get': {
        const runId = parse(channel);
        this.repos.runs.require(runId, 'Execução');
        return this.canvasLayout(runId);
      }
      case 'canvas.result.get':
        return this.liveResults.refresh(parse(channel));
      case 'canvas.result.events': {
        const { runId, before, after, limit } = parse(channel);
        return this.repos.resultEvents(runId, { before, after, limit });
      }
      case 'canvas.notes.get':
        return this.repos.getMissionNote(parse(channel));
      case 'canvas.notes.save': {
        const { missionId, text, revision } = parse(channel);
        const note = this.repos.saveMissionNote(missionId, text, revision);
        this.push({ kind: 'changed', entity: 'missionNote', id: missionId });
        return note;
      }
      case 'flow.commands': {
        const run = this.repos.runs.require(parse(channel), 'Execução');
        const workspace = this.repos.workspaces.require(run.workspaceId, 'Projeto');
        return this.flow.commands(workspace.path);
      }
      case 'flow.approve': {
        const { runId, blockId } = parse(channel);
        this.repos.runs.require(runId, 'Execução');
        return this.flow.approveWaiting(runId, blockId);
      }
      case 'flow.trigger': {
        const { runId, blockId } = parse(channel);
        this.repos.runs.require(runId, 'Execução');
        return this.flow.trigger(runId, blockId);
      }
      case 'canvas.layout.save': {
        const { runId, layout } = parse(channel);
        this.repos.runs.require(runId, 'Execução');
        this.repos.setValue(`canvasLayout:${runId}`, JSON.stringify(layout));
        return;
      }
      case 'canvas.workspaces':
        return this.repos.workspaces.list().map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
        }));
      case 'canvas.mission.create': {
        const { workspaceId, title, objective } = parse(channel);
        const workspace = this.repos.workspaces.require(workspaceId, 'Projeto');
        const { mission, runId } = await this.createMission(workspace, title, objective);
        return { missionId: mission.id, runId };
      }
      case 'canvas.task.create': {
        const { runId, task } = parse(channel);
        if (this.planning.has(runId))
          throw new HiveError('CONFLICT', 'Aguarde a Queen terminar o planejamento.');
        return this.scheduler.addTask(runId, task);
      }
      case 'canvas.task.link': {
        const { taskId, dependsOnTaskId, linked } = parse(channel);
        return this.scheduler.setDependency(taskId, dependsOnTaskId, linked);
      }
      case 'canvas.task.assign': {
        const { taskId, workerId } = parse(channel);
        return this.scheduler.assign(taskId, workerId);
      }
      case 'canvas.worker.create': {
        const value = parse(channel);
        if (value.providerId) this.repos.providers.require(value.providerId, 'Provedor');
        const preset = rolePresets[value.role];
        const worker = this.repos.workers.put({
          id: newId('worker'),
          name: value.name,
          role: value.role,
          beeColor: null,
          squad: [],
          description: preset.description,
          providerId: value.providerId,
          modelId: value.providerId ? value.modelId : null,
          skills: [...preset.skills],
          tools: preset.tools,
          autoApproveCommands: [],
          mcpServers: [],
          systemPrompt: preset.systemPrompt,
          limits: { ...this.repos.getSettings().defaultLimits },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        this.cortex.connectNewWorker(worker.id);
        this.changed('worker', worker.id);
        return canvasWorker(this.repos, worker);
      }
      case 'canvas.worker.setModel': {
        const { workerId, providerId, modelId } = parse(channel);
        this.repos.providers.require(providerId, 'Provedor');
        const worker = this.repos.workers.require(workerId, 'Agente');
        const saved = this.repos.workers.put({
          ...worker,
          providerId,
          modelId,
          updatedAt: nowIso(),
        });
        this.changed('worker', saved.id);
        return canvasWorker(this.repos, saved);
      }
      case 'canvas.terminal.open':
        return this.openCanvasTerminal(parse(channel));
      case 'cortex.list':
        return this.cortex.list(parse(channel));
      case 'cortex.create':
        return this.cortex.create(parse(channel));
      case 'cortex.update':
        return this.cortex.update(parse(channel));
      case 'cortex.delete': {
        const { cortexId, purge } = parse(channel);
        return this.cortex.delete(cortexId, purge);
      }
      case 'cortex.connect':
        return this.cortex.connect(parse(channel));
      case 'cortex.disconnect': {
        const { cortexId, workerId } = parse(channel);
        return this.cortex.disconnect(cortexId, workerId);
      }
      case 'cortex.permissions': {
        const { cortexId, workerId, permissions } = parse(channel);
        return this.cortex.setPermissions(cortexId, workerId, permissions);
      }
      case 'cortex.memories':
        return this.cortex.memories(parse(channel));
      case 'cortex.memory':
        return this.cortex.memory(parse(channel));
      case 'cortex.memory.create':
        return this.cortex.createMemory(parse(channel));
      case 'cortex.memory.edit':
        return this.cortex.editMemory(parse(channel));
      case 'cortex.memory.revoke':
        return this.cortex.revokeMemory(parse(channel));
      case 'cortex.proposals': {
        const { cortexId, status } = parse(channel);
        return this.cortex.proposals(cortexId, status);
      }
      case 'cortex.proposal.resolve':
        return this.cortex.resolve(parse(channel));
      case 'cortex.proposal.assess':
        return this.cortex.assess(parse(channel).proposalId);
      case 'cortex.activity':
        return this.cortex.activity(parse(channel));
      case 'cortex.search': {
        const { cortexId, query } = parse(channel);
        return this.cortex.search(cortexId, query);
      }
      case 'autopilot.status':
        return this.autopilotStatus();
      case 'autopilot.setEnabled': {
        const settings = this.repos.getSettings();
        this.repos.saveSettings({
          ...settings,
          autopilot: { ...settings.autopilot, enabled: parse(channel) },
        });
        this.changed('settings');
        this.changed('autopilot');
        return this.autopilotStatus();
      }
      case 'autopilot.enqueue':
        this.autopilot.enqueue(parse(channel));
        return this.autopilotStatus();
      case 'autopilot.dequeue':
        this.autopilot.dequeue(parse(channel));
        return this.autopilotStatus();
      case 'autopilot.move': {
        const { runId, offset } = parse(channel);
        this.autopilot.move(runId, offset);
        return this.autopilotStatus();
      }
      default:
        throw new HiveError(
          'VALIDATION',
          `O recurso ${channel} ainda não foi implementado nesta versão.`,
        );
    }
  }

  /** The stored layout of a run's canvas; a damaged one starts over rather than failing. */
  private canvasLayout(runId: string): CanvasLayout {
    try {
      const parsed = canvasLayoutSchema.safeParse(
        JSON.parse(this.repos.getValue(`canvasLayout:${runId}`) ?? 'null'),
      );
      return parsed.success ? parsed.data : emptyCanvasLayout;
    } catch {
      return emptyCanvasLayout;
    }
  }

  /**
   * A terminal next to an agent on the canvas. A shell opens in the worktree of the task the
   * agent is on (so the user sees the same files), or in the project folder; a conversation runs
   * the `agents` command, opened on that agent, which works in the project like in any terminal.
   */
  private async openCanvasTerminal(
    value: IpcInput<'canvas.terminal.open'>,
  ): Promise<CanvasTerminal> {
    const run = this.repos.runs.require(value.runId, 'Execução');
    const workspace = this.repos.workspaces.require(run.workspaceId, 'Projeto');
    const size = value.cols && value.rows ? { cols: value.cols, rows: value.rows } : undefined;
    if (value.blockId) {
      // A Terminal block: the project folder, with a shell or Claude Code. Claude Code runs
      // under the user's own sign-in, and only the user types into it.
      if (value.kind === 'chat')
        throw new HiveError('VALIDATION', 'Conversas com agentes abrem na janela do agente.');
      if (value.kind === 'claude' && !(await commandExists('claude')))
        throw new HiveError(
          'VALIDATION',
          'O Claude Code não está instalado. Instale com "npm install -g @anthropic-ai/claude-code", rode "claude" uma vez para entrar e abra de novo.',
        );
      const session = await this.terminals.start(
        workspace.id,
        workspace.path,
        value.kind === 'claude' ? 'claude' : '',
        '.',
        size,
      );
      const entry = {
        runId: run.id,
        workerId: null,
        blockId: value.blockId,
        kind: value.kind,
        taskId: null,
      };
      this.canvasTerminals.set(session.id, entry);
      return { session, ...entry };
    }
    if (!value.workerId) throw new HiveError('VALIDATION', 'Escolha o agente do terminal.');
    if (value.kind === 'claude')
      throw new HiveError('VALIDATION', 'O Claude Code abre num bloco Terminal.');
    const worker = this.repos.workers.require(value.workerId, 'Agente');
    if (value.kind === 'chat' && (!worker.providerId || !worker.modelId))
      throw new HiveError('VALIDATION', `${worker.name} ainda não tem provedor e modelo.`);
    if (value.kind === 'chat' && !this.control)
      throw new HiveError('VALIDATION', 'A conversa no terminal não está disponível agora.');
    const live = this.repos.tasks
      .list('run_id = ?', run.id)
      .find(
        (task) =>
          task.workerId === worker.id &&
          ['running', 'waiting_approval'].includes(task.status) &&
          !!task.worktreePath,
      );
    const inWorktree = value.kind === 'shell' && live?.worktreePath ? live : null;
    const session = await this.terminals.start(
      workspace.id,
      inWorktree?.worktreePath ?? workspace.path,
      value.kind === 'chat' ? 'agents' : '',
      '.',
      size,
    );
    const entry = {
      runId: run.id,
      workerId: worker.id,
      blockId: null,
      kind: value.kind,
      taskId: inWorktree?.id ?? null,
    };
    this.canvasTerminals.set(session.id, entry);
    return { session, ...entry };
  }

  private canvasTerminalsOf(runId: string): CanvasTerminal[] {
    const result: CanvasTerminal[] = [];
    for (const [sessionId, entry] of this.canvasTerminals) {
      const session = this.terminals.get(sessionId);
      if (!session) {
        this.canvasTerminals.delete(sessionId);
        continue;
      }
      if (entry.runId === runId)
        result.push({
          session,
          workerId: entry.workerId,
          blockId: entry.blockId,
          kind: entry.kind,
          taskId: entry.taskId,
        });
    }
    return result;
  }

  /** True for a terminal the Nexus opened (and that still exists). */
  isCanvasTerminal(sessionId: string): boolean {
    return this.canvasTerminals.has(sessionId) && !!this.terminals.get(sessionId);
  }

  /** A mission with its first run, from the project's current branch and commit. */
  private async createMission(workspace: Workspace, title: string, objective: string) {
    const repo = await inspectRepository(workspace.path);
    if (!repo.head)
      throw new HiveError(
        'GIT',
        'Crie o primeiro commit do repositório antes de criar uma missão.',
      );
    const mission = {
      title,
      objective,
      id: newId('mission'),
      workspaceId: workspace.id,
      createdAt: nowIso(),
    };
    const run = {
      id: newId('run'),
      missionId: mission.id,
      workspaceId: workspace.id,
      status: 'draft' as const,
      baseBranch: repo.branch ?? workspace.defaultBranch,
      baseCommit: repo.head,
      queenWorkerId: null,
      planNotes: null,
      report: null,
      error: null,
      createdAt: nowIso(),
      finishedAt: null,
    };
    this.repos.transaction(() => {
      this.repos.missions.put(mission);
      this.repos.runs.put(run);
    });
    this.changed('mission', mission.id);
    return { mission, runs: [run], runId: run.id };
  }

  /** Agents pointing at a removed provider would keep a model they can no longer call. */
  private detachWorkers() {
    const providers = new Set(this.repos.providers.list().map((provider) => provider.id));
    for (const worker of this.repos.workers.list())
      if (worker.providerId && !providers.has(worker.providerId))
        this.repos.workers.put({ ...worker, providerId: null, modelId: null, updatedAt: nowIso() });
  }

  /** Provider errors explained for the user; a 404 almost always means a retired model. */
  private modelFailure(modelId: string, error: unknown) {
    const detail = secretRedactor.redact(errorMessage(error));
    if (!detail.includes('(404)')) return detail;
    return `O modelo "${modelId}" não está disponível neste provedor (provavelmente foi descontinuado, mesmo aparecendo na lista). Na aba Agentes, use "Aplicar configuração recomendada" ou escolha outro modelo. Detalhe: ${detail}`;
  }

  /**
   * Assigns a tested model to every agent. Each candidate costs one tiny chat call and
   * results are shared between agents, so a full team usually needs only a few calls.
   */
  private async applyRecommended(
    providerId: string,
    workerIds: string[] | null = null,
  ): Promise<RecommendedSetup> {
    const provider = this.repos.providers.require(providerId, 'Provedor');
    const client = this.client(providerId);
    // Claude Code runs the model set in it: nothing to try, and each try would spend the plan.
    if (provider.kind === 'claude-code') return this.assignClaudeCode(providerId, workerIds);
    let catalog = this.repos.listModels(providerId);
    if (!catalog.length) {
      catalog = await client.listModels();
      this.repos.replaceModels(providerId, catalog);
      this.repos.providers.put({ ...provider, modelsFetchedAt: nowIso() });
    }
    const ids = catalog.map((model) => model.id);
    const free = catalog
      .filter(
        (model) =>
          model.pricing?.inputPerMTok === 0 &&
          model.pricing.outputPerMTok === 0 &&
          model.capabilities.tools !== 'no',
      )
      .map((model) => model.id);
    const tested = new Map<string, Promise<string | null>>();
    const works = (modelId: string) => {
      if (!tested.has(modelId))
        tested.set(
          modelId,
          client.testModel(modelId).then(
            () => null,
            (error: unknown) => this.modelFailure(modelId, error),
          ),
        );
      return tested.get(modelId)!;
    };
    const result: RecommendedSetup = { assignments: [], unavailable: [] };
    const workers = this.repos.workers
      .list()
      .filter((worker) => !workerIds || workerIds.includes(worker.id));
    if (workerIds && workers.length !== workerIds.length)
      throw new HiveError('NOT_FOUND', 'Agente não encontrado.');
    for (const worker of workers) {
      let modelId: string | null = null;
      for (const candidate of recommendedModelCandidates(provider.kind, worker.role, ids, free)) {
        if ((await works(candidate)) === null) {
          modelId = candidate;
          break;
        }
      }
      // Without a working model the provider is still recorded, so the card shows the problem.
      this.repos.workers.put({ ...worker, providerId, modelId, updatedAt: nowIso() });
      result.assignments.push({ workerId: worker.id, workerName: worker.name, modelId });
    }
    for (const [modelId, outcome] of tested) {
      const message = await outcome;
      if (message) result.unavailable.push({ modelId, message });
    }
    this.changed('worker');
    return result;
  }

  /** Missions of one project, so every open project can show its own list in the sidebar. */
  private missionList(workspaceId: string | null) {
    if (!workspaceId) return [];
    const pinned = new Set(this.pinnedMissionIds());
    const workers = new Map(this.repos.workers.list().map((worker) => [worker.id, worker]));
    const kinds = new Map(
      this.repos.providers.list().map((provider) => [provider.id, provider.kind]),
    );
    return this.repos.missions.list('workspace_id = ?', workspaceId).map((mission) => {
      const run = this.repos.runs.list('mission_id = ?', mission.id)[0];
      // Which providers do the work: those of the agents on the tasks, most-used first.
      const counts = new Map<ProviderKind, number>();
      for (const task of run ? this.repos.tasks.list('run_id = ?', run.id) : []) {
        const providerId = task.workerId ? workers.get(task.workerId)?.providerId : null;
        const kind = providerId ? kinds.get(providerId) : undefined;
        if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      return {
        ...mission,
        lastRunStatus: run?.status ?? null,
        pinned: pinned.has(mission.id),
        providerKinds: [...counts].sort((a, b) => b[1] - a[1]).map(([kind]) => kind),
      };
    });
  }

  /** Pinned missions are kept as ids in settings; ids of deleted missions are ignored. */
  private pinnedMissionIds(): string[] {
    const raw = this.repos.getValue('pinnedMissions');
    if (!raw) return [];
    try {
      const ids: unknown = JSON.parse(raw);
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private setMissionPinned(id: string, pinned: boolean): void {
    this.repos.missions.require(id, 'Missão');
    const ids = this.pinnedMissionIds().filter((item) => item !== id);
    this.repos.setValue('pinnedMissions', JSON.stringify(pinned ? [...ids, id] : ids));
    this.changed('mission', id);
  }
}

/** A model change as the task log tells it. */
function describeSwitch(change: RouteSwitch): string {
  if (change.restored)
    return `De volta ao modelo principal: ${change.to.providerName} · ${change.to.model}.`;
  return `${change.from.providerName} · ${change.from.model}: ${change.reason}. Seguindo com ${change.to.providerName} · ${change.to.model}, sem esperar.`;
}

function switchData(change: RouteSwitch): Record<string, unknown> {
  return {
    failover: true,
    from: { providerId: change.from.providerId, model: change.from.model },
    to: { providerId: change.to.providerId, model: change.to.model },
    reason: change.reason,
    restored: change.restored,
  };
}

/** Whether a command is on the PATH (`where` on Windows, `which` elsewhere). */
function commandExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'where' : 'which',
      [name],
      { timeout: 5_000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}
