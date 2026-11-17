// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Select } from './ui';

afterEach(cleanup);

const options = [
  { value: 'plan', label: 'Plano da Queen', hint: 'a Queen divide em tarefas' },
  { value: 'queue', label: 'Turno (fila)' },
  { value: 'compare', label: 'Comparar agentes' },
];

it('abre um menu do próprio app, com o rótulo acessível e largura mínima', () => {
  const onChange = vi.fn();
  render(<Select ariaLabel="Modo da missão" value="plan" options={options} onChange={onChange} />);
  const trigger = screen.getByRole('combobox', { name: 'Modo da missão' });
  expect(trigger.textContent).toContain('Plano da Queen');
  fireEvent.click(trigger);
  const menu = screen.getByRole('listbox');
  // The trigger has no width in jsdom; the menu still gets the minimum.
  expect(menu.style.width).toBe('200px');
  expect(screen.getByRole('option', { name: /Plano da Queen/ }).getAttribute('aria-selected')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('option', { name: /Comparar agentes/ }));
  expect(onChange).toHaveBeenCalledWith('compare');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('escolhe pelo teclado e mostra o texto de espera quando nada está escolhido', () => {
  const onChange = vi.fn();
  render(
    <Select
      ariaLabel="Conectar agente"
      value=""
      placeholder="Conectar agente…"
      options={options}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole('combobox', { name: 'Conectar agente' });
  expect(trigger.textContent).toContain('Conectar agente…');
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('queue');
});
