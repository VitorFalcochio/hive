import { beeColorOf, beeColors, type Worker } from '@hive/core';

/**
 * Hive's mascot: a pixel-art bee. Each character of the grid is one pixel; the wings, eyes and
 * body are separate groups so they can be animated (flapping, blinking, hovering).
 */
const grid = [
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

const colors: Record<string, string> = {
  y: '#f5b544',
  a: '#c98a1e',
  k: '#1c1d21',
  w: '#e9ecf2',
  c: '#ffe27a',
};

/** The Queen's crown, drawn over the top rows between the antennae. */
const crown = ['.....c.cc.c.....', '.....cccccc.....'];

/** The antennae are the body colour about a fifth darker, as gold is to its shade. */
function shade(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * 0.78);
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`;
}

/** Colours of a bee whose body is `body`; the stripes, eyes and wings never change. */
function paletteFor(body: string | undefined): Record<string, string> {
  return body ? { ...colors, y: body, a: shade(body) } : colors;
}

const EYE_ROWS = new Set([4, 5]);
const WIDTH = grid[0]!.length;
const HEIGHT = grid.length;

type Part = 'leftWing' | 'rightWing' | 'eyes' | 'body';

function partOf(cell: string, x: number, y: number): Part {
  if (cell === 'w') return x < WIDTH / 2 ? 'leftWing' : 'rightWing';
  if (cell === 'k' && EYE_ROWS.has(y)) return 'eyes';
  return 'body';
}

const crownPixels = crown.flatMap((row, y) =>
  [...row].flatMap((cell, x) => (cell === 'c' ? [{ x, y, cell }] : [])),
);

// The grid never changes, so the pixels are laid out once; colours are looked up per bee.
const pixels: Record<Part, { x: number; y: number; cell: string }[]> = {
  leftWing: [],
  rightWing: [],
  eyes: [],
  body: [],
};
grid.forEach((row, y) =>
  [...row].forEach((cell, x) => {
    if (!colors[cell]) return;
    const part = partOf(cell, x, y);
    pixels[part].push({ x, y, cell });
    // Blinking squashes the eyes, so the face behind them has to be there too.
    if (part === 'eyes') pixels.body.push({ x, y, cell: 'y' });
  }),
);

function Pixels({ part, palette }: { part: Part; palette: Record<string, string> }) {
  return (
    <>
      {pixels[part].map(({ x, y, cell }) => (
        // Slightly oversized so neighbouring pixels never show a hairline gap when scaled.
        <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={palette[cell]} />
      ))}
    </>
  );
}

/** 'still' is for bees in lists, where a page full of motion would distract. */
export type MascotMood = 'idle' | 'working' | 'still';

export function Mascot({
  size = 48,
  mood = 'idle',
  color,
  crowned = false,
  label,
}: {
  /** Width in pixels; the height follows the sprite's proportions. */
  size?: number;
  mood?: MascotMood;
  /** Body colour as `#rrggbb`; each agent has its own. Defaults to Hive's gold. */
  color?: string;
  /** The Queen wears a crown. */
  crowned?: boolean;
  /** Accessible name; without it the mascot is decorative. */
  label?: string;
}) {
  const palette = paletteFor(color);
  return (
    <svg
      className={`mascot mascot-${mood}`}
      width={size}
      height={(size * HEIGHT) / WIDTH}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      shapeRendering="crispEdges"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g className="mascot-hover">
        <g className="mascot-wing left">
          <Pixels part="leftWing" palette={palette} />
        </g>
        <g className="mascot-wing right">
          <Pixels part="rightWing" palette={palette} />
        </g>
        <Pixels part="body" palette={palette} />
        {crowned &&
          crownPixels.map(({ x, y, cell }) => (
            <rect key={`c${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={palette[cell]} />
          ))}
        <g className="mascot-eyes">
          <Pixels part="eyes" palette={palette} />
        </g>
      </g>
    </svg>
  );
}

/** An agent's own bee, in the colour picked for it or its role's. */
export function AgentBee({
  worker,
  size = 18,
  mood = 'still',
}: {
  worker: Pick<Worker, 'id' | 'role' | 'beeColor'>;
  size?: number;
  mood?: MascotMood;
}) {
  return (
    <Mascot
      size={size}
      mood={mood}
      color={beeColors[beeColorOf(worker)].hex}
      crowned={worker.role === 'queen'}
    />
  );
}
