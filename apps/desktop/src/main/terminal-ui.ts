import type { AgentOutcome, RuntimeEvent } from '@hive/agents';
import { beeColorOf, beeColors, type Worker, type WorkerRole, type Workspace } from '@hive/core';
import { errorMessage } from '@hive/shared';
import type { ApprovalAnswer, Exchange, TurnHandlers } from './terminal-agents';

/** Where the app draws: the shell's terminal, through the command that launched it. */
export interface TerminalHost {
  write: (text: string) => void;
  size: () => { cols: number; rows: number };
  /** Ends the command; the shell takes the terminal back. */
  end: () => void;
}

export interface TerminalAppServices {
  workspace: Workspace;
  workers: () => Worker[];
  turn: (
    workerId: string,
    request: string,
    history: Exchange[],
    handlers: TurnHandlers,
    signal: AbortSignal,
  ) => Promise<AgentOutcome>;
  /** What the tokens cost with the agent's model ("grátis", "US$ 0,0021"), when known. */
  cost: (workerId: string, usage: AgentOutcome['usage']) => string | null;
}

/* ANSI: everything is drawn with plain escape sequences, so any terminal shows it. */
const reset = '\x1b[0m';
const bold = '\x1b[1m';
// Faint text (SGR 2) does not survive Windows' ConPTY, so hints are drawn in gray instead.
const dim = '\x1b[38;2;128;133;141m';
const hideCursor = '\x1b[?25l';
const showCursor = '\x1b[?25h';
const clearLine = '\r\x1b[2K';
const newline = '\r\n';

function rgb(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}
const gray = rgb('#62666d');
const red = rgb('#f87185');
const green = rgb('#4cd6a0');
const yellow = rgb('#f5b544');

const roleOrder: WorkerRole[] = ['queen', 'architect', 'frontend', 'backend', 'qa', 'reviewer'];
const roleLabels: Record<WorkerRole, string> = {
  queen: 'Coordenação',
  architect: 'Arquitetura',
  frontend: 'Frontend',
  backend: 'Backend',
  qa: 'Testes',
  reviewer: 'Revisão',
  custom: 'Personalizado',
};

/** What the agent is doing, for the spinner line. */
const stateLabels: Record<string, string> = {
  thinking: 'pensando',
  planning: 'se preparando',
  coding: 'programando',
  testing: 'testando',
  reviewing: 'revisando',
  waiting_provider: 'aguardando o provedor',
};

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function fit(text: string, width: number): string {
  if (width <= 1) return '';
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

// Arrows and other keys that arrive as escape sequences (CSI or SS3).
const keySequence = new RegExp(`^${String.fromCharCode(27)}(?:\\[[0-9;]*[A-Za-z~]|O[A-Za-z])`);

/** One keystroke per item: escape sequences (arrows) stay whole, characters by code point. */
export function splitKeys(data: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < data.length;) {
    const sequence = keySequence.exec(data.slice(index));
    if (sequence) {
      keys.push(sequence[0]);
      index += sequence[0].length;
      continue;
    }
    const character = String.fromCodePoint(data.codePointAt(index)!);
    keys.push(character);
    index += character.length;
  }
  return keys;
}

/** How a tool call reads in the transcript. */
export function describeTool(tool: string, args: Record<string, unknown>): string {
  const target = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '');
  switch (tool) {
    case 'read_file':
      return `Lendo ${target('path')}`;
    case 'list_dir':
      return `Listando ${target('path') || '.'}`;
    case 'search':
      return `Buscando "${target('query')}"`;
    case 'write_file':
      return `Escrevendo ${target('path')}`;
    case 'replace_in_file':
      return `Editando ${target('path')}`;
    case 'run_command':
      return `$ ${target('command')}`;
    case 'read_skill_resource':
      return `Lendo ${target('path')} da skill ${target('skill')}`;
    default:
      return tool;
  }
}

type Mode = 'pick' | 'prompt' | 'running' | 'approval' | 'closed';

/**
 * Hive inside a shell: `agents` lists the bees to pick one, then a conversation with it where
 * every step it takes shows up live, like Claude Code. Commands it wants to run are approved
 * here with a key.
 */
export class HiveTerminalApp {
  private mode: Mode = 'pick';
  private choices: Worker[] = [];
  private pickIndex = 0;
  private pickLines = 0;
  private pickNote = '';
  private worker: Worker | null = null;
  /** The agent's last text in this turn, so a reply that repeats it is not printed twice. */
  private said = '';
  private line = '';
  private history: Exchange[] = [];
  private typed: string[] = [];
  private typedIndex = 0;
  private abort: AbortController | null = null;
  private answer: ((answer: ApprovalAnswer) => void) | null = null;
  private spinner: { timer: ReturnType<typeof setInterval>; frame: number; text: string } | null =
    null;

  constructor(
    private readonly host: TerminalHost,
    private readonly services: TerminalAppServices,
  ) {}

  start(command: string): void {
    if (command === 'agents') this.openPicker();
    else {
      this.help();
      this.end();
    }
  }

  input(data: string): void {
    // A paste with line breaks is one request, not several.
    const keys =
      this.mode === 'prompt' && data.length > 1 && /[\r\n]/.test(data.replace(/\r$/, ''))
        ? [data.replace(/\r?\n|\r/g, ' ').trimEnd()]
        : splitKeys(data);
    for (const key of keys) {
      if (this.mode === 'closed') return;
      if (this.mode === 'pick') this.pickKey(key);
      else if (this.mode === 'prompt') this.promptKey(key);
      else if (this.mode === 'approval') this.approvalKey(key);
      else if (key === '\x03') this.interrupt();
    }
  }

  /** The connection to the shell is gone (the terminal closed): stop everything quietly. */
  dispose(): void {
    if (this.mode === 'closed') return;
    this.mode = 'closed';
    this.stopSpinner();
    this.answer?.('no');
    this.abort?.abort();
  }

  private write(text: string) {
    if (this.mode !== 'closed') this.host.write(text);
  }

  private end() {
    if (this.mode === 'closed') return;
    this.stopSpinner();
    this.abort?.abort();
    this.host.write(`${reset}${showCursor}`);
    this.mode = 'closed';
    this.host.end();
  }

  private help() {
    this.write(
      [
        `${yellow}●${reset} ${bold}Hive${reset} no terminal`,
        '',
        `  ${bold}agents${reset}       escolher uma abelha e conversar com ela neste projeto`,
        `  ${bold}hive help${reset}    esta ajuda`,
        '',
        `${dim}  Na conversa: /agentes troca de abelha · /nova recomeça · /sair sai · Ctrl+C interrompe${reset}`,
        '',
      ].join(newline),
    );
  }

  /* ---------------------------------------------------------------- Picking an agent */

  private openPicker() {
    this.mode = 'pick';
    this.choices = [...this.services.workers()].sort(
      (a, b) =>
        (roleOrder.indexOf(a.role) + 1 || 99) - (roleOrder.indexOf(b.role) + 1 || 99) ||
        a.name.localeCompare(b.name),
    );
    if (!this.choices.length) {
      this.write(`${red}Nenhum agente configurado.${reset} Crie um na tela Agentes.${newline}`);
      this.end();
      return;
    }
    const current = this.worker ? this.choices.findIndex((w) => w.id === this.worker!.id) : -1;
    this.pickIndex = Math.max(0, current);
    this.pickLines = 0;
    this.pickNote = '';
    this.write(
      `${hideCursor}${newline}${yellow}●${reset} ${bold}Escolha uma abelha${reset} ${dim}para trabalhar em ${this.services.workspace.name}${reset}${newline}${newline}`,
    );
    this.drawPicker();
  }

  private drawPicker() {
    const { cols } = this.host.size();
    const nameWidth = Math.min(26, Math.max(...this.choices.map((w) => w.name.length)) + 1);
    const roleWidth = 14;
    const modelWidth = Math.max(8, cols - 6 - nameWidth - roleWidth - 2);
    const rows = this.choices.map((worker, index) => {
      const color = rgb(beeColors[beeColorOf(worker)].hex);
      const selected = index === this.pickIndex;
      const marker = selected ? `${color}❯${reset}` : ' ';
      const name = fit(worker.name, nameWidth);
      const model = worker.modelId
        ? `${gray}${fit(worker.modelId, modelWidth).trimEnd()}${reset}`
        : `${red}sem modelo${reset}`;
      return `${marker} ${color}●${reset} ${selected ? bold : ''}${name}${reset}${dim}${fit(roleLabels[worker.role], roleWidth)}${reset}${model}`;
    });
    const lines = [
      ...rows,
      '',
      this.pickNote || `${dim}↑↓ escolhe · Enter conversa · Esc sai${reset}`,
    ];
    // Back to the first row and drawn again in place.
    if (this.pickLines) this.write(`\x1b[${this.pickLines}A`);
    for (const line of lines) this.write(`${clearLine}${line}${newline}`);
    this.pickLines = lines.length;
  }

  private pickKey(key: string) {
    if (key === '\x1b[A' || key === 'k') {
      this.pickIndex = (this.pickIndex - 1 + this.choices.length) % this.choices.length;
      this.drawPicker();
    } else if (key === '\x1b[B' || key === 'j') {
      this.pickIndex = (this.pickIndex + 1) % this.choices.length;
      this.drawPicker();
    } else if (key === '\r') {
      const chosen = this.choices[this.pickIndex]!;
      if (!chosen.providerId || !chosen.modelId) {
        this.pickNote = `${red}${chosen.name} ainda não tem modelo. Configure na tela Agentes.${reset}`;
        this.drawPicker();
        return;
      }
      if (this.worker?.id !== chosen.id) this.history = [];
      this.worker = chosen;
      this.write(showCursor);
      this.greet();
    } else if (key === '\x1b' || key === 'q' || key === '\x03' || key === '\x04') {
      if (this.worker) {
        // Back to the conversation that was going on.
        this.write(showCursor);
        this.prompt();
      } else this.end();
    }
  }

  /* ---------------------------------------------------------------- The conversation */

  private color() {
    return this.worker ? rgb(beeColors[beeColorOf(this.worker)].hex) : yellow;
  }

  private greet() {
    const worker = this.worker!;
    this.write(
      [
        '',
        `${this.color()}●${reset} ${bold}${worker.name}${reset} ${gray}· ${worker.modelId}${reset}`,
        `${dim}  Trabalhando direto em ${this.services.workspace.path}. Escreva o que precisa e tecle Enter.${reset}`,
        `${dim}  /agentes troca de abelha · /nova recomeça · /sair sai · Ctrl+C interrompe${reset}`,
        '',
      ].join(newline),
    );
    this.prompt();
  }

  private prompt() {
    this.mode = 'prompt';
    this.line = '';
    this.typedIndex = this.typed.length;
    this.write(`${newline}`);
    this.drawLine();
  }

  private drawLine() {
    const { cols } = this.host.size();
    const room = Math.max(10, cols - 4);
    const visible = this.line.length > room ? `…${this.line.slice(-(room - 1))}` : this.line;
    this.write(`${clearLine}${this.color()}${bold}›${reset} ${visible}`);
  }

  private promptKey(key: string) {
    if (key === '\r') void this.submit();
    else if (key === '\x7f' || key === '\b') {
      this.line = [...this.line].slice(0, -1).join('');
      this.drawLine();
    } else if (key === '\x03') {
      if (this.line) {
        this.line = '';
        this.drawLine();
      } else {
        this.write(newline);
        this.end();
      }
    } else if (key === '\x04') {
      this.write(newline);
      this.end();
    } else if (key === '\x15') {
      this.line = '';
      this.drawLine();
    } else if (key === '\x1b[A' || key === '\x1b[B') {
      if (!this.typed.length) return;
      const step = key === '\x1b[A' ? -1 : 1;
      this.typedIndex = Math.min(this.typed.length, Math.max(0, this.typedIndex + step));
      this.line = this.typed[this.typedIndex] ?? '';
      this.drawLine();
    } else if (!key.startsWith('\x1b') && key >= ' ') {
      this.line += key;
      this.drawLine();
    }
  }

  private async submit() {
    const text = this.line.trim();
    this.write(newline);
    if (!text) return this.prompt();
    const command = text.toLowerCase();
    // Shell habits: a bare "exit" leaves too, it is never sent to the agent.
    if (['/sair', '/exit', '/quit', 'sair', 'exit', 'quit'].includes(command)) return this.end();
    if (['/agentes', '/agents'].includes(command)) return this.openPicker();
    if (['/nova', '/new', '/clear'].includes(command)) {
      this.history = [];
      this.write(
        `${dim}  Nova conversa: o agente não lembra mais das mensagens anteriores.${reset}`,
      );
      return this.prompt();
    }
    if (['/ajuda', '/help'].includes(command)) {
      this.help();
      return this.prompt();
    }
    this.typed.push(text);
    await this.run(text);
    if (this.mode !== 'closed') this.prompt();
  }

  private async run(request: string) {
    const worker = this.worker!;
    this.mode = 'running';
    this.said = '';
    this.abort = new AbortController();
    this.write(newline);
    this.startSpinner('pensando');
    try {
      const outcome = await this.services.turn(
        worker.id,
        request,
        [...this.history],
        {
          onEvent: (event) => this.show(event),
          approve: (command) => this.askApproval(command),
        },
        this.abort.signal,
      );
      this.stopSpinner();
      this.reply(outcome);
      if (outcome.status === 'completed') this.history.push({ request, reply: outcome.summary });
    } catch (error) {
      this.stopSpinner();
      this.write(`${red}✗ ${errorMessage(error)}${reset}${newline}`);
    } finally {
      this.abort = null;
    }
  }

  private interrupt() {
    if (!this.abort || this.abort.signal.aborted) return;
    this.print(`${yellow}  Interrompendo…${reset}`);
    this.abort.abort();
  }

  private reply(outcome: AgentOutcome) {
    const tokens = outcome.usage.promptTokens + outcome.usage.completionTokens;
    const cost = this.worker ? this.services.cost(this.worker.id, outcome.usage) : null;
    const meta = `${gray}  ${outcome.steps} passo(s) · ${tokens.toLocaleString('pt-BR')} tokens${cost ? ` · ${cost}` : ''}${reset}`;
    if (outcome.status === 'cancelled') {
      this.write(`${yellow}  Interrompido.${reset}${newline}`);
      return;
    }
    if (outcome.status === 'failed' && !outcome.summary) {
      this.write(
        `${red}✗ ${outcome.error ?? 'O agente não terminou.'}${reset}${newline}${meta}${newline}`,
      );
      return;
    }
    // A plain-text answer was already shown as the agent spoke.
    const repeated = outcome.summary.trim() === this.said;
    const body = outcome.summary.trim().replace(/\r?\n/g, `${newline}  `);
    this.write(
      (repeated ? '' : `${newline}${this.color()}●${reset} ${body}${newline}`) +
        (outcome.status === 'failed' ? `${red}  ${outcome.error ?? ''}${reset}${newline}` : '') +
        `${meta}${newline}`,
    );
  }

  /** A line of the transcript, kept above the spinner while one is turning. */
  private print(line: string) {
    if (this.spinner) this.write(`${clearLine}${line}${newline}`);
    else this.write(`${line}${newline}`);
    this.drawSpinner();
  }

  private show(event: RuntimeEvent) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'model.response': {
        const content = typeof data.content === 'string' ? data.content.trim() : '';
        if (content) this.said = content;
        if (content)
          this.print(`${this.color()}●${reset} ${content.replace(/\r?\n/g, `${newline}  `)}`);
        break;
      }
      case 'tool.call': {
        const tool = typeof data.tool === 'string' ? data.tool : '';
        if (!tool || tool === 'finish') break;
        const args = (data.args ?? {}) as Record<string, unknown>;
        this.print(`  ${gray}⎿${reset} ${describeTool(tool, args)}`);
        break;
      }
      case 'command.finished': {
        const ok = data.exitCode === 0;
        const seconds =
          typeof data.durationMs === 'number' ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : '';
        const status = data.timedOut ? 'tempo esgotado' : `saída ${String(data.exitCode)}`;
        this.print(`    ${ok ? `${green}✓` : `${red}✗`} ${status}${seconds}${reset}`);
        break;
      }
      case 'tool.result':
        if (data.isError && data.tool !== 'run_command') {
          const output = typeof data.output === 'string' ? data.output.split('\n')[0] : '';
          this.print(`    ${red}✗ ${output}${reset}`);
        }
        break;
      case 'info':
        if (event.level === 'warn') this.print(`  ${yellow}!${reset} ${event.message}`);
        break;
      case 'worker.state': {
        const label = typeof data.state === 'string' ? stateLabels[data.state] : undefined;
        if (label && this.spinner) this.spinner.text = label;
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- Approvals */

  private askApproval(command: string): Promise<ApprovalAnswer> {
    if (this.mode === 'closed') return Promise.resolve('no');
    this.stopSpinner();
    this.write(
      `${yellow}?${reset} ${this.worker!.name} quer rodar ${bold}${command}${reset}${newline}` +
        `  ${dim}[s] sim · [n] não · [a] sempre para este agente${reset} `,
    );
    this.mode = 'approval';
    return new Promise((resolve) => {
      this.answer = (answer) => {
        this.answer = null;
        const label =
          answer === 'yes'
            ? `${green}sim${reset}`
            : answer === 'always'
              ? `${green}sempre${reset}`
              : `${red}não${reset}`;
        this.write(`${label}${newline}`);
        if (this.mode === 'approval') {
          this.mode = 'running';
          this.startSpinner('pensando');
        }
        resolve(answer);
      };
    });
  }

  private approvalKey(key: string) {
    const lower = key.toLowerCase();
    if (lower === 's' || lower === 'y') this.answer?.('yes');
    else if (lower === 'a') this.answer?.('always');
    else if (lower === 'n' || key === '\r' || key === '\x1b') this.answer?.('no');
    else if (key === '\x03') {
      this.answer?.('no');
      this.interrupt();
    }
  }

  /* ---------------------------------------------------------------- Spinner */

  private startSpinner(text: string) {
    this.stopSpinner();
    this.write(hideCursor);
    this.spinner = {
      frame: 0,
      text,
      timer: setInterval(() => {
        if (!this.spinner) return;
        this.spinner.frame = (this.spinner.frame + 1) % spinnerFrames.length;
        this.drawSpinner();
      }, 120),
    };
    this.drawSpinner();
  }

  private drawSpinner() {
    if (!this.spinner || !this.worker) return;
    const frame = spinnerFrames[this.spinner.frame]!;
    this.write(
      `${clearLine}${this.color()}${frame}${reset} ${dim}${this.worker.name} está ${this.spinner.text}… (Ctrl+C interrompe)${reset}`,
    );
  }

  private stopSpinner() {
    if (!this.spinner) return;
    clearInterval(this.spinner.timer);
    this.spinner = null;
    this.write(`${clearLine}${showCursor}`);
  }
}
