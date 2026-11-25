import type { CSSProperties } from 'react';
import {
  BookOpen,
  Bug,
  ClipboardList,
  Compass,
  Crown,
  Database,
  Eye,
  FlaskConical,
  Gauge,
  LayoutTemplate,
  Map as MapIcon,
  Puzzle,
  Server,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  beeColorOf,
  roleInfo,
  type MarketplaceAgent,
  type MarketplacePackage,
  type WorkerRole,
} from '@hive/core';
import { Mascot } from './mascot';

/** The insignia each role wears on its portrait. */
export const roleIcons: Record<WorkerRole, LucideIcon> = {
  queen: Crown,
  architect: Compass,
  frontend: LayoutTemplate,
  backend: Server,
  explorer: MapIcon,
  requirements: ClipboardList,
  qa: FlaskConical,
  reviewer: Eye,
  debugger: Bug,
  security: ShieldCheck,
  database: Database,
  performance: Gauge,
  integration: Puzzle,
  custom: Sparkles,
};

/** The bee colour of an agent in a package: its own, or its role's. */
export const agentColor = (agent: Pick<MarketplaceAgent, 'key' | 'role' | 'color'>) =>
  agent.color ?? beeColorOf({ id: agent.key, role: agent.role, beeColor: null });

/** The colour a package is drawn in: its first agent's, or Hive's gold for skills. */
export const packageColor = (pkg: MarketplacePackage) =>
  pkg.agents[0] ? agentColor(pkg.agents[0]) : '#f5b544';

export const roleName = (role: WorkerRole) => roleInfo[role].label;

/** An agent's portrait: its bee on a disc of its colour, with the role's insignia. */
export function AgentPortrait({
  agent,
  size = 64,
  animated = false,
}: {
  agent: Pick<MarketplaceAgent, 'key' | 'role' | 'color' | 'name'>;
  size?: number;
  animated?: boolean;
}) {
  const Icon = roleIcons[agent.role];
  return (
    <span
      className="market-portrait"
      style={{ '--accent': agentColor(agent), '--portrait': `${size}px` } as CSSProperties}
      title={`${agent.name} · ${roleName(agent.role)}`}
    >
      <Mascot
        size={Math.round(size * 0.68)}
        mood={animated ? 'idle' : 'still'}
        color={agentColor(agent)}
      />
      <span className="market-portrait-insignia" aria-hidden>
        <Icon size={Math.max(10, Math.round(size * 0.2))} strokeWidth={2.4} />
      </span>
    </span>
  );
}

/**
 * The picture at the top of a card or of the preview: one portrait for an agent, the whole
 * team side by side, or a book for a skill package.
 */
export function PackageCover({
  pkg,
  large = false,
  animated = false,
}: {
  pkg: MarketplacePackage;
  large?: boolean;
  animated?: boolean;
}) {
  const size = large ? 84 : 64;
  return (
    <span
      className={large ? 'market-cover large' : 'market-cover'}
      style={{ '--accent': packageColor(pkg) } as CSSProperties}
      aria-hidden
    >
      <span className="market-cover-comb" />
      {pkg.agents.length === 0 ? (
        <span className="market-portrait" style={{ '--portrait': `${size}px` } as CSSProperties}>
          <BookOpen size={Math.round(size * 0.4)} />
        </span>
      ) : pkg.agents.length === 1 ? (
        <AgentPortrait agent={pkg.agents[0]!} size={size} animated={animated} />
      ) : (
        <span className="market-team">
          {pkg.agents.slice(0, 4).map((agent) => (
            <AgentPortrait
              key={agent.key}
              agent={agent}
              size={Math.round(size * 0.82)}
              animated={animated}
            />
          ))}
          {pkg.agents.length > 4 && (
            <span className="market-team-more">+{pkg.agents.length - 4}</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The small round picture beside a card's name: the agent's portrait, the team's lead with a
 * count of the rest, or a book for a skill package.
 */
export function PackageAvatar({ pkg, size = 52 }: { pkg: MarketplacePackage; size?: number }) {
  const lead = pkg.agents[0];
  return (
    <span
      className="market-avatar"
      style={{ '--accent': packageColor(pkg) } as CSSProperties}
      aria-hidden
    >
      {lead ? (
        <AgentPortrait agent={lead} size={size} />
      ) : (
        <span className="market-portrait" style={{ '--portrait': `${size}px` } as CSSProperties}>
          <BookOpen size={Math.round(size * 0.42)} />
        </span>
      )}
      {pkg.agents.length > 1 && (
        <span className="market-avatar-count">+{pkg.agents.length - 1}</span>
      )}
    </span>
  );
}
