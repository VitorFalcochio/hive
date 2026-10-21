import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CaseSensitive, ChevronDown, FileText, Regex, Search, WholeWord, X } from 'lucide-react';
import type { SearchMatch, SearchResult } from '@hive/core';
import { useCode } from './code/store';
import { message, useHive } from './context';
import { Empty, PageHeader } from './ui';

const DEBOUNCE_MS = 250;

interface FileGroup {
  path: string;
  matches: SearchMatch[];
}

const fileName = (path: string) => path.split('/').pop() ?? path;
const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');

/** Results of one file together, in the order git reported the files. */
export function groupByFile(matches: SearchMatch[]): FileGroup[] {
  const groups = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const list = groups.get(match.path);
    if (list) list.push(match);
    else groups.set(match.path, [match]);
  }
  return [...groups].map(([path, items]) => ({ path, matches: items }));
}

/** The line as shown: leading indentation dropped, the match split out for highlighting. */
export function previewParts(match: SearchMatch) {
  const indent = match.text.length - match.text.trimStart().length;
  const text = match.text.slice(indent);
  const start = Math.max(0, match.column - 1 - indent);
  const end = Math.min(text.length, start + match.length);
  return { before: text.slice(0, start), hit: text.slice(start, end), after: text.slice(end) };
}

export function SearchPage() {
  const { summary, go } = useHive();
  const workspace = summary?.workspace ?? null;
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Searches as you type; an answer that arrives after a newer request is dropped.
  useEffect(() => {
    const text = query.trim();
    const id = ++request.current;
    if (!workspace || text.length < 2) {
      setResult(null);
      setError('');
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      window.hive
        .invoke('fs.search', { query: text, caseSensitive, wholeWord, regex })
        .then((next) => {
          if (id !== request.current) return;
          setResult(next);
          setError('');
          setCollapsed([]);
        })
        .catch((failure: unknown) => {
          if (id !== request.current) return;
          setResult(null);
          setError(message(failure));
        })
        .finally(() => {
          if (id === request.current) setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, wholeWord, regex, workspace]);

  const groups = useMemo(() => groupByFile(result?.matches ?? []), [result]);

  function open(path: string, line = 1, column = 1, length = 0) {
    useCode.getState().revealAt({ path, line, column, length });
    go('code');
  }

  const toggle = (path: string) =>
    setCollapsed((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );

  const total = result ? result.matches.length : 0;
  const empty = result && !total && !result.files.length;

  return (
    <>
      <PageHeader
        eyebrow={workspace?.name ?? 'Projeto'}
        title="Buscar"
        description="Procura nos nomes e no conteúdo de todos os arquivos do projeto, inclusive os que ainda não foram commitados. Pastas do .gitignore ficam de fora."
      />
      {!workspace ? (
        <Empty>Abra um projeto para buscar nos arquivos dele.</Empty>
      ) : (
        <>
          <div className="search-bar">
            <Search size={15} className="search-icon" aria-hidden="true" />
            <input
              ref={input}
              value={query}
              maxLength={200}
              spellCheck={false}
              placeholder="Buscar no projeto"
              aria-label="Buscar no projeto"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
            />
            {query && (
              <button
                className="search-option"
                title="Limpar"
                aria-label="Limpar busca"
                onClick={() => {
                  setQuery('');
                  input.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
            <span className="search-divider" aria-hidden="true" />
            <SearchOption
              label="Diferenciar maiúsculas"
              active={caseSensitive}
              onToggle={() => setCaseSensitive((value) => !value)}
            >
              <CaseSensitive size={16} />
            </SearchOption>
            <SearchOption
              label="Palavra inteira"
              active={wholeWord}
              onToggle={() => setWholeWord((value) => !value)}
            >
              <WholeWord size={16} />
            </SearchOption>
            <SearchOption
              label="Expressão regular"
              active={regex}
              onToggle={() => setRegex((value) => !value)}
            >
              <Regex size={16} />
            </SearchOption>
          </div>

          <p className="search-summary" role="status">
            {error ? (
              <span className="error-text">{error}</span>
            ) : busy ? (
              'Buscando…'
            ) : result ? (
              <>
                {total} resultado(s) em {groups.length} arquivo(s)
                {result.files.length ? ` · ${result.files.length} nome(s) de arquivo` : ''}
                {result.truncated && ' · mostrando os primeiros 2.000'}
              </>
            ) : (
              'Digite ao menos 2 caracteres.'
            )}
          </p>

          {empty && <Empty>Nada encontrado para “{query.trim()}”.</Empty>}

          {!!result?.files.length && (
            <section className="search-section">
              <h2>Arquivos</h2>
              <ul className="search-files">
                {result.files.map((path) => (
                  <li key={path}>
                    <button onClick={() => open(path)}>
                      <FileText size={14} />
                      <span className="search-file-name">{fileName(path)}</span>
                      <span className="search-file-folder">{folderOf(path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!!groups.length && (
            <section className="search-section">
              <h2>No conteúdo</h2>
              {groups.map((group) => {
                const expanded = !collapsed.includes(group.path);
                return (
                  <div key={group.path} className="search-group">
                    <button
                      className="search-group-head"
                      aria-expanded={expanded}
                      onClick={() => toggle(group.path)}
                    >
                      <ChevronDown size={13} className={expanded ? 'chevron open' : 'chevron'} />
                      <FileText size={14} />
                      <span className="search-file-name">{fileName(group.path)}</span>
                      <span className="search-file-folder">{folderOf(group.path)}</span>
                      <span className="search-count">{group.matches.length}</span>
                    </button>
                    {expanded && (
                      <ul className="search-lines">
                        {group.matches.map((match) => {
                          const parts = previewParts(match);
                          return (
                            <li key={`${match.line}:${match.column}`}>
                              <button
                                onClick={() =>
                                  open(match.path, match.line, match.column, match.length)
                                }
                              >
                                <span className="search-line-number">{match.line}</span>
                                <span className="search-line-text">
                                  {parts.before}
                                  {parts.hit && <mark>{parts.hit}</mark>}
                                  {parts.after}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}
    </>
  );
}

function SearchOption({
  label,
  active,
  onToggle,
  children,
}: {
  label: string;
  active: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <button
      className={active ? 'search-option active' : 'search-option'}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}
