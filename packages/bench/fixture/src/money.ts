/** Formats cents as Brazilian reais, e.g. 123456 -> "R$ 1.234,56". */
export function formatBRL(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const centavos = (abs % 100).toString().padStart(2, '0');
  return `${negative ? '-' : ''}R$ ${reais},${centavos}`;
}

/** Returns `percent`% of a value in cents. */
export function percentOf(cents: number, percent: number): number {
  return (cents * percent) / 100;
}
