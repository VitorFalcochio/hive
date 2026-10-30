import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CheckSquare,
  FileText,
  Folder,
  LayoutGrid,
  MapPin,
  Play,
  Search,
  StickyNote,
  Terminal,
  Users,
  ZoomIn,
} from 'lucide-react';
import {
  CommandRegistry,
  ownsKeyboard,
  queenAvailable,
  type Command,
  type CommandContext,
  type CommandIcon,
} from './command-registry';

const icons: Record<CommandIcon, typeof Search> = {
  agent: Users,
  task: CheckSquare,
  note: StickyNote,
  group: Folder,
  result: FileText,
  view: LayoutGrid,
  search: Search,
  zoom: ZoomIn,
  logs: Terminal,
  mission: MapPin,
  play: Play,
  queen: Bot,
  pin: MapPin,
};

export function CommandPalette({
  registry,
  context,
  open,
  onOpenChange,
  blocked,
  onError,
}: {
  registry: CommandRegistry<CommandContext>;
  context: CommandContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blocked: boolean;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'agent' | 'task'>('all');
  const [selectedId, setSelectedId] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.altKey ||
        event.metaKey ||
        event.getModifierState('AltGraph')
      )
        return;
      if (!event.ctrlKey || !(event.code === 'Space' || event.key === ' ')) return;
      if (
        blocked ||
        !!document.querySelector('[role="dialog"]:not([data-command-palette])') ||
        (!open && ownsKeyboard(event.target)) ||
        (open && ownsKeyboard(event.target) && !box.current?.contains(event.target as Node))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onOpenChange(!open);
    };
    const requested = () => {
      if (!blocked && !document.querySelector('[role="dialog"]:not([data-command-palette])'))
        onOpenChange(true);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('nc:commands', requested);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('nc:commands', requested);
    };
  }, [open, blocked, onOpenChange]);
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setScope('all');
    setSelectedId('');
    input.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  const executionContext: CommandContext = useMemo(
    () => ({
      ...context,
      find: (kind) => {
        setScope(kind);
        setQuery('');
        setSelectedId('');
      },
    }),
    [context],
  );
  const results = useMemo(() => {
    const matches = registry.search(query, executionContext, scope);
    if (
      query.trim() &&
      scope === 'all' &&
      !matches.some(
        ({ command }) =>
          command.title.toLocaleLowerCase('pt-BR') === query.trim().toLocaleLowerCase('pt-BR'),
      )
    ) {
      const ask: Command<CommandContext> = {
        id: 'queen.free-text',
        title: `Pedir à Queen: ${query.trim()}`,
        description: 'Interpretar o pedido e revisar a proposta antes de aplicar.',
        category: 'Queen AI',
        icon: 'queen',
        keywords: [],
        availability: queenAvailable,
        execute: (current) => current.ask('ask', query.trim()),
      };
      matches.push({ command: ask, available: ask.availability(executionContext), score: 3 });
    }
    return matches;
  }, [registry, query, executionContext, scope]);
  const enabled = results.filter((result) => result.available === true);
  const active = enabled.find((result) => result.command.id === selectedId) ?? enabled[0];
  const activeId = active?.command.id;
  useEffect(() => {
    if (open && activeId)
      document.getElementById(`${id}-${activeId}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, id, activeId]);
  const execute = (command: Command<CommandContext>) => {
    if (command.availability(executionContext) !== true) return;
    if (!command.keepOpen) onOpenChange(false);
    const run = () => {
      void Promise.resolve()
        .then(() => command.execute(executionContext))
        .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
    };
    if (command.keepOpen) run();
    else requestAnimationFrame(run);
  };
  if (!open) return null;
  return (
    <div
      className="nc-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        className="nc-palette"
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        data-command-palette
        data-keyboard-owner
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            const fields = [
              ...(box.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? []),
            ];
            const current = fields.indexOf(document.activeElement as HTMLElement);
            fields[(current + (event.shiftKey ? -1 : 1) + fields.length) % fields.length]?.focus();
          }
        }}
      >
        <div className="nc-palette-search">
          <Search size={18} />
          <input
            ref={input}
            role="combobox"
            aria-label="Pesquisar comandos e elementos"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${id}-${active.command.id}` : undefined}
            value={query}
            maxLength={4000}
            placeholder={
              scope === 'all'
                ? 'Buscar comandos, agentes, tarefas ou pedir à Queen…'
                : `Encontrar ${scope === 'agent' ? 'agente' : 'tarefa'}…`
            }
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedId('');
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const current = enabled.findIndex(
                  (result) => result.command.id === active?.command.id,
                );
                const next =
                  enabled[
                    (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) %
                      enabled.length
                  ];
                if (next) setSelectedId(next.command.id);
              } else if (event.key === 'Enter' && active) {
                event.preventDefault();
                execute(active.command);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        {scope !== 'all' && (
          <button
            className="nc-palette-scope"
            onClick={() => {
              setScope('all');
              input.current?.focus();
            }}
          >
            ← Todos os comandos
          </button>
        )}
        <div
          className="nc-palette-results"
          id={`${id}-list`}
          role="listbox"
          aria-label="Comandos e elementos"
        >
          {!results.length && (
            <div className="nc-palette-empty">
              Nenhum elemento encontrado. Volte aos comandos para pedir ajuda à Queen.
            </div>
          )}
          {results.map(({ command, available }, index) => {
            const Icon = icons[command.icon];
            return (
              <div key={command.id}>
                {(index === 0 || results[index - 1]?.command.category !== command.category) && (
                  <div className="nc-palette-category">{command.category}</div>
                )}
                <div
                  role="option"
                  id={`${id}-${command.id}`}
                  aria-selected={active?.command.id === command.id}
                  aria-disabled={available !== true}
                  className={`nc-palette-option${active?.command.id === command.id ? ' active' : ''}${available === true ? '' : ' disabled'}`}
                  onMouseMove={() => {
                    if (available === true) setSelectedId(command.id);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => execute(command)}
                >
                  <Icon size={17} />
                  <div>
                    <strong>{command.title}</strong>
                    <span>{available === true ? command.description : available}</span>
                  </div>
                  {command.shortcut && <kbd>{command.shortcut}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
        <footer>
          <span>↑ ↓ navegar</span>
          <span>↵ executar</span>
          <span>Ctrl + Espaço fechar</span>
        </footer>
      </div>
    </div>
  );
}
