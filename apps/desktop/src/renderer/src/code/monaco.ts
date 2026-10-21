import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import { useCode } from './store';

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    return new EditorWorker();
  },
};

// Files are edited one at a time, without the project's types or node_modules: semantic errors
// would mostly be false "cannot find module" reports, so only syntax errors are shown.
for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
  });
}

monaco.editor.defineTheme('hive', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#08090a',
    'editorGutter.background': '#08090a',
    'editor.lineHighlightBackground': '#ffffff08',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#3b3e44',
    'editorLineNumber.activeForeground': '#8a8f98',
    'editor.selectionBackground': '#ffffff26',
    'editor.inactiveSelectionBackground': '#ffffff14',
    'editorIndentGuide.background1': '#ffffff0d',
    'editorIndentGuide.activeBackground1': '#ffffff24',
    'editorWidget.background': '#141517',
    'editorWidget.border': '#ffffff24',
    'editorSuggestWidget.background': '#141517',
    'editorSuggestWidget.selectedBackground': '#ffffff14',
    'diffEditor.insertedTextBackground': '#4cd6a01f',
    'diffEditor.removedTextBackground': '#f871851f',
    'diffEditor.insertedLineBackground': '#4cd6a010',
    'diffEditor.removedLineBackground': '#f8718510',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff22',
  },
});

export const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'hive',
  automaticLayout: true,
  fontFamily: "'JetBrains Mono Variable', Consolas, monospace",
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderLineHighlight: 'line',
  padding: { top: 10 },
  tabSize: 2,
  fixedOverflowWidgets: true,
};

export { monaco };

interface Doc {
  model: monaco.editor.ITextModel;
  /** Version that matches the file on disk. */
  savedVersion: number;
  mtimeMs: number;
}

// Each project keeps its own models, so the same relative path can be open in two projects.
const docsByProject = new Map<string, Map<string, Doc>>();
const loadingByProject = new Map<string, Map<string, Promise<Doc>>>();

function projectMap<T>(store: Map<string, Map<string, T>>): Map<string, T> {
  const project = useCode.getState().project ?? '';
  let map = store.get(project);
  if (!map) {
    map = new Map();
    store.set(project, map);
  }
  return map;
}

/** Documents of the project in front. */
const docs = () => projectMap(docsByProject);
const loading = () => projectMap(loadingByProject);

const uriFor = (path: string) => monaco.Uri.file(`/${useCode.getState().project ?? ''}/${path}`);

export class UnopenableFile extends Error {}

/** Load a workspace file into a Monaco model once; later calls reuse it. */
export function openDoc(path: string): Promise<Doc> {
  const existing = docs().get(path);
  if (existing && !existing.model.isDisposed()) return Promise.resolve(existing);
  const pending = loading().get(path);
  if (pending) return pending;
  const promise = window.hive
    .invoke('fs.read', { path })
    .then((file) => {
      if (file.content === null)
        throw new UnopenableFile(
          file.binary
            ? 'Arquivo binário: não pode ser aberto no editor.'
            : 'Arquivo grande demais para o editor (mais de 5 MB).',
        );
      const model = monaco.editor.createModel(file.content, undefined, uriFor(path));
      const doc: Doc = {
        model,
        savedVersion: model.getAlternativeVersionId(),
        mtimeMs: file.mtimeMs,
      };
      model.onDidChangeContent(() =>
        useCode.getState().setDirty(path, model.getAlternativeVersionId() !== doc.savedVersion),
      );
      docs().set(path, doc);
      return doc;
    })
    .finally(() => loading().delete(path));
  loading().set(path, promise);
  return promise;
}

/** Releases the models of a project whose tab was closed. */
export function disposeProjectDocs(project: string): void {
  const map = docsByProject.get(project);
  if (map) for (const doc of map.values()) doc.model.dispose();
  docsByProject.delete(project);
  loadingByProject.delete(project);
}

export function getDoc(path: string): Doc | undefined {
  return docs().get(path);
}

export interface AiTextEdit {
  path: string;
  startOffset: number;
  endOffset: number;
  original: string;
  replacement: string;
  baseContent: string;
}

/** Apply a reviewed AI proposal to the open model as one undoable edit. */
export function applyAiTextEdit(edit: AiTextEdit): void {
  const doc = docs().get(edit.path);
  if (!doc) throw new Error('O arquivo da proposta não está mais aberto.');
  const current = doc.model.getValue();
  if (current !== edit.baseContent)
    throw new Error('O arquivo mudou depois que a proposta foi criada. Gere uma nova proposta.');
  if (current.slice(edit.startOffset, edit.endOffset) !== edit.original)
    throw new Error('O trecho selecionado mudou. Gere uma nova proposta.');
  const range = monaco.Range.fromPositions(
    doc.model.getPositionAt(edit.startOffset),
    doc.model.getPositionAt(edit.endOffset),
  );
  doc.model.pushStackElement();
  doc.model.pushEditOperations([], [{ range, text: edit.replacement }], () => null);
  doc.model.pushStackElement();
  if (useCode.getState().selection?.path === edit.path) useCode.getState().setSelection(null);
}

/** Save to disk. Throws a CONFLICT error when the file changed elsewhere, unless forced. */
export async function saveDoc(path: string, force = false): Promise<void> {
  const doc = docs().get(path);
  if (!doc) return;
  const version = doc.model.getAlternativeVersionId();
  const { mtimeMs } = await window.hive.invoke('fs.write', {
    path,
    content: doc.model.getValue(),
    expectedMtimeMs: force ? null : doc.mtimeMs,
  });
  doc.mtimeMs = mtimeMs;
  doc.savedVersion = version;
  const store = useCode.getState();
  store.setDirty(path, doc.model.getAlternativeVersionId() !== version);
  store.setConflict(path, false);
}

/** Replace the model with the disk version, keeping undo history. */
export async function reloadDoc(path: string): Promise<void> {
  const doc = docs().get(path);
  if (!doc) return;
  const file = await window.hive.invoke('fs.read', { path }).catch(() => null);
  if (!file || file.content === null) return;
  if (file.content !== doc.model.getValue())
    doc.model.pushEditOperations(
      [],
      [{ range: doc.model.getFullModelRange(), text: file.content }],
      () => null,
    );
  doc.mtimeMs = file.mtimeMs;
  doc.savedVersion = doc.model.getAlternativeVersionId();
  const store = useCode.getState();
  store.setDirty(path, false);
  store.setConflict(path, false);
}

/**
 * React to changes on disk (agents applying work, git checkout, other editors): clean files are
 * reloaded silently; files with unsaved edits are flagged as conflicts instead of overwritten.
 */
export async function syncFromDisk(paths: string[]): Promise<void> {
  for (const path of paths) {
    const doc = docs().get(path);
    if (!doc) continue;
    const file = await window.hive.invoke('fs.read', { path }).catch(() => null);
    if (!file) {
      useCode.getState().forget(path);
      continue;
    }
    if (Math.abs(file.mtimeMs - doc.mtimeMs) <= 1) continue;
    if (useCode.getState().dirty[path]) useCode.getState().setConflict(path, true);
    else await reloadDoc(path);
  }
}

/** Every open document, e.g. after a branch switch. */
export function openPaths(): string[] {
  return [...docs().keys()];
}

function languageFor(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const extension = name.includes('.') ? `.${name.split('.').pop()}` : '';
  return (
    monaco.languages
      .getLanguages()
      .find(
        (language) =>
          (extension && language.extensions?.includes(extension)) ||
          language.filenames?.some((file) => file.toLowerCase() === name),
      )?.id ?? 'plaintext'
  );
}

/** Read-only models for diff panes, keyed so they can be reused. */
const diffModels = new Map<string, monaco.editor.ITextModel>();

export function diffModel(key: string, path: string, content: string): monaco.editor.ITextModel {
  const existing = diffModels.get(key);
  if (existing && !existing.isDisposed()) {
    if (existing.getValue() !== content) existing.setValue(content);
    return existing;
  }
  const model = monaco.editor.createModel(
    content,
    languageFor(path),
    monaco.Uri.parse(`hive-diff:/${encodeURIComponent(key)}/${path}`),
  );
  diffModels.set(key, model);
  return model;
}
