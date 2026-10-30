import { useCallback, useEffect, useRef, useState } from 'react';
import {
  queenActionLabel,
  type CanvasQueenApplied,
  type CanvasQueenProposal,
  type CanvasQueenRequest,
} from '@hive/core';
import { Markdown } from '../markdown';
import { Modal } from '../ui';

export function QueenCommand({
  runId,
  mode,
  instruction: initial,
  selection,
  view,
  center,
  beforeRequest,
  onApplied,
  onClose,
}: {
  runId: string;
  mode: CanvasQueenRequest['mode'];
  instruction?: string;
  selection: string[];
  view: CanvasQueenRequest['view'];
  center: () => { x: number; y: number };
  beforeRequest: () => Promise<void>;
  onApplied: (result: CanvasQueenApplied) => Promise<string[]>;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState(initial ?? '');
  const [proposal, setProposal] = useState<CanvasQueenProposal | null>(null);
  const [receipt, setReceipt] = useState<CanvasQueenApplied | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);
  const pending = useRef(false);
  const proposalId = useRef<string | undefined>(undefined);
  const submit = useCallback(async () => {
    if (!instruction.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setProposal(null);
    setReceipt(null);
    try {
      await beforeRequest();
      if (!alive.current) return;
      if (proposalId.current)
        await window.hive.invoke('canvas.queen.cancel', { runId, proposalId: proposalId.current });
      const value = await window.hive.invoke('canvas.queen.propose', {
        runId,
        mode,
        instruction,
        selectedNodeIds: selection,
        view,
        center: center(),
      });
      if (!alive.current) {
        void window.hive
          .invoke('canvas.queen.cancel', { runId, proposalId: value.id })
          .catch(() => {});
        return;
      }
      proposalId.current = value.id;
      setProposal(value);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }, [instruction, beforeRequest, runId, mode, selection, view, center]);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    alive.current = true;
    let current = true;
    if (initial?.trim())
      queueMicrotask(() => {
        if (current) void submitRef.current();
      });
    return () => {
      current = false;
      alive.current = false;
      void window.hive
        .invoke('canvas.queen.cancel', { runId, proposalId: proposalId.current })
        .catch(() => {});
    };
  }, [initial, runId]);
  const approve = async () => {
    if (!proposal || applying || receipt) return;
    setApplying(true);
    setError('');
    try {
      await beforeRequest();
      const applied = await window.hive.invoke('canvas.queen.apply', {
        runId,
        proposalId: proposal.id,
      });
      setReceipt(applied);
      const local = await onApplied(applied);
      setReceipt({ ...applied, applied: [...applied.applied, ...local] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setApplying(false);
    }
  };
  return (
    <Modal
      title="Queen · Command Mode"
      description="A Queen propõe operações permitidas. Alterações só são aplicadas após sua aprovação."
      wide
      onClose={() => {
        if (!applying) onClose();
      }}
    >
      <form
        className="form nc-queen-command"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Pedido à Queen
          <textarea
            autoFocus
            rows={3}
            maxLength={4000}
            value={instruction}
            disabled={busy || applying}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Explique o que o Frontend está fazendo…"
          />
        </label>
        <button
          type="submit"
          className="secondary"
          disabled={busy || applying || !instruction.trim()}
        >
          {busy ? 'Queen analisando…' : 'Consultar Queen'}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {proposal && (
          <section className="nc-queen-preview" aria-label="Prévia da Queen">
            <p className="nc-sub">
              {proposal.queen.name} · {proposal.queen.modelId} · prévia válida até{' '}
              {new Date(proposal.expiresAt).toLocaleTimeString('pt-BR')}
            </p>
            <Markdown source={proposal.answer} />
            {proposal.actions.length > 0 ? (
              <>
                <h3>Operações propostas ({proposal.actions.length})</h3>
                <ol>
                  {proposal.actions.map((action, index) => (
                    <li key={`${proposal.id}:${index}`}>
                      <strong>{queenActionLabel(action)}</strong>
                      <details>
                        <summary>Revisar parâmetros completos</summary>
                        <pre>{JSON.stringify(action, null, 2)}</pre>
                      </details>
                    </li>
                  ))}
                </ol>
                {proposal.actions.some((action) => action.type === 'create_task') && (
                  <p className="nc-queen-caution">
                    Nesta missão, novas tarefas podem começar imediatamente pelo motor após
                    aprovação.
                  </p>
                )}
              </>
            ) : (
              <p className="muted-text">Resposta informativa; nenhuma alteração proposta.</p>
            )}
          </section>
        )}
        {receipt && (
          <section role="status">
            <h3>{receipt.error ? 'Aplicação parcial' : 'Operações aplicadas'}</h3>
            <ul>
              {receipt.applied.map((line, index) => (
                <li key={`${index}:${line}`}>{line}</li>
              ))}
            </ul>
            {receipt.error && <p className="form-error">{receipt.error}</p>}
          </section>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={applying} onClick={onClose}>
            {receipt ? 'Fechar' : 'Cancelar'}
          </button>
          {proposal && proposal.actions.length > 0 && !receipt && (
            <button type="button" disabled={busy || applying} onClick={() => void approve()}>
              {applying ? 'Aplicando…' : `Aprovar e executar ${proposal.actions.length} ação(ões)`}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
