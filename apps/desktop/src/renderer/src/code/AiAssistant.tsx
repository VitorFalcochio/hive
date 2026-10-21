import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Bot,
  Check,
  CodeXml,
  MessageSquareText,
  SearchCheck,
  Send,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import type { CodeAssistantMode } from '@hive/core';
import { useHive, usableWorkers } from '../context';
import { applyAiTextEdit, editorOptions, getDoc, monaco } from './monaco';
import { useCode, type AiProposal } from './store';

interface ChatEntry {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

let messageId = 0;
let proposalModelId = 0;

export function AiAssistant({ path, onClose }: { path: string | null; onClose: () => void }) {
  const { workers, providers, fail, notify, go } = useHive();
  const editorSelection = useCode((state) => state.selection);
  const selection = editorSelection?.path === path && editorSelection.text ? editorSelection : null;
  const availableWorkers = useMemo(() => usableWorkers(workers, providers), [providers, workers]);
  const preferred =
    availableWorkers.find((worker) => worker.role === 'reviewer') ?? availableWorkers[0] ?? null;
  const [workerId, setWorkerId] = useState('');
  const worker = availableWorkers.find((item) => item.id === workerId) ?? preferred;
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  // A proposal sent from the Design Mode is shown here until it is accepted or dismissed.
  const pendingProposal = useCode((state) => state.pendingProposal);
  const incoming = pendingProposal?.path === path ? pendingProposal : null;
  const shownProposal = incoming ?? proposal;
  const [draft, setDraft] = useState('');
  const [composerMode, setComposerMode] = useState<'chat' | 'edit'>('chat');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function request(mode: CodeAssistantMode, instruction: string, display = instruction) {
    if (!path || !worker) return;
    const doc = getDoc(path);
    if (!doc) {
      fail(new Error('Aguarde o arquivo terminar de abrir.'));
      return;
    }
    if (mode !== 'chat' && !selection) {
      fail(new Error('Selecione um trecho no editor primeiro.'));
      return;
    }
    const fileContent = doc.model.getValue();
    if (fileContent.length > 1_000_000) {
      fail(new Error('Este arquivo é grande demais para enviar ao agente (limite de 1 MB).'));
      return;
    }
    if (selection && selection.text.length > 100_000) {
      fail(new Error('Selecione um trecho com até 100 mil caracteres.'));
      return;
    }
    const capturedSelection = selection
      ? {
          startOffset: selection.startOffset,
          endOffset: selection.endOffset,
          text: selection.text,
        }
      : null;
    const userEntry: ChatEntry = { id: ++messageId, role: 'user', content: display };
    setMessages((current) => [...current, userEntry]);
    setBusy(true);
    try {
      const response = await window.hive.invoke('code.assist', {
        workerId: worker.id,
        mode,
        path,
        fileContent,
        selection: capturedSelection,
        instruction,
        history: messages
          .slice(-12)
          .map(({ role, content }) => ({ role, content: content.slice(0, 12_000) })),
      });
      setMessages((current) => [
        ...current,
        { id: ++messageId, role: 'assistant', content: response.answer },
      ]);
      if (response.proposal && capturedSelection) {
        setProposal({
          path,
          startOffset: capturedSelection.startOffset,
          endOffset: capturedSelection.endOffset,
          original: capturedSelection.text,
          replacement: response.proposal.replacement,
          baseContent: fileContent,
          proposedContent:
            fileContent.slice(0, capturedSelection.startOffset) +
            response.proposal.replacement +
            fileContent.slice(capturedSelection.endOffset),
          summary: response.proposal.summary,
        });
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const instruction = draft.trim();
    if (!instruction) return;
    setDraft('');
    void request(composerMode, instruction);
    setComposerMode('chat');
  }

  function prepareEdit() {
    if (!selection) return;
    setComposerMode('edit');
    setDraft('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function dismissProposal() {
    setProposal(null);
    useCode.getState().setPendingProposal(null);
  }

  function acceptProposal() {
    if (!shownProposal) return;
    try {
      applyAiTextEdit(shownProposal);
      dismissProposal();
      notify('Proposta aplicada ao editor. Revise e salve com Ctrl+S.');
    } catch (error) {
      fail(error);
    }
  }

  return (
    <aside className="ai-assistant" aria-label="Assistente de código">
      <header className="ai-header">
        <div>
          <span className="ai-title">
            <Sparkles size={15} /> IA no código
          </span>
          <small>{path ?? 'Nenhum arquivo aberto'}</small>
        </div>
        <button className="icon-button" aria-label="Fechar assistente" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      {availableWorkers.length ? (
        <label className="ai-worker">
          <Bot size={13} />
          <span className="sr-only">Agente</span>
          <select value={worker?.id ?? ''} onChange={(event) => setWorkerId(event.target.value)}>
            {availableWorkers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.modelId}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <button className="ai-configure" onClick={() => go('agents')}>
          Configure o modelo de um agente para usar a IA.
        </button>
      )}

      <div className={selection ? 'ai-selection active' : 'ai-selection'}>
        <CodeXml size={13} />
        {selection ? (
          <span>{selection.text.length.toLocaleString('pt-BR')} caracteres selecionados</span>
        ) : (
          <span>Selecione um trecho no arquivo</span>
        )}
      </div>

      <div className="ai-quick-actions">
        <button
          onClick={prepareEdit}
          disabled={!selection || !worker || busy}
          title="Descrever uma alteração para o trecho"
        >
          <WandSparkles size={13} /> Editar com IA
        </button>
        <button
          onClick={() =>
            void request(
              'explain',
              'Explique o trecho selecionado: o que ele faz, como funciona e quais detalhes merecem atenção.',
              'Explique este trecho.',
            )
          }
          disabled={!selection || !worker || busy}
        >
          <MessageSquareText size={13} /> Explicar
        </button>
        <button
          onClick={() =>
            void request(
              'review',
              'Revise o trecho selecionado. Aponte bugs, riscos, legibilidade, desempenho e testes ausentes, priorizando os achados mais importantes.',
              'Revise este trecho.',
            )
          }
          disabled={!selection || !worker || busy}
        >
          <SearchCheck size={13} /> Revisar
        </button>
      </div>

      <div className="ai-conversation" aria-live="polite">
        {!messages.length && !shownProposal && (
          <div className="ai-welcome">
            <Sparkles size={22} />
            <strong>Converse sobre o arquivo</strong>
            <span>Selecione código para editar, explicar ou revisar com o agente escolhido.</span>
          </div>
        )}
        {messages.map((entry) => (
          <div key={entry.id} className={`ai-message ${entry.role}`}>
            <span>{entry.role === 'user' ? 'Você' : (worker?.name ?? 'Agente')}</span>
            <p>{entry.content}</p>
          </div>
        ))}
        {busy && (
          <div className="ai-thinking" role="status">
            <span /> <span /> <span /> O agente está analisando…
          </div>
        )}
        {shownProposal && (
          <section className="ai-proposal">
            <header>
              <div>
                <strong>Proposta de alteração</strong>
                <small>{shownProposal.summary}</small>
              </div>
            </header>
            <ProposalDiff proposal={shownProposal} />
            <div className="ai-proposal-actions">
              <button className="secondary" onClick={dismissProposal}>
                <X size={13} /> Rejeitar
              </button>
              <button onClick={acceptProposal}>
                <Check size={13} /> Aceitar no editor
              </button>
            </div>
          </section>
        )}
      </div>

      <form
        className={composerMode === 'edit' ? 'ai-composer edit' : 'ai-composer'}
        onSubmit={submit}
      >
        {composerMode === 'edit' && <span>Descreva a alteração no trecho selecionado</span>}
        <label className="sr-only" htmlFor="ai-code-prompt">
          Mensagem para o agente
        </label>
        <textarea
          id="ai-code-prompt"
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            composerMode === 'edit'
              ? 'Ex.: extraia a validação para uma função…'
              : 'Pergunte sobre o arquivo ou a seleção…'
          }
          disabled={!path || !worker || busy}
          maxLength={10_000}
          rows={3}
        />
        <button className="icon-button" type="submit" disabled={!draft.trim() || busy || !worker}>
          <Send size={14} />
          <span className="sr-only">Enviar</span>
        </button>
      </form>
    </aside>
  );
}

function ProposalDiff({ proposal }: { proposal: AiProposal }) {
  const host = useRef<HTMLDivElement>(null);
  const [modelKey] = useState(() => ++proposalModelId);

  useEffect(() => {
    if (!host.current) return;
    const original = monaco.editor.createModel(
      proposal.baseContent,
      undefined,
      monaco.Uri.parse(`hive-ai-original:/${modelKey}/${proposal.path}`),
    );
    const modified = monaco.editor.createModel(
      proposal.proposedContent,
      undefined,
      monaco.Uri.parse(`hive-ai-proposed:/${modelKey}/${proposal.path}`),
    );
    const editor = monaco.editor.createDiffEditor(host.current, {
      ...editorOptions,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      ignoreTrimWhitespace: false,
      lineNumbers: 'off',
      folding: false,
    });
    editor.setModel({ original, modified });
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [modelKey, proposal]);

  return <div ref={host} className="ai-proposal-diff" aria-label="Diff da proposta" />;
}
