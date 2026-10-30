import type { CanvasQueenRequest, CanvasSnapshot } from '@hive/core';

export type CommandCategory = 'Criar' | 'Cortex' | 'Workspace' | 'Execução' | 'Queen AI';
export type CommandIcon =
  | 'agent'
  | 'task'
  | 'note'
  | 'group'
  | 'result'
  | 'view'
  | 'search'
  | 'zoom'
  | 'logs'
  | 'mission'
  | 'play'
  | 'queen'
  | 'pin'
  | 'cortex';
export type PaletteOperation =
  | 'new-mission'
  | 'new-agent'
  | 'new-task'
  | 'new-note'
  | 'new-group'
  | 'result'
  | 'fit'
  | 'center'
  | 'zoom-in'
  | 'zoom-out'
  | 'organize'
  | 'workspace'
  | 'agent'
  | 'none'
  | 'inspect'
  | 'logs'
  | 'resume'
  | 'pin'
  | 'group-selection'
  | 'new-cortex'
  | 'blocks';
export interface CommandContext {
  snapshot: CanvasSnapshot | null;
  ready: boolean;
  selectedNodeIds: string[];
  pinnableSelection?: boolean;
  groupableSelection?: boolean;
  perform: (operation: PaletteOperation) => void | Promise<void>;
  reveal: (nodeId: string) => void;
  find: (kind: 'agent' | 'task') => void;
  ask: (mode: CanvasQueenRequest['mode'], instruction?: string) => void;
  autopilot: () => void;
}
export interface Command<C> {
  id: string;
  title: string;
  description: string;
  category: CommandCategory;
  icon: CommandIcon;
  keywords: string[];
  shortcut?: string;
  keepOpen?: boolean;
  entity?: 'agent' | 'task' | 'block' | 'mission';
  availability: (context: C) => true | string;
  execute: (context: C) => void | Promise<void>;
}
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
export const commandCategories: CommandCategory[] = [
  'Criar',
  'Cortex',
  'Workspace',
  'Execução',
  'Queen AI',
];

/** Independent of React and extensible: registering a command does not change the palette UI. */
export class CommandRegistry<C> {
  private readonly entries = new Map<
    string,
    { command: Command<C>; title: string; text: string }
  >();
  register(command: Command<C>): this {
    if (this.entries.has(command.id)) throw new Error(`Comando duplicado: ${command.id}`);
    this.entries.set(command.id, {
      command,
      title: normalize(command.title),
      text: normalize([command.title, command.description, ...command.keywords].join(' ')),
    });
    return this;
  }
  search(query: string, context: C, scope: 'all' | 'agent' | 'task' = 'all', limit = 60) {
    const needle = normalize(query.trim());
    const words = needle.split(/\s+/).filter(Boolean);
    const matches = [];
    for (const { command, title, text } of this.entries.values()) {
      if (!needle && scope === 'all' && command.entity) continue;
      if (scope !== 'all' && command.entity !== scope) continue;
      if (words.length && !words.every((word) => text.includes(word))) continue;
      matches.push({
        command,
        available: command.availability(context),
        score: title === needle ? 0 : title.startsWith(needle) ? 1 : 2,
      });
    }
    return matches
      .sort(
        (a, b) =>
          commandCategories.indexOf(a.command.category) -
            commandCategories.indexOf(b.command.category) || a.score - b.score,
      )
      .slice(0, limit);
  }
}

const ready = (context: CommandContext) =>
  (!!context.snapshot && context.ready) || 'Selecione uma missão e aguarde o layout ser carregado.';
export const queenAvailable = (context: CommandContext): true | string =>
  ready(context) !== true
    ? ready(context)
    : !!context.snapshot?.workers.some(
        (worker) => worker.role === 'queen' && worker.providerId && worker.modelId,
      ) || 'Configure provedor e modelo da Queen na aba Agentes.';
const taskAvailable = (context: CommandContext) =>
  ready(context) !== true
    ? ready(context)
    : (!!context.snapshot &&
        !context.snapshot.planning &&
        ['awaiting_plan_approval', 'running', 'review', 'failed', 'cancelled'].includes(
          context.snapshot.detail.run.status,
        )) ||
      'A missão não aceita novas tarefas neste estado.';

export function registerCanvasCommands(registry: CommandRegistry<CommandContext>) {
  const command = (
    id: string,
    title: string,
    description: string,
    category: CommandCategory,
    icon: CommandIcon,
    operation: PaletteOperation,
    keywords: string[] = [],
    shortcut?: string,
    availability: Command<CommandContext>['availability'] = ready,
  ) =>
    registry.register({
      id,
      title,
      description,
      category,
      icon,
      keywords,
      shortcut,
      availability,
      execute: (context) => context.perform(operation),
    });
  command(
    'create.mission',
    'Nova missão',
    'Abrir o fluxo de criação de missão.',
    'Criar',
    'mission',
    'new-mission',
    ['criar', 'projeto'],
    undefined,
    () => true,
  );
  command(
    'create.agent',
    'Novo agente',
    'Adicionar ou configurar um agente real no Canvas.',
    'Criar',
    'agent',
    'new-agent',
    ['criar', 'adicionar', 'equipe'],
  );
  command(
    'create.task',
    'Nova tarefa',
    'Abrir o formulário da missão atual.',
    'Criar',
    'task',
    'new-task',
    ['criar', 'adicionar'],
    undefined,
    taskAvailable,
  );
  command(
    'create.note',
    'Nova nota',
    'Criar nota espacial no centro visível.',
    'Criar',
    'note',
    'new-note',
    ['criar', 'escrever', 'markdown'],
    'N',
  );
  command(
    'create.group',
    'Novo grupo',
    'Criar um quadro no centro visível.',
    'Criar',
    'group',
    'new-group',
    ['criar', 'frame'],
  );
  command(
    'create.result',
    'Abrir Resultado Vivo',
    'A missão já tem um bloco; abrir seu relatório e notas.',
    'Criar',
    'result',
    'result',
    ['novo bloco resultado', 'documentar', 'relatório'],
  );
  command(
    'cortex.new',
    'Cortex — Shared Memory',
    'Adicionar um bloco de memória compartilhada e persistente do projeto.',
    'Cortex',
    'cortex',
    'new-cortex',
    ['criar', 'memória', 'memory', 'bloco', 'cérebro', 'conhecimento', 'decisões'],
  );
  command(
    'blocks.open',
    'Abrir menu de blocos',
    'Arrastar notas, grupos e Cortex para o canvas.',
    'Criar',
    'note',
    'blocks',
    ['blocos', 'adicionar', 'arrastar', 'cortex'],
  );
  command(
    'view.center',
    'Centralizar visualização',
    'Encontrar o trabalho em andamento.',
    'Workspace',
    'view',
    'center',
    ['camera', 'agentes'],
  );
  command(
    'view.fit',
    'Ajustar à tela',
    'Enquadrar os elementos do Canvas.',
    'Workspace',
    'zoom',
    'fit',
    ['zoom', 'centralizar'],
    'F',
  );
  command(
    'view.zoom-in',
    'Aproximar zoom',
    'Aumentar a escala do Canvas.',
    'Workspace',
    'zoom',
    'zoom-in',
  );
  command(
    'view.zoom-out',
    'Afastar zoom',
    'Reduzir a escala do Canvas.',
    'Workspace',
    'zoom',
    'zoom-out',
  );
  command(
    'view.organize',
    'Organizar automaticamente',
    'Reorganizar preservando as posições fixadas.',
    'Workspace',
    'group',
    'organize',
    ['layout', 'arrumar', 'reorganizar'],
  );
  for (const [operation, label, description] of [
    ['workspace', 'Workspace', 'Janelas dos agentes e tarefas.'],
    ['agent', 'Agentes', 'Agrupar tarefas por agente.'],
    ['none', 'Fluxo', 'Exibir dependências entre tarefas.'],
  ] as const)
    command(
      `view.${operation}`,
      `Alternar para ${label}`,
      description,
      'Workspace',
      'view',
      operation,
      ['modo', 'visualização'],
    );
  for (const [kind, title] of [
    ['agent', 'Encontrar agente'],
    ['task', 'Encontrar tarefa'],
  ] as const)
    registry.register({
      id: `find.${kind}`,
      title,
      description: 'Pesquisar e centralizar um elemento real.',
      category: 'Workspace',
      icon: 'search',
      keywords: ['buscar', 'localizar'],
      keepOpen: true,
      availability: ready,
      execute: (context) => context.find(kind),
    });
  command(
    'selection.pin',
    'Fixar ou desafixar seleção',
    'Preservar posições durante a organização.',
    'Workspace',
    'pin',
    'pin',
    ['posição', 'travar'],
    'P',
    (context) =>
      (context.pinnableSelection ??
        context.selectedNodeIds.some((id) => /^(agent|task|result|group):/.test(id))) ||
      'Selecione um agente, tarefa ou Resultado Vivo para fixar.',
  );
  command(
    'selection.group',
    'Agrupar seleção',
    'Criar quadro ao redor dos nós selecionados.',
    'Workspace',
    'group',
    'group-selection',
    ['frame', 'grupo'],
    'Ctrl+G',
    (context) =>
      (context.groupableSelection ?? context.selectedNodeIds.length > 0) ||
      'Selecione nós independentes para agrupar.',
  );
  command(
    'mission.inspect',
    'Inspecionar missão',
    'Abrir os detalhes da missão atual.',
    'Execução',
    'mission',
    'inspect',
  );
  command('mission.logs', 'Abrir logs', 'Exibir Live Logs do motor.', 'Execução', 'logs', 'logs');
  command(
    'mission.result',
    'Abrir resultados',
    'Relatório automático e Minhas Notas.',
    'Execução',
    'result',
    'result',
    ['resultado vivo', 'relatório'],
  );
  command(
    'mission.resume',
    'Retomar missão',
    'Usar a execução real do Hive.',
    'Execução',
    'play',
    'resume',
    ['executar', 'iniciar'],
    undefined,
    (context) =>
      (!!context.snapshot &&
        !context.snapshot.planning &&
        ['awaiting_plan_approval', 'failed', 'cancelled', 'review'].includes(
          context.snapshot.detail.run.status,
        ) &&
        context.snapshot.detail.tasks.some((task) =>
          ['pending', 'blocked', 'failed', 'cancelled'].includes(task.status),
        )) ||
      'Não há execução parada com tarefas retomáveis.',
  );
  for (const [mode, title, instruction] of [
    ['ask', 'Pedir à Queen', undefined],
    [
      'explain',
      'Explicar missão',
      'Explique esta missão e o trabalho de cada agente com os fatos disponíveis.',
    ],
    [
      'progress',
      'Resumir progresso',
      'Resuma o progresso real, evidências de testes e pendências.',
    ],
    [
      'suggest',
      'Sugerir próximas tarefas',
      'Sugira próximas tarefas para esta missão, com uma prévia antes de criar.',
    ],
  ] as const)
    registry.register({
      id: `queen.${mode}`,
      title,
      description: 'Usar a Queen configurada; alterações exigem prévia e aprovação.',
      category: 'Queen AI',
      icon: 'queen',
      keywords: ['ia', 'ajuda', 'inteligência'],
      availability: queenAvailable,
      execute: (context) => context.ask(mode, instruction),
    });
  registry.register({
    id: 'queen.autopilot',
    title: 'Nexus Autopilot — Criar fluxo com IA',
    description: 'Transformar um objetivo em um workflow visual, editável e executável.',
    category: 'Queen AI',
    icon: 'queen',
    keywords: ['autopilot', 'fluxo', 'workflow', 'orquestração', 'equipe'],
    availability: queenAvailable,
    execute: (context) => context.autopilot(),
  });
  return registry;
}

/** Browsers/editors own these shortcuts; the palette must not intercept them. */
export function ownsKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], .xterm, .monaco-editor, .cm-editor, [data-keyboard-owner], [role="dialog"]',
  );
}
