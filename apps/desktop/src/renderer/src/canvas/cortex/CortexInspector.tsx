import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  BrainCircuit,
  Check,
  GitCommitVertical,
  History,
  Inbox,
  Link2,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Unlink,
  X,
} from 'lucide-react';
import {
  cortexMemoryKindLabels,
  type CanvasWorker,
  type CortexActivity,
  type CortexDraft,
  type CortexMemory,
  type CortexMemoryKind,
  type CortexOverview,
  type CortexPermission,
  type CortexPermissions,
  type CortexProposal,
  type CortexSearchResult,
} from '@hive/core';
import { Modal } from '../../ui';
import { roleLabel } from '../model';

export type CortexTab = 'memories' | 'approvals' | 'decisions' | 'activity' | 'connections';

const tabs: { id: CortexTab; label: string; icon: typeof Activity }[] = [
  { id: 'memories', label: 'Memories', icon: BrainCircuit },
  { id: 'approvals', label: 'Approvals', icon: Inbox },
  { id: 'decisions', label: 'Decisions', icon: GitCommitVertical },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'connections', label: 'Conexões', icon: Link2 },
];

const statusLabels: Record<CortexMemory['status'], string> = {
  active: 'Vigente',
  superseded: 'Substituída',
  revoked: 'Revogada',
};
const permissionHelp: Record<CortexPermission, string> = {
  read: 'Read — consulta memórias aprovadas e recebe as relevantes como contexto.',
  propose: 'Propose — sugere memórias novas e altera as próprias (com aprovação).',
  approve: 'Approve — recomenda aprovar ou rejeitar propostas de outros agentes.',
  manage: 'Manage — propõe alterar ou revogar qualquer memória deste Cortex.',
};
const verdictLabels: Record<CortexProposal['reviews'][number]['verdict'], string> = {
  approve: 'aprovar',
  reject: 'rejeitar',
  merge: 'mesclar com existente',
  revise: 'revisar',
};

const errorText = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);
const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Loads one list and reloads it when the block changes; the caller renders its states. */
function useList<T>(load: () => Promise<T[]>, version: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    setError('');
    load().then(setItems, (failure: unknown) => setError(errorText(failure)));
  }, [load]);
  useEffect(() => reload(), [reload, version]);
  return { items, error, reload };
}

function State({
  loading,
  error,
  empty,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string;
  empty: string | null;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (error)
    return (
      <div className="nc-cortex-state-box error" role="alert">
        <span>{error}</span>
        <button className="secondary nc-small" onClick={onRetry}>
          <RefreshCw size={12} /> Tentar de novo
        </button>
      </div>
    );
  if (loading)
    return (
      <div className="nc-cortex-state-box" role="status">
        Carregando…
      </div>
    );
  if (empty)
    return (
      <div className="nc-cortex-state-box" role="status">
        {empty}
      </div>
    );
  return <>{children}</>;
}

export function CortexInspector({
  block,
  workers,
  initialTab = 'memories',
  onClose,
}: {
  block: CortexOverview;
  workers: Map<string, CanvasWorker>;
  initialTab?: CortexTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<CortexTab>(initialTab);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const { node } = block;
  // Any change to the block (counts, connections, last activity) refreshes the open tab.
  const version = `${node.updatedAt}|${block.lastActivityAt}|${block.pendingApprovals}|${block.memories.active}`;
  const act = useCallback(async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      setNotice({ text: done, tone: 'ok' });
      return true;
    } catch (failure) {
      setNotice({ text: errorText(failure), tone: 'error' });
      return false;
    }
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === 'error' ? 8000 : 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const name = (workerId: string | null, fallback: string) =>
    (workerId && workers.get(workerId)?.name) || fallback;

  return (
    <Modal
      title={`Cortex Inspector · ${node.name}`}
      description="Memória compartilhada e persistente do projeto. Só agentes conectados acessam; o que eles propõem espera a sua aprovação."
      size="xl"
      onClose={onClose}
    >
      <div className="nc-cortex-inspector" data-keyboard-owner>
        <div role="tablist" className="nc-tabs">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`nc-tab${tab === id ? ' selected' : ''}`}
              onClick={() => setTab(id)}
            >
              <Icon size={13} /> {label}
              {id === 'approvals' && block.pendingApprovals > 0 && (
                <span className="nc-tab-count">{block.pendingApprovals}</span>
              )}
              {id === 'memories' && <span className="nc-tab-count">{block.memories.active}</span>}
              {id === 'connections' && (
                <span className="nc-tab-count">{node.connections.length}</span>
              )}
            </button>
          ))}
        </div>
        {notice && (
          <p
            className={notice.tone === 'error' ? 'form-error' : 'nc-cortex-ok'}
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            {notice.text}
          </p>
        )}
        <div className="nc-cortex-panel" role="tabpanel">
          {tab === 'memories' && (
            <MemoriesTab block={block} version={version} act={act} name={name} />
          )}
          {tab === 'approvals' && (
            <ApprovalsTab block={block} version={version} act={act} name={name} />
          )}
          {tab === 'decisions' && <DecisionsTab block={block} version={version} name={name} />}
          {tab === 'activity' && <ActivityTab block={block} version={version} />}
          {tab === 'connections' && <ConnectionsTab block={block} workers={workers} act={act} />}
        </div>
      </div>
    </Modal>
  );
}

type Act = (work: () => Promise<unknown>, done: string) => Promise<boolean>;
type Name = (workerId: string | null, fallback: string) => string;

/* ---------------------------------------------------------------- memories */

const blankDraft = (): CortexDraft => ({
  kind: 'decision',
  title: '',
  content: '',
  rationale: '',
  tags: [],
  evidence: [],
  audience: [],
});
const draftOf = (memory: CortexMemory | CortexProposal['draft']): CortexDraft => ({
  kind: memory.kind,
  title: memory.title,
  content: memory.content,
  rationale: memory.rationale,
  tags: memory.tags,
  evidence: memory.evidence,
  audience: memory.audience,
});

function DraftEditor({
  draft,
  onChange,
}: {
  draft: CortexDraft;
  onChange: (draft: CortexDraft) => void;
}) {
  const list = (value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return (
    <div className="form nc-cortex-draft">
      <div className="nc-cortex-row">
        <label>
          Tipo
          <select
            value={draft.kind}
            onChange={(event) =>
              onChange({ ...draft, kind: event.target.value as CortexMemoryKind })
            }
          >
            {(Object.keys(cortexMemoryKindLabels) as CortexMemoryKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {cortexMemoryKindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Título
          <input
            value={draft.title}
            maxLength={160}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </label>
      </div>
      <label>
        Conteúdo
        <textarea
          rows={4}
          maxLength={4000}
          value={draft.content}
          onChange={(event) => onChange({ ...draft, content: event.target.value })}
        />
      </label>
      <label>
        Justificativa
        <textarea
          rows={2}
          maxLength={2000}
          value={draft.rationale}
          onChange={(event) => onChange({ ...draft, rationale: event.target.value })}
        />
      </label>
      <div className="nc-cortex-row">
        <label className="grow">
          Tags (vírgula)
          <input
            value={draft.tags.join(', ')}
            onChange={(event) => onChange({ ...draft, tags: list(event.target.value) })}
          />
        </label>
        <label className="grow">
          Evidências (arquivos, tarefas)
          <input
            value={draft.evidence.join(', ')}
            onChange={(event) => onChange({ ...draft, evidence: list(event.target.value) })}
          />
        </label>
      </div>
      <label>
        Relevante para
        <span className="nc-cortex-checks">
          {(['architect', 'frontend', 'backend', 'qa', 'reviewer', 'custom'] as const).map(
            (role) => (
              <label key={role} className="check">
                <input
                  type="checkbox"
                  checked={draft.audience.includes(role)}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      audience: event.target.checked
                        ? [...draft.audience, role]
                        : draft.audience.filter((item) => item !== role),
                    })
                  }
                />
                {roleLabel(role)}
              </label>
            ),
          )}
        </span>
      </label>
    </div>
  );
}

function MemoryCard({
  memory,
  name,
  children,
}: {
  memory: CortexMemory;
  name: Name;
  children?: ReactNode;
}) {
  return (
    <article className={`nc-cortex-card status-${memory.status}`}>
      <header>
        <span className="badge">{cortexMemoryKindLabels[memory.kind]}</span>
        <strong>{memory.title}</strong>
        <span className={`nc-cortex-status ${memory.status}`}>{statusLabels[memory.status]}</span>
      </header>
      <p className="nc-cortex-content">{memory.content}</p>
      {memory.rationale && <p className="nc-cortex-why">Por quê: {memory.rationale}</p>}
      <footer>
        <span>
          {name(memory.author.workerId, memory.author.name)} · aprovada por {memory.approvedBy.name}{' '}
          · v{memory.version} · {when(memory.updatedAt)}
        </span>
        {memory.tags.length > 0 && <span className="mono">#{memory.tags.join(' #')}</span>}
        {memory.evidence.length > 0 && <span className="mono">{memory.evidence.join(', ')}</span>}
      </footer>
      {children}
    </article>
  );
}

function MemoriesTab({
  block,
  version,
  act,
  name,
}: {
  block: CortexOverview;
  version: string;
  act: Act;
  name: Name;
}) {
  const cortexId = block.node.id;
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const [kind, setKind] = useState<CortexMemoryKind | ''>('');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{
    memory: CortexMemory | null;
    draft: CortexDraft;
  } | null>(null);
  const [revoking, setRevoking] = useState<{ memory: CortexMemory; note: string } | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<CortexSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const load = useCallback(
    () =>
      window.hive.invoke('cortex.memories', {
        cortexId,
        status: status === 'active' ? ['active'] : undefined,
        kinds: kind ? [kind] : undefined,
        search: filter || undefined,
      }),
    [cortexId, status, kind, filter],
  );
  const list = useList(load, version);

  const save = async () => {
    if (!editing) return;
    const ok = editing.memory
      ? await act(
          () =>
            window.hive.invoke('cortex.memory.edit', {
              memoryId: editing.memory!.id,
              expectedVersion: editing.memory!.version,
              draft: editing.draft,
              note: 'Editada no Inspector.',
            }),
          'Memória atualizada. Agentes afetados serão avisados na próxima tarefa.',
        )
      : await act(
          () =>
            window.hive.invoke('cortex.memory.create', {
              cortexId,
              draft: editing.draft,
              supersedes: null,
            }),
          'Memória registrada e disponível aos agentes conectados.',
        );
    if (ok) setEditing(null);
  };

  if (editing)
    return (
      <section className="nc-cortex-section">
        <h3>{editing.memory ? 'Editar memória' : 'Nova memória'}</h3>
        <DraftEditor
          draft={editing.draft}
          onChange={(draft) => setEditing({ ...editing, draft })}
        />
        <div className="modal-actions">
          <button className="secondary" onClick={() => setEditing(null)}>
            Cancelar
          </button>
          <button
            disabled={
              editing.draft.title.trim().length < 3 || editing.draft.content.trim().length < 3
            }
            onClick={() => void save()}
          >
            Salvar
          </button>
        </div>
      </section>
    );

  return (
    <section className="nc-cortex-section">
      <form
        className="nc-cortex-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (!query.trim()) return;
          setSearching(true);
          window.hive
            .invoke('cortex.search', { cortexId, query })
            .then(setResult, () => setResult(null))
            .finally(() => setSearching(false));
        }}
      >
        <Search size={14} />
        <input
          value={query}
          placeholder="Testar a busca dos agentes: “como identificar os usuários?”"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="secondary nc-small" disabled={searching || !query.trim()}>
          {searching ? 'Buscando…' : 'Buscar por significado'}
        </button>
      </form>
      {result && (
        <div className="nc-cortex-results" role="status">
          <span className="muted-text">
            {result.hits.length} resultado(s) · {result.tokens} tokens · motor {result.model}
            {result.degraded ? ` · provedor indisponível: ${result.degraded}` : ''}
          </span>
          {result.hits.map((hit) => (
            <div key={hit.memory.id} className="nc-cortex-hit">
              <span className="mono">{hit.similarity.toFixed(2)}</span> {hit.memory.title}
            </div>
          ))}
          <button className="ghost nc-small" onClick={() => setResult(null)}>
            <X size={12} /> Fechar
          </button>
        </div>
      )}
      <div className="nc-cortex-toolbar">
        <input
          className="grow"
          value={filter}
          placeholder="Filtrar por texto"
          onChange={(event) => setFilter(event.target.value)}
        />
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as CortexMemoryKind | '')}
        >
          <option value="">Todos os tipos</option>
          {(Object.keys(cortexMemoryKindLabels) as CortexMemoryKind[]).map((item) => (
            <option key={item} value={item}>
              {cortexMemoryKindLabels[item]}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as 'active' | 'all')}
        >
          <option value="active">Vigentes</option>
          <option value="all">Todas (com histórico)</option>
        </select>
        <button
          className="nc-small"
          onClick={() => setEditing({ memory: null, draft: blankDraft() })}
        >
          Nova memória
        </button>
      </div>
      <State
        loading={!list.items}
        error={list.error}
        empty={
          list.items?.length === 0
            ? filter || kind
              ? 'Nada encontrado com esses filtros.'
              : 'Nenhuma memória ainda. Quando um agente conectado propuser uma e você aprovar, ela aparece aqui.'
            : null
        }
        onRetry={list.reload}
      >
        <div className="nc-cortex-list">
          {list.items?.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} name={name}>
              {memory.status === 'active' && (
                <div className="nc-cortex-actions">
                  <button
                    className="ghost nc-small"
                    onClick={() => setEditing({ memory, draft: draftOf(memory) })}
                  >
                    <Pencil size={12} /> Editar
                  </button>
                  {revoking?.memory.id === memory.id ? (
                    <span className="nc-cortex-inline">
                      <input
                        autoFocus
                        value={revoking.note}
                        placeholder="Motivo da revogação"
                        onChange={(event) => setRevoking({ memory, note: event.target.value })}
                      />
                      <button
                        className="danger nc-small"
                        disabled={!revoking.note.trim()}
                        onClick={() =>
                          void act(
                            () =>
                              window.hive.invoke('cortex.memory.revoke', {
                                memoryId: memory.id,
                                expectedVersion: memory.version,
                                note: revoking.note,
                              }),
                            'Memória revogada: não aparece mais para os agentes.',
                          ).then((ok) => ok && setRevoking(null))
                        }
                      >
                        Revogar
                      </button>
                      <button className="ghost nc-small" onClick={() => setRevoking(null)}>
                        Cancelar
                      </button>
                    </span>
                  ) : (
                    <button
                      className="ghost nc-small danger"
                      onClick={() => setRevoking({ memory, note: '' })}
                    >
                      Revogar
                    </button>
                  )}
                </div>
              )}
            </MemoryCard>
          ))}
        </div>
      </State>
    </section>
  );
}

/* ---------------------------------------------------------------- approvals */

function ApprovalsTab({
  block,
  version,
  act,
  name,
}: {
  block: CortexOverview;
  version: string;
  act: Act;
  name: Name;
}) {
  const cortexId = block.node.id;
  const [show, setShow] = useState<'pending' | 'resolved'>('pending');
  const [editing, setEditing] = useState<{ id: string; draft: CortexDraft } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [assessing, setAssessing] = useState<string | null>(null);
  const load = useCallback(
    () =>
      window.hive.invoke('cortex.proposals', {
        cortexId,
        status: show === 'pending' ? ['pending'] : ['approved', 'rejected', 'changes_requested'],
      }),
    [cortexId, show],
  );
  const list = useList(load, version);
  const memories = useList(
    useCallback(
      () => window.hive.invoke('cortex.memories', { cortexId, status: ['active'] }),
      [cortexId],
    ),
    version,
  );
  const titles = useMemo(
    () => new Map((memories.items ?? []).map((memory) => [memory.id, memory.title])),
    [memories.items],
  );
  const resolve = (proposal: CortexProposal, decision: 'approve' | 'reject' | 'request_changes') =>
    act(
      () =>
        window.hive.invoke('cortex.proposal.resolve', {
          proposalId: proposal.id,
          decision,
          note: notes[proposal.id] ?? '',
          ...(decision === 'approve' && editing?.id === proposal.id
            ? { draft: editing.draft }
            : {}),
        }),
      decision === 'approve'
        ? 'Aprovada: agora é memória compartilhada.'
        : decision === 'reject'
          ? 'Rejeitada: não será usada como memória.'
          : 'Ajustes pedidos ao agente.',
    ).then((ok) => ok && editing?.id === proposal.id && setEditing(null));

  return (
    <section className="nc-cortex-section">
      <div className="nc-cortex-toolbar">
        <div className="nc-segment" role="group" aria-label="Propostas">
          <button
            className={show === 'pending' ? 'on' : undefined}
            onClick={() => setShow('pending')}
          >
            Pendentes
          </button>
          <button
            className={show === 'resolved' ? 'on' : undefined}
            onClick={() => setShow('resolved')}
          >
            Resolvidas
          </button>
        </div>
        <span className="muted-text grow">
          Propostas não são fatos: os agentes só recebem o que você aprovar.
        </span>
      </div>
      <State
        loading={!list.items}
        error={list.error}
        empty={
          list.items?.length === 0
            ? show === 'pending'
              ? 'Nenhuma proposta aguardando aprovação.'
              : 'Nenhuma proposta resolvida ainda.'
            : null
        }
        onRetry={list.reload}
      >
        <div className="nc-cortex-list">
          {list.items?.map((proposal) => (
            <article
              key={proposal.id}
              className={`nc-cortex-card proposal status-${proposal.status}`}
            >
              <header>
                <span className="badge">
                  {proposal.action === 'create'
                    ? 'Nova'
                    : proposal.action === 'update'
                      ? 'Alteração'
                      : 'Revogação'}{' '}
                  · {cortexMemoryKindLabels[proposal.draft.kind]}
                </span>
                <strong>{proposal.draft.title}</strong>
                {proposal.status !== 'pending' && (
                  <span className={`nc-cortex-status ${proposal.status}`}>{proposal.status}</span>
                )}
              </header>
              {editing?.id === proposal.id ? (
                <DraftEditor
                  draft={editing.draft}
                  onChange={(draft) => setEditing({ id: proposal.id, draft })}
                />
              ) : (
                <>
                  <p className="nc-cortex-content">{proposal.draft.content}</p>
                  {proposal.draft.rationale && (
                    <p className="nc-cortex-why">Justificativa: {proposal.draft.rationale}</p>
                  )}
                  {proposal.draft.evidence.length > 0 && (
                    <p className="nc-cortex-why mono">
                      Evidências: {proposal.draft.evidence.join(', ')}
                    </p>
                  )}
                </>
              )}
              {proposal.targetMemoryId && (
                <p className="nc-cortex-why">
                  {proposal.action === 'create' ? 'Substitui' : 'Memória alvo'}:{' '}
                  {titles.get(proposal.targetMemoryId) ?? proposal.targetMemoryId}
                </p>
              )}
              {proposal.duplicates.length > 0 && (
                <p className="nc-cortex-warn">
                  Possível duplicidade com:{' '}
                  {proposal.duplicates
                    .map(
                      (item) =>
                        `${titles.get(item.memoryId) ?? item.memoryId} (${Math.round(item.score * 100)}%)`,
                    )
                    .join(', ')}
                </p>
              )}
              {proposal.reviews.map((review, index) => (
                <p
                  key={index}
                  className={review.actor.kind === 'system' ? 'nc-cortex-warn' : 'nc-cortex-review'}
                >
                  <Sparkles size={11} /> {review.actor.name}:{' '}
                  {review.actor.kind === 'system'
                    ? ''
                    : `recomenda ${verdictLabels[review.verdict]} — `}
                  {review.reason}
                </p>
              ))}
              <footer>
                <span>
                  {name(proposal.proposer.workerId, proposal.proposer.name)} ·{' '}
                  {when(proposal.createdAt)}
                  {proposal.origin.taskId ? ' · durante uma tarefa' : ''}
                </span>
                {proposal.resolution && (
                  <span>
                    {proposal.resolution.actor.name}: {proposal.resolution.note || 'sem nota'}
                  </span>
                )}
              </footer>
              {proposal.status === 'pending' && (
                <div className="nc-cortex-actions">
                  <input
                    className="grow"
                    placeholder="Nota para o agente (opcional)"
                    value={notes[proposal.id] ?? ''}
                    onChange={(event) => setNotes({ ...notes, [proposal.id]: event.target.value })}
                  />
                  <button
                    className="ghost nc-small"
                    disabled={assessing === proposal.id}
                    title="A Queen compara com as memórias existentes e recomenda; a decisão é sua."
                    onClick={() => {
                      setAssessing(proposal.id);
                      void act(
                        () =>
                          window.hive.invoke('cortex.proposal.assess', { proposalId: proposal.id }),
                        'Parecer da Queen registrado.',
                      ).finally(() => setAssessing(null));
                    }}
                  >
                    <Sparkles size={12} />{' '}
                    {assessing === proposal.id ? 'Queen avaliando…' : 'Parecer da Queen'}
                  </button>
                  {editing?.id === proposal.id ? (
                    <button className="ghost nc-small" onClick={() => setEditing(null)}>
                      Descartar edição
                    </button>
                  ) : (
                    proposal.action !== 'revoke' && (
                      <button
                        className="ghost nc-small"
                        onClick={() =>
                          setEditing({ id: proposal.id, draft: draftOf(proposal.draft) })
                        }
                      >
                        <Pencil size={12} /> Ajustar
                      </button>
                    )
                  )}
                  <button
                    className="secondary nc-small"
                    onClick={() => void resolve(proposal, 'request_changes')}
                  >
                    Pedir ajustes
                  </button>
                  <button
                    className="secondary nc-small danger"
                    onClick={() => void resolve(proposal, 'reject')}
                  >
                    <X size={12} /> Rejeitar
                  </button>
                  <button className="nc-small" onClick={() => void resolve(proposal, 'approve')}>
                    <Check size={12} /> Aprovar
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </State>
    </section>
  );
}

/* ---------------------------------------------------------------- decisions */

function DecisionsTab({
  block,
  version,
  name,
}: {
  block: CortexOverview;
  version: string;
  name: Name;
}) {
  const cortexId = block.node.id;
  const list = useList(
    useCallback(
      () => window.hive.invoke('cortex.memories', { cortexId, kinds: ['decision'] }),
      [cortexId],
    ),
    version,
  );
  const [open, setOpen] = useState<string | null>(null);
  const byId = useMemo(
    () => new Map((list.items ?? []).map((memory) => [memory.id, memory])),
    [list.items],
  );
  const ordered = useMemo(
    () =>
      [...(list.items ?? [])].sort(
        (a, b) =>
          Number(b.status === 'active') - Number(a.status === 'active') ||
          b.createdAt.localeCompare(a.createdAt),
      ),
    [list.items],
  );
  return (
    <section className="nc-cortex-section">
      {!block.node.config.architecturalDecisions && (
        <p className="nc-cortex-warn">
          O histórico de decisões está desligado nas conexões deste Cortex.
        </p>
      )}
      <State
        loading={!list.items}
        error={list.error}
        empty={list.items?.length === 0 ? 'Nenhuma decisão arquitetural registrada.' : null}
        onRetry={list.reload}
      >
        <ol className="nc-cortex-timeline">
          {ordered.map((memory) => (
            <li key={memory.id} className={`status-${memory.status}`}>
              <MemoryCard memory={memory} name={name}>
                <div className="nc-cortex-chain">
                  {memory.supersedes && (
                    <span>
                      Substitui: {byId.get(memory.supersedes)?.title ?? memory.supersedes}
                    </span>
                  )}
                  {memory.supersededBy && (
                    <span>
                      Substituída por: {byId.get(memory.supersededBy)?.title ?? memory.supersededBy}
                    </span>
                  )}
                  {memory.origin.runId && (
                    <span className="mono">
                      Missão de origem: {memory.origin.missionId ?? memory.origin.runId}
                    </span>
                  )}
                  <span className="mono">{memory.id}</span>
                  <button
                    className="ghost nc-small"
                    onClick={() => setOpen(open === memory.id ? null : memory.id)}
                  >
                    <History size={12} /> Histórico ({memory.history.length})
                  </button>
                </div>
                {open === memory.id && (
                  <ul className="nc-cortex-history">
                    {memory.history.map((entry) => (
                      <li key={`${entry.version}:${entry.at}`}>
                        <span className="mono">v{entry.version}</span> {entry.change} por{' '}
                        {entry.actor.name} · {when(entry.at)}
                        {entry.note && ` — ${entry.note}`}
                        {entry.previous && <em> (antes: “{entry.previous.title}”)</em>}
                      </li>
                    ))}
                  </ul>
                )}
              </MemoryCard>
            </li>
          ))}
        </ol>
      </State>
    </section>
  );
}

/* ---------------------------------------------------------------- activity */

const activityLabels: Partial<Record<CortexActivity['type'], string>> = {
  query: 'Consulta',
  context: 'Contexto',
  proposed: 'Proposta',
  reviewed: 'Parecer',
  approved: 'Aprovação',
  rejected: 'Rejeição',
  changes_requested: 'Ajustes',
  edited: 'Edição',
  revoked: 'Revogação',
  notified: 'Aviso',
  delivered: 'Entrega',
  denied: 'Negado',
  embedding: 'Embeddings',
  connected: 'Conexão',
  disconnected: 'Desconexão',
  permissions: 'Permissões',
  configured: 'Configuração',
  created: 'Criação',
};

function ActivityTab({ block, version }: { block: CortexOverview; version: string }) {
  const cortexId = block.node.id;
  const [type, setType] = useState<CortexActivity['type'] | ''>('');
  const list = useList(
    useCallback(
      () =>
        window.hive.invoke('cortex.activity', {
          cortexId,
          types: type ? [type] : undefined,
          limit: 300,
        }),
      [cortexId, type],
    ),
    version,
  );
  return (
    <section className="nc-cortex-section">
      <div className="nc-cortex-toolbar">
        <select
          value={type}
          onChange={(event) => setType(event.target.value as CortexActivity['type'] | '')}
        >
          <option value="">Todas as operações</option>
          {Object.entries(activityLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <span className="muted-text grow">
          Consultas, propostas, aprovações, avisos e acessos negados ficam registrados.
        </span>
      </div>
      <State
        loading={!list.items}
        error={list.error}
        empty={list.items?.length === 0 ? 'Nenhuma operação registrada.' : null}
        onRetry={list.reload}
      >
        <ul className="nc-cortex-activity">
          {list.items?.map((entry) => (
            <li key={entry.id} className={`type-${entry.type}`}>
              <span className="mono">{when(entry.ts)}</span>
              <span className="badge">{activityLabels[entry.type] ?? entry.type}</span>
              <span className="grow">{entry.message}</span>
            </li>
          ))}
        </ul>
      </State>
    </section>
  );
}

/* ---------------------------------------------------------------- connections & settings */

function ConnectionsTab({
  block,
  workers,
  act,
}: {
  block: CortexOverview;
  workers: Map<string, CanvasWorker>;
  act: Act;
}) {
  const { node } = block;
  const [name, setName] = useState(node.name);
  const [budget, setBudget] = useState(node.config.taskTokenBudget);
  useEffect(() => setName(node.name), [node.name]);
  useEffect(() => setBudget(node.config.taskTokenBudget), [node.config.taskTokenBudget]);
  const unconnected = [...workers.values()].filter(
    (worker) => !node.connections.some((connection) => connection.workerId === worker.id),
  );
  const toggle = (workerId: string, permissions: CortexPermissions, key: CortexPermission) =>
    act(
      () =>
        window.hive.invoke('cortex.permissions', {
          cortexId: node.id,
          workerId,
          permissions: { ...permissions, [key]: !permissions[key] },
        }),
      'Permissões atualizadas.',
    );
  const config = (patch: Partial<typeof node.config>, done = 'Configuração salva.') =>
    act(() => window.hive.invoke('cortex.update', { cortexId: node.id, config: patch }), done);
  return (
    <section className="nc-cortex-section">
      <h3>Agentes conectados</h3>
      <p className="muted-text">
        Só quem tem uma linha até este bloco acessa a memória. Arraste de um agente no canvas, ou
        conecte aqui.
      </p>
      {node.connections.length === 0 ? (
        <div className="nc-cortex-state-box">
          Nenhum agente conectado: ninguém acessa este Cortex.
        </div>
      ) : (
        <table className="nc-cortex-table">
          <thead>
            <tr>
              <th>Agente</th>
              {(['read', 'propose', 'approve', 'manage'] as const).map((key) => (
                <th key={key} title={permissionHelp[key]}>
                  {key[0]!.toUpperCase() + key.slice(1)}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {node.connections.map((connection) => {
              const worker = workers.get(connection.workerId);
              return (
                <tr key={connection.workerId}>
                  <td>
                    <strong>{worker?.name ?? connection.workerId}</strong>
                    <span className="muted-text">
                      {' '}
                      {worker ? roleLabel(worker.role) : 'agente removido'}
                      {connection.source === 'autopilot' ? ' · via Autopilot' : ''}
                    </span>
                  </td>
                  {(['read', 'propose', 'approve', 'manage'] as const).map((key) => (
                    <td key={key}>
                      <input
                        type="checkbox"
                        aria-label={`${key} para ${worker?.name ?? connection.workerId}`}
                        title={permissionHelp[key]}
                        checked={connection.permissions[key]}
                        onChange={() =>
                          void toggle(connection.workerId, connection.permissions, key)
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      className="ghost nc-small danger"
                      onClick={() =>
                        void act(
                          () =>
                            window.hive.invoke('cortex.disconnect', {
                              cortexId: node.id,
                              workerId: connection.workerId,
                            }),
                          'Agente desconectado: perdeu o acesso.',
                        )
                      }
                    >
                      <Unlink size={12} /> Desconectar
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {unconnected.length > 0 && (
        <div className="nc-cortex-toolbar">
          <select
            value=""
            aria-label="Conectar agente"
            onChange={(event) =>
              event.target.value &&
              void act(
                () =>
                  window.hive.invoke('cortex.connect', {
                    cortexId: node.id,
                    workerId: event.target.value,
                  }),
                'Agente conectado com Read e Propose.',
              )
            }
          >
            <option value="">Conectar agente…</option>
            {unconnected.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name} · {roleLabel(worker.role)}
              </option>
            ))}
          </select>
        </div>
      )}
      <ul className="nc-cortex-help">
        {(Object.keys(permissionHelp) as CortexPermission[]).map((key) => (
          <li key={key}>{permissionHelp[key]}</li>
        ))}
      </ul>

      <h3>Configuração</h3>
      <div className="form">
        <div className="nc-cortex-row">
          <label className="grow">
            Nome
            <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </label>
          <button
            className="secondary nc-small"
            disabled={!name.trim() || name === node.name}
            onClick={() =>
              void act(
                () => window.hive.invoke('cortex.update', { cortexId: node.id, name }),
                'Nome salvo.',
              )
            }
          >
            Salvar nome
          </button>
        </div>
        <p className="muted-text">
          Escopo: projeto · Persistente · Política de escrita:{' '}
          {node.config.writePolicy === 'approval' ? 'aprovação' : 'direta'} · Motor de busca:{' '}
          {block.embedding.model}
          {block.embedding.degraded ? ` (provedor falhou: ${block.embedding.degraded})` : ''}
        </p>
        {(
          [
            ['semanticSearch', 'Busca semântica (embeddings)'],
            ['relevanceFiltering', 'Filtrar por relevância para a tarefa e o papel'],
            ['deduplication', 'Evitar duplicidades'],
            ['changeNotifications', 'Avisar agentes afetados por mudanças'],
            [
              'architecturalDecisions',
              'Histórico de decisões (decisão alterada vira nova decisão)',
            ],
            ['humanApprovalRequired', 'Aprovação humana obrigatória'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={node.config[key]}
              onChange={(event) => {
                if (
                  key === 'humanApprovalRequired' &&
                  !event.target.checked &&
                  !window.confirm(
                    'Sem aprovação humana, agentes com Approve poderão publicar memórias. Continuar?',
                  )
                )
                  return;
                void config({ [key]: event.target.checked });
              }}
            />
            {label}
          </label>
        ))}
        <div className="nc-cortex-row">
          <label>
            Orçamento de tokens por tarefa
            <input
              type="number"
              min={100}
              max={8000}
              step={100}
              value={budget}
              onChange={(event) => setBudget(Number(event.target.value))}
            />
          </label>
          <button
            className="secondary nc-small"
            disabled={budget === node.config.taskTokenBudget || budget < 100 || budget > 8000}
            onClick={() => void config({ taskTokenBudget: budget })}
          >
            Salvar orçamento
          </button>
        </div>
        <EmbeddingSettings
          block={block}
          onSave={(embedding) => config({ embedding }, 'Motor de embeddings salvo.')}
        />
      </div>
    </section>
  );
}

function EmbeddingSettings({
  block,
  onSave,
}: {
  block: CortexOverview;
  onSave: (embedding: CortexOverview['node']['config']['embedding']) => Promise<boolean>;
}) {
  const current = block.node.config.embedding;
  const [mode, setMode] = useState(current.mode);
  const [providerId, setProviderId] = useState(current.providerId ?? '');
  const [modelId, setModelId] = useState(current.modelId ?? '');
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void window.hive
      .invoke('provider.list')
      .then((list) =>
        setProviders(
          list.filter((item) => item.enabled).map((item) => ({ id: item.id, name: item.name })),
        ),
      )
      .catch(() => setProviders([]));
  }, []);
  const changed =
    mode !== current.mode ||
    providerId !== (current.providerId ?? '') ||
    modelId !== (current.modelId ?? '');
  return (
    <fieldset className="nc-cortex-fieldset">
      <legend>Embeddings</legend>
      <label className="check">
        <input type="radio" checked={mode === 'local'} onChange={() => setMode('local')} />
        Local do Hive (offline, gratuito; conceitos de software em pt/en)
      </label>
      <label className="check">
        <input type="radio" checked={mode === 'provider'} onChange={() => setMode('provider')} />
        Provedor compatível com OpenAI (/embeddings, ex.: Ollama com nomic-embed-text)
      </label>
      {mode === 'provider' && (
        <div className="nc-cortex-row">
          <label className="grow">
            Provedor
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              <option value="">Escolha…</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            Modelo de embeddings
            <input
              value={modelId}
              placeholder="nomic-embed-text"
              onChange={(event) => setModelId(event.target.value)}
            />
          </label>
        </div>
      )}
      <p className="muted-text">
        Se o provedor falhar, a busca usa o motor local e a tarefa segue normalmente.
      </p>
      <button
        className="secondary nc-small"
        disabled={!changed || (mode === 'provider' && (!providerId || !modelId.trim()))}
        onClick={() =>
          void onSave(
            mode === 'local'
              ? { mode: 'local', providerId: null, modelId: null }
              : { mode: 'provider', providerId, modelId: modelId.trim() },
          )
        }
      >
        Salvar embeddings
      </button>
    </fieldset>
  );
}
