export {
  git,
  gitPreflight,
  GIT_MISSING,
  hiveCommitFlags,
  isEnvironmentFailure,
  type GitResult,
} from './git';
export {
  WorktreeManager,
  diffRefs,
  linkDependencies,
  unlinkDependencies,
  inspectRepository,
  isHiveBranch,
  listWorktrees,
  statusPorcelain,
  taskBranchName,
  type DiffFile,
  type DiffResult,
  type RepoInfo,
  type WorktreeEntry,
} from './repository';
export {
  GitManager,
  classifyGitFailure,
  type GitApprovalRequest,
  type GitAuditEntry,
  type GitBranch,
  type GitCommit,
  type GitFileStatus,
  type GitManagerOptions,
  type GitStatus,
  type OperationOptions,
} from './git/manager';
export {
  defaultGitPolicy,
  needsApproval,
  type GitActor,
  type GitOperationKind,
  type GitPolicy,
} from './git/policy';
export {
  assertBranchName,
  assertRemoteUrl,
  literalPathspecs,
  repoRelativePath,
} from './git/validate';
