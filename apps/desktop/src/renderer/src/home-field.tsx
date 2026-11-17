import { useEffect, useRef } from 'react';
import { beeGrid, beePalette } from '@hive/core';

/**
 * The home screen's backdrop: a halftone of tiny honeycomb cells whose brightness follows a slow
 * noise field, so patches of honey drift across the dark like weather on a map, with a few pixel
 * bees crossing it. It dims behind the centre so the content stays readable, and holds still when
 * motion is reduced.
 */
const GAP = 9; // between cell centres, in CSS pixels
const ROW = GAP * 0.866; // hex rows
const FPS = 14;
const LEVELS = 12;
const HONEY = '#f5b544';
const GLINT = '#ffe39a';

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Large drifting shapes, with finer texture on top. */
function honeyAt(x: number, y: number, t: number): number {
  return (
    noise(x * 0.011 + t * 0.018, y * 0.011 - t * 0.009) * 0.62 +
    noise(x * 0.032 - t * 0.026, y * 0.032 + t * 0.014) * 0.28 +
    noise(x * 0.09, y * 0.09 + t * 0.05) * 0.1
  );
}

const smooth = (edge0: number, edge1: number, value: number) => {
  const k = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return k * k * (3 - 2 * k);
};

/** One small hexagon, drawn once per colour and stamped for every cell. */
function hexSprite(color: string, scale: number): HTMLCanvasElement {
  const radius = 3.1 * scale;
  const size = Math.ceil(radius * 2 + 2);
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i + Math.PI / 6;
    const px = size / 2 + radius * Math.cos(angle);
    const py = size / 2 + radius * Math.sin(angle);
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  return sprite;
}

const palette = beePalette();
const beePixels = beeGrid.flatMap((row, y) =>
  [...row].flatMap((cell, x) => (palette[cell] ? [{ x, y, color: palette[cell] }] : [])),
);

/** Bees crossing slowly, each on its own height, speed and bob. */
const bees = [
  { lane: 0.18, speed: 9, phase: 0, size: 2 },
  { lane: 0.62, speed: -6, phase: 0.45, size: 2.5 },
  { lane: 0.84, speed: 12, phase: 0.8, size: 1.6 },
];

function motionReduced(): boolean {
  return (
    document.documentElement.classList.contains('motion-reduce') ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

/**
 * `home` is the tall band behind the greeting; `cover` is a shorter one behind a page title, such
 * as a mission's, quieter on the left where the title sits.
 */
export function HiveField({ variant = 'home' }: { variant?: 'home' | 'cover' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !host || !ctx) return;
    let width = 0;
    let height = 0;
    let scale = 1;
    let sprites: HTMLCanvasElement[] = [];
    let frame = 0;
    let last = 0;
    const started = performance.now();

    const resize = () => {
      scale = Math.min(2, window.devicePixelRatio || 1);
      width = host.clientWidth;
      // A band across the top of the page, fading to black (see .home-field); below it, plain.
      height =
        variant === 'cover'
          ? 420
          : Math.round(Math.min(820, Math.max(560, host.clientHeight * 0.85)));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sprites = [hexSprite(HONEY, scale), hexSprite(GLINT, scale)];
    };

    const draw = (now: number) => {
      const t = (now - started) / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const [honey, glint] = sprites as [HTMLCanvasElement, HTMLCanvasElement];
      const half = honey.width / 2;
      // Quiet behind the greeting and the prompt, brighter towards the edges.
      const cx = variant === 'cover' ? Math.min(width * 0.32, 520) : width / 2;
      const cy = variant === 'cover' ? height * 0.42 : Math.min(height * 0.32, 300);
      const reach = Math.max(420, Math.min(width, 1100) * 0.5);
      for (let r = 0, y = ROW / 2; y < height + ROW; r++, y += ROW) {
        for (let x = r % 2 ? GAP / 2 : 0; x < width + GAP; x += GAP) {
          const value = smooth(0.46, 0.78, honeyAt(x, y, t));
          const dx = (x - cx) / reach;
          const dy = (y - cy) / (reach * 0.7);
          const mask = 0.3 + 0.7 * smooth(0.3, 1.2, Math.sqrt(dx * dx + dy * dy));
          const alpha = 0.035 + value * 0.5 * mask;
          const level = Math.round(alpha * LEVELS) / LEVELS;
          if (level <= 0) continue;
          ctx.globalAlpha = level;
          ctx.drawImage(value > 0.92 ? glint : honey, x * scale - half, y * scale - half);
        }
      }
      // The bees.
      ctx.globalAlpha = 0.55;
      const unit = scale;
      for (const bee of bees) {
        const span = width + 120;
        const travel = (((bee.phase * span + t * bee.speed * 4) % span) + span) % span;
        const bx = bee.speed > 0 ? travel - 60 : width + 60 - travel;
        const by = bee.lane * height + Math.sin(t * 1.3 + bee.phase * 9) * 10;
        const px = bee.size * unit;
        const flip = bee.speed < 0;
        for (const pixel of beePixels) {
          ctx.fillStyle = pixel.color;
          const gx = flip ? beeGrid[0]!.length - 1 - pixel.x : pixel.x;
          ctx.fillRect(
            Math.round(bx * scale + gx * px),
            Math.round(by * scale + pixel.y * px),
            Math.ceil(px),
            Math.ceil(px),
          );
        }
      }
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (document.hidden || now - last < 1000 / FPS) return;
      last = now;
      draw(now);
    };

    resize();
    draw(started);
    const observer = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    observer.observe(host);
    if (!motionReduced()) frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [variant]);
  return (
    <div className={variant === 'cover' ? 'home-field cover' : 'home-field'} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  );
}
