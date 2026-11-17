import { useState } from 'react';
import { Check, ChevronDown, Pin } from 'lucide-react';
import type { Run } from '@hive/core';
import { runTone, statusLabels } from './ui';

export interface SidebarMission {
  id: string;
  title: string;
  lastRunStatus: Run['status'] | null;
  pinned: boolean;
}

type Section = 'pinned' | 'progress' | 'done';

const doneStatuses = new Set<Run['status']>(['completed', 'cancelled']);

/** Pinned first; then missions still moving; then the finished ones. */
export function sectionOf(mission: SidebarMission): Section {
  if (mission.pinned) return 'pinned';
  if (mission.lastRunStatus && doneStatuses.has(mission.lastRunStatus)) return 'done';
  return 'progress';
}

/**
 * A project's missions as one list hanging from the project, like files in a folder: pinned ones
 * on top, then the ones still moving, and the finished ones folded into a single row at the end
 * (open on its own when the selected mission is among them).
 */
export function MissionCards({
  missions,
  selectedId,
  onOpen,
  onPin,
}: {
  missions: SidebarMission[];
  selectedId: string | null;
  onOpen(id: string): void;
  onPin(id: string, pinned: boolean): void;
}) {
  const [showDone, setShowDone] = useState(false);
  const active = missions.filter((mission) => sectionOf(mission) !== 'done');
  const pinned = active.filter((mission) => mission.pinned);
  const moving = active.filter((mission) => !mission.pinned);
  const done = missions.filter((mission) => sectionOf(mission) === 'done');
  const doneOpen = showDone || done.some((mission) => mission.id === selectedId);
  const row = (mission: SidebarMission, index: number) => (
    <MissionCard
      key={mission.id}
      mission={mission}
      index={index}
      selected={mission.id === selectedId}
      onOpen={onOpen}
      onPin={onPin}
    />
  );
  return (
    <div className="mission-cards">
      {[...pinned, ...moving].map(row)}
      {pinned.length > 0 && moving.length > 0 && (
        <span className="mission-divider" aria-hidden="true" />
      )}
      {!active.length && <p className="mission-empty">Nenhuma missão em andamento.</p>}
      {done.length > 0 && (
        <>
          <button
            className="mission-done-toggle"
            aria-expanded={doneOpen}
            onClick={() => setShowDone((value) => !value)}
          >
            <Check size={12} />
            <span>Concluídas</span>
            <span className="mission-done-count">{done.length}</span>
            <ChevronDown size={12} className={doneOpen ? 'chevron open' : 'chevron'} />
          </button>
          {doneOpen && <div className="mission-done-list">{done.map(row)}</div>}
        </>
      )}
    </div>
  );
}

function MissionCard({
  mission,
  index,
  selected,
  onOpen,
  onPin,
}: {
  mission: SidebarMission;
  index: number;
  selected: boolean;
  onOpen(id: string): void;
  onPin(id: string, pinned: boolean): void;
}) {
  const status = statusLabels[mission.lastRunStatus ?? 'draft'];
  const tone = runTone(mission.lastRunStatus);
  return (
    <div
      className={`mission-card tone-${tone}${selected ? ' selected' : ''}${mission.pinned ? ' pinned' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <button
        className="mission-card-main"
        title={`${mission.title} · ${status}`}
        aria-current={selected ? 'page' : undefined}
        onClick={() => onOpen(mission.id)}
      >
        <span className={`mission-dot tone-${tone}`} aria-hidden="true" />
        <span className="truncate">{mission.title}</span>
        <span className="sr-only">, {status}</span>
      </button>
      <button
        className={mission.pinned ? 'mission-pin on' : 'mission-pin'}
        title={mission.pinned ? 'Desafixar' : 'Fixar'}
        aria-label={mission.pinned ? 'Desafixar missão' : 'Fixar missão'}
        aria-pressed={mission.pinned}
        onClick={() => onPin(mission.id, !mission.pinned)}
      >
        <Pin size={12} />
      </button>
    </div>
  );
}
