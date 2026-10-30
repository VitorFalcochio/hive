// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyCanvasLayout, type CanvasLayout } from '@hive/core';
import { useLayout } from './use-layout';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const note = { id: 'note:one', text: 'A', x: 0, y: 0, tone: 'gold' as const };
function bridge() {
  let stored = emptyCanvasLayout;
  const invoke = vi.fn(async (channel: string, input?: unknown): Promise<unknown> => {
    if (channel === 'canvas.layout.get') return stored;
    if (channel === 'canvas.layout.save') stored = (input as { layout: CanvasLayout }).layout;
    return undefined;
  });
  window.hive = { invoke, subscribe: () => () => {} } as unknown as Window['hive'];
  return {
    invoke,
    get stored() {
      return stored;
    },
  };
}
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

it('serializa autosaves sem ressuscitar um layout antigo quando uma gravação anterior falha', async () => {
  vi.useFakeTimers();
  const hive = bridge();
  const normal = hive.invoke.getMockImplementation()!;
  let rejectFirst!: (error: Error) => void;
  let writes = 0;
  hive.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'canvas.layout.save' && ++writes === 1)
      return new Promise((_resolve, reject) => {
        rejectFirst = reject;
      });
    return normal(channel, input);
  });
  const hook = renderHook(() => useLayout('r'));
  await settle();
  act(() => hook.result.current.addNote(note));
  let first!: Promise<void>;
  act(() => {
    first = hook.result.current.persist().catch(() => {});
  });
  await settle();
  act(() => hook.result.current.updateNote(note.id, { text: 'B' }));
  let second!: Promise<void>;
  act(() => {
    second = hook.result.current.persist();
  });
  await act(async () => {
    rejectFirst(new Error('Falha anterior'));
    await first;
    await second;
  });
  await act(async () => {
    await hook.result.current.persist();
  });
  expect(hive.stored.notes[0]?.text).toBe('B');
  expect(writes).toBe(2);
  expect(hook.result.current.saveError).toBe('');
});

it('uma resposta de reload atrasada não sobrescreve uma mudança manual mais recente', async () => {
  vi.useFakeTimers();
  const hive = bridge();
  const normal = hive.invoke.getMockImplementation()!;
  const hook = renderHook(() => useLayout('r'));
  await settle();
  act(() => hook.result.current.addNote(note));
  await act(async () => {
    await hook.result.current.persist();
  });
  let read!: (value: CanvasLayout) => void;
  hive.invoke.mockImplementation(async (channel, input) =>
    channel === 'canvas.layout.get'
      ? new Promise((resolve) => {
          read = resolve;
        })
      : normal(channel, input),
  );
  let reload!: Promise<void>;
  act(() => {
    reload = hook.result.current.reload();
  });
  await settle();
  act(() => hook.result.current.updateNote(note.id, { text: 'Texto posterior' }));
  await act(async () => {
    read(hive.stored);
    await reload;
  });
  expect(hook.result.current.layout.notes[0]?.text).toBe('Texto posterior');
  await act(async () => {
    await hook.result.current.persist();
  });
  expect(hive.stored.notes[0]?.text).toBe('Texto posterior');
});

it('não grava um layout vazio quando a leitura falha e permite recuperar a sincronização', async () => {
  const hive = bridge();
  hive.invoke.mockRejectedValueOnce(new Error('IPC indisponível'));
  const hook = renderHook(() => useLayout('r'));
  await settle();
  expect(hook.result.current.ready).toBe(false);
  act(() => hook.result.current.addNote(note));
  expect(
    hive.invoke.mock.calls.filter(([channel]) => channel === 'canvas.layout.save'),
  ).toHaveLength(0);
  await act(async () => {
    await hook.result.current.reload();
  });
  expect(hook.result.current.ready).toBe(true);
});
