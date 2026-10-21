import { beforeEach, expect, it } from 'vitest';
import { fileTab, hasUnsavedChanges, taskDiffTab, useCode } from './store';

beforeEach(() => {
  useCode.setState({
    groups: [{ tabs: [], active: null }],
    focused: 0,
    dirty: {},
    conflicts: {},
    selection: null,
  });
});

it('abre abas sem duplicar, divide a tela e fecha o grupo vazio', () => {
  const { open, split, close } = useCode.getState();
  open(fileTab('src/a.ts'));
  open(fileTab('src/b.ts'));
  open(fileTab('src/a.ts'));
  expect(useCode.getState().groups[0]).toEqual({
    tabs: [fileTab('src/a.ts'), fileTab('src/b.ts')],
    active: 'file:src/a.ts',
  });

  split();
  const state = useCode.getState();
  expect(state.groups).toHaveLength(2);
  expect(state.focused).toBe(1);
  expect(state.groups[1]!.tabs).toEqual([fileTab('src/a.ts')]);

  open(taskDiffTab('t1', 'Tarefa', 'src/c.ts'));
  expect(useCode.getState().groups[1]!.active).toBe('diff:task:t1:src/c.ts');
  close('file:src/a.ts', 1);
  close('diff:task:t1:src/c.ts', 1);
  expect(useCode.getState().groups).toHaveLength(1);
});

it('esquece abas de arquivos removidos e acompanha alterações não salvas', () => {
  const { open, forget, setDirty, setSelection } = useCode.getState();
  open(fileTab('a.ts'));
  open(fileTab('b.ts'));
  setDirty('b.ts', true);
  setSelection({ path: 'b.ts', startOffset: 0, endOffset: 1, text: 'b' });
  expect(hasUnsavedChanges()).toBe(true);
  forget('b.ts');
  expect(useCode.getState().groups[0]!.tabs.map((tab) => tab.path)).toEqual(['a.ts']);
  expect(useCode.getState().groups[0]!.active).toBe('file:a.ts');
  expect(useCode.getState().selection).toBeNull();
  setDirty('b.ts', false);
  expect(hasUnsavedChanges()).toBe(false);
});
