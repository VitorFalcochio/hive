import { describe, expect, it } from 'vitest';
import { sectionOf, type SidebarMission } from './mission-cards';

const mission = (overrides: Partial<SidebarMission>): SidebarMission => ({
  id: 'm',
  title: 'Missão',
  lastRunStatus: null,
  pinned: false,
  ...overrides,
});

describe('sectionOf', () => {
  it('puts pinned missions first, whatever their status', () => {
    expect(sectionOf(mission({ pinned: true, lastRunStatus: 'completed' }))).toBe('pinned');
    expect(sectionOf(mission({ pinned: true, lastRunStatus: 'running' }))).toBe('pinned');
  });

  it('keeps missions still moving in progress, including drafts', () => {
    expect(sectionOf(mission({}))).toBe('progress');
    expect(sectionOf(mission({ lastRunStatus: 'draft' }))).toBe('progress');
    expect(sectionOf(mission({ lastRunStatus: 'running' }))).toBe('progress');
    expect(sectionOf(mission({ lastRunStatus: 'review' }))).toBe('progress');
  });

  it('moves finished missions to done', () => {
    expect(sectionOf(mission({ lastRunStatus: 'completed' }))).toBe('done');
    expect(sectionOf(mission({ lastRunStatus: 'cancelled' }))).toBe('done');
  });
});
