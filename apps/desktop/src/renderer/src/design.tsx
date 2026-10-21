import { useEffect, useState } from 'react';
import { ChevronDown, Pencil, Sparkles, X } from 'lucide-react';
import { fileTab, useCode, type AiProposal } from './code/store';
import { useHive, usableWorkers } from './context';

// Shape of the element report sent by the inspector injected into the preview page.
export interface DesignElement {
  tag: string;
  id: string | null;
  classes: string[];
  selector: string;
  text: string;
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
    rect: {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
    },
    styles,
  };
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
  ['fontSize', 'Tamanho da fonte'],
  ['padding', 'Preenchimento'],
  ['margin', 'Margem'],
  ['borderRadius', 'Raio da borda'],
];

// A whole-file proposal has to fit in one model reply, so larger files are refused up front.
export const MAX_PROPOSAL_CHARS = 24_000;
const sourceFile = /\.(tsx?|jsx?|css|scss|html?|vue|svelte)$/i;

export const isSourceFile = (path: string) => sourceFile.test(path);

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
  return editableStyles.flatMap(([property]) => {
    const from = element.styles[property] ?? '';
    const to = (values[property] ?? '').trim();
    return to && to !== from ? [{ property, from, to }] : [];
  });
}

const toKebab = (property: string) =>
  property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export function buildStyleInstruction(
  element: DesignElement,
  changes: StyleChange[],
  note: string,
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

export function DesignPanel({ element, onClose }: { element: DesignElement; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const visible = styleLabels.filter(([key]) => expanded || primaryStyles.has(key));
  return (
    <section
      className={editing ? 'design-panel editing' : 'design-panel'}
      aria-label="Elemento selecionado"
    >
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
      {element.text && <p className="design-text">{element.text}</p>}
      {editing ? (
        <DesignEditor element={element} />
      ) : (
        <dl className="design-styles">
          {visible.map(([key, label]) =>
            element.styles[key] ? (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{element.styles[key]}</dd>
              </div>
            ) : null,
          )}
        </dl>
      )}
      <div className="design-actions">
        {!editing && (
          <button className="design-more" onClick={() => setExpanded((value) => !value)}>
            <ChevronDown size={13} className={expanded ? 'flip' : undefined} />
            {expanded ? 'Menos estilos' : 'Todos os estilos'}
          </button>
        )}
        <button
          className={editing ? 'design-more active' : 'design-more'}
          onClick={() => setEditing((value) => !value)}
        >
          <Pencil size={12} />
          {editing ? 'Voltar aos estilos' : 'Editar estilos'}
        </button>
      </div>
    </section>
  );
}

// The primary styles are the ones that usually explain a look; the rest sit behind a toggle.
const primaryStyles = new Set(['color', 'backgroundColor', 'fontSize', 'padding', 'margin']);

/** Edits a few styles and asks the agent for a reviewable proposal in the Code view. */
export function DesignEditor({ element }: { element: DesignElement }) {
  const { workers, providers, fail, notify, go } = useHive();
  const usable = usableWorkers(workers, providers);
  const worker = usable.find((item) => item.role === 'reviewer') ?? usable[0] ?? null;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(editableStyles.map(([key]) => [key, element.styles[key] ?? ''])),
  );
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const changes = styleChanges(element, values);

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
        instruction: buildStyleInstruction(element, changes, note),
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

  return (
    <section className="design-editor" aria-label="Editar estilos">
      <div className="design-fields">
        {editableStyles.map(([key, label]) => (
          <label key={key} className={values[key] !== element.styles[key] ? 'changed' : undefined}>
            <span>{label}</span>
            <input
              value={values[key] ?? ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [key]: event.target.value }))
              }
              spellCheck={false}
            />
          </label>
        ))}
      </div>
      <label className="design-field">
        <span>Arquivo do componente</span>
        <select
          value={file}
          onChange={(event) => setFile(event.target.value)}
          disabled={!files.length}
        >
          <option value="">
            {files.length ? 'Escolha o arquivo' : 'Nenhum arquivo de código encontrado'}
          </option>
          {files.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </label>
      <label className="design-field">
        <span>Observação para o agente (opcional)</span>
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="design-submit">
        <span className="design-count">
          {changes.length ? `${changes.length} alteração(ões)` : 'Sem alterações de estilo'}
        </span>
        <button
          className="primary"
          type="button"
          onClick={() => void generate()}
          disabled={busy || !worker || !file || (!changes.length && !note.trim())}
        >
          <Sparkles size={13} /> {busy ? 'Gerando proposta…' : 'Gerar proposta com a IA'}
        </button>
      </div>
      {!worker && (
        <p className="design-hint">Configure um agente com provedor e modelo para usar a IA.</p>
      )}
    </section>
  );
}
