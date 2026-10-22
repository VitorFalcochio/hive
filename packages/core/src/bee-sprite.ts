/**
 * Hive's mascot as pixel art, shared by the app (SVG) and the terminal (half-block characters).
 * Each character of the grid is one pixel: y body, a antennae, k stripes and eyes, w wings.
 */
export const beeGrid = [
  '...y........y...',
  '....a......a....',
  '.....yyyyyy.....',
  '.ww.yyyyyyyy.ww.',
  'wwwyykkyykkyywww',
  'wwwyykkyykkyywww',
  '.wwyyyyyyyyyyww.',
  '...kkkkkkkkkk...',
  '...yyyyyyyyyy...',
  '...kkkkkkkkkk...',
  '....yyyyyyyy....',
  '.....k.kk.k.....',
];

/** The Queen's crown (c), drawn over the top rows between the antennae. */
export const beeCrown = ['.....c.cc.c.....', '.....cccccc.....'];

/** The same bee at half the size, for places where the big one takes too much room. */
export const beeSmallGrid = [
  '..a......a..',
  'ww.yyyyyy.ww',
  'wwykkyykkyww',
  '.wyyyyyyyyw.',
  '..kkkkkkkk..',
  '..yyyyyyyy..',
  '..kkkkkkkk..',
  '...yyyyyy...',
];
export const beeSmallCrown = ['....c..c....', '...cccccc...'];

const baseColors: Record<string, string> = {
  y: '#f5b544',
  a: '#c98a1e',
  k: '#1c1d21',
  w: '#e9ecf2',
  c: '#ffe27a',
};

/** The antennae are the body colour about a fifth darker, as gold is to its shade. */
function shade(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * 0.78);
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`;
}

/** Colours of a bee whose body is `body`; the stripes, eyes and wings never change. */
export function beePalette(body?: string): Record<string, string> {
  return body ? { ...baseColors, y: body, a: shade(body) } : baseColors;
}

/**
 * The bee as rows of pixels (a colour, or null where it is see-through). `wingsUp` lifts the
 * wings a pixel, the other half of a flap.
 */
export function beePixels(
  options: { body?: string; crowned?: boolean; wingsUp?: boolean; small?: boolean } = {},
): (string | null)[][] {
  const palette = beePalette(options.body);
  const grid = options.small ? beeSmallGrid : beeGrid;
  const rows = grid.map((row) =>
    [...row].map((cell) => (cell === 'w' || !palette[cell] ? null : palette[cell]!)),
  );
  grid.forEach((row, y) =>
    [...row].forEach((cell, x) => {
      if (cell !== 'w') return;
      // Raised beside the small bee's antennae the wings read as horns, so its flap goes down.
      const lift = options.small ? 1 : -1;
      const target = options.wingsUp ? Math.min(grid.length - 1, Math.max(0, y + lift)) : y;
      if (!rows[target]![x]) rows[target]![x] = palette.w!;
    }),
  );
  if (options.crowned)
    (options.small ? beeSmallCrown : beeCrown).forEach((row, y) =>
      [...row].forEach((cell, x) => {
        if (cell === 'c') rows[y]![x] = palette.c!;
      }),
    );
  return rows;
}
