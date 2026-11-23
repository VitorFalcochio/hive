// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Worker } from '@hive/core';
import { BeeColorPicker, recentBeeColors } from './bee-color-picker';
import { AgentBee } from './mascot';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

/** The picker as a drawer uses it: the value is the agent's stored pick. */
function Harness({ initial = null as string | null, onChange = vi.fn() }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <BeeColorPicker
      value={value}
      fallback="#F97316"
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

const fills = (container: HTMLElement) =>
  new Set([...container.querySelectorAll('rect')].map((rect) => rect.getAttribute('fill')));

describe('seletor de cor da abelha', () => {
  it('mostra as 24 cores por família e escolhe uma, com nome, HEX e prévia na cor', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    const palette = screen.getByRole('radiogroup', { name: 'Cor da abelha' });
    expect(within(palette).getAllByRole('radio')).toHaveLength(24);
    expect(within(palette).getByRole('group', { name: 'Verdes' })).toBeTruthy();
    // With no pick the bee wears its role's colour.
    expect(screen.getByText('(da função)', { exact: false })).toBeTruthy();

    fireEvent.click(within(palette).getByRole('radio', { name: 'Azul-celeste' }));
    expect(onChange).toHaveBeenLastCalledWith('#38BDF8');
    expect(screen.getByText(/Azul-celeste/)).toBeTruthy();
    expect(screen.getByText('#38BDF8')).toBeTruthy();
    expect(
      within(palette).getByRole('radio', { name: 'Azul-celeste' }).getAttribute('aria-checked'),
    ).toBe('true');
    // The preview is drawn in the colour; stripes and eyes stay dark, as always.
    expect(fills(container).has('#38BDF8')).toBe(true);
    expect(fills(container).has('#1c1d21')).toBe(true);
  });

  it('voltar à cor da função não guarda escolha nenhuma', () => {
    const onChange = vi.fn();
    render(<Harness initial="#38BDF8" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Cor da função/ }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('button', { name: /Cor da função/ })).toBeNull();
    // Picking the role's own colour is the same as no pick.
    fireEvent.click(screen.getByRole('radio', { name: 'Laranja' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('aceita qualquer cor por HEX, recusa o que não é cor e ajusta por matiz, saturação e luz', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Personalizar/ }));
    const hex = screen.getByLabelText('HEX');
    fireEvent.change(hex, { target: { value: '#12ab' } });
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/formato #RRGGBB/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(hex, { target: { value: '#12ab9c' } });
    expect(onChange).toHaveBeenLastCalledWith('#12AB9C');
    expect(screen.getByText('Personalizada', { exact: false })).toBeTruthy();

    fireEvent.change(screen.getByRole('slider', { name: /Luz/ }), { target: { value: '90' } });
    const lighter = onChange.mock.lastCall![0] as string;
    expect(lighter).toMatch(/^#[0-9A-F]{6}$/);
    expect(lighter).not.toBe('#12AB9C');
  });

  it('lembra as cores usadas por último nesta máquina', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'Lilás' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Grafite' }));
    expect(recentBeeColors()).toEqual(['#475569', '#C084FC']);
    expect(
      within(screen.getByRole('group', { name: 'Cores recentes' })).getAllByRole('radio'),
    ).toHaveLength(2);
  });

  it('sem armazenamento disponível o seletor continua funcionando', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Rosa' }));
    expect(onChange).toHaveBeenLastCalledWith('#EC4899');
    spy.mockRestore();
  });
});

describe('abelha de cada agente', () => {
  const worker = (patch: Partial<Worker>) =>
    ({ id: 'w', role: 'backend', beeColor: null, ...patch }) as Worker;

  it('usa a cor escolhida, a de uma versão antiga ou a da função, sem mudar o desenho', () => {
    const drawn = (patch: Partial<Worker>) => {
      const { container, unmount } = render(<AgentBee worker={worker(patch)} size={22} />);
      const result = {
        colours: fills(container),
        pixels: container.querySelectorAll('rect').length,
      };
      unmount();
      return result;
    };
    const picked = drawn({ beeColor: '#10B981' });
    const legacy = drawn({ beeColor: 'cyan' });
    const role = drawn({ role: 'debugger' });
    expect(picked.colours.has('#10B981')).toBe(true);
    expect(legacy.colours.has('#22D3EE')).toBe(true);
    expect(role.colours.has('#EF4444')).toBe(true);
    // Same silhouette whatever the colour.
    expect(new Set([picked.pixels, legacy.pixels, role.pixels]).size).toBe(1);
  });
});
