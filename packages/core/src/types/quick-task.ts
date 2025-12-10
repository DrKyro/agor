import type { AgenticToolName } from './agentic-tool';
import type { BoardID, TaskID, UUID } from './id';
import type { Repo, RepoSlug } from './repo';
import type { PermissionMode, Session } from './session';
import type { Worktree } from './worktree';

/**
 * Lightweight git metadata returned by /git-info service
 */
export interface RepoGitInfo {
  repo_id: UUID;
  slug: RepoSlug;
  currentBranch: string;
  defaultBranch?: string;
  /**
   * Raw git state (SHA + "-dirty" suffix when uncommitted changes exist)
   */
  gitState?: string;
  /**
   * Latest commit SHA (without "-dirty" suffix)
   */
  headSha?: string;
  /**
   * Whether repository working tree is clean
   */
  isClean: boolean;
  /**
   * Absolute path where git commands were executed
   */
  path: string;
}

/**
 * Request payload for title generation service
 */
export interface TitleGenerationRequest {
  prompt: string;
}

/**
 * Result returned by title generation service/helper
 */
export interface TitleGenerationResult {
  title: string;
  usedAI: boolean;
  model?: string;
  fallbackReason?: string;
}

/**
 * Payload for quick-task service that orchestrates worktree → session → task execution
 */
export interface QuickTaskRequest {
  repo_id: UUID;
  /**
   * Base branch to branch from when creating the worktree (defaults to "dev")
   */
  base_branch?: string;
  agent: AgenticToolName;
  permissionMode?: PermissionMode;
  prompt: string;
  /**
   * Optional board assignment for the new worktree/session
   */
  board_id?: BoardID;
}

/**
 * Response payload returned after quick task orchestration
 */
export interface QuickTaskResponse {
  worktree: Worktree;
  session: Session;
  taskId?: TaskID;
  executionStatus?: string;
  executionError?: string;
  titleGeneration: TitleGenerationResult;
}

/**
 * Helper type for repo select options in UI forms
 */
export type QuickTaskRepoOption = Pick<Repo, 'repo_id' | 'name' | 'slug' | 'default_branch'>;
