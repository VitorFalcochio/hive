// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HivePush, LiveResult, MissionNote } from '@hive/core';
import { useLiveResult, useMissionNotes } from './use-live-result';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function bridge() {
  let note: MissionNote = { missionId: 'm', text: '', revision: 0, updatedAt: null };
  const listeners = new Set<(push: HivePush) => void>();
  const invoke = vi.fn(async (channel: string, input?: unknown): Promise<unknown> => {
    if (channel === 'canvas.notes.get') return { ...note };
    if (channel === 'canvas.notes.save') {
      const next = input as { missionId: string; text: string; revision: number };
      if (next.revision !== note.revision)
        throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
      note = {
        missionId: next.missionId,
        text: next.text,
        revision: note.revision + 1,
        updatedAt: 'now',
      };
      return { ...note };
    }
    return undefined;
  });
  window.hive = {
    invoke,
    subscribe: (listener: (push: HivePush) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Window['hive'];
  return {
    invoke,
    listeners,
    get note() {
      return note;
    },
    external(text: string) {
      note = { ...note, text, revision: note.revision + 1 };
    },
    push(push: HivePush) {
      for (const listener of listeners) listener(push);
    },
  };
}
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

it('salva com debounce, protege cada tecla e recupera notas ao reabrir', async () => {
  const hive = bridge();
  const hook = renderHook(() => useMissionNotes('m'));
  await tick();
  expect(hook.result.current.ready).toBe(true);
  act(() => hook.result.current.change('# Manual\n- [ ] Checklist\n```ts\nconst x = 1;\n```'));
  expect(JSON.parse(localStorage.getItem('hive.mission-note:m')!).text).toContain('# Manual');
  await tick(599);
  expect(hive.note.revision).toBe(0);
  await tick(1);
  expect(hive.note.revision).toBe(1);
  expect(localStorage.getItem('hive.mission-note:m')).toBeNull();
  hook.unmount();
  const reopened = renderHook(() => useMissionNotes('m'));
  await tick();
  expect(reopened.result.current.text).toBe(hive.note.text);
  expect(reopened.result.current.status).toBe('Salvo');
});

it('mantém notas intactas quando o relatório automático muda e limpa listeners', async () => {
  const hive = bridge();
  hive.external('Só meu texto');
  const hook = renderHook(() => useMissionNotes('m'));
  await tick();
  act(() => hive.push({ kind: 'changed', entity: 'result', id: 'r' }));
  await tick(1000);
  expect(hook.result.current.text).toBe('Só meu texto');
  expect(
    hive.invoke.mock.calls.filter(([channel]) => channel === 'canvas.notes.save'),
  ).toHaveLength(0);
  hook.unmount();
  expect(hive.listeners.size).toBe(0);
});

it('serializa gravações e preserva digitação durante uma gravação em andamento', async () => {
  const hive = bridge();
  const normal = hive.invoke.getMockImplementation()!;
  let finish!: (value: MissionNote) => void;
  hive.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'canvas.notes.save' && (input as { revision: number }).revision === 0)
      return new Promise<MissionNote>((resolve) => {
        finish = resolve;
      });
    return normal(channel, input);
  });
  const hook = renderHook(() => useMissionNotes('m'));
  await tick();
  act(() => hook.result.current.change('primeira'));
  await tick(600);
  act(() => hook.result.current.change('segunda'));
  await tick(600);
  expect(
    hive.invoke.mock.calls.filter(([channel]) => channel === 'canvas.notes.save'),
  ).toHaveLength(1);
  hive.external('primeira');
  await act(async () => finish({ ...hive.note }));
  expect(hook.result.current.text).toBe('segunda');
  await tick(600);
  expect(hive.note.text).toBe('segunda');
  expect(hive.note.revision).toBe(2);
});

it('recupera rascunho após fechar antes do autosave e após falha de IPC', async () => {
  const hive = bridge();
  const normal = hive.invoke.getMockImplementation()!;
  hive.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'canvas.notes.save') throw new Error('Offline');
    return normal(channel, input);
  });
  const hook = renderHook(() => useMissionNotes('m'));
  await tick();
  act(() => hook.result.current.change('Última tecla'));
  hook.unmount();
  await tick();
  expect(JSON.parse(localStorage.getItem('hive.mission-note:m')!).text).toBe('Última tecla');
  hive.invoke.mockImplementation(normal);
  const reopened = renderHook(() => useMissionNotes('m'));
  await tick();
  expect(reopened.result.current.text).toBe('Última tecla');
  await tick(600);
  expect(hive.note.text).toBe('Última tecla');
});

it('preserva rascunho conflitante e só substitui a versão remota após revisão explícita', async () => {
  const hive = bridge();
  const hook = renderHook(() => useMissionNotes('m'));
  await tick();
  act(() => hook.result.current.change('Rascunho local'));
  hive.external('Outra janela');
  await tick(600);
  expect(hook.result.current.conflict).toBe(true);
  expect(hook.result.current.saved).toBe('Outra janela');
  expect(hook.result.current.text).toBe('Rascunho local');
  expect(hive.note.text).toBe('Outra janela');
  act(() => hook.result.current.change('Outra janela + Rascunho local'));
  await tick(600);
  expect(hive.note.text).toBe('Outra janela');
  act(() => hook.result.current.resolve());
  await tick();
  expect(hive.note.text).toBe('Outra janela + Rascunho local');
});

it('não habilita gravação quando a leitura falha nem mistura notas de missões', async () => {
  const hive = bridge();
  hive.invoke.mockRejectedValue(new Error('Offline'));
  const hook = renderHook(() => useMissionNotes('other'));
  await tick();
  expect(hook.result.current.ready).toBe(false);
  act(() => hook.result.current.change('Não gravar'));
  await tick(1000);
  expect(hive.invoke).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('hive.mission-note:m')).toBeNull();
});

it('preserva rascunhos simultâneos em slots separados quando duas sessões falham', async () => {
  const hive = bridge();
  const normal = hive.invoke.getMockImplementation()!;
  hive.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'canvas.notes.save') throw new Error('Offline');
    return normal(channel, input);
  });
  const first = renderHook(() => useMissionNotes('m'));
  const second = renderHook(() => useMissionNotes('m'));
  await tick();
  act(() => first.result.current.change('Texto da primeira sessão'));
  act(() => second.result.current.change('Texto da segunda sessão'));
  first.unmount();
  second.unmount();
  await tick();
  const recovered = renderHook(() => useMissionNotes('m'));
  await tick();
  expect(recovered.result.current.recoveries.map((draft) => draft.text)).toEqual(
    expect.arrayContaining(['Texto da primeira sessão', 'Texto da segunda sessão']),
  );
});

it('reconcilia eventos perdidos por polling e ao recuperar conexão, sem chamar o motor', async () => {
  const hive = bridge();
  let current = { runId: 'r', cursor: 1, changeCount: 1 } as LiveResult;
  hive.invoke.mockImplementation(async (channel) => {
    if (channel === 'canvas.result.get') return current;
    return undefined;
  });
  const hook = renderHook(() => useLiveResult('r'));
  await tick();
  expect(hook.result.current.result?.cursor).toBe(1);
  current = { ...current, cursor: 2, changeCount: 2 };
  await tick(10_000);
  expect(hook.result.current.result?.cursor).toBe(2);
  hive.invoke.mockRejectedValueOnce(new Error('Offline'));
  act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  expect(hook.result.current.error).toBe('Offline');
  current = { ...current, cursor: 3 };
  act(() => hive.push({ kind: 'changed', entity: 'result', id: 'r' }));
  await tick(700);
  expect(hook.result.current.result?.cursor).toBe(3);
  expect(hook.result.current.error).toBe('');
  hook.unmount();
  expect(hive.listeners.size).toBe(0);
  expect(hive.invoke.mock.calls.every(([channel]) => channel === 'canvas.result.get')).toBe(true);
});
