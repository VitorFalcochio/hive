import { useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import {
  resultUpdate,
  type CanvasSnapshot,
  type LiveResult,
  type ResultEventPage,
} from '@hive/core';
import { Markdown } from '../markdown';
import { useMissionNotes } from './use-live-result';

const testLabels = {
  running: 'Em execução',
  passed: 'Aprovado',
  failed: 'Falhou',
  unverified: 'Não verificado',
};

export function LiveResultPanel({
  result,
  error,
  snapshot,
  onClose,
}: {
  result: LiveResult | null;
  error: string;
  snapshot: CanvasSnapshot;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'report' | 'notes'>('report');
  const [preview, setPreview] = useState(false);
  const notes = useMissionNotes(snapshot.detail.mission.id);
  const [history, setHistory] = useState<ResultEventPage['events']>([]);
  const [hasMore, setHasMore] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyRetry, setHistoryRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const latest = useRef<number | undefined>(undefined);
  const runId = snapshot.detail.run.id;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [onClose]);
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        let more = true;
        while (alive && more) {
          const initial = latest.current === undefined;
          const page = await window.hive.invoke('canvas.result.events', {
            runId,
            after: latest.current,
            limit: 100,
          });
          if (!alive) return;
          latest.current = page.events.at(-1)?.cursor ?? latest.current ?? 0;
          setHistory((current) =>
            [
              ...new Map(
                [...current, ...page.events].map((item) => [item.event.id, item]),
              ).values(),
            ].sort((a, b) => a.cursor - b.cursor),
          );
          if (initial) setHasMore(page.hasMore);
          // New events use a forward cursor, so bursts cannot leave gaps between pages.
          more = !initial && page.hasMore;
        }
        setHistoryError('');
      } catch (failure) {
        if (alive) {
          setHistoryError(String(failure));
          retry = setTimeout(() => setHistoryRetry((attempt) => attempt + 1), 2000);
        }
      }
    };
    void read();
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [runId, result?.cursor, historyRetry]);
  const older = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const page = await window.hive.invoke('canvas.result.events', {
        runId,
        before: history[0]?.cursor,
        limit: 100,
      });
      setHistory((current) =>
        [
          ...new Map([...page.events, ...current].map((item) => [item.event.id, item])).values(),
        ].sort((a, b) => a.cursor - b.cursor),
      );
      setHasMore(page.hasMore);
      setHistoryError('');
    } catch (failure) {
      setHistoryError(String(failure));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="nc-overlay" role="dialog" aria-modal="true" aria-label="Resultado Vivo">
      <div className="nc-overlay-window nc-result-window">
        <header className="nc-window-head">
          <FileText size={20} />
          <div className="nc-window-title">
            <strong>Resultado Vivo</strong>
            <span>{snapshot.detail.mission.title}</span>
          </div>
          <button
            className="icon-button"
            aria-label="Fechar Resultado Vivo"
            onClick={onClose}
            autoFocus
          >
            <X size={16} />
          </button>
        </header>
        <nav className="nc-result-tabs" aria-label="Conteúdo do Resultado Vivo">
          <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>
            Relatório automático
          </button>
          <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
            Minhas Notas
          </button>
        </nav>
        {tab === 'notes' ? (
          <div className="nc-result-notes">
            <div className="nc-result-note-toolbar">
              <span role="status">{notes.status}</span>
              <button className="ghost" onClick={() => setPreview(!preview)}>
                {preview ? 'Editar Markdown' : 'Visualizar Markdown'}
              </button>
              <button className="ghost" onClick={notes.retry}>
                Salvar / tentar novamente
              </button>
            </div>
            <p className="nc-sub">
              Notas pessoais desta missão. Atualizações automáticas preservam este conteúdo.
            </p>
            {notes.recoveries.length > 0 && (
              <details className="nc-result-conflict">
                <summary>
                  Rascunhos recuperáveis de outras sessões ({notes.recoveries.length})
                </summary>
                <p>Compare e copie os trechos que deseja manter no editor antes de salvar.</p>
                {notes.recoveries.map((draft) => (
                  <pre key={draft.key}>{draft.text}</pre>
                ))}
              </details>
            )}
            {notes.conflict && (
              <div role="alert" className="nc-result-conflict">
                <strong>Versão salva em outra janela</strong>
                <pre>{notes.saved || '(vazia)'}</pre>
                <p>
                  Seu rascunho permanece no editor. Copie ou combine os trechos antes de salvar.
                </p>
                <button onClick={notes.resolve}>Salvar meu texto revisado sobre esta versão</button>
              </div>
            )}
            {preview ? (
              <div className="nc-result-note-preview">
                <Markdown source={notes.text} />
              </div>
            ) : (
              <textarea
                aria-label="Minhas Notas em Markdown"
                spellCheck
                value={notes.text}
                disabled={!notes.ready}
                maxLength={200_000}
                placeholder={'# Minhas Notas\n\n- Observações\n- [ ] Revisar\n\n```\ncódigo\n```'}
                onChange={(event) => notes.change(event.target.value)}
              />
            )}
          </div>
        ) : (
          <div className="nc-result-content">
            <p className="nc-result-mode">
              Agregação factual determinística. Sumarização narrativa por IA ainda não habilitada.
              Cada registro indica sua fonte; testes sem evidência permanecem não verificados.
            </p>
            {error && <p role="alert">Não foi possível sincronizar: {error}</p>}
            {!result ? (
              <p>Carregando relatório…</p>
            ) : (
              <>
                <section>
                  <h3>Resumo da missão</h3>
                  <p className="nc-result-summary">{result.summary}</p>
                  <p className="nc-sub">
                    Referência: run:{result.runId} · cursor:{result.cursor} · {result.changeCount}{' '}
                    alterações ·{' '}
                    {result.updatedAt ? new Date(result.updatedAt).toLocaleString('pt-BR') : '—'}
                  </p>
                </section>
                {(
                  [
                    ['Implementado', result.completed],
                    ['Em andamento', result.active],
                    ['Falta concluir', result.remaining],
                    ['Riscos e pendências', result.risks],
                    ['Próximas ações previstas pelo motor', result.next],
                  ] as const
                ).map(([title, items]) => (
                  <section key={title}>
                    <h3>{title}</h3>
                    {items.length ? (
                      <ul>
                        {items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted-text">Nenhum registro.</p>
                    )}
                  </section>
                ))}
                <section>
                  <h3>Arquivos modificados</h3>
                  {!result.files.length && (
                    <p className="muted-text">Nenhuma alteração registrada.</p>
                  )}
                  <ul>
                    {result.files.map((file) => (
                      <li key={`${file.taskId}:${file.path}`}>
                        <code>{file.path}</code> · {file.status}
                        <small>
                          Tarefa: {file.taskId} · Fonte: {file.evidence}
                          {file.commit && ` · commit: ${file.commit}`}
                          {file.worktree && ` · worktree: ${file.worktree}`}
                        </small>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>Testes</h3>
                  {!result.tests.length && (
                    <p>Não executado: nenhuma evidência de testes registrada.</p>
                  )}
                  <ul>
                    {result.tests.map((test) => (
                      <li key={test.id}>
                        <strong className={`nc-test-${test.status}`}>
                          {testLabels[test.status]}
                        </strong>{' '}
                        · <code>{test.command}</code>
                        <small>
                          Tarefa: {test.taskId} · Fonte: {test.evidence}
                        </small>
                        {test.output && (
                          <details>
                            <summary>Saída registrada</summary>
                            <pre>{test.output}</pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}
            <section>
              <h3>Linha do tempo</h3>
              {historyError && <p role="alert">Falha ao carregar histórico: {historyError}</p>}
              {hasMore && (
                <button className="ghost" disabled={loading} onClick={() => void older()}>
                  {loading ? 'Carregando…' : 'Carregar eventos anteriores'}
                </button>
              )}
              <ol className="nc-result-timeline">
                {history.map(({ cursor, event }) => {
                  const update = resultUpdate(event);
                  const worker = snapshot.workers.find((item) => item.id === event.workerId);
                  return (
                    <li key={event.id}>
                      <time>{new Date(event.ts).toLocaleString('pt-BR')}</time>
                      <p>{update.text}</p>
                      <small>
                        {update.verified ? 'Evidência registrada' : 'Não verificado'} · Origem:{' '}
                        {worker?.name ?? event.workerId ?? 'Motor'} · Missão:{' '}
                        {snapshot.detail.mission.id} · Execução: {runId}
                        {event.taskId && ` · Tarefa: ${event.taskId}`} · Evento: {event.id} ·
                        cursor:{cursor}
                      </small>
                    </li>
                  );
                })}
              </ol>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
