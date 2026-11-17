// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '@hive/core';
import { Hive, type HiveContext } from './context';
import { SettingsPage } from './settings';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  // Backup and update sections ask the main process for their state; nothing comes back here.
  window.hive = {
    invoke: vi.fn(() => new Promise(() => undefined)),
    subscribe: () => () => undefined,
  } as unknown as Window['hive'];
});

function setup() {
  const go = vi.fn();
  const context = {
    workers: [],
    refresh: vi.fn(),
    notify: vi.fn(),
    go,
  } as unknown as HiveContext;
  render(
    <Hive.Provider value={context}>
      <SettingsPage settings={defaultSettings} onSaved={async () => undefined} />
    </Hive.Provider>,
  );
  return { go };
}

it('mostra uma categoria por vez e lembra a escolhida', () => {
  setup();
  expect(screen.getByText('Limites padrão para agentes novos')).toBeTruthy();
  expect(screen.queryByText('Replanejamento adaptativo')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Sistema/ }));
  expect(screen.getByText('Aparência')).toBeTruthy();
  expect(screen.queryByText('Limites padrão para agentes novos')).toBeNull();
  expect(localStorage.getItem('hive.settings.tab')).toBe('system');
});

it('busca em todas as categorias, sem se importar com acentos', () => {
  setup();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar configuração' }), {
    target: { value: 'orcamento' },
  });
  expect(screen.getByText('Orçamento de tokens')).toBeTruthy();
  expect(screen.getByText('Modelos e consumo', { selector: '.settings-block-path' })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar configuração' }), {
    target: { value: 'xyzzy' },
  });
  expect(screen.getByText(/Nada encontrado/)).toBeTruthy();
});

it('marca a categoria com alterações não salvas e leva aos provedores', () => {
  const { go } = setup();
  fireEvent.click(screen.getByRole('button', { name: /Modelos e consumo/ }));
  fireEvent.change(screen.getByRole('spinbutton', { name: /Orçamento diário de tokens/ }), {
    target: { value: '5000000' },
  });
  expect(
    screen.getByRole('button', { name: /Modelos e consumo/ }).querySelector('.settings-nav-dot'),
  ).toBeTruthy();
  expect(screen.getByText('Alterações não salvas')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Gerenciar provedores/ }));
  expect(go).toHaveBeenCalledWith('providers');
});
