import type { ComponentType } from 'react';
import {
  Bell,
  CalendarClock,
  FlaskConical,
  Stamp,
  Frame,
  Gauge,
  Globe,
  GripVertical,
  MessagesSquare,
  ShieldCheck,
  Plug,
  SquareTerminal,
  StickyNote,
  X,
} from 'lucide-react';
import { PixelDrop } from './nectar-art';
import { ClaudeLogo } from '../../provider-logo';

/** Blocks the user can drag onto the canvas; the drop decides where they go. */
export type BlockKind =
  | 'note'
  | 'frame'
  | 'cortex'
  | 'tokens'
  | 'dialogue'
  | 'delivery'
  | 'browser'
  | 'provider'
  | 'terminal'
  | 'claude'
  | 'schedule'
  | 'check'
  | 'approval'
  | 'notify';
export const BLOCK_MIME = 'application/x-hive-block';

const categories: {
  title: string;
  blocks: {
    kind: BlockKind;
    title: string;
    description: string;
    icon: ComponentType<{ size?: number }>;
  }[];
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
    title: 'Fluxo',
    blocks: [
      {
        kind: 'schedule',
        title: 'Agendado',
        description: 'Inicia a missão num horário. Ligue até a Queen.',
        icon: CalendarClock,
      },
      {
        kind: 'check',
        title: 'Verificação',
        description: 'Roda testes, lint ou build no que o agente entregou: passou ou falhou.',
        icon: FlaskConical,
      },
      {
        kind: 'approval',
        title: 'Aprovação',
        description: 'Segura a entrega até você aprovar, ou aplica sozinha.',
        icon: Stamp,
      },
      {
        kind: 'notify',
        title: 'Notificação',
        description: 'Avisa no Windows quando algo chega aqui.',
        icon: Bell,
      },
    ],
  },
  {
    title: 'Provedores',
    blocks: [
      {
        kind: 'provider',
        title: 'Provedor',
        description: 'Escolha ou conecte um provedor e ligue-o a um agente.',
        icon: Plug,
      },
    ],
  },
  {
    title: 'Testar o app',
    blocks: [
      {
        kind: 'browser',
        title: 'Navegador',
        description: 'O Hive Browser: abra o app e veja ao vivo o QA testando.',
        icon: Globe,
      },
    ],
  },
  {
    title: 'Terminais',
    blocks: [
      {
        kind: 'terminal',
        title: 'Terminal',
        description: 'Um terminal de verdade na pasta do projeto.',
        icon: SquareTerminal,
      },
      {
        kind: 'claude',
        title: 'Claude Code',
        description: 'O Claude Code com a sua conta, trabalhando no mesmo projeto.',
        icon: ClaudeLogo,
      },
    ],
  },
  {
    title: 'Monitoramento',
    blocks: [
      {
        kind: 'tokens',
        title: 'Tokens',
        description: 'Uso de hoje em % do orçamento diário, ao vivo.',
        icon: Gauge,
      },
      {
        kind: 'dialogue',
        title: 'Diálogo',
        description: 'A conversa da equipe: quem entregou o quê a quem, ao vivo.',
        icon: MessagesSquare,
      },
      {
        kind: 'delivery',
        title: 'Entrega',
        description: 'Cada requisito da missão e a verificação final do projeto integrado.',
        icon: ShieldCheck,
      },
    ],
  },
  {
    title: 'Nectar',
    blocks: [
      {
        kind: 'cortex',
        title: 'Nectar — Shared Intelligence',
        description: 'Memória persistente do projeto. Conecte agentes para dar acesso.',
        icon: PixelDrop,
      },
    ],
  },
];

/** The block menu of the Workspace: drag a block to the canvas, or click to place it in view. */
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
        <span>
          <strong>Blocos</strong>
          <small>Arraste para o canvas ou clique para adicionar</small>
        </span>
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
              <GripVertical size={14} className="nc-block-grip" aria-hidden />
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
