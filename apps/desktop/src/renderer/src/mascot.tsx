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
};

const EYE_ROWS = new Set([4, 5]);
const WIDTH = grid[0]!.length;
const HEIGHT = grid.length;

type Part = 'leftWing' | 'rightWing' | 'eyes' | 'body';

function partOf(cell: string, x: number, y: number): Part {
  if (cell === 'w') return x < WIDTH / 2 ? 'leftWing' : 'rightWing';
  if (cell === 'k' && EYE_ROWS.has(y)) return 'eyes';
  return 'body';
}

// The grid never changes, so the pixels are laid out once.
const pixels: Record<Part, { x: number; y: number; fill: string }[]> = {
  leftWing: [],
  rightWing: [],
  eyes: [],
  body: [],
};
grid.forEach((row, y) =>
  [...row].forEach((cell, x) => {
    const fill = colors[cell];
    if (!fill) return;
    const part = partOf(cell, x, y);
    pixels[part].push({ x, y, fill });
    // Blinking squashes the eyes, so the face behind them has to be there too.
    if (part === 'eyes') pixels.body.push({ x, y, fill: colors.y! });
  }),
);

function Pixels({ part }: { part: Part }) {
  return (
    <>
      {pixels[part].map(({ x, y, fill }) => (
        // Slightly oversized so neighbouring pixels never show a hairline gap when scaled.
        <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill} />
      ))}
    </>
  );
}

export type MascotMood = 'idle' | 'working';

export function Mascot({
  size = 48,
  mood = 'idle',
  label,
}: {
  /** Width in pixels; the height follows the sprite's proportions. */
  size?: number;
  mood?: MascotMood;
  /** Accessible name; without it the mascot is decorative. */
  label?: string;
}) {
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
          <Pixels part="leftWing" />
        </g>
        <g className="mascot-wing right">
          <Pixels part="rightWing" />
        </g>
        <Pixels part="body" />
        <g className="mascot-eyes">
          <Pixels part="eyes" />
        </g>
      </g>
    </svg>
  );
}
