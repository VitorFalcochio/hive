import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import type { RunStatus } from '@hive/core';
import { message } from './context';
import { Mascot } from './mascot';

export const statusLabels: Record<RunStatus, string> = {
  draft: 'Rascunho',
  planning: 'Planejando',
  awaiting_plan_approval: 'Plano pronto',
  failed: 'Falhou',
  running: 'Em execução',
  review: 'Em revisão',
  completed: 'Concluído',
  cancelled: 'Cancelado',
};

type Tone = 'idle' | 'busy' | 'ok' | 'error';
const statusTones: Partial<Record<RunStatus, Tone>> = {
  planning: 'busy',
  running: 'busy',
  awaiting_plan_approval: 'ok',
  completed: 'ok',
  failed: 'error',
};
export const runTone = (status: RunStatus | null | undefined): Tone =>
  (status && statusTones[status]) || 'idle';

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot dot-${tone}`} role={label ? 'img' : undefined} aria-label={label} />;
}

/** Local running/error state for one async action, used by modals and cards. */
export function useTask() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (action: () => Promise<void>) => {
    setRunning(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setRunning(false);
    }
  }, []);
  return { running, error, setError, run };
}

export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  size,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  size?: 'xl';
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={size === 'xl' ? 'modal xl' : wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {description && <p className="modal-description">{description}</p>}
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  children,
  leading,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Shown to the left of the title, e.g. the mascot on the overview. */
  leading?: ReactNode;
}) {
  return (
    <div className="page-header">
      {leading && <div className="page-leading">{leading}</div>}
      <div className="page-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Mascot size={40} />
      <p>{children}</p>
      {action}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary text shown in the menu, e.g. the key hint. */
  hint?: string;
  /** Small pill shown in the menu and on the trigger, e.g. "Grátis". */
  tag?: { label: string; tone?: 'free' };
  /** Section heading; consecutive options with the same group share one heading. */
  group?: string;
}

function SelectTag({ tag }: { tag: NonNullable<SelectOption['tag']> }) {
  return <span className={tag.tone ? `select-tag ${tag.tone}` : 'select-tag'}>{tag.label}</span>;
}

/**
 * Dark-themed replacement for `<select>`, whose native menu ignores the app theme on Windows.
 * The menu is fixed-positioned so modals and cards never clip it.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = 'Selecione',
  disabled = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const listId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event.type === 'mousedown' && (event.target as Element).closest?.('.select-menu')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  function show() {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  }
  function pick(option: SelectOption | undefined) {
    if (option) onChange(option.value);
    setOpen(false);
    button.current?.focus();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            show();
            return;
          }
          if (!open) return;
          if (event.key === 'Escape') {
            // Keep the surrounding modal open.
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            setOpen(false);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(options.length - 1, index + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            pick(options[active]);
          } else if (event.key === 'Tab') setOpen(false);
        }}
      >
        <span className={selected ? 'truncate' : 'truncate placeholder'}>
          {selected?.label ?? placeholder}
        </span>
        {selected?.tag && <SelectTag tag={selected.tag} />}
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            className="select-menu"
            style={{ top: position.top, left: position.left, width: position.width }}
          >
            {options.map((option, index) => (
              <Fragment key={option.value}>
                {option.group && option.group !== options[index - 1]?.group && (
                  <li role="presentation" className="select-group">
                    {option.group}
                  </li>
                )}
                <li
                  role="option"
                  aria-selected={option.value === value}
                  className={index === active ? 'active' : undefined}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(option)}
                >
                  <span className="truncate">{option.label}</span>
                  {option.hint && <small>{option.hint}</small>}
                  {option.tag && <SelectTag tag={option.tag} />}
                  <span className="select-check">
                    {option.value === value && <Check size={13} />}
                  </span>
                </li>
              </Fragment>
            ))}
            {!options.length && <li className="select-empty">Nenhuma opção</li>}
          </ul>,
          document.body,
        )}
    </>
  );
}

/** Edits slide in from the right, so the table stays in view behind them. */
export function Drawer({
  eyebrow,
  title,
  onClose,
  footer,
  children,
  onSubmit,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
  onSubmit: () => void;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="drawer-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        <div className="drawer-footer">{footer}</div>
      </form>
    </div>
  );
}
