import { beforeEach, describe, expect, it } from 'vitest';
import { fileTab, hasUnsavedChanges, projectHasUnsavedChanges, useCode } from './store';

beforeEach(() => {
  useCode.setState({ project: null, snapshots: {} });
  useCode.getState().switchTo('alpha');
  useCode.setState({ groups: [{ tabs: [], active: null }], focused: 0, dirty: {}, conflicts: {} });
});

describe('per-project editor state', () => {
  it('keeps each project’s open tabs when switching back and forth', () => {
    useCode.getState().open(fileTab('src/App.tsx'));
    useCode.getState().switchTo('beta');
    expect(useCode.getState().groups[0]!.tabs).toEqual([]);

    useCode.getState().open(fileTab('index.html'));
    useCode.getState().switchTo('alpha');
    expect(useCode.getState().groups[0]!.tabs.map((tab) => tab.id)).toEqual(['file:src/App.tsx']);

    useCode.getState().switchTo('beta');
    expect(useCode.getState().groups[0]!.tabs.map((tab) => tab.id)).toEqual(['file:index.html']);
  });

  it('reports unsaved edits in a project that is in the background', () => {
    useCode.getState().setDirty('src/App.tsx', true);
    useCode.getState().switchTo('beta');
    expect(projectHasUnsavedChanges('alpha')).toBe(true);
    expect(projectHasUnsavedChanges('beta')).toBe(false);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('does not keep a snapshot for the project in front', () => {
    useCode.getState().switchTo('beta');
    useCode.getState().switchTo('alpha');
    expect(Object.keys(useCode.getState().snapshots)).toEqual(['beta']);
  });

  it('drops the state of a closed project', () => {
    useCode.getState().switchTo('beta');
    useCode.getState().dropProject('alpha');
    expect(Object.keys(useCode.getState().snapshots)).toEqual([]);
  });
});
