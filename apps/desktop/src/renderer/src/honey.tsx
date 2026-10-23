import type { DashboardSummary } from '@hive/core';

/**
 * A honey bottle in pixel art, like the one in Minecraft: cork, glass neck and a round bottle
 * of honey with a glint. One character per pixel; `.` is transparent.
 */
const BOTTLE = [
  '....cc....',
  '....cc....',
  '...gccg...',
  '...g..g...',
  '..gghhgg..',
  '.ghlhhhhg.',
  'ghlhhhhhhg',
  'ghhhhhhhdg',
  'ghhhhhhhdg',
  'ghhhhhhddg',
  '.gdhhhddg.',
  '..gggggg..',
];

const colors: Record<string, string> = {
  c: '#9a6332', // cork
  g: '#cfdbe3', // glass
  h: '#f5b544', // honey
  d: '#d48a1c', // honey in shadow
  l: '#ffe39a', // glint
};

export function HoneyJar({ size = 14, label }: { size?: number; label?: string }) {
  const width = BOTTLE[0]!.length;
  const height = BOTTLE.length;
  return (
    <svg
      className="honey-jar"
      width={(size * width) / height}
      height={size}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label && <title>{label}</title>}
      {BOTTLE.flatMap((row, y) =>
        [...row].map((pixel, x) =>
          colors[pixel] ? (
            <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={colors[pixel]} />
          ) : null,
        ),
      )}
    </svg>
  );
}

const full = new Intl.NumberFormat('pt-BR');

/** Honey given today, in the status bar. Counted, never capped. */
export function HoneyMeter({ honey }: { honey: DashboardSummary['honey'] }) {
  return (
    <span
      className="honey-meter"
      title={`Mel usado hoje: ${full.format(honey.today)} · desde o começo: ${full.format(honey.total)}. Cada mel é um turbo numa tarefa, sem limite.`}
    >
      <HoneyJar size={14} />
      {full.format(honey.today)} hoje
    </span>
  );
}
