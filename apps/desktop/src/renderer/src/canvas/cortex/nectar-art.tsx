import { memo } from 'react';

/** The Nectar drop, pixel by pixel: o outline, h highlight, m honey, s shade. */
const DROP = [
  '....oo....',
  '...ommo...',
  '...ommo...',
  '..ommmmo..',
  '..ohmmmo..',
  '.ohhmmmmo.',
  '.ohmmmmmo.',
  'ohmmmmmmso',
  'ommmmmmmso',
  'ommmmmmsso',
  '.ommmmsso.',
  '..oossoo..',
  '....oo....',
];
const DROP_COLORS: Record<string, string> = {
  o: 'var(--nc-wax, #7a4a06)',
  h: 'var(--nc-honey-light, #ffd98a)',
  m: 'var(--nc-cortex, #f5b544)',
  s: 'var(--nc-honey-deep, #d98a0c)',
};
const dropPixels = DROP.flatMap((row, y) =>
  [...row].flatMap((cell, x) => (DROP_COLORS[cell] ? [{ x, y, fill: DROP_COLORS[cell] }] : [])),
);

/**
 * The Nectar icon: a drop of honey in the same pixel style as the agents' bees. Same props as a
 * lucide icon, so it fits wherever the block's icon is shown.
 */
export function PixelDrop({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-1.5 0 13 13"
      shapeRendering="crispEdges"
      aria-hidden
      className="nc-pixel-drop"
    >
      {dropPixels.map(({ x, y, fill }) => (
        <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} fill={fill} />
      ))}
    </svg>
  );
}

/** Where the drips hang along the bottom edge (fraction of the width) and how long each is. */
const DRIPS = [
  { at: 0.12, length: 3 },
  { at: 0.31, length: 5 },
  { at: 0.47, length: 2 },
  { at: 0.66, length: 6 },
  { at: 0.84, length: 3 },
];
/** Falling drops start from the longest drips first. */
const FALL_FROM = [3, 1, 0];
const COLUMNS = 94;

/**
 * Honey running off the bottom of the block. Each pending proposal is a drop still falling (up
 * to three at once): nectar that has not become honey until the user approves it.
 */
export const NectarDrips = memo(function NectarDrips({ pending }: { pending: number }) {
  return (
    <div className="nc-cortex-drips" aria-hidden>
      <svg viewBox={`0 0 ${COLUMNS} 10`} preserveAspectRatio="none" shapeRendering="crispEdges">
        <rect x={0} y={0} width={COLUMNS} height={1} fill="var(--nc-cortex)" opacity={0.9} />
        {DRIPS.map(({ at, length }) => {
          const x = Math.round(at * COLUMNS);
          return (
            <g key={at}>
              <rect x={x - 1} y={1} width={3} height={1} fill="var(--nc-cortex)" />
              <rect x={x} y={1} width={1} height={length} fill="var(--nc-cortex)" />
              {/* A round bead at the tip: three pixels wide, shaded on the right. */}
              <rect x={x - 1} y={length} width={3} height={2} fill="var(--nc-cortex)" />
              <rect x={x + 1} y={length} width={1} height={2} fill="var(--nc-honey-deep)" />
              <rect x={x} y={length + 2} width={1} height={1} fill="var(--nc-honey-deep)" />
              <rect x={x} y={1} width={1} height={1} fill="var(--nc-honey-light)" />
            </g>
          );
        })}
      </svg>
      {FALL_FROM.slice(0, Math.min(pending, FALL_FROM.length)).map((spot, index) => (
        <span
          key={spot}
          className="nc-cortex-drop"
          style={{
            left: `calc(${DRIPS[spot]!.at * 100}% - 1px)`,
            animationDelay: `${index * 0.85}s`,
          }}
        >
          <i style={{ left: 2, top: 0, width: 2, height: 3 }} />
          <i style={{ left: 0, top: 3, width: 6, height: 4 }} />
          <i style={{ left: 2, top: 7, width: 2, height: 2, background: 'var(--nc-honey-deep)' }} />
          <i
            style={{ left: 1, top: 3, width: 2, height: 2, background: 'var(--nc-honey-light)' }}
          />
        </span>
      ))}
    </div>
  );
});

/** Memories that fill the block completely. */
export const FULL_AT = 30;
