import { Fragment, useMemo, useState } from 'react';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import type { ReviewComment } from '@hive/core';
import { anchorKey, anchorOf, parsePatch, type DiffLine } from './review';

/**
 * A task's diff, line by line. While `editable`, hovering a line shows a button to leave a
 * comment on it; comments sit under their line until they are sent to the agent.
 */
export function ReviewDiff({
  patch,
  comments,
  editable,
  onChange,
}: {
  patch: string;
  comments: ReviewComment[];
  editable: boolean;
  onChange(comments: ReviewComment[]): void;
}) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const [composing, setComposing] = useState<string | null>(null);
  const byLine = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const key = anchorKey(comment);
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [comments]);

  if (!files.length) return <p className="review-empty">Nenhuma alteração.</p>;

  return (
    <div className="review-diff">
      {files.map((file) => (
        <section key={file.path} className="review-file">
          <header className="review-file-head">
            <code>{file.path}</code>
          </header>
          <table className="review-lines">
            <tbody>
              {file.lines.map((line, index) => {
                const anchor = anchorOf(file.path, line);
                const key = anchor ? anchorKey(anchor) : null;
                const notes = key ? (byLine.get(key) ?? []) : [];
                return (
                  <Fragment key={index}>
                    <tr className={`review-line kind-${line.kind}`}>
                      <td className="review-num">{line.oldLine ?? ''}</td>
                      <td className="review-num">{line.newLine ?? ''}</td>
                      <td className="review-code">
                        {editable && anchor && (
                          <button
                            className="review-add"
                            title="Comentar esta linha"
                            aria-label={`Comentar a linha ${anchor.line} de ${file.path}`}
                            onClick={() => setComposing(key)}
                          >
                            <MessageSquarePlus size={13} />
                          </button>
                        )}
                        <span className="review-sign">{sign(line)}</span>
                        <span className="review-text">{line.text || ' '}</span>
                      </td>
                    </tr>
                    {notes.map((note, position) => (
                      <tr key={`note-${position}`} className="review-note-row">
                        <td colSpan={3}>
                          <div className="review-note">
                            <p>{note.body}</p>
                            {editable && (
                              <button
                                className="icon-button"
                                title="Apagar comentário"
                                aria-label="Apagar comentário"
                                onClick={() => onChange(comments.filter((item) => item !== note))}
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {anchor && composing === key && (
                      <tr className="review-note-row">
                        <td colSpan={3}>
                          <CommentEditor
                            onCancel={() => setComposing(null)}
                            onSave={(body) => {
                              onChange([...comments, { ...anchor, body }]);
                              setComposing(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

const sign = (line: DiffLine) => (line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : '');

function CommentEditor({ onSave, onCancel }: { onSave(body: string): void; onCancel(): void }) {
  const [body, setBody] = useState('');
  const save = () => {
    if (body.trim()) onSave(body.trim());
  };
  return (
    <div className="review-editor">
      <textarea
        autoFocus
        rows={3}
        maxLength={4000}
        value={body}
        placeholder="O que o agente deve mudar aqui?"
        aria-label="Comentário"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="review-editor-actions">
        <small>Ctrl+Enter para salvar · Esc para cancelar</small>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" disabled={!body.trim()} onClick={save}>
          Comentar
        </button>
      </div>
    </div>
  );
}
