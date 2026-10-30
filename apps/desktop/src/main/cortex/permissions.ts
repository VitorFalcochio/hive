import type {
  CortexConnection,
  CortexNode,
  CortexPermission,
  CortexPermissions,
  Run,
} from '@hive/core';
import { HiveError } from '@hive/shared';

/**
 * Access to a Cortex comes only from a connection drawn on the Nexus (or applied from an
 * Autopilot flow the user approved). These checks run in the main process for every agent
 * operation; the renderer never decides who may read or write.
 */

export const permissionLabels: Record<CortexPermission, string> = {
  read: 'Read',
  propose: 'Propose',
  approve: 'Approve',
  manage: 'Manage',
};

export function connectionOf(node: CortexNode, workerId: string): CortexConnection | null {
  return node.connections.find((connection) => connection.workerId === workerId) ?? null;
}

export function can(node: CortexNode, workerId: string, permission: CortexPermission): boolean {
  return !!connectionOf(node, workerId)?.permissions[permission];
}

/** The Cortex blocks of the run's project that grant this agent a permission. */
export function grantingNodes(
  nodes: CortexNode[],
  run: Pick<Run, 'workspaceId'>,
  workerId: string,
  permission: CortexPermission,
): CortexNode[] {
  return nodes.filter(
    (node) => node.workspaceId === run.workspaceId && can(node, workerId, permission),
  );
}

export function requirePermission(
  node: CortexNode,
  workerId: string,
  permission: CortexPermission,
): CortexConnection {
  const connection = connectionOf(node, workerId);
  if (!connection)
    throw new HiveError('VALIDATION', `Este agente não está conectado ao Cortex “${node.name}”.`);
  if (!connection.permissions[permission])
    throw new HiveError(
      'VALIDATION',
      `Este agente não tem a permissão ${permissionLabels[permission]} no Cortex “${node.name}”.`,
    );
  return connection;
}

/** Writing implies reading what is there, so Propose, Approve and Manage bring Read along. */
export function normalizePermissions(permissions: CortexPermissions): CortexPermissions {
  const writes = permissions.propose || permissions.approve || permissions.manage;
  return { ...permissions, read: permissions.read || writes };
}

/** What an Autopilot flow may grant: never Approve or Manage, which only the user gives. */
export function autopilotPermissions(requested: CortexPermission[]): CortexPermissions {
  return normalizePermissions({
    read: requested.includes('read'),
    propose: requested.includes('propose'),
    approve: false,
    manage: false,
  });
}
