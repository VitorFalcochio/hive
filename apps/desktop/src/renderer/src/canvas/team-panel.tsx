import type { CanvasTeamMessage, Task } from '@hive/core';
import type { CanvasView } from './nodes';

/** How each Hive Teams message reads in the timeline. */
const kindLabels: Record<CanvasTeamMessage['kind'], string> = {
  spawn: 'Agente criado',
  delegation: 'Delegação',
  review_request: 'Pedido de revisão',
  feedback: 'Feedback',
  report: 'Relatório',
  note: 'Nota',
};

const verdictLabels: Record<string, string> = {
  approved: 'aprovado',
  changes_requested: 'mudanças pedidas',
};

/** A task's place in a Hive Teams team, in the words the canvas shows. */
export const teamRoleLabels: Record<NonNullable<Task['team']>['role'], string> = {
  lead: 'Líder',
  member: 'Membro',
  review: 'Revisão',
  consolidate: 'Consolidação do líder',
};

function who(view: CanvasView, id: string | null): string {
  if (!id) return 'Queen';
  return view.workers.get(id)?.name ?? 'agente';
}

/**
 * The Hive Teams conversation: every agent created, piece of work delegated, review and report,
 * in the order it happened. `filter` narrows it to one agent or one task.
 */
export function TeamMessages({
  view,
  filter,
}: {
  view: CanvasView;
  filter?: (message: CanvasTeamMessage) => boolean;
}) {
  const messages = (view.snapshot.teamMessages ?? []).filter(filter ?? (() => true));
  if (!messages.length) return null;
  return (
    <ol className="nc-team-messages" aria-label="Mensagens do Hive Teams">
      {messages.map((message) => (
        <li key={message.id} className={`kind-${message.kind}`}>
          <p className="nc-team-head">
            <strong>{kindLabels[message.kind]}</strong>
            {message.verdict && (
              <span className={`nc-chip verdict-${message.verdict}`}>
                {verdictLabels[message.verdict] ?? message.verdict}
              </span>
            )}
            <span className="nc-team-route">
              {who(view, message.fromAgentId)} → {who(view, message.toAgentId)}
            </span>
          </p>
          <p className="nc-team-subject">{message.subject}</p>
          {message.body && <p className="nc-team-body">{message.body}</p>}
        </li>
      ))}
    </ol>
  );
}

/** The leader an agent answers to, for agents a leader created. */
export function teamLeaderName(view: CanvasView, workerId: string): string | null {
  const parent = view.workers.get(workerId)?.team?.parentAgentId;
  return parent ? (view.workers.get(parent)?.name ?? 'líder') : null;
}
