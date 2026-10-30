import { BrainCircuit, Frame, StickyNote, X } from 'lucide-react';

/** Blocks the user can drag onto the canvas; the drop decides where they go. */
export type BlockKind = 'note' | 'frame' | 'cortex';
export const BLOCK_MIME = 'application/x-hive-block';

const categories: {
  title: string;
  blocks: { kind: BlockKind; title: string; description: string; icon: typeof StickyNote }[];
}[] = [
  {
    title: 'Anotações',
    blocks: [
      { kind: 'note', title: 'Nota', description: 'Texto livre no canvas.', icon: StickyNote },
      {
        kind: 'frame',
        title: 'Grupo',
        description: 'Quadro que agrupa e move junto.',
        icon: Frame,
      },
    ],
  },
  {
    title: 'Cortex',
    blocks: [
      {
        kind: 'cortex',
        title: 'Cortex — Shared Memory',
        description: 'Memória persistente do projeto. Conecte agentes para dar acesso.',
        icon: BrainCircuit,
      },
    ],
  },
];

/** The block menu of the Nexus: drag a block to the canvas, or click to place it in view. */
export function BlockLibrary({
  onPlace,
  onClose,
  disabled,
}: {
  onPlace: (kind: BlockKind) => void;
  onClose: () => void;
  /** Why blocks cannot be added right now, if they cannot. */
  disabled?: string;
}) {
  return (
    <aside className="nc-blocks" aria-label="Blocos">
      <header>
        <strong>Blocos</strong>
        <button className="icon-button" aria-label="Fechar blocos" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {disabled && <p className="muted-text">{disabled}</p>}
      {categories.map((category) => (
        <section key={category.title}>
          <h4>{category.title}</h4>
          {category.blocks.map(({ kind, title, description, icon: Icon }) => (
            <button
              key={kind}
              className={`nc-block kind-${kind}`}
              draggable={!disabled}
              disabled={!!disabled}
              title="Arraste para o canvas ou clique para adicionar no centro"
              onDragStart={(event) => {
                event.dataTransfer.setData(BLOCK_MIME, kind);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onPlace(kind)}
            >
              <span className="nc-block-icon">
                <Icon size={16} />
              </span>
              <span className="nc-block-text">
                <strong>{title}</strong>
                <span>{description}</span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
