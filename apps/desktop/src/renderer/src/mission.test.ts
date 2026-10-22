import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@hive/core';
import { trackSquad, type Squads } from './mission';

const event = (type: AgentEvent['type'], data: Record<string, unknown> | null = null) =>
  ({ type, taskId: 't1', data }) as AgentEvent;

const replay = (events: AgentEvent[]) => events.reduce(trackSquad, {} as Squads);

describe('trackSquad', () => {
  it('keeps the soldiers that started and have not reported yet', () => {
    const squads = replay([
      event('info', { soldier: 'scout', phase: 'start' }),
      event('info', { soldier: 'researcher', phase: 'start' }),
      event('tool.call', { soldier: 'scout', tool: 'read_file' }),
      event('info', { soldier: 'scout', phase: 'end', status: 'completed' }),
    ]);

    expect(squads.t1).toEqual(['researcher']);
  });

  it('starts every session of the task with no soldier out', () => {
    const squads = replay([
      event('info', { soldier: 'builder', phase: 'start' }),
      event('session.started'),
    ]);

    expect(squads.t1).toEqual([]);
  });
});
