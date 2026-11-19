import { memo } from 'react';

/** How the night looks: a bright moon while the shift works, a dimmer one while it is paused. */
export type ShiftMood = 'working' | 'waiting' | 'paused';

type Pixel = { x: number; y: number; fill: string };

/** A full moon in pixels: pale honey, a shaded edge, a lit edge and a few craters. */
const MOON_SIZE = 18;
const CRATERS = new Set([
  '5.5',
  '6.5',
  '5.6',
  '11.4',
  '12.4',
  '10.10',
  '11.10',
  '10.11',
  '6.12',
  '13.8',
]);
const moonPixels: Pixel[] = [];
for (let y = 0; y < MOON_SIZE; y++)
  for (let x = 0; x < MOON_SIZE; x++) {
    const dx = x + 0.5 - MOON_SIZE / 2;
    const dy = y + 0.5 - MOON_SIZE / 2;
    const distance = Math.hypot(dx, dy);
    if (distance > MOON_SIZE / 2) continue;
    const edge = distance > MOON_SIZE / 2 - 2.2;
    const fill = CRATERS.has(`${x}.${y}`)
      ? '#d9c27e'
      : edge && dx + dy > 2
        ? '#e6d08f'
        : edge && dx + dy < -5
          ? '#fffbe8'
          : '#fbefc4';
    moonPixels.push({ x, y, fill });
  }

function Pixels({ pixels }: { pixels: Pixel[] }) {
  return (
    <g>
      {pixels.map(({ x, y, fill }) => (
        <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} fill={fill} />
      ))}
    </g>
  );
}

/** Stars scattered the same way on every render: position, size and when each twinkles. */
const STARS = Array.from({ length: 140 }, (_, index) => {
  const random = (salt: number) => {
    const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  return {
    left: random(1) * 100,
    top: random(2) * 80,
    size: random(3) > 0.85 ? 3 : 2,
    delay: random(4) * 6,
    twinkle: random(5) > 0.45,
  };
});
/** The few bright ones, drawn as a pixel cross. */
const BRIGHT = [
  { left: 7, top: 16 },
  { left: 68, top: 56 },
  { left: 95, top: 38 },
];

/**
 * The night sky behind the Modo Turno page, like the honeycomb behind the overview: twinkling
 * stars and a pixel moon across the top, fading into the page as it goes down. Purely decorative.
 */
export const ShiftSky = memo(function ShiftSky({ mood }: { mood: ShiftMood }) {
  return (
    <div className={`shift-sky ${mood}`} aria-hidden>
      {STARS.map((star, index) => (
        <span
          key={index}
          className={`shift-star${star.twinkle ? ' twinkle' : ''}${star.left > 14 && star.left < 62 ? ' faint' : ''}`}
          style={{
            left: `${star.left}%`,
            top: `${star.top}%`,
            width: star.size,
            height: star.size,
            animationDelay: `${star.delay}s`,
          }}
        />
      ))}
      {BRIGHT.map((star, index) => (
        <span
          key={index}
          className="shift-star-bright"
          style={{ left: `${star.left}%`, top: `${star.top}%`, animationDelay: `${index * 1.7}s` }}
        />
      ))}
      <div className="shift-scene">
        <div className="shift-moon-glow" />
        <svg
          className="shift-moon"
          viewBox={`0 0 ${MOON_SIZE} ${MOON_SIZE}`}
          shapeRendering="crispEdges"
        >
          <Pixels pixels={moonPixels} />
        </svg>
      </div>
    </div>
  );
});
