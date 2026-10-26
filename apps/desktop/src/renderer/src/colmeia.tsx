import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Maximize2, Minimize2, Play, Square, X } from 'lucide-react';
import { soldierPresets, type AgentEvent, type Worker, type WorkerState } from '@hive/core';
import {
  emptyComb,
  hexCenter,
  hexPoints,
  honeyLevel,
  pruneBees,
  reduceComb,
  spiral,
  type BeeTrack,
  type CombState,
  type FeedItem,
} from './colmeia-model';
import { fileTab, taskDiffTab, useCode } from './code/store';
import { demoScript } from './colmeia-demo';
import { useHive } from './context';
import { AgentBee, Mascot, SoldierBee } from './mascot';
import { PageHeader } from './ui';

const RADIUS = 36;
/** A written cell shines this long after its last edit. */
const FRESH_MS = 2_500;
const EVENTS_PER_RUN = 2_000;

const stateLabels: Record<WorkerState, string> = {
  idle: 'Parada',
  planning: 'Planejando',
  thinking: 'Pensando',
  coding: 'Codando',
  testing: 'Testando',
  reviewing: 'Revisando',
  waiting_approval: 'Aguardando você',
  waiting_provider: 'Esperando o provedor',
  completed: 'Concluiu',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

const busy = (state: WorkerState) =>
  state === 'thinking' ||
  state === 'coding' ||
  state === 'testing' ||
  state === 'reviewing' ||
  state === 'planning';

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

const basename = (path: string) => path.split('/').pop() ?? path;

/**
 * The comb of one project, rebuilt from the events of its running and latest missions and kept
 * live from then on. Terminal agents (`agents`) appear too: their events are pushed, not stored.
 */
function useComb(workspaceId: string | null, runIds: string[], alive: Set<string>): CombState {
  const { onEvent } = useHive();
  const [comb, setComb] = useState<CombState>(emptyComb);
  const runKey = runIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const seen = new Set<string>();
    const buffered: AgentEvent[] = [];
    let loaded = false;
    const ours = (event: AgentEvent) => !workspaceId || event.workspaceId === workspaceId;
    const apply = (events: AgentEvent[]) =>
      setComb((current) =>
        events.reduce((state, event) => {
          if (seen.has(event.id)) return state;
          seen.add(event.id);
          return reduceComb(state, event);
        }, current),
      );
    // Events that arrive while the history loads wait, so nothing is applied twice or lost.
    const unsubscribe = onEvent((event) => {
      if (!ours(event)) return;
      if (loaded) apply([event]);
      else buffered.push(event);
    });
    setComb(emptyComb);
    void Promise.all(
      runKey
        .split(',')
        .filter(Boolean)
        .map((runId) =>
          window.hive.invoke('events.query', { runId, limit: EVENTS_PER_RUN }).catch(() => []),
        ),
    ).then((lists) => {
      if (cancelled) return;
      const history = lists.flat().sort((a, b) => a.ts.localeCompare(b.ts));
      loaded = true;
      apply([...history, ...buffered]);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceId, runKey, onEvent]);

  return useMemo(() => pruneBees(comb, alive), [comb, alive]);
}

/**
 * Plays the scripted demo mission on its own comb. Its bees leave when the script ends; the
 * comb stays until the user goes back to the live view.
 */
function useDemo(workers: Worker[]) {
  const [comb, setComb] = useState<CombState | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clear = () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  };
  useEffect(() => clear, []);

  function start() {
    clear();
    const { steps, keys } = demoScript(workers);
    setComb(emptyComb);
    let elapsed = 0;
    for (const step of steps) {
      elapsed += step.after;
      timers.current.push(
        setTimeout(() => {
          const event = { ...step.event, ts: new Date().toISOString() };
          setComb((current) => (current ? reduceComb(current, event) : current));
        }, elapsed),
      );
    }
    timers.current.push(
      setTimeout(
        () => setComb((current) => current && pruneBees(current, new Set())),
        elapsed + 1_500,
      ),
    );
    return keys;
  }

  function stop() {
    clear();
    setComb(null);
  }

  return { comb, start: () => void start(), stop };
}

interface Placed {
  bee: BeeTrack | null;
  worker: Worker;
  x: number;
  y: number;
  /** Stable across take-off and landing, so the bee flies instead of reappearing. */
  id: string;
}

export function ColmeiaPage() {
  const { summary, workers, go } = useHive();
  const stage = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const workspace = summary?.workspace ?? null;

  const activeTasks = useMemo(
    () => (summary?.activeTasks ?? []).filter((task) => task.status === 'running'),
    [summary],
  );
  const chats = useMemo(
    () => (summary?.activeChats ?? []).filter((chat) => chat.workspaceId === workspace?.id),
    [summary, workspace],
  );
  const latestRun = summary?.recentRuns.find((run) => run.workspaceId === workspace?.id) ?? null;
  const runIds = useMemo(() => {
    const ids = new Set(activeTasks.map((task) => task.runId));
    if (latestRun) ids.add(latestRun.id);
    return [...ids].sort();
  }, [activeTasks, latestRun]);
  const alive = useMemo(
    () => new Set([...activeTasks.map((task) => task.id), ...chats.map((chat) => chat.id)]),
    [activeTasks, chats],
  );
  const live = useComb(workspace?.id ?? null, runIds, alive);
  const demo = useDemo(workers);
  const comb = demo.comb ?? live;

  // Fresh honey fades on its own, so the comb re-renders while some is still shining.
  useEffect(() => {
    const shining = Object.values(comb.cells).some(
      (cell) => Date.now() - cell.writtenAt < FRESH_MS,
    );
    if (!shining) return;
    const timer = setTimeout(() => setNow(Date.now()), 500);
    return () => clearTimeout(timer);
  }, [comb, now]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const workerById = useMemo(
    () => new Map(workers.map((worker) => [worker.id, worker])),
    [workers],
  );
  // A soldier that reported back is on her way out; she leaves the screen at once.
  const bees = Object.values(comb.bees).filter(
    (bee) => !bee.done && bee.workerId && workerById.has(bee.workerId),
  );
  const captains = bees.filter((bee) => !bee.soldier);
  const resting = workers.filter((worker) => !captains.some((bee) => bee.workerId === worker.id));

  // The comb: every ring that holds a touched file, the empty cells of the last one as wax.
  let rings = 1;
  while (1 + 3 * rings * (rings + 1) < comb.order.length) rings++;
  const slots = spiral(1 + 3 * rings * (rings + 1)).map((coords) => hexCenter(coords, RADIUS));
  const minX = Math.min(...slots.map((slot) => slot.x)) - RADIUS * 1.2;
  const maxX = Math.max(...slots.map((slot) => slot.x)) + RADIUS * 1.2;
  const minY = Math.min(...slots.map((slot) => slot.y)) - RADIUS * 1.6;
  const combBottom = Math.max(...slots.map((slot) => slot.y)) + RADIUS;
  // The entrance: a landing strip under the comb where idle bees wait.
  const entranceY = combBottom + RADIUS * 1.5;
  const width = Math.max(maxX - minX, (resting.length + 1) * 46);
  const left = (minX + maxX) / 2 - width / 2;
  const height = entranceY + RADIUS * 1.1 - minY;

  const placed: Placed[] = [];
  const perCell = new Map<string, number>();
  const usedWorkers = new Set<string>();
  const spread: [number, number][] = [
    [0, -12],
    [16, 6],
    [-16, 6],
    [0, 18],
    [20, -10],
    [-20, -10],
  ];
  for (const bee of captains) {
    const worker = workerById.get(bee.workerId!)!;
    const cell = bee.target ? comb.cells[bee.target] : undefined;
    const slot = cell ? slots[cell.slot] : undefined;
    const index = cell ? (perCell.get(cell.path) ?? 0) : 0;
    if (cell) perCell.set(cell.path, index + 1);
    const [dx, dy] = spread[index % spread.length]!;
    const first = !usedWorkers.has(worker.id);
    usedWorkers.add(worker.id);
    placed.push({
      bee,
      worker,
      id: first ? worker.id : bee.key,
      // A bee between files hovers just above the comb, centred, until she lands on one.
      x: slot ? slot.x + dx : (placed.length - (captains.length - 1) / 2) * 52,
      y: slot ? slot.y + dy : minY + RADIUS * 0.7,
    });
  }
  resting.forEach((worker, index) =>
    placed.push({
      bee: null,
      worker,
      id: worker.id,
      x: (index - (resting.length - 1) / 2) * 46,
      y: entranceY,
    }),
  );
  const soldiers = bees
    .filter((bee) => bee.soldier)
    .map((bee, index) => {
      const captain = placed.find((item) => item.bee?.key === bee.captain);
      const cell = bee.target ? comb.cells[bee.target] : undefined;
      const slot = cell ? slots[cell.slot] : undefined;
      const angle = (index * 2 * Math.PI) / 5;
      return {
        bee,
        worker: workerById.get(bee.workerId!)!,
        x: slot ? slot.x + 14 * Math.cos(angle) : (captain?.x ?? 0) + 22 * Math.cos(angle),
        y: slot ? slot.y + 14 * Math.sin(angle) : (captain?.y ?? minY) + 18 + 10 * Math.sin(angle),
      };
    });
  const at = (x: number, y: number) => ({
    left: `${((x - left) / width) * 100}%`,
    top: `${((y - minY) / height) * 100}%`,
  });

  const targets = new Set(bees.map((bee) => bee.target).filter(Boolean));
  const written = comb.order.filter((path) => comb.cells[path]!.writes > 0).length;

  function openCell(path: string) {
    // The demo's files are made up.
    if (demo.comb) return;
    const cell = comb.cells[path]!;
    const task = activeTasks.find((item) => item.id === cell.taskId);
    useCode
      .getState()
      .open(cell.taskId ? taskDiffTab(cell.taskId, task?.title ?? 'Tarefa', path) : fileTab(path));
    go('code');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen();
  }

  const description = activeTasks.length
    ? `${activeTasks.length} tarefa${activeTasks.length > 1 ? 's' : ''} em andamento${latestRun ? ` · ${latestRun.missionTitle}` : ''}`
    : chats.length
      ? `${chats.length} abelha${chats.length > 1 ? 's' : ''} respondendo no terminal`
      : 'A colmeia está quieta. Rode uma missão ou chame uma abelha com agents no terminal.';

  return (
    <>
      <PageHeader
        eyebrow={demo.comb ? 'Demonstração' : 'Ao vivo'}
        title="Colmeia"
        description={
          demo.comb
            ? 'Uma missão de mentira com o seu time, para ver a colmeia trabalhando. Nada roda de verdade.'
            : description
        }
      >
        {demo.comb ? (
          <button className="secondary" onClick={demo.stop}>
            <Square size={13} /> Voltar ao vivo
          </button>
        ) : (
          <button className="secondary" onClick={demo.start}>
            <Play size={13} /> Demonstração
          </button>
        )}
        <button className="secondary" onClick={toggleFullscreen}>
          <Maximize2 size={13} /> Tela cheia
        </button>
      </PageHeader>
      <div ref={stage} className={fullscreen ? 'colmeia fullscreen' : 'colmeia'}>
        <div className="colmeia-stage">
          {fullscreen && (
            <button
              className="icon-button colmeia-exit"
              title="Sair da tela cheia"
              onClick={toggleFullscreen}
            >
              <Minimize2 size={15} />
            </button>
          )}
          <div
            className="colmeia-comb"
            style={{ aspectRatio: `${width} / ${height}`, ['--ratio' as string]: width / height }}
          >
            <svg
              viewBox={`${left} ${minY} ${width} ${height}`}
              role="img"
              aria-label={`Favo com ${comb.order.length} arquivos tocados, ${written} com mel`}
            >
              <defs>
                {slots.map((slot, index) => (
                  <clipPath key={index} id={`cell-${index}`}>
                    <polygon points={hexPoints(slot.x, slot.y, RADIUS - 3)} />
                  </clipPath>
                ))}
              </defs>
              <line
                className="colmeia-entrance"
                x1={left + 12}
                x2={left + width - 12}
                y1={entranceY + RADIUS * 0.55}
                y2={entranceY + RADIUS * 0.55}
              />
              {slots.map((slot, index) => {
                const path = comb.order[index];
                const cell = path ? comb.cells[path] : undefined;
                if (!cell)
                  return (
                    <polygon
                      key={index}
                      className="colmeia-wax"
                      points={hexPoints(slot.x, slot.y, RADIUS - 3)}
                    />
                  );
                const level = honeyLevel(cell);
                const classes = [
                  'colmeia-cell',
                  level ? 'honey' : '',
                  targets.has(cell.path) ? 'active' : '',
                  now - cell.writtenAt < FRESH_MS ? 'fresh' : '',
                ].join(' ');
                const top = slot.y - RADIUS;
                return (
                  <g
                    key={cell.path}
                    className={classes}
                    role="button"
                    tabIndex={0}
                    onClick={() => openCell(cell.path)}
                    onKeyDown={(event) => event.key === 'Enter' && openCell(cell.path)}
                  >
                    <title>
                      {`${cell.path}\n${cell.writes ? `${cell.writes} edição(ões)` : 'só lido'} · ${cell.reads} leitura(s)`}
                    </title>
                    <polygon
                      className="colmeia-cell-shape"
                      points={hexPoints(slot.x, slot.y, RADIUS - 3)}
                    />
                    <rect
                      className="colmeia-honey"
                      clipPath={`url(#cell-${index})`}
                      x={slot.x - RADIUS}
                      y={top}
                      width={RADIUS * 2}
                      height={RADIUS * 2}
                      style={{ transform: `scaleY(${level})` }}
                    />
                    <text x={slot.x} y={slot.y + 3.5} textAnchor="middle">
                      {clip(basename(cell.path), 11)}
                    </text>
                  </g>
                );
              })}
            </svg>
            {placed.map(({ bee, worker, id, x, y }, index) => (
              <div
                key={id}
                className={[
                  'colmeia-bee',
                  bee ? `on ${bee.state}` : 'resting',
                  bee?.alert ? 'alert' : '',
                ].join(' ')}
                style={at(x, y)}
                title={bee ? `${worker.name}: ${bee.doing}` : `${worker.name} está na colmeia`}
              >
                <AgentBee
                  worker={worker}
                  size={bee ? 30 : 22}
                  mood={bee && busy(bee.state) ? 'working' : 'idle'}
                />
                {bee && (
                  // Neighbours alternate above and below, so their bubbles do not cover each other.
                  <span className={index % 2 ? 'colmeia-bubble below' : 'colmeia-bubble'}>
                    {bee.state === 'waiting_approval' ? '✋ ' : ''}
                    {clip(bee.doing, 30)}
                  </span>
                )}
              </div>
            ))}
            {soldiers.map(({ bee, worker, x, y }) => (
              <div key={bee.key} className="colmeia-bee soldier on" style={at(x, y)}>
                <SoldierBee captain={worker} role={bee.soldier!} working size={15} />
              </div>
            ))}
            {!comb.order.length && (
              <div className="colmeia-empty">
                <Mascot size={44} mood="idle" />
                <span>Os favos aparecem aqui quando as abelhas começam a mexer nos arquivos.</span>
              </div>
            )}
          </div>
          <p className="colmeia-legend">
            <span>
              <strong>{comb.order.length}</strong> arquivos no favo
            </span>
            <span>
              <strong>{written}</strong> com mel
            </span>
            <span>
              <strong>{comb.tokens.toLocaleString('pt-BR')}</strong> tokens
            </span>
          </p>
        </div>
        <ColmeiaSide comb={comb} bees={bees} workerById={workerById} />
      </div>
    </>
  );
}

function ColmeiaSide({
  comb,
  bees,
  workerById,
}: {
  comb: CombState;
  bees: BeeTrack[];
  workerById: Map<string, Worker>;
}) {
  const { summary, refresh, fail } = useHive();
  const approvals = summary?.pendingApprovals ?? [];
  const nameOf = (key: string) => {
    const bee = comb.bees[key];
    const worker = bee?.workerId ? workerById.get(bee.workerId) : undefined;
    if (!worker) return 'Abelha';
    return bee?.soldier ? `${soldierPresets[bee.soldier].label} de ${worker.name}` : worker.name;
  };
  const feedName = (item: FeedItem) => {
    const name = (item.workerId && workerById.get(item.workerId)?.name) || 'Abelha';
    return item.soldier ? `${soldierPresets[item.soldier].label} de ${name}` : name;
  };

  function answer(approvalId: string, approve: boolean) {
    void window.hive
      .invoke('approval.resolve', { approvalId, approve, remember: false })
      .then(refresh)
      .catch(fail);
  }

  return (
    <aside className="colmeia-side">
      <h3>No ar</h3>
      {bees.length ? (
        <ul className="colmeia-list">
          {bees.map((bee) => {
            const worker = workerById.get(bee.workerId!)!;
            const pending = approvals.find((approval) => approval.taskId === bee.taskId);
            return (
              <li key={bee.key} className={bee.soldier ? 'soldier' : undefined}>
                <span className="colmeia-list-bee">
                  {bee.soldier ? (
                    <SoldierBee captain={worker} role={bee.soldier} working size={13} />
                  ) : (
                    <AgentBee
                      worker={worker}
                      size={18}
                      mood={busy(bee.state) ? 'working' : 'still'}
                    />
                  )}
                </span>
                <span className="colmeia-list-main">
                  <span>
                    {nameOf(bee.key)}
                    <small className={`colmeia-state ${bee.state}`}>{stateLabels[bee.state]}</small>
                  </span>
                  <small className={bee.alert ? 'error-text' : undefined}>{bee.doing}</small>
                  {bee.chatTitle && !bee.soldier && (
                    <small className="colmeia-chat">“{bee.chatTitle}”</small>
                  )}
                  {pending && !bee.soldier && (
                    <span className="colmeia-approval">
                      <code title={pending.detail}>{clip(pending.detail, 60)}</code>
                      <button onClick={() => answer(pending.id, true)}>
                        <Check size={13} /> Permitir
                      </button>
                      <button className="secondary" onClick={() => answer(pending.id, false)}>
                        <X size={13} /> Negar
                      </button>
                    </span>
                  )}
                  {!pending && bee.chatTitle && bee.state === 'waiting_approval' && (
                    <small className="colmeia-chat">Responda no terminal.</small>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="field-hint">Nenhuma abelha trabalhando agora.</p>
      )}
      <h3>Agora há pouco</h3>
      {comb.feed.length ? (
        <ol className="colmeia-feed">
          {comb.feed.slice(0, 14).map((item) => (
            <li key={item.id} className={item.tone}>
              <time>
                {new Date(item.at).toLocaleTimeString('pt-BR', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </time>
              <span>
                <strong>{feedName(item)}</strong> {item.text}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="field-hint">As entregas e os comandos aparecem aqui.</p>
      )}
    </aside>
  );
}
