// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CanvasSnapshot, CanvasTeamMessage, CanvasWorker } from '@hive/core';
import type { CanvasView } from './nodes';
import { TeamMessages, teamLeaderName } from './team-panel';

afterEach(cleanup);

const worker = (id: string, name: string, team?: CanvasWorker['team']): CanvasWorker => ({
  id,
  name,
  role: 'backend',
  beeColor: null,
  providerId: 'p',
  providerName: 'P',
  modelId: 'm',
  ...(team ? { team } : {}),
});

const message = (id: string, patch: Partial<CanvasTeamMessage>): CanvasTeamMessage => ({
  id,
  kind: 'delegation',
  fromAgentId: 'claude',
  toAgentId: 'codex',
  fromTaskId: 'lead',
  toTaskId: 'impl',
  subject: 'Implementar a API',
  body: 'Siga o contrato.',
  verdict: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

function view(messages: CanvasTeamMessage[]): CanvasView {
  const workers = [
    worker('claude', 'Claude'),
    worker('codex', 'Codex', { parentAgentId: 'claude', createdByAgentId: 'claude', depth: 1 }),
    worker('nemotron', 'Nemotron', {
      parentAgentId: 'claude',
      createdByAgentId: 'claude',
      depth: 1,
    }),
  ];
  return {
    snapshot: { teamMessages: messages } as CanvasSnapshot,
    workers: new Map(workers.map((item) => [item.id, item])),
  } as unknown as CanvasView;
}

it('mostra a conversa da equipe em ordem, com quem fala com quem e o veredito', () => {
  render(
    <TeamMessages
      view={view([
        message('1', {}),
        message('2', {
          kind: 'feedback',
          fromAgentId: 'nemotron',
          subject: 'Mudanças pedidas',
          verdict: 'changes_requested',
        }),
        message('3', {
          kind: 'report',
          fromAgentId: 'claude',
          toAgentId: null,
          subject: 'Relatório de Claude',
        }),
      ])}
    />,
  );
  const items = within(screen.getByRole('list', { name: 'Mensagens do Hive Teams' })).getAllByRole(
    'listitem',
  );
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining('DelegaçãoClaude → Codex'),
    expect.stringContaining('mudanças pedidasNemotron → Codex'),
    expect.stringContaining('Claude → Queen'),
  ]);
});

it('filtra por agente ou tarefa e não mostra nada sem mensagens', () => {
  const { container } = render(
    <TeamMessages
      view={view([message('1', {}), message('2', { toTaskId: 'outra' })])}
      filter={(m) => m.toTaskId === 'outra'}
    />,
  );
  expect(container.querySelectorAll('li')).toHaveLength(1);
  cleanup();
  const empty = render(<TeamMessages view={view([])} />);
  expect(empty.container.innerHTML).toBe('');
  expect(teamLeaderName(view([]), 'codex')).toBe('Claude');
  expect(teamLeaderName(view([]), 'claude')).toBeNull();
});
