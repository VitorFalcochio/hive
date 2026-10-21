import { Plus, X } from 'lucide-react';
import type { Workspace } from '@hive/core';

// Open projects as browser-style tabs. Closing a tab keeps the project in the sidebar.
export function ProjectTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onOpen,
}: {
  tabs: Workspace[];
  activeId: string | null;
  onActivate(workspace: Workspace): void;
  onClose(workspace: Workspace): void;
  onOpen(): void;
}) {
  return (
    <div className="project-tabs" role="tablist" aria-label="Projetos abertos">
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <div key={tab.id} className={selected ? 'project-tab selected' : 'project-tab'}>
            <button
              role="tab"
              aria-selected={selected}
              className="project-tab-name"
              title={tab.path}
              onClick={() => onActivate(tab)}
            >
              {tab.name}
            </button>
            <button
              className="project-tab-close"
              aria-label={`Fechar ${tab.name}`}
              title="Fechar aba"
              onClick={() => onClose(tab)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button
        className="project-tab-add"
        onClick={onOpen}
        title="Abrir repositório"
        aria-label="Abrir repositório"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
