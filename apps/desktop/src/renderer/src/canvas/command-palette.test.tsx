// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandRegistry, registerCanvasCommands, type CommandContext } from './command-registry';
import { CommandPalette } from './command-palette';

afterEach(cleanup);
function setup() {
  const execute = vi.fn();
  const registry = new CommandRegistry<CommandContext>();
  for (const [id, title, category] of [
    ['note', 'Criar anotação', 'Criar'],
    ['logs', 'Abrir logs', 'Execução'],
    ['disabled', 'Pausa indisponível', 'Execução'],
  ] as const)
    registry.register({
      id,
      title,
      description: title,
      category,
      icon: 'note',
      keywords: [],
      availability: () => (id === 'disabled' ? 'Não há suporte real de pausa' : true),
      execute: () => execute(id),
    });
  const context: CommandContext = {
    snapshot: null,
    ready: true,
    selectedNodeIds: [],
    perform: vi.fn(),
    reveal: vi.fn(),
    find: vi.fn(),
    ask: vi.fn(),
    autopilot: vi.fn(),
  };
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button>Voltar aqui</button>
        <input aria-label="Campo protegido" />
        <textarea aria-label="Editor protegido" />
        <div contentEditable suppressContentEditableWarning data-testid="editable" />
        <div className="xterm">
          <button>Terminal</button>
        </div>
        <div className="monaco-editor">
          <button>Código</button>
        </div>
        <CommandPalette
          registry={registry}
          context={context}
          open={open}
          onOpenChange={setOpen}
          blocked={false}
          onError={vi.fn()}
        />
      </>
    );
  }
  render(<Harness />);
  const toggle = (element: Element | Window = window) =>
    fireEvent.keyDown(element, { key: ' ', code: 'Space', ctrlKey: true });
  return { execute, registry, context, toggle };
}

it('abre imediatamente, navega por teclado, executa e restaura o foco ao fechar', async () => {
  const { toggle, execute } = setup();
  const prior = screen.getByRole('button', { name: 'Voltar aqui' });
  prior.focus();
  toggle(prior);
  const input = screen.getByRole('combobox', { name: 'Pesquisar comandos e elementos' });
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(execute).toHaveBeenCalledWith('logs'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(prior);
  toggle(prior);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  expect(document.activeElement).toBe(prior);
});

it('filtra sem acentos e nunca executa resultados indisponíveis', async () => {
  const { toggle, execute } = setup();
  toggle();
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'anotacao' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(execute).toHaveBeenCalledWith('note'));
  toggle();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Pausa' } });
  const option = screen.getByRole('option', { name: /Pausa indisponível/ });
  expect(option.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(option);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('não intercepta terminais, editores, texto, IME nem atalhos já tratados', () => {
  const { toggle } = setup();
  for (const element of [
    screen.getByLabelText('Campo protegido'),
    screen.getByLabelText('Editor protegido'),
    screen.getByTestId('editable'),
    screen.getByRole('button', { name: 'Terminal' }),
    screen.getByRole('button', { name: 'Código' }),
  ]) {
    toggle(element);
    expect(screen.queryByRole('dialog')).toBeNull();
  }
  for (const patch of [
    { isComposing: true },
    { keyCode: 229 },
    { altKey: true },
    { metaKey: true },
    { repeat: true },
  ]) {
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, ...patch });
    expect(screen.queryByRole('dialog')).toBeNull();
  }
  const event = new KeyboardEvent('keydown', {
    key: ' ',
    code: 'Space',
    ctrlKey: true,
    cancelable: true,
  });
  event.preventDefault();
  act(() => window.dispatchEvent(event));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Ctrl + Espaço fecha a paleta mesmo com o campo de busca focado e remove listeners', () => {
  const { toggle } = setup();
  toggle();
  toggle(screen.getByRole('combobox'));
  expect(screen.queryByRole('dialog')).toBeNull();
  cleanup();
  toggle();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('aceita novos comandos no registry sem alterar o componente da paleta', () => {
  const registry = new CommandRegistry<{ enabled: boolean }>();
  registry.register({
    id: 'plugin.example',
    title: 'Extensão útil',
    description: 'Comando adicionado por registro.',
    category: 'Workspace',
    icon: 'view',
    keywords: ['extra'],
    availability: (context) => context.enabled || 'Desabilitado',
    execute: vi.fn(),
  });
  expect(registry.search('extra', { enabled: true })[0]?.command.id).toBe('plugin.example');
  expect(registry.search('extensao', { enabled: false })[0]?.available).toBe('Desabilitado');
  expect(() => registry.register(registry.search('', { enabled: true })[0]!.command)).toThrow(
    /duplicado/,
  );
});

it('oferece o Nexus Autopilot na paleta existente e chama o fluxo dedicado', async () => {
  const autopilot = vi.fn();
  const context: CommandContext = {
    snapshot: {
      detail: {
        run: { status: 'awaiting_plan_approval' },
        tasks: [],
      },
      workers: [{ role: 'queen', providerId: 'provider', modelId: 'model' }],
      planning: false,
    } as unknown as CommandContext['snapshot'],
    ready: true,
    selectedNodeIds: [],
    perform: vi.fn(),
    reveal: vi.fn(),
    find: vi.fn(),
    ask: vi.fn(),
    autopilot,
  };
  const registry = registerCanvasCommands(new CommandRegistry<CommandContext>());
  const result = registry.search('autopilot', context)[0];
  expect(result?.command.title).toContain('Nexus Autopilot');
  expect(result?.available).toBe(true);
  await result?.command.execute(context);
  expect(autopilot).toHaveBeenCalledOnce();
});
