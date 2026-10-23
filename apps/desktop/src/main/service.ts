import { app, dialog, safeStorage, shell } from 'electron';
import { stat } from 'node:fs/promises';
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
  type DashboardSummary,
  type ExecutionLimits,
  type RecommendedSetup,
  type HivePush,
  type IpcChannel,
  type IpcInput,
  type RunDetail,
  type WorkerRole,
  type Workspace,
} from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import {
  GatedClient,
  OpenAICompatibleClient,
  ProviderGate,
  workerCompatibilityIssues,
  type ChatClient,
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
  Scheduler,
  planMission,
  validatePlan,
  type AutopilotHistoryItem,
} from '@hive/orchestrator';
import { NativeAgentRuntime, type AgentRuntime } from '@hive/agents';
import { SkillForgeAdapter, builtinSkillNames } from '@hive/skills';
import { FileService } from './files';
import { TerminalManager } from './terminal';
import { TerminalAgents } from './terminal-agents';
import { HiveTerminalApp } from './terminal-ui';
import { startControlServer, writeCommandShims, type ControlServer } from './control-server';
import { assistCode } from './code-assistant';
import { describeProject } from './project-context';
import { startStaticServer, type StaticServer } from './static-server';
import { locateElement } from './locate';

/** Local midnight as an ISO time: "today" for the token meter is the user's calendar day. */
function startOfToday(): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

export class DesktopService {
  readonly repos: Repositories;
  readonly scheduler: Scheduler;
  readonly autopilot: Autopilot;
  readonly terminals: TerminalManager;
  /** Set by the app shell to notify the user when the shift finishes a mission. */
  onShiftFinished?: (item: AutopilotHistoryItem) => void;
  /** Set by the app shell: a PNG data URL of part of the window, for Design Mode notes. */
  capturePage?: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<string | null>;
  private readonly planning = new Set<string>();
  /** One per provider, shared by everything that calls it. */
  private readonly gates = new Map<string, ProviderGate>();
  private shiftTimer: ReturnType<typeof setTimeout> | undefined;
  // Each open project keeps its own watcher and preview server, so switching tabs loses nothing.
  private readonly fileServices = new Map<string, FileService>();
  private readonly previewServers = new Map<string, StaticServer>();
  private control: ControlServer | null = null;
  private terminalAgents: TerminalAgents | null = null;

  constructor(
    database: HiveDatabase,
    private readonly dataDir: string,
    private readonly push: (push: HivePush) => void,
    runtime: AgentRuntime = new NativeAgentRuntime(),
  ) {
    this.repos = new Repositories(database);
    this.scheduler = new Scheduler({
      repos: this.repos,
      runtime,
      chatFor: (providerId) => this.chatClient(providerId),
      resolveSkills: (names) => this.skills().resolve(names),
      // Outside the user's repository, on the same drive as Hive's data.
      worktreeRoot: (workspace) => path.join(this.dataDir, 'worktrees', workspace.id),
      onEvent: (event) => this.push({ kind: 'event', event }),
      onChange: (entity, id) => this.changed(entity, id),
      unattended: (runId) => this.autopilot.isUnattended(runId),
    });
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
    // A process interruption must not leave a plan marked as running indefinitely.
    for (const run of this.repos.runs.list()) {
      if (run.status === 'planning')
        this.repos.runs.put({
          ...run,
          status: 'failed',
          error: 'O aplicativo fechou durante o planejamento. Gere o plano novamente.',
        });
    }
    this.scheduler.recover();
    this.terminals = new TerminalManager((event) => this.push({ kind: 'terminal', event }));
    // A shift that was on when Hive closed picks its queue back up.
    this.advanceShift();
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
  }

  /**
   * Gives Hive's terminals the `agents` and `hive` commands: a local endpoint they call, and
   * the command scripts on their PATH. Terminals opened before this keep working without them.
   */
  async enableTerminalCommands(): Promise<void> {
    const agents = new TerminalAgents({
      repos: this.repos,
      chatFor: (providerId) => this.chatClient(providerId),
      resolveSkills: async (names) => (await this.skills().resolve(names)).skills,
      onWorkerChanged: (id) => this.changed('worker', id),
      onChange: () => this.changed('chat'),
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
      app.start(command === 'hive' && argument !== 'agents' ? 'help' : 'agents');
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

  dispose(): void {
    clearTimeout(this.shiftTimer);
    this.shiftTimer = undefined;
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
      const result = await planMission({
        title: mission.title,
        objective: mission.objective,
        workers: this.repos.workers.list(),
        projectContext: await describeProject(workspace.path, {
          name: workspace.name,
          branch: run.baseBranch,
        }),
        queen,
        skills: (await this.skills().resolve(queen.skills)).skills,
        model: queen.modelId,
        chat: this.chatClient(queen.providerId),
        signal: AbortSignal.timeout(180_000),
      });
      return this.setPlan(runId, result.plan);
    } catch (error) {
      const failure = this.modelFailure(queen.modelId, error);
      this.repos.runs.put({ ...run, queenWorkerId, status: 'failed', error: failure });
      this.changed('run', runId);
      throw error instanceof HiveError ? new HiveError(error.code, failure) : error;
    } finally {
      this.planning.delete(runId);
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

  private client(providerId: string) {
    const provider = this.repos.providers.require(providerId, 'Provedor');
    if (!provider.enabled) throw new HiveError('PROVIDER', 'O provedor está desativado.');
    const secret = this.repos.getSecret(providerId);
    const apiKey = secret ? safeStorage.decryptString(Buffer.from(secret.ciphertext)) : null;
    return new OpenAICompatibleClient({
      providerId,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey,
    });
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
      for (const task of plan.tasks)
        this.repos.tasks.put({
          ...task,
          id: newId('task'),
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
        const result = this.repos.saveSettings({ ...this.repos.getSettings(), ...parse(channel) });
        this.changed('settings');
        return result;
      }
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
        // Running commands of the closed project stop with its tab.
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
        this.repos.deleteSecret(id);
        const result = this.repos.providers.put({
          ...provider,
          hasCredential: false,
          credentialHint: null,
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
      case 'provider.test': {
        const id = parse(channel);
        let result;
        try {
          const test = await this.client(id).testConnection();
          result = {
            ok: true,
            message: `${test.modelCount} modelos disponíveis.`,
            at: nowIso(),
            latencyMs: test.latencyMs,
          };
        } catch (error) {
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
          id: previous?.id ?? newId('worker'),
          createdAt: previous?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        });
        this.changed('worker', result.id);
        return result;
      }
      case 'worker.delete': {
        const id = parse(channel);
        this.repos.workers.delete(id);
        this.changed('worker', id);
        return;
      }
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
        const repo = await inspectRepository(workspace.path);
        if (!repo.head)
          throw new HiveError(
            'GIT',
            'Crie o primeiro commit do repositório antes de criar uma missão.',
          );
        const mission = {
          ...value,
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
          activeChats: this.terminalAgents?.activeChats() ?? [],
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
    return this.repos.missions.list('workspace_id = ?', workspaceId).map((mission) => ({
      ...mission,
      lastRunStatus: this.repos.runs.list('mission_id = ?', mission.id)[0]?.status ?? null,
      pinned: pinned.has(mission.id),
    }));
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
