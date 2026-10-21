import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ChevronDown,
  FileSearch,
  Inbox,
  Italic,
  RotateCcw,
  Sparkles,
  Underline,
  X,
} from 'lucide-react';
import type { LocateCandidate } from '@hive/core';
import { fileTab, useCode, type AiProposal } from './code/store';
import { useHive, usableWorkers } from './context';
import type { DesignNote } from './design-tray';

// Shape of the element report sent by the inspector injected into the preview page.
export interface DesignElement {
  tag: string;
  id: string | null;
  classes: string[];
  selector: string;
  text: string;
  /** True when the text can be replaced without losing child elements. */
  editableText: boolean;
  /** Where a dev build says the element was written (absolute or URL-like path), if it says. */
  source: { file: string; line: number | null } | null;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

// Messages cross the iframe boundary, so they are untrusted until checked here.
export function parseDesignElement(data: unknown): DesignElement | null {
  if (!isRecord(data) || data.source !== 'hive-design' || data.type !== 'select') return null;
  const element = data.element;
  if (!isRecord(element)) return null;
  const rect = element.rect;
  if (!isRecord(rect) || !['x', 'y', 'width', 'height'].every((key) => isNumber(rect[key])))
    return null;
  if (typeof element.tag !== 'string' || typeof element.selector !== 'string') return null;
  if (typeof element.text !== 'string') return null;
  if (!Array.isArray(element.classes) || !element.classes.every((item) => typeof item === 'string'))
    return null;
  if (element.id !== null && typeof element.id !== 'string') return null;
  if (!isRecord(element.styles)) return null;
  const styles: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.styles)) {
    if (typeof value === 'string') styles[key] = value;
  }
  return {
    tag: element.tag,
    id: element.id,
    classes: element.classes,
    selector: element.selector,
    text: element.text,
    editableText: element.editableText === true,
    source: parseSource(element.source),
    rect: {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
    },
    styles,
  };
}

function parseSource(value: unknown): DesignElement['source'] {
  if (!isRecord(value) || typeof value.file !== 'string' || !value.file.trim()) return null;
  if (value.file.length > 1_000) return null;
  const line = isNumber(value.line) && value.line >= 1 ? Math.floor(value.line) : null;
  return { file: value.file, line };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const styleLabels: [string, string][] = [
  ['display', 'Display'],
  ['position', 'Posição'],
  ['color', 'Cor do texto'],
  ['backgroundColor', 'Fundo'],
  ['fontFamily', 'Fonte'],
  ['fontSize', 'Tamanho da fonte'],
  ['fontWeight', 'Peso'],
  ['lineHeight', 'Altura de linha'],
  ['margin', 'Margem'],
  ['padding', 'Preenchimento'],
  ['borderRadius', 'Raio da borda'],
];

// Styles the editor can change. Each one is also a line in the request sent to the agent.
export const editableStyles: [string, string][] = [
  ['color', 'Cor do texto'],
  ['backgroundColor', 'Fundo'],
  ['fontFamily', 'Fonte'],
  ['fontSize', 'Tamanho da fonte'],
  ['fontWeight', 'Peso'],
  ['fontStyle', 'Itálico'],
  ['textDecorationLine', 'Sublinhado'],
  ['textAlign', 'Alinhamento'],
  ['padding', 'Preenchimento'],
  ['margin', 'Margem'],
  ['borderRadius', 'Raio da borda'],
];

// A whole-file proposal has to fit in one model reply, so larger files are refused up front.
export const MAX_PROPOSAL_CHARS = 24_000;
const sourceFile = /\.(tsx?|jsx?|css|scss|html?|vue|svelte)$/i;

export const isSourceFile = (path: string) => sourceFile.test(path);

const hexByte = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');

/**
 * Turns a CSS color as the browser reports it (rgb, rgba, hex) into hex, the format the color
 * picker understands. Fully transparent colors become 'transparent'; unknown text yields ''.
 */
export function toHex(value: string): string {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return 'transparent';
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(text)) return text;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!rgb) return '';
  const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return '';
  const [r, g, b] = parts.slice(0, 3).map(Number);
  const alpha =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : Number(parts[3]);
  if ([r, g, b, alpha].some((part) => !Number.isFinite(part))) return '';
  if (alpha <= 0) return 'transparent';
  const hex = `#${hexByte(r!)}${hexByte(g!)}${hexByte(b!)}`;
  return alpha < 1 ? hex + hexByte(alpha * 255) : hex;
}

const colorStyles = new Set(['color', 'backgroundColor']);

// Values are compared after normalizing, so picking the color the element already has is no change.
function normalizeStyle(property: string, value: string): string {
  const text = value.trim();
  if (colorStyles.has(property)) return toHex(text) || text;
  if (property === 'textAlign') return text === 'start' ? 'left' : text === 'end' ? 'right' : text;
  return text;
}

/** The editor's starting values: the element's computed styles, in the editor's formats. */
export function initialValues(element: DesignElement): Record<string, string> {
  return Object.fromEntries(
    editableStyles.map(([key]) => [key, normalizeStyle(key, element.styles[key] ?? '')]),
  );
}

export interface StyleChange {
  property: string;
  from: string;
  to: string;
}

/** Only the styles whose value the user actually changed. */
export function styleChanges(
  element: DesignElement,
  values: Record<string, string>,
): StyleChange[] {
  const initial = initialValues(element);
  return editableStyles.flatMap(([property]) => {
    const to = (values[property] ?? '').trim();
    if (!to || normalizeStyle(property, to) === initial[property]) return [];
    return [{ property, from: element.styles[property] ?? '', to }];
  });
}

/** The new text, or null when the text is unchanged or cannot be edited. */
export function textChange(element: DesignElement, text: string): string | null {
  return element.editableText && text !== element.text ? text : null;
}

const toKebab = (property: string) =>
  property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export function buildStyleInstruction(
  element: DesignElement,
  changes: StyleChange[],
  note: string,
  text: string | null = null,
): string {
  const classes = element.classes.length ? ` class="${element.classes.join(' ')}"` : '';
  const id = element.id ? ` id="${element.id}"` : '';
  const target = [
    `<${element.tag}${id}${classes}>`,
    element.text ? `com o texto "${element.text}"` : '',
    `(seletor no preview: ${element.selector})`,
  ]
    .filter(Boolean)
    .join(' ');
  return [
    `Aplique mudanças visuais ao elemento ${target} neste arquivo.`,
    text !== null ? `Troque o texto do elemento para: "${text}"` : '',
    changes.length ? 'Estilos a alterar (propriedade: valor atual → novo valor):' : '',
    ...changes.map(
      (change) => `- ${toKebab(change.property)}: ${change.from || '(vazio)'} → ${change.to}`,
    ),
    note.trim() ? `Pedido adicional do usuário: ${note.trim()}` : '',
    'Localize o elemento pelas classes, pelo texto ou pela estrutura. Use o mecanismo de estilo que o projeto já usa (classes, CSS ou estilos inline).',
    'Altere somente o necessário e mantenha o restante do arquivo idêntico.',
    'Retorne o arquivo completo, já com as alterações. Se o elemento não estiver neste arquivo, não proponha alteração e explique na resposta.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** What the preview should show on the selected element right now. */
export interface DesignPreview {
  styles: Record<string, string>;
  text: string | null;
}

/** What the panel needs from the preview around it. */
export interface DesignHost {
  onPreview: (preview: DesignPreview) => void;
  /** PNG data URL of the element as the preview shows it now, or null. */
  onCapture: () => Promise<string | null>;
  /** Puts a finished note in the tray. */
  onAddNote: (note: Omit<DesignNote, 'id'>) => void;
}

export function DesignPanel({
  element,
  onClose,
  ...host
}: {
  element: DesignElement;
  onClose: () => void;
} & DesignHost) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="design-panel editing" aria-label="Elemento selecionado">
      <header className="design-panel-header">
        <div>
          <strong>
            &lt;{element.tag}
            {element.id ? `#${element.id}` : ''}&gt;
          </strong>
          <span className="design-size">
            {element.rect.width} × {element.rect.height} px
          </span>
        </div>
        <button className="icon-button" onClick={onClose} title="Fechar" aria-label="Fechar">
          <X size={14} />
        </button>
      </header>
      <code className="design-selector">{element.selector}</code>
      <DesignEditor element={element} {...host} />
      <button className="design-more" onClick={() => setExpanded((value) => !value)}>
        <ChevronDown size={13} className={expanded ? 'flip' : undefined} />
        {expanded ? 'Ocultar estilos calculados' : 'Ver estilos calculados'}
      </button>
      {expanded && (
        <dl className="design-styles">
          {styleLabels.map(([key, label]) =>
            element.styles[key] ? (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{element.styles[key]}</dd>
              </div>
            ) : null,
          )}
        </dl>
      )}
    </section>
  );
}

const palette = [
  '#000000',
  '#ffffff',
  '#6b7280',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

const fontFamilies: [string, string][] = [
  ['Inter, sans-serif', 'Inter'],
  ['Arial, sans-serif', 'Arial'],
  ['Helvetica, sans-serif', 'Helvetica'],
  ['Verdana, sans-serif', 'Verdana'],
  ["'Trebuchet MS', sans-serif", 'Trebuchet MS'],
  ['Georgia, serif', 'Georgia'],
  ["'Times New Roman', serif", 'Times New Roman'],
  ["'Courier New', monospace", 'Courier New'],
  ['system-ui, sans-serif', 'Fonte do sistema'],
];

const fontWeights: [string, string][] = [
  ['300', 'Leve'],
  ['400', 'Normal'],
  ['500', 'Médio'],
  ['600', 'Seminegrito'],
  ['700', 'Negrito'],
  ['800', 'Extranegrito'],
];

const alignments: [string, string, ReactNode][] = [
  ['left', 'Alinhar à esquerda', <AlignLeft key="left" size={14} />],
  ['center', 'Centralizar', <AlignCenter key="center" size={14} />],
  ['right', 'Alinhar à direita', <AlignRight key="right" size={14} />],
  ['justify', 'Justificar', <AlignJustify key="justify" size={14} />],
];

const firstFamily = (value: string) =>
  value
    .split(',')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '') ?? '';

/** Edits the element live in the preview and asks the agent to save the result in the code. */
export function DesignEditor({
  element,
  onPreview,
  onCapture,
  onAddNote,
}: { element: DesignElement } & DesignHost) {
  const { workers, providers, fail, notify, go } = useHive();
  const usable = usableWorkers(workers, providers);
  const worker = usable.find((item) => item.role === 'reviewer') ?? usable[0] ?? null;
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(element));
  const [text, setText] = useState(element.text);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  // Likely files for this element, best first; the first one is chosen unless the user picks.
  const [candidates, setCandidates] = useState<LocateCandidate[] | null>(null);
  const picked = useRef(false);
  const changes = styleChanges(element, values);
  const newText = textChange(element, text);
  const changedCount = changes.length + (newText !== null ? 1 : 0);

  // Every edit is mirrored on the page at once; only the changed styles are sent.
  const preview = useRef(onPreview);
  preview.current = onPreview;
  // Serialized so the effect runs only when the edit itself changes, not on every render.
  const previewKey = JSON.stringify({
    styles: Object.fromEntries(changes.map((change) => [change.property, change.to])),
    text: newText,
  });
  useEffect(() => {
    preview.current(JSON.parse(previewKey) as DesignPreview);
  }, [previewKey]);

  useEffect(() => {
    let alive = true;
    window.hive
      .invoke('fs.files')
      .then((list) => {
        if (alive) setFiles(list.filter(isSourceFile));
      })
      .catch(() => {
        if (alive) setFiles([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    window.hive
      .invoke('design.locate', {
        tag: element.tag,
        id: element.id,
        classes: element.classes.slice(0, 12),
        text: element.text.slice(0, 400),
        source: element.source,
      })
      .then((found) => {
        if (!alive) return;
        setCandidates(found);
        const best = found.find((item) => isSourceFile(item.path));
        if (best && !picked.current) setFile(best.path);
      })
      .catch(() => {
        if (alive) setCandidates([]);
      });
    return () => {
      alive = false;
    };
  }, [element]);
  const located = candidates?.find((item) => item.path === file) ?? null;

  const set = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const changed = (key: string) => changes.some((change) => change.property === key);

  function undo() {
    setValues(initialValues(element));
    setText(element.text);
  }

  async function addToTray() {
    setAdding(true);
    try {
      const image = await onCapture().catch(() => null);
      onAddNote({
        element: {
          tag: element.tag,
          id: element.id,
          classes: element.classes,
          selector: element.selector,
          text: element.text,
        },
        file: file ? { path: file, line: located?.line ?? null } : null,
        changes,
        newText,
        comment: note.trim(),
        image,
      });
      setNote('');
      notify('Anotação adicionada à bandeja.');
    } finally {
      setAdding(false);
    }
  }

  async function generate() {
    if (!worker || !file) return;
    setBusy(true);
    try {
      // The editor is large, so it is loaded only when a proposal is requested.
      const { openDoc } = await import('./code/monaco');
      const doc = await openDoc(file);
      const content = doc.model.getValue();
      if (content.length > MAX_PROPOSAL_CHARS)
        throw new Error(
          `Este arquivo tem mais de ${MAX_PROPOSAL_CHARS.toLocaleString('pt-BR')} caracteres. Edite-o pela aba Código.`,
        );
      const response = await window.hive.invoke('code.assist', {
        workerId: worker.id,
        mode: 'edit',
        path: file,
        fileContent: content,
        selection: { startOffset: 0, endOffset: content.length, text: content },
        instruction: buildStyleInstruction(element, changes, note, newText),
        history: [],
      });
      if (!response.proposal) throw new Error(response.answer);
      const proposal: AiProposal = {
        path: file,
        startOffset: 0,
        endOffset: content.length,
        original: content,
        replacement: response.proposal.replacement,
        baseContent: content,
        proposedContent: response.proposal.replacement,
        summary: response.proposal.summary,
      };
      useCode.getState().open(fileTab(file));
      useCode.getState().setPendingProposal(proposal);
      go('code');
      notify('Proposta pronta. Revise no editor antes de aceitar.');
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  const families = fontFamilies.some(([value]) => value === values.fontFamily)
    ? fontFamilies
    : [
        [values.fontFamily ?? '', `${firstFamily(values.fontFamily ?? '') || 'Atual'} (atual)`] as [
          string,
          string,
        ],
        ...fontFamilies,
      ];
  const weights = fontWeights.some(([value]) => value === values.fontWeight)
    ? fontWeights
    : [
        [values.fontWeight ?? '', `${values.fontWeight} (atual)`] as [string, string],
        ...fontWeights,
      ];
  const underline = (values.textDecorationLine ?? '').includes('underline');

  return (
    <section className="design-editor" aria-label="Editar elemento">
      {element.editableText && (
        <DesignGroup title="Texto">
          <textarea
            className={newText !== null ? 'changed' : undefined}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="Texto do elemento"
          />
        </DesignGroup>
      )}

      <DesignGroup title="Cores">
        <ColorField
          label="Texto"
          value={values.color ?? ''}
          changed={changed('color')}
          onChange={(value) => set('color', value)}
        />
        <ColorField
          label="Fundo"
          value={values.backgroundColor ?? ''}
          changed={changed('backgroundColor')}
          allowTransparent
          onChange={(value) => set('backgroundColor', value)}
        />
      </DesignGroup>

      <DesignGroup title="Tipografia">
        <div className="design-row">
          <select
            className={changed('fontFamily') ? 'changed' : undefined}
            value={values.fontFamily ?? ''}
            onChange={(event) => set('fontFamily', event.target.value)}
            aria-label="Fonte"
          >
            {families.map(([value, label]) => (
              <option key={value} value={value} style={{ fontFamily: value }}>
                {label}
              </option>
            ))}
          </select>
          <select
            className={changed('fontWeight') ? 'changed' : undefined}
            value={values.fontWeight ?? ''}
            onChange={(event) => set('fontWeight', event.target.value)}
            aria-label="Peso da fonte"
          >
            {weights.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <SizeField
          label="Tamanho"
          value={values.fontSize ?? ''}
          max={96}
          min={8}
          changed={changed('fontSize')}
          onChange={(value) => set('fontSize', value)}
        />
        <div className="design-row design-toolbar">
          <div className="design-buttons" role="group" aria-label="Estilo do texto">
            <button
              type="button"
              className={values.fontStyle === 'italic' ? 'active' : undefined}
              aria-pressed={values.fontStyle === 'italic'}
              title="Itálico"
              onClick={() => set('fontStyle', values.fontStyle === 'italic' ? 'normal' : 'italic')}
            >
              <Italic size={14} />
            </button>
            <button
              type="button"
              className={underline ? 'active' : undefined}
              aria-pressed={underline}
              title="Sublinhado"
              onClick={() => set('textDecorationLine', underline ? 'none' : 'underline')}
            >
              <Underline size={14} />
            </button>
          </div>
          <div className="design-buttons" role="group" aria-label="Alinhamento">
            {alignments.map(([value, label, icon]) => (
              <button
                key={value}
                type="button"
                className={values.textAlign === value ? 'active' : undefined}
                aria-pressed={values.textAlign === value}
                title={label}
                onClick={() => set('textAlign', value)}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </DesignGroup>

      <DesignGroup title="Espaço e forma">
        <SizeField
          label="Espaço interno"
          hint="todos os lados"
          value={values.padding ?? ''}
          max={80}
          changed={changed('padding')}
          onChange={(value) => set('padding', value)}
        />
        <SizeField
          label="Espaço externo"
          hint="todos os lados"
          value={values.margin ?? ''}
          max={80}
          changed={changed('margin')}
          onChange={(value) => set('margin', value)}
        />
        <SizeField
          label="Cantos arredondados"
          value={values.borderRadius ?? ''}
          max={60}
          changed={changed('borderRadius')}
          onChange={(value) => set('borderRadius', value)}
        />
      </DesignGroup>

      <div className="design-status">
        <span className="design-count">
          {changedCount
            ? `${changedCount} alteração(ões) no preview`
            : 'Clique e ajuste: o preview muda na hora'}
        </span>
        <button
          type="button"
          className="design-more"
          onClick={undo}
          disabled={!changedCount}
          title="Voltar ao original"
        >
          <RotateCcw size={12} /> Desfazer
        </button>
      </div>

      <DesignGroup title="Levar para o código">
        <p className="design-hint-inline">
          As mudanças acima aparecem só no preview. Junte vários ajustes na bandeja e envie todos
          para um agente, ou aplique só este agora com a IA.
        </p>
        <div className="design-located" role="status">
          {candidates === null ? (
            'Procurando o arquivo deste elemento…'
          ) : located ? (
            <>
              <FileSearch size={13} />
              <span>
                {located.reason === 'framework' ? 'Informado pela página' : 'Encontrado pelo texto'}
                : <code>{located.path + (located.line ? `:${located.line}` : '')}</code>
              </span>
            </>
          ) : file ? (
            'Arquivo escolhido à mão.'
          ) : (
            'Não achei o arquivo. Escolha abaixo, ou deixe o agente procurar.'
          )}
        </div>
        <select
          value={file}
          onChange={(event) => {
            picked.current = true;
            setFile(event.target.value);
          }}
          disabled={!files.length}
          aria-label="Arquivo do componente"
        >
          <option value="">
            {files.length ? 'Arquivo do componente' : 'Nenhum arquivo de código encontrado'}
          </option>
          {!!candidates?.length && (
            <optgroup label="Prováveis">
              {candidates.map((item) => (
                <option key={`likely-${item.path}`} value={item.path}>
                  {item.path + (item.line ? `:${item.line}` : '')}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Todos os arquivos">
            {files.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </optgroup>
        </select>
        <textarea
          rows={2}
          value={note}
          placeholder="O que mudar, em palavras (opcional)"
          onChange={(event) => setNote(event.target.value)}
          aria-label="O que mudar"
        />
        <div className="design-send">
          <button
            type="button"
            className="secondary"
            onClick={() => void addToTray()}
            disabled={adding || (!changedCount && !note.trim())}
            title="Guarda este ajuste para enviar junto com outros"
          >
            <Inbox size={13} /> {adding ? 'Adicionando…' : 'Adicionar à bandeja'}
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => void generate()}
            disabled={busy || !worker || !file || (!changedCount && !note.trim())}
          >
            <Sparkles size={13} /> {busy ? 'Gerando…' : 'Aplicar agora'}
          </button>
        </div>
        {!worker && (
          <p className="design-hint-inline">
            Configure um agente com provedor e modelo para usar a IA.
          </p>
        )}
      </DesignGroup>
    </section>
  );
}

function DesignGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="design-group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

function ColorField({
  label,
  value,
  changed,
  allowTransparent = false,
  onChange,
}: {
  label: string;
  value: string;
  changed: boolean;
  allowTransparent?: boolean;
  onChange: (value: string) => void;
}) {
  const hex = toHex(value);
  const transparent = hex === 'transparent';
  // The native picker only takes #rrggbb, so alpha is dropped there.
  const pickerValue = hex && !transparent ? hex.slice(0, 7) : '#ffffff';
  return (
    <div className={changed ? 'design-color changed' : 'design-color'}>
      <span className="design-label">{label}</span>
      <div className="design-color-row">
        <label
          className={transparent ? 'design-swatch transparent' : 'design-swatch'}
          style={{ '--swatch': transparent ? 'transparent' : value } as CSSProperties}
          title="Escolher cor"
        >
          <input
            type="color"
            value={pickerValue}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`Escolher ${label.toLowerCase()}`}
          />
        </label>
        <input
          className="design-hex"
          value={transparent ? 'transparente' : value}
          onChange={(event) =>
            onChange(event.target.value === 'transparente' ? 'transparent' : event.target.value)
          }
          spellCheck={false}
          aria-label={`Código da cor: ${label.toLowerCase()}`}
        />
      </div>
      <div
        className="design-palette"
        role="group"
        aria-label={`Cores rápidas: ${label.toLowerCase()}`}
      >
        {allowTransparent && (
          <button
            type="button"
            className={transparent ? 'design-chip transparent active' : 'design-chip transparent'}
            title="Sem fundo"
            aria-label="Sem fundo"
            onClick={() => onChange('transparent')}
          />
        )}
        {palette.map((color) => (
          <button
            key={color}
            type="button"
            className={hex === color ? 'design-chip active' : 'design-chip'}
            style={{ background: color }}
            title={color}
            aria-label={color}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  );
}

/** A px value with a slider. Multi-value inputs (e.g. "10px 18px") start from the first value. */
function SizeField({
  label,
  hint,
  value,
  min = 0,
  max,
  changed,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  min?: number;
  max: number;
  changed: boolean;
  onChange: (value: string) => void;
}) {
  const parsed = parseFloat(value);
  const number = Number.isFinite(parsed) ? Math.round(parsed) : min;
  return (
    <div className={changed ? 'design-size-field changed' : 'design-size-field'}>
      <span className="design-label">
        {label}
        {hint && <small> · {hint}</small>}
      </span>
      <div className="design-row">
        <input
          type="range"
          min={min}
          max={Math.max(max, number)}
          value={number}
          onChange={(event) => onChange(`${event.target.value}px`)}
          aria-label={label}
        />
        <div className="design-number">
          <input
            type="number"
            min={min}
            value={number}
            onChange={(event) => onChange(`${event.target.value || 0}px`)}
            aria-label={`${label} em pixels`}
          />
          <span>px</span>
        </div>
      </div>
    </div>
  );
}
