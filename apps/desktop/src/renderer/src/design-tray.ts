import { create } from 'zustand';
import type { Plan } from '@hive/core';
import type { StyleChange } from './design';

/** One change asked for in the Design Mode, waiting in the tray to go to an agent. */
export interface DesignNote {
  id: string;
  element: { tag: string; id: string | null; classes: string[]; selector: string; text: string };
  /** Best guess of the file (and line) that renders the element. */
  file: { path: string; line: number | null } | null;
  changes: StyleChange[];
  newText: string | null;
  comment: string;
  /** Small PNG of the element as it looked when the note was taken. */
  image: string | null;
}

interface TrayState {
  /** Notes per project, so switching projects keeps each tray. */
  notes: Record<string, DesignNote[]>;
  add(project: string, note: DesignNote): void;
  update(project: string, id: string, patch: Partial<DesignNote>): void;
  remove(project: string, id: string): void;
  clear(project: string): void;
}

export const useTray = create<TrayState>((set) => ({
  notes: {},
  add: (project, note) =>
    set((state) => ({
      notes: { ...state.notes, [project]: [...(state.notes[project] ?? []), note] },
    })),
  update: (project, id, patch) =>
    set((state) => ({
      notes: {
        ...state.notes,
        [project]: (state.notes[project] ?? []).map((note) =>
          note.id === id ? { ...note, ...patch } : note,
        ),
      },
    })),
  remove: (project, id) =>
    set((state) => ({
      notes: {
        ...state.notes,
        [project]: (state.notes[project] ?? []).filter((note) => note.id !== id),
      },
    })),
  clear: (project) =>
    set((state) => {
      const notes = { ...state.notes };
      delete notes[project];
      return { notes };
    }),
}));

export const MAX_TRAY_NOTES = 12;
/** A plan task description holds at most 4,000 characters. */
const MAX_DESCRIPTION = 4_000;

const kebab = (property: string) => property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function describeElement(element: DesignNote['element']): string {
  const id = element.id ? ` id="${element.id}"` : '';
  const classes = element.classes.length ? ` class="${element.classes.join(' ')}"` : '';
  const text = element.text ? ` com o texto "${element.text.slice(0, 80)}"` : '';
  return `<${element.tag}${id}${classes}>${text}`;
}

/** One line per thing to change, for the note card and for the agent. */
export function noteLines(note: DesignNote): string[] {
  return [
    ...(note.newText !== null ? [`Texto: "${note.element.text}" → "${note.newText}"`] : []),
    ...note.changes.map(
      (change) => `${kebab(change.property)}: ${change.from || '(vazio)'} → ${change.to}`,
    ),
    ...(note.comment.trim() ? [`Pedido: ${note.comment.trim()}`] : []),
  ];
}

/**
 * Turns the tray into a single task for an agent. Each note names the element, the likely
 * file and the exact changes; notes that do not fit the task size are left out and counted.
 */
export function buildDesignTask(
  notes: DesignNote[],
  pageUrl: string,
): {
  title: string;
  description: string;
  included: number;
} {
  const head = [
    `Ajustes visuais pedidos no Design Mode do Hive, na página ${pageUrl || 'do preview'}.`,
    'Para cada item: encontre o elemento no código (comece pelo arquivo provável; se não estiver lá, busque pelas classes e pelo texto), aplique a mudança com o mecanismo de estilo que o projeto já usa (classes, CSS ou estilos inline) e não altere mais nada.',
    '',
  ].join('\n');
  let description = head;
  let included = 0;
  for (const [index, note] of notes.entries()) {
    const where = note.file
      ? `   Arquivo provável: ${note.file.path}${note.file.line ? `:${note.file.line}` : ''}`
      : '   Arquivo: desconhecido, procure pelas classes e pelo texto';
    const block = [
      `${index + 1}. ${describeElement(note.element)} (seletor: ${note.element.selector})`,
      where,
      ...noteLines(note).map((line) => `   - ${line}`),
      '',
    ].join('\n');
    if (description.length + block.length > MAX_DESCRIPTION) break;
    description += `${block}\n`;
    included += 1;
  }
  const skipped = notes.length - included;
  if (skipped)
    description = `${description.trimEnd()}\n\n(${skipped} anotação(ões) não couberam nesta tarefa.)`;
  return {
    title: `Ajustes de design (${included} ${included === 1 ? 'item' : 'itens'})`,
    description: description.trimEnd(),
    included,
  };
}

/** A one-task plan, so the tray goes straight to an agent without asking the Queen. */
export function designPlan(
  task: { title: string; description: string },
  workerId: string | null,
): Plan {
  return {
    notes: 'Criado a partir da bandeja do Design Mode.',
    tasks: [
      {
        key: 'design',
        title: task.title,
        description: task.description,
        workerId,
        dependsOn: [],
        acceptanceCriteria: [
          'Cada ajuste listado aparece na página do preview.',
          'Nada além dos ajustes listados foi alterado.',
        ],
      },
    ],
  };
}
