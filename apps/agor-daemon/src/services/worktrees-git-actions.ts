/**
 * Worktrees Git Actions Service
 *
 * Provides REST API for git operations on worktrees.
 * Exposed as nested routes: worktrees/:id/git/*
 *
 * Operations:
 * - POST /worktrees/:id/git/rebase - Rebase onto target branch
 * - POST /worktrees/:id/git/merge - Merge from target branch
 * - POST /worktrees/:id/git/rename-branch - Rename current branch
 * - POST /worktrees/:id/git/create-pr - Create a pull request
 * - POST /worktrees/:id/git/push - Push current branch
 * - GET /worktrees/:id/git/branches - List available branches
 */

import type { WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  createPullRequest,
  listBranches,
  mergeBranch,
  pushBranch,
  rebaseBranch,
  renameBranch,
} from '@agor/core/git';
import type { Worktree, WorktreeID } from '@agor/core/types';

// Type for route params
interface RouteParams {
  route?: {
    id?: string;
  };
  query?: Record<string, unknown>;
}

// Helper to get worktree or throw
async function getWorktreeOrThrow(
  worktreeRepo: WorktreeRepository,
  params: RouteParams
): Promise<Worktree> {
  const worktreeId = params.route?.id;
  if (!worktreeId) {
    throw new Error('Worktree ID is required');
  }

  const worktree = await worktreeRepo.findById(worktreeId as WorktreeID);
  if (!worktree) {
    throw new Error(`Worktree not found: ${worktreeId}`);
  }

  return worktree;
}

export function setupWorktreesGitActionsService(
  app: Application,
  worktreeRepo: WorktreeRepository
) {
  // ============================================================
  // Rebase Service: POST /worktrees/:id/git/rebase
  // ============================================================
  app.use('worktrees/:id/git/rebase', {
    async create(data: { onto: string }, params: RouteParams) {
      const worktree = await getWorktreeOrThrow(worktreeRepo, params);

      if (!data.onto) {
        throw new Error('Target branch (onto) is required');
      }

      console.log(`🔄 Rebasing worktree ${worktree.name} onto ${data.onto}`);

      const result = await rebaseBranch(worktree.path, data.onto);

      if (!result.success) {
        throw new Error(result.error || 'Rebase failed');
      }

      return { success: true, message: `Rebased onto ${data.onto}` };
    },
  });

  // ============================================================
  // Merge Service: POST /worktrees/:id/git/merge
  // ============================================================
  app.use('worktrees/:id/git/merge', {
    async create(data: { from: string }, params: RouteParams) {
      const worktree = await getWorktreeOrThrow(worktreeRepo, params);

      if (!data.from) {
        throw new Error('Source branch (from) is required');
      }

      console.log(`🔀 Merging ${data.from} into worktree ${worktree.name}`);

      const result = await mergeBranch(worktree.path, data.from);

      if (!result.success) {
        throw new Error(result.error || 'Merge failed');
      }

      return { success: true, message: `Merged ${data.from}` };
    },
  });

  // ============================================================
  // Rename Branch Service: POST /worktrees/:id/git/rename-branch
  // ============================================================
  app.use('worktrees/:id/git/rename-branch', {
    async create(data: { newName: string }, params: RouteParams) {
      const worktree = await getWorktreeOrThrow(worktreeRepo, params);

      if (!data.newName) {
        throw new Error('New branch name (newName) is required');
      }

      console.log(`✏️ Renaming branch in worktree ${worktree.name} to ${data.newName}`);

      const result = await renameBranch(worktree.path, data.newName);

      if (!result.success) {
        throw new Error(result.error || 'Rename failed');
      }

      // Update worktree ref in database
      await worktreeRepo.update(worktree.worktree_id, {
        ref: data.newName,
        name: data.newName, // Worktree name usually matches branch name
      });

      return { success: true, newName: data.newName };
    },
  });

  // ============================================================
  // Create PR Service: POST /worktrees/:id/git/create-pr
  // ============================================================
  app.use('worktrees/:id/git/create-pr', {
    async create(data: { title: string; body?: string; base?: string }, params: RouteParams) {
      const worktree = await getWorktreeOrThrow(worktreeRepo, params);

      if (!data.title) {
        throw new Error('PR title is required');
      }

      console.log(`📝 Creating PR for worktree ${worktree.name}: ${data.title}`);

      // Push first to ensure remote branch exists
      const pushResult = await pushBranch(worktree.path);
      if (!pushResult.success) {
        throw new Error(`Failed to push: ${pushResult.error}`);
      }

      // Create PR using gh CLI
      const result = await createPullRequest(worktree.path, {
        title: data.title,
        body: data.body,
        base: data.base || worktree.base_ref,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to create PR');
      }

      // Update worktree with PR URL
      if (result.prUrl) {
        await worktreeRepo.update(worktree.worktree_id, {
          pull_request_url: result.prUrl,
        });
      }

      return {
        success: true,
        prUrl: result.prUrl,
        prNumber: result.prNumber,
      };
    },
  });

  // ============================================================
  // Push Service: POST /worktrees/:id/git/push
  // ============================================================
  app.use('worktrees/:id/git/push', {
    async create(data: { force?: boolean }, params: RouteParams) {
      const worktree = await getWorktreeOrThrow(worktreeRepo, params);

      console.log(`⬆️ Pushing worktree ${worktree.name}${data.force ? ' (force)' : ''}`);

      const result = await pushBranch(worktree.path, data.force);

      if (!result.success) {
        throw new Error(result.error || 'Push failed');
      }

      return { success: true };
    },
  });

  // ============================================================
  // List Branches Service: GET /worktrees/:id/git/branches
  // ============================================================
  app.use('worktrees/:id/git/branches', {
    async find(params: RouteParams) {
      const worktree = await getWorktreeOrThrow(worktreeRepo, params);

      const branches = await listBranches(worktree.path);

      return branches;
    },
  });

  console.log('✅ Worktree git actions services registered');
}
