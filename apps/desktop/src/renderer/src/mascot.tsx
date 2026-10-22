import { BookOpen, Eye, FlaskConical, Search, Wrench, type LucideIcon } from 'lucide-react';
import {
  beeColorOf,
  beeColors,
  beeCrown,
  beeGrid,
  beePalette,
  soldierPresets,
  type SoldierRole,
  type Worker,
} from '@hive/core';

/**
 * Hive's mascot: the pixel-art bee from `beeGrid`. The wings, eyes and body are separate groups
 * so they can be animated (flapping, blinking, hovering).
 */
const grid = beeGrid;
const paletteFor = beePalette;
const colors = beePalette();

const EYE_ROWS = new Set([4, 5]);
const WIDTH = grid[0]!.length;
const HEIGHT = grid.length;

type Part = 'leftWing' | 'rightWing' | 'eyes' | 'body';

function partOf(cell: string, x: number, y: number): Part {
  if (cell === 'w') return x < WIDTH / 2 ? 'leftWing' : 'rightWing';
  if (cell === 'k' && EYE_ROWS.has(y)) return 'eyes';
  return 'body';
}

const crownPixels = beeCrown.flatMap((row, y) =>
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

const insignias: Record<SoldierRole, LucideIcon> = {
  scout: Search,
  builder: Wrench,
  tester: FlaskConical,
  reviewer: Eye,
  researcher: BookOpen,
};

/**
 * A soldier: a small bee in its captain's colour, without the crown, wearing its role's insignia.
 * The one at work flaps its wings; a soldier switched off is drawn faded.
 */
export function SoldierBee({
  captain,
  role,
  enabled = true,
  working = false,
  size = 16,
}: {
  captain: Pick<Worker, 'id' | 'role' | 'beeColor'>;
  role: SoldierRole;
  enabled?: boolean;
  working?: boolean;
  size?: number;
}) {
  const Insignia = insignias[role];
  const state = working ? ' working' : enabled ? '' : ' off';
  return (
    <span className={`soldier-bee${state}`} title={soldierPresets[role].label}>
      <Mascot
        size={size}
        mood={working ? 'working' : 'still'}
        color={beeColors[beeColorOf(captain)].hex}
      />
      <span className="soldier-insignia" aria-hidden>
        <Insignia size={Math.max(9, Math.round(size * 0.55))} strokeWidth={2.5} />
      </span>
    </span>
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
