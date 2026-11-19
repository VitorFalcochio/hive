/**
 * What a Git operation can do, from harmless to irreversible or public:
 * - read: looks only (status, diff, log, branches).
 * - write: changes the local repository in a way the user can undo (stage, commit, fetch,
 *   checkout, new branch, fast-forward pull).
 * - destructive: throws work away or rewrites what others may rely on (discard changes,
 *   delete an unmerged branch, abort a merge, take "ours"/"theirs" over a file).
 * - publish: sends work to a remote (push). Others see it, and it cannot be taken back.
 */
export type GitOperationKind = 'read' | 'write' | 'destructive' | 'publish';

/** Who asked: the user from Hive's interface, or an agent (or the Queen) through Hive. */
export type GitActor = { kind: 'user' } | { kind: 'agent'; id: string; name?: string };

export interface GitPolicy {
  /**
   * Kinds that run without asking. 'read' is always allowed; destructive and publish are never
   * in here by default. Hive's interface asks the user itself before calling those.
   */
  autoApprove: GitOperationKind[];
  /** Branches agents may not change without approval, besides main, master and the remote's default. */
  protectedBranches: string[];
}

export const defaultGitPolicy: GitPolicy = {
  autoApprove: ['read', 'write'],
  protectedBranches: [],
};

export const DEFAULT_PROTECTED = ['main', 'master'];

/**
 * Whether an operation needs approval. Reads never do. Destructive and publishing operations
 * always do, unless the policy auto-approves their kind. Writes do when an agent makes them on
 * a protected branch: agents work on their own branches, and the main line is the user's.
 */
export function needsApproval(
  policy: GitPolicy,
  kind: GitOperationKind,
  actor: GitActor,
  onProtectedBranch: boolean,
): boolean {
  if (kind === 'read') return false;
  if (kind === 'write' && actor.kind === 'agent' && onProtectedBranch) return true;
  return !policy.autoApprove.includes(kind);
}
