import { useState } from 'react';
import { ChevronDown, Pin } from 'lucide-react';
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
  const groups: Record<Section, SidebarMission[]> = { pinned: [], progress: [], done: [] };
  for (const mission of missions) groups[sectionOf(mission)].push(mission);
  return (
    <div className="mission-cards">
      <MissionSection
        title="Fixadas"
        tone="pinned"
        items={groups.pinned}
        selectedId={selectedId}
        onOpen={onOpen}
        onPin={onPin}
      />
      <MissionSection
        title="Em andamento"
        tone="progress"
        items={groups.progress}
        selectedId={selectedId}
        onOpen={onOpen}
        onPin={onPin}
      />
      <MissionSection
        title="Concluídas"
        tone="done"
        items={groups.done}
        selectedId={selectedId}
        onOpen={onOpen}
        onPin={onPin}
      />
    </div>
  );
}

function MissionSection({
  title,
  tone,
  items,
  selectedId,
  onOpen,
  onPin,
}: {
  title: string;
  tone: Section;
  items: SidebarMission[];
  selectedId: string | null;
  onOpen(id: string): void;
  onPin(id: string, pinned: boolean): void;
}) {
  // Every section starts closed; the counts show what is inside.
  const [open, setOpen] = useState(false);
  return (
    <section className={`mission-section tone-${tone}`}>
      <button
        className="mission-section-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="section-ring" aria-hidden="true" />
        <span className="mission-section-title">{title}</span>
        <span className="mission-section-count">{items.length}</span>
        <ChevronDown size={13} className={open ? 'chevron open' : 'chevron'} />
      </button>
      <div className={open ? 'mission-section-body open' : 'mission-section-body'}>
        <div className="mission-section-inner">
          {items.length === 0 && <p className="mission-empty">Nada aqui.</p>}
          {items.map((mission, index) => (
            <MissionCard
              key={mission.id}
              mission={mission}
              index={index}
              selected={mission.id === selectedId}
              onOpen={onOpen}
              onPin={onPin}
            />
          ))}
        </div>
      </div>
    </section>
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
  const status = mission.lastRunStatus ?? 'draft';
  const tone = runTone(mission.lastRunStatus);
  return (
    <div
      className={`mission-card tone-${tone}${selected ? ' selected' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <button className="mission-card-main" onClick={() => onOpen(mission.id)}>
        <span className="mission-card-top">
          <span className={`mission-dot tone-${tone}`} aria-hidden="true" />
          <span className="truncate">{mission.title}</span>
        </span>
        <span className="mission-card-status">{statusLabels[status]}</span>
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
