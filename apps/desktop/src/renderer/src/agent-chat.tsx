import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Copy,
  FileDiff,
  History,
  Loader2,
  MessageSquareText,
  Plus,
  ShieldQuestion,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  rolePresets,
  type AgentChat,
  type AgentChatApproval,
  type AgentChatMessage,
  type AgentChatMode,
  type AgentChatStep,
  type HivePush,
  type Worker,
  type WorkerRole,
  type Workspace,
} from '@hive/core';
import { hasAccess, message, useHive } from './context';
import { Markdown } from './markdown';
import { AgentBee } from './mascot';

/** Messages read per page; older ones load on request. */
const PAGE = 40;
/** Longer answers are cut on screen until the user asks for all of it. */
const LONG_ANSWER = 24_000;
/** Steps shown before "show earlier steps". */
const VISIBLE_STEPS = 8;

const roleOrder: WorkerRole[] = ['queen', 'architect', 'frontend', 'backend', 'qa', 'reviewer'];

/** The team as the sidebar lists it: the user's agents (not a mission's Hive Teams members). */
export function chatAgents(workers: Worker[]): Worker[] {
  const rank = (role: WorkerRole) => {
    const index = roleOrder.indexOf(role);
    return index === -1 ? roleOrder.length : index;
  };
  return workers
    .filter((worker) => !worker.team)
    .sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name, 'pt-BR'));
}

const modeLabels: Record<AgentChatMode, string> = {
  conversation: 'Conversa',
  execution: 'Execução',
};

const statusLabels: Record<AgentChatMessage['status'], string> = {
  running: 'trabalhando',
  completed: 'concluído',
  failed: 'falhou',
  cancelled: 'interrompido',
  interrupted: 'interrompido com o Hive fechado',
};

/** Per-machine conveniences: the last conversation and mode. Storage may be unavailable. */
function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Only a convenience.
  }
}

/** The fresher of two copies of a message: a finished one, or the one with more steps. */
function fresher(a: AgentChatMessage, b: AgentChatMessage): AgentChatMessage {
  if (a.status !== 'running' && b.status === 'running') return a;
  if (b.status !== 'running' && a.status === 'running') return b;
  return b.steps.length + b.droppedSteps >= a.steps.length + a.droppedSteps ? b : a;
}

/** Two lists of one conversation merged by id, oldest first; unchanged messages keep identity. */
export function mergeMessages(
  current: AgentChatMessage[],
  incoming: AgentChatMessage[],
): AgentChatMessage[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const known = byId.get(item.id);
    byId.set(item.id, known ? fresher(known, item) : item);
  }
  const order = new Map<string, number>();
  [...current, ...incoming].forEach((item) => {
    if (!order.has(item.id)) order.set(item.id, order.size);
  });
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || order.get(a.id)! - order.get(b.id)!,
  );
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

/**
 * Direct Agent Chat with one agent in the project in front: conversations kept per project and
 * agent, two modes (read-only conversation, real execution), the agent's steps live, command
 * approvals inline and a stop button. Everything runs in the main process; this page only
 * shows it, a page of messages at a time.
 */
export function AgentChatPage({ workspace, worker }: { workspace: Workspace; worker: Worker }) {
  const { providers, onAgentChat, go } = useHive();
  const lastKey = `hive.agentChat.last.${workspace.id}.${worker.id}`;
  const modeKey = `hive.agentChat.mode.${worker.id}`;
  const [chats, setChats] = useState<AgentChat[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [approval, setApproval] = useState<AgentChatApproval | null>(null);
  const [mode, setMode] = useState<AgentChatMode>(() =>
    remembered(modeKey) === 'execution' ? 'execution' : 'conversation',
  );
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  const provider = providers.find((item) => item.id === worker.providerId) ?? null;
  const configured = !!worker.providerId && !!worker.modelId;
  const reachable = !!provider && hasAccess(provider);
  const working = messages.some((item) => item.role === 'agent' && item.status === 'running');

  const loadChats = useCallback(async () => {
    const list = await window.hive.invoke('agentChat.list', {
      workspaceId: workspace.id,
      workerId: worker.id,
    });
    setChats(list);
    return list;
  }, [workspace.id, worker.id]);

  // The conversations of this agent in this project; the last one used opens again.
  useEffect(() => {
    let alive = true;
    loadChats()
      .then((list) => {
        if (!alive) return;
        const last = remembered(lastKey);
        setChatId(list.find((chat) => chat.id === last)?.id ?? list[0]?.id ?? null);
      })
      .catch((failure) => alive && setError(message(failure)));
    return () => {
      alive = false;
    };
  }, [loadChats, lastKey]);

  // The open conversation: its latest messages, whether the agent waits on an approval, and
  // its live progress. The listener goes away with the conversation, so nothing doubles.
  useEffect(() => {
    remember(lastKey, chatId);
    setApproval(null);
    setMore(false);
    setMessages((current) => current.filter((item) => item.chatId === chatId));
    if (!chatId) {
      setMessages([]);
      return;
    }
    let alive = true;
    const unsubscribe = onAgentChat((push: Extract<HivePush, { kind: 'agentChat' }>) => {
      if (push.chatId !== chatId || push.workspaceId !== workspace.id) return;
      setMessages((current) => mergeMessages(current, [push.message]));
      setApproval(push.approval);
    });
    setLoading(true);
    stick.current = true;
    Promise.all([
      window.hive.invoke('agentChat.messages', { chatId, limit: PAGE }),
      window.hive.invoke('agentChat.state', chatId),
    ])
      .then(([page, state]) => {
        if (!alive) return;
        setMessages((current) =>
          mergeMessages(
            current.filter((item) => item.chatId === chatId),
            page.messages,
          ),
        );
        setMore(page.more);
        setApproval(state.approval);
      })
      .catch((failure) => alive && setError(message(failure)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [chatId, lastKey, onAgentChat, workspace.id]);

  // Follows the newest message only while the user is at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages, approval]);

  async function loadOlder() {
    const first = messages[0];
    if (!chatId || !first) return;
    const element = scroller.current;
    const height = element?.scrollHeight ?? 0;
    try {
      const page = await window.hive.invoke('agentChat.messages', {
        chatId,
        before: first.id,
        limit: PAGE,
      });
      stick.current = false;
      setMessages((current) => mergeMessages(page.messages, current));
      setMore(page.more);
      // Keeps the message the user was reading in place.
      requestAnimationFrame(() => {
        if (element) element.scrollTop += element.scrollHeight - height;
      });
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || working || sending) return;
    setSending(true);
    setError('');
    try {
      let id = chatId;
      if (!id) {
        const chat = await window.hive.invoke('agentChat.create', {
          workspaceId: workspace.id,
          workerId: worker.id,
        });
        id = chat.id;
        setChats((current) => [chat, ...(current ?? [])]);
        setChatId(id);
      }
      const { user, agent } = await window.hive.invoke('agentChat.send', {
        chatId: id,
        text,
        mode,
      });
      stick.current = true;
      setMessages((current) => mergeMessages(current, [user, agent]));
      setDraft('');
      void loadChats().catch(() => undefined);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }

  async function stop() {
    if (!chatId) return;
    try {
      await window.hive.invoke('agentChat.cancel', chatId);
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function answer(choice: 'yes' | 'no' | 'always') {
    if (!chatId || !approval) return;
    try {
      await window.hive.invoke('agentChat.approve', {
        chatId,
        approvalId: approval.id,
        answer: choice,
      });
      setApproval(null);
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function remove(chat: AgentChat) {
    if (!window.confirm(`Apagar a conversa “${chat.title}”? O histórico dela será perdido.`))
      return;
    try {
      await window.hive.invoke('agentChat.delete', chat.id);
      const list = await loadChats();
      if (chat.id === chatId) setChatId(list[0]?.id ?? null);
    } catch (failure) {
      setError(message(failure));
    }
  }

  function newConversation() {
    setChatId(null);
    setHistoryOpen(false);
    setError('');
    input.current?.focus();
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function chooseMode(next: AgentChatMode) {
    setMode(next);
    remember(modeKey, next);
  }

  const current = chats?.find((chat) => chat.id === chatId) ?? null;
  const role = rolePresets[worker.role]?.label ?? worker.role;

  return (
    <div className="agent-chat">
      <header className="agent-chat-header">
        <AgentBee worker={worker} size={30} mood={working ? 'working' : 'still'} />
        <div className="agent-chat-identity">
          <h1>
            {worker.name}
            <span className="agent-chat-role">{role}</span>
          </h1>
          <p>
            <span>
              Projeto: <strong>{workspace.name}</strong>
            </span>
            <span>
              Modelo:{' '}
              {configured ? (
                <strong>
                  {provider?.name ?? 'provedor removido'} · {worker.modelId}
                </strong>
              ) : (
                <strong className="warn-text">nenhum configurado</strong>
              )}
            </span>
          </p>
        </div>
        <div className="agent-chat-actions">
          <button className="ghost" onClick={newConversation} title="Nova conversa">
            <Plus size={14} /> Nova conversa
          </button>
          <div className="agent-chat-history">
            <button
              className="ghost"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(!historyOpen)}
              title="Conversas anteriores"
            >
              <History size={14} /> Conversas{chats?.length ? ` (${chats.length})` : ''}
            </button>
            {historyOpen && (
              <div className="agent-chat-history-menu" role="menu">
                {!chats?.length && <p className="muted">Nenhuma conversa ainda.</p>}
                {chats?.slice(0, 100).map((chat) => (
                  <div
                    key={chat.id}
                    className={chat.id === chatId ? 'history-row selected' : 'history-row'}
                  >
                    <button
                      role="menuitem"
                      className="history-open"
                      onClick={() => {
                        setChatId(chat.id);
                        setHistoryOpen(false);
                      }}
                    >
                      <span className="truncate">{chat.title}</span>
                      <small>{when(chat.updatedAt)}</small>
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Apagar ${chat.title}`}
                      title="Apagar conversa"
                      onClick={() => void remove(chat)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {(!configured || (configured && !reachable)) && (
        <div className="agent-chat-banner" role="status">
          <AlertTriangle size={14} />
          <span>
            {!configured
              ? `${worker.name} ainda não tem provedor e modelo.`
              : `O provedor ${provider?.name ?? ''} não está acessível (desligado ou sem chave).`}
          </span>
          <button className="ghost" onClick={() => go(configured ? 'providers' : 'agents')}>
            {configured ? 'Abrir Provedores' : 'Configurar agente'}
          </button>
        </div>
      )}

      <div
        className="agent-chat-log"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className="agent-chat-thread">
          {more && (
            <button className="ghost agent-chat-older" onClick={() => void loadOlder()}>
              Carregar mensagens anteriores
            </button>
          )}
          {!messages.length && !loading && (
            <div className="agent-chat-empty">
              <AgentBee worker={worker} size={44} />
              <strong>{current ? current.title : `Converse com ${worker.name}`}</strong>
              <span>
                No modo <b>Conversa</b> o agente só lê o projeto: perguntas, análises, arquitetura,
                revisão e planejamento. No modo <b>Execução</b> ele faz o trabalho de verdade na
                pasta do projeto, com as ferramentas e aprovações do Hive.
              </span>
            </div>
          )}
          {messages.map((item) => (
            <MessageView key={item.id} item={item} worker={worker} />
          ))}
          {approval && (
            <div className="agent-chat-approval" role="alert">
              <header>
                <ShieldQuestion size={15} /> {worker.name} quer executar um comando
              </header>
              <code>{approval.command}</code>
              <div className="agent-chat-approval-actions">
                <button onClick={() => void answer('yes')}>Permitir</button>
                <button className="secondary" onClick={() => void answer('always')}>
                  Sempre permitir este comando
                </button>
                <button className="secondary" onClick={() => void answer('no')}>
                  Negar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="agent-chat-composer">
        {error && (
          <div className="agent-chat-error" role="alert">
            <AlertTriangle size={14} />
            <span>{error}</span>
            <button className="icon-button" aria-label="Fechar aviso" onClick={() => setError('')}>
              <X size={13} />
            </button>
          </div>
        )}
        <div className="agent-chat-modes" role="radiogroup" aria-label="Modo">
          {(['conversation', 'execution'] as const).map((item) => (
            <button
              key={item}
              role="radio"
              aria-checked={mode === item}
              className={mode === item ? 'selected' : undefined}
              onClick={() => chooseMode(item)}
            >
              {item === 'conversation' ? <MessageSquareText size={13} /> : <Wrench size={13} />}
              {modeLabels[item]}
            </button>
          ))}
          <span className="agent-chat-mode-hint">
            {mode === 'conversation'
              ? 'Só leitura: não altera arquivos nem executa comandos.'
              : 'Altera arquivos e executa comandos na pasta do projeto, com as aprovações configuradas.'}
          </span>
        </div>
        <div className={mode === 'execution' ? 'agent-chat-input execution' : 'agent-chat-input'}>
          <textarea
            ref={input}
            value={draft}
            rows={3}
            placeholder={
              mode === 'conversation'
                ? `Pergunte algo a ${worker.name}…`
                : `Descreva a tarefa para ${worker.name}…`
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKey}
          />
          <div className="agent-chat-input-bar">
            <span className="muted">Enter envia · Shift+Enter quebra linha</span>
            {working ? (
              <button className="secondary" onClick={() => void stop()}>
                <Square size={12} /> Parar
              </button>
            ) : (
              <button disabled={!draft.trim() || sending} onClick={() => void send()}>
                Enviar <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

/** One message; unchanged messages are not drawn again when another one changes. */
const MessageView = memo(function MessageView({
  item,
  worker,
}: {
  item: AgentChatMessage;
  worker: Worker;
}) {
  if (item.role === 'user')
    return (
      <div className="chat-msg user">
        <div className="chat-msg-head">
          <span>Você</span>
          {item.mode === 'execution' && <span className="chat-chip">Execução</span>}
          <button
            className="icon-button chat-copy"
            aria-label="Copiar mensagem"
            title="Copiar"
            onClick={() => copy(item.content)}
          >
            <Copy size={12} />
          </button>
        </div>
        <p>{item.content}</p>
      </div>
    );
  return <AgentReply item={item} worker={worker} />;
});

function AgentReply({ item, worker }: { item: AgentChatMessage; worker: Worker }) {
  const [allSteps, setAllSteps] = useState(false);
  const [full, setFull] = useState(false);
  const running = item.status === 'running';
  const hidden = allSteps ? 0 : Math.max(0, item.steps.length - VISIBLE_STEPS);
  const steps = useMemo(() => item.steps.slice(hidden), [item.steps, hidden]);
  const long = item.content.length > LONG_ANSWER && !full;
  const tokens = item.usage.promptTokens + item.usage.completionTokens;
  return (
    <div className={`chat-msg agent status-${item.status}`}>
      <div className="chat-msg-head">
        <AgentBee worker={worker} size={14} mood={running ? 'working' : 'still'} />
        <span>{worker.name}</span>
        {item.model && (
          <span className="chat-model" title={`Motor: ${item.model.runtime}`}>
            {item.model.providerName} · {item.model.modelId}
          </span>
        )}
        <span className={`chat-status ${item.status}`}>{statusLabels[item.status]}</span>
        {item.content && (
          <button
            className="icon-button chat-copy"
            aria-label="Copiar resposta"
            title="Copiar"
            onClick={() => copy(item.content)}
          >
            <Copy size={12} />
          </button>
        )}
      </div>
      {(steps.length > 0 || item.droppedSteps > 0) && (
        <ol className="chat-steps">
          {(hidden > 0 || item.droppedSteps > 0) && (
            <li>
              <button className="link" onClick={() => setAllSteps(true)} disabled={!hidden}>
                {hidden + item.droppedSteps} passo(s) anterior(es)
                {item.droppedSteps > 0 && !hidden ? ' (os mais antigos não foram guardados)' : ''}
              </button>
            </li>
          )}
          {steps.map((step, index) => (
            <StepView key={`${step.at}-${index}`} step={step} />
          ))}
        </ol>
      )}
      {running && !item.content && (
        <div className="ai-thinking" role="status">
          <span />
          <span />
          <span />
          {item.mode === 'execution' ? 'Executando…' : 'Pensando…'}
        </div>
      )}
      {item.content && (
        <Markdown
          copyable
          className="chat-answer"
          source={long ? `${item.content.slice(0, LONG_ANSWER)}\n\n…` : item.content}
        />
      )}
      {long && (
        <button className="link" onClick={() => setFull(true)}>
          Mostrar a resposta inteira ({Math.round(item.content.length / 1000)} mil caracteres)
        </button>
      )}
      {item.error && item.status !== 'completed' && (
        <div className="chat-error">
          <AlertTriangle size={13} /> {item.error}
        </div>
      )}
      {item.changedFiles.length > 0 && (
        <details className="chat-files">
          <summary>
            <FileDiff size={13} /> {item.changedFiles.length} arquivo(s) alterado(s)
          </summary>
          <ul>
            {item.changedFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!running && tokens > 0 && (
        <small className="chat-usage">{tokens.toLocaleString('pt-BR')} tokens</small>
      )}
    </div>
  );
}

function StepView({ step }: { step: AgentChatStep }) {
  const icon =
    step.status === 'running' ? (
      <Loader2 size={12} className="spin" />
    ) : step.status === 'error' ? (
      <X size={12} />
    ) : (
      <Check size={12} />
    );
  if (step.kind === 'note')
    return (
      <li className="chat-step note">
        <span className="chat-step-text">{step.label}</span>
      </li>
    );
  const body = (
    <>
      <span className="chat-step-icon">{icon}</span>
      <span className="chat-step-text">{step.label}</span>
    </>
  );
  return (
    <li className={`chat-step ${step.kind} ${step.status}`}>
      {step.detail ? (
        <details>
          <summary>{body}</summary>
          <pre>{step.detail}</pre>
        </details>
      ) : (
        <div className="chat-step-row">{body}</div>
      )}
    </li>
  );
}
