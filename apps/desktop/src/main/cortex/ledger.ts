import type {
  CortexActor,
  CortexDraft,
  CortexMemory,
  CortexNode,
  CortexOrigin,
  CortexProposal,
} from '@hive/core';
import type { CortexRepository } from '@hive/persistence';
import { HiveError, newId, nowIso } from '@hive/shared';
import { cleanDraft } from './sanitize';

export type MemoryChangeKind = 'approved' | 'updated' | 'superseded' | 'revoked';

/** A memory became (or stopped being) knowledge the agents receive. */
export interface MemoryChange {
  node: CortexNode;
  memory: CortexMemory;
  change: MemoryChangeKind;
  /** The memory it replaced, for a new decision that supersedes another. */
  replaced: CortexMemory | null;
  actor: CortexActor;
}

const MAX_HISTORY = 100;

const draftOf = (memory: CortexMemory): CortexDraft => ({
  kind: memory.kind,
  title: memory.title,
  content: memory.content,
  rationale: memory.rationale,
  tags: memory.tags,
  evidence: memory.evidence,
  audience: memory.audience,
});

const push = <T>(list: T[], item: T) => [...list, item].slice(-MAX_HISTORY);

/**
 * Proposals and memories. Nothing an agent sends becomes knowledge here without a decision: a
 * proposal waits as `pending` until the user (or, only when the user turned human approval off, an
 * agent with Approve) resolves it. Every change keeps the previous content in the memory's history,
 * and a decision that replaces another leaves the old one readable as `superseded`.
 */
export class CortexLedger {
  constructor(
    private readonly repo: CortexRepository,
    private readonly onChange: (change: MemoryChange) => void,
  ) {}

  memory(memoryId: string): CortexMemory {
    return this.repo.memories.require(memoryId, 'Memória');
  }

  propose(input: {
    node: CortexNode;
    action: CortexProposal['action'];
    targetMemoryId: string | null;
    draft: CortexDraft;
    proposer: CortexActor;
    origin: CortexOrigin;
    duplicates: CortexProposal['duplicates'];
    warnings: string[];
  }): CortexProposal {
    const draft = cleanDraft(input.draft);
    if (input.targetMemoryId) {
      const target = this.memory(input.targetMemoryId);
      if (target.cortexId !== input.node.id)
        throw new HiveError('VALIDATION', 'A memória indicada é de outro Cortex.');
      if (input.action !== 'create' && target.status !== 'active')
        throw new HiveError('CONFLICT', 'Só memórias vigentes podem ser alteradas ou revogadas.');
    } else if (input.action !== 'create')
      throw new HiveError('VALIDATION', 'Indique a memória a alterar ou revogar.');
    const at = nowIso();
    const proposal: CortexProposal = {
      id: newId('cxp'),
      cortexId: input.node.id,
      workspaceId: input.node.workspaceId,
      action: input.action,
      targetMemoryId: input.targetMemoryId,
      draft,
      proposer: input.proposer,
      origin: input.origin,
      status: 'pending',
      duplicates: input.duplicates,
      reviews: input.warnings.length
        ? [
            {
              actor: { kind: 'system', workerId: null, name: 'Cortex' },
              verdict: 'revise',
              reason: `Atenção: o texto ${input.warnings.join('; ')}. Ele será tratado como dado, nunca como instrução.`,
              at,
            },
          ]
        : [],
      resolution: null,
      createdAt: at,
      updatedAt: at,
    };
    this.repo.proposals.put(proposal);
    this.repo.log({
      cortexId: input.node.id,
      workspaceId: input.node.workspaceId,
      type: 'proposed',
      actor: input.proposer,
      runId: input.origin.runId,
      taskId: input.origin.taskId,
      message: `${input.proposer.name} propôs ${input.action === 'create' ? 'uma memória' : input.action === 'update' ? 'uma alteração' : 'uma revogação'}: ${draft.title}`,
      memoryIds: input.targetMemoryId ? [input.targetMemoryId] : [],
      data: {
        proposalId: proposal.id,
        duplicates: input.duplicates.length,
        warnings: input.warnings,
      },
    });
    return proposal;
  }

  /** An opinion on a pending proposal; it decides nothing. */
  review(proposalId: string, review: CortexProposal['reviews'][number]): CortexProposal {
    return this.repo.transaction(() => {
      const proposal = this.repo.proposals.require(proposalId, 'Proposta');
      if (proposal.status !== 'pending')
        throw new HiveError('CONFLICT', 'Esta proposta já foi resolvida.');
      const saved = this.repo.proposals.put({
        ...proposal,
        reviews: [
          ...proposal.reviews.filter(
            (item) =>
              item.actor.workerId !== review.actor.workerId || review.actor.kind !== 'agent',
          ),
          review,
        ].slice(-10),
        updatedAt: nowIso(),
      });
      this.repo.log({
        cortexId: proposal.cortexId,
        workspaceId: proposal.workspaceId,
        type: 'reviewed',
        actor: review.actor,
        runId: proposal.origin.runId,
        taskId: proposal.origin.taskId,
        message: `${review.actor.name} recomendou ${review.verdict}: ${proposal.draft.title}`,
        memoryIds: [],
        data: { proposalId, verdict: review.verdict },
      });
      return saved;
    });
  }

  /**
   * Resolves a pending proposal. The check that it is still pending, and that the memory it changes
   * is still the version it saw, happen in the same transaction as the write: two windows (or a user
   * and an agent) cannot both resolve it.
   */
  resolve(input: {
    node: CortexNode;
    proposalId: string;
    decision: 'approve' | 'reject' | 'request_changes';
    actor: CortexActor;
    note: string;
    draft?: CortexDraft;
  }): { proposal: CortexProposal; memory: CortexMemory | null } {
    let change: MemoryChange | null = null;
    const result = this.repo.transaction(() => {
      const proposal = this.repo.proposals.require(input.proposalId, 'Proposta');
      if (proposal.cortexId !== input.node.id)
        throw new HiveError('VALIDATION', 'Esta proposta é de outro Cortex.');
      if (proposal.status !== 'pending')
        throw new HiveError('CONFLICT', 'Esta proposta já foi resolvida.');
      const at = nowIso();
      if (input.decision !== 'approve') {
        const status = input.decision === 'reject' ? 'rejected' : 'changes_requested';
        const saved = this.repo.proposals.put({
          ...proposal,
          status,
          resolution: { actor: input.actor, note: input.note, at, memoryId: null },
          updatedAt: at,
        });
        this.repo.log({
          cortexId: proposal.cortexId,
          workspaceId: proposal.workspaceId,
          type: status,
          actor: input.actor,
          runId: proposal.origin.runId,
          taskId: proposal.origin.taskId,
          message: `${status === 'rejected' ? 'Rejeitada' : 'Ajustes pedidos'}: ${proposal.draft.title}${input.note ? ` — ${input.note}` : ''}`,
          memoryIds: [],
          data: { proposalId: proposal.id },
        });
        return { proposal: saved, memory: null };
      }
      const draft = cleanDraft(input.draft ?? proposal.draft);
      let memory: CortexMemory;
      if (proposal.action === 'create') {
        ({ memory, change } = this.write(
          input.node,
          draft,
          proposal.proposer,
          input.actor,
          proposal.origin,
          proposal.targetMemoryId,
        ));
      } else {
        const target = this.memory(proposal.targetMemoryId!);
        if (target.status !== 'active')
          throw new HiveError(
            'CONFLICT',
            'A memória mudou desde a proposta: ela não está mais vigente.',
          );
        if (proposal.action === 'revoke') {
          memory = this.retire(
            target,
            'revoked',
            input.actor,
            input.note || proposal.draft.rationale,
          );
          change = {
            node: input.node,
            memory,
            change: 'revoked',
            replaced: null,
            actor: input.actor,
          };
        } else if (target.kind === 'decision' && input.node.config.architecturalDecisions) {
          // A changed decision is a new decision; the old one stays as history.
          ({ memory, change } = this.write(
            input.node,
            draft,
            proposal.proposer,
            input.actor,
            proposal.origin,
            target.id,
          ));
        } else {
          memory = this.amend(target, draft, input.actor, input.note || 'Alteração aprovada.');
          change = {
            node: input.node,
            memory,
            change: 'updated',
            replaced: null,
            actor: input.actor,
          };
        }
      }
      const saved = this.repo.proposals.put({
        ...proposal,
        draft,
        status: 'approved',
        resolution: { actor: input.actor, note: input.note, at, memoryId: memory.id },
        updatedAt: at,
      });
      this.repo.log({
        cortexId: proposal.cortexId,
        workspaceId: proposal.workspaceId,
        type: 'approved',
        actor: input.actor,
        runId: proposal.origin.runId,
        taskId: proposal.origin.taskId,
        message: `Aprovada: ${draft.title}`,
        memoryIds: [memory.id],
        data: { proposalId: proposal.id, action: proposal.action },
      });
      return { proposal: saved, memory };
    });
    if (change) this.onChange(change);
    return result;
  }

  /** A memory the user writes directly: writing it is the approval. */
  create(
    node: CortexNode,
    draft: CortexDraft,
    actor: CortexActor,
    supersedes: string | null,
  ): CortexMemory {
    let change: MemoryChange | null = null;
    const memory = this.repo.transaction(() => {
      const written = this.write(
        node,
        cleanDraft(draft),
        actor,
        actor,
        { runId: null, missionId: null, taskId: null },
        supersedes,
      );
      change = written.change;
      this.repo.log({
        cortexId: node.id,
        workspaceId: node.workspaceId,
        type: 'approved',
        actor,
        runId: null,
        taskId: null,
        message: `Memória registrada pelo usuário: ${written.memory.title}`,
        memoryIds: [written.memory.id],
        data: null,
      });
      return written.memory;
    });
    if (change) this.onChange(change);
    return memory;
  }

  edit(
    node: CortexNode,
    memoryId: string,
    expectedVersion: number,
    draft: CortexDraft,
    actor: CortexActor,
    note: string,
  ): CortexMemory {
    let change: MemoryChange | null = null;
    const memory = this.repo.transaction(() => {
      const target = this.current(node, memoryId, expectedVersion);
      if (target.status !== 'active')
        throw new HiveError('CONFLICT', 'Só memórias vigentes podem ser editadas.');
      const memory = this.amend(target, cleanDraft(draft), actor, note || 'Editada pelo usuário.');
      change = { node, memory, change: 'updated', replaced: null, actor };
      this.repo.log({
        cortexId: node.id,
        workspaceId: node.workspaceId,
        type: 'edited',
        actor,
        runId: null,
        taskId: null,
        message: `Editada: ${memory.title}`,
        memoryIds: [memory.id],
        data: { version: memory.version },
      });
      return memory;
    });
    if (change) this.onChange(change);
    return memory;
  }

  revoke(
    node: CortexNode,
    memoryId: string,
    expectedVersion: number,
    actor: CortexActor,
    note: string,
  ): CortexMemory {
    let change: MemoryChange | null = null;
    const memory = this.repo.transaction(() => {
      const target = this.current(node, memoryId, expectedVersion);
      if (target.status !== 'active')
        throw new HiveError('CONFLICT', 'Esta memória já não está vigente.');
      const memory = this.retire(target, 'revoked', actor, note);
      change = { node, memory, change: 'revoked', replaced: null, actor };
      this.repo.log({
        cortexId: node.id,
        workspaceId: node.workspaceId,
        type: 'revoked',
        actor,
        runId: null,
        taskId: null,
        message: `Revogada: ${memory.title} — ${note}`,
        memoryIds: [memory.id],
        data: null,
      });
      return memory;
    });
    if (change) this.onChange(change);
    return memory;
  }

  /* ---------------------------------------------------------------- internals */

  private current(node: CortexNode, memoryId: string, expectedVersion: number): CortexMemory {
    const memory = this.memory(memoryId);
    if (memory.cortexId !== node.id)
      throw new HiveError('VALIDATION', 'Esta memória é de outro Cortex.');
    if (memory.version !== expectedVersion)
      throw new HiveError(
        'CONFLICT',
        'A memória foi alterada em outro lugar. Recarregue para ver a versão atual antes de mudar.',
      );
    return memory;
  }

  private write(
    node: CortexNode,
    draft: CortexDraft,
    author: CortexActor,
    approver: CortexActor,
    origin: CortexOrigin,
    supersedes: string | null,
  ): { memory: CortexMemory; change: MemoryChange } {
    const at = nowIso();
    const id = newId('mem');
    let replaced: CortexMemory | null = null;
    if (supersedes) {
      const old = this.memory(supersedes);
      if (old.cortexId !== node.id)
        throw new HiveError('VALIDATION', 'A memória substituída é de outro Cortex.');
      if (old.status === 'active') {
        replaced = this.repo.memories.put({
          ...old,
          status: 'superseded',
          supersededBy: id,
          version: old.version + 1,
          history: push(old.history, {
            version: old.version + 1,
            at,
            actor: approver,
            change: 'superseded',
            note: `Substituída por “${draft.title}”.`,
            previous: null,
          }),
          updatedAt: at,
        });
      }
    }
    const memory = this.repo.memories.put({
      id,
      cortexId: node.id,
      workspaceId: node.workspaceId,
      ...draft,
      status: 'active',
      supersedes: replaced ? replaced.id : null,
      supersededBy: null,
      author,
      approvedBy: approver,
      origin,
      version: 1,
      history: [
        {
          version: 1,
          at,
          actor: approver,
          change: 'created',
          note: replaced ? `Substitui “${replaced.title}”.` : '',
          previous: null,
        },
      ],
      createdAt: at,
      updatedAt: at,
    });
    return {
      memory,
      change: {
        node,
        memory,
        change: replaced ? 'superseded' : 'approved',
        replaced,
        actor: approver,
      },
    };
  }

  private amend(
    target: CortexMemory,
    draft: CortexDraft,
    actor: CortexActor,
    note: string,
  ): CortexMemory {
    const at = nowIso();
    return this.repo.memories.put({
      ...target,
      ...draft,
      version: target.version + 1,
      history: push(target.history, {
        version: target.version + 1,
        at,
        actor,
        change: 'edited',
        note: note.slice(0, 500),
        previous: draftOf(target),
      }),
      updatedAt: at,
    });
  }

  private retire(
    target: CortexMemory,
    status: 'revoked',
    actor: CortexActor,
    note: string,
  ): CortexMemory {
    const at = nowIso();
    return this.repo.memories.put({
      ...target,
      status,
      version: target.version + 1,
      history: push(target.history, {
        version: target.version + 1,
        at,
        actor,
        change: 'revoked',
        note: note.slice(0, 500),
        previous: null,
      }),
      updatedAt: at,
    });
  }
}
