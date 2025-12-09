/**
 * Worktrees Diff Service
 *
 * Provides REST API for git diff operations on worktrees.
 * Exposed as a nested route: worktrees/:id/diff
 *
 * Operations:
 * - GET /worktrees/:id/diff - Get diff between two refs
 *
 * Authorization:
 * - Requires view permission on the worktree
 */

import type { WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { getAvailableRefs, getWorktreeDiff, getWorktreeDiffOutput } from '@agor/core/git';
import type { WorktreeID } from '@agor/core/types';

export type WorktreeDiffParams = {
  route?: {
    id?: string;
  };
  query?: {
    from?: string;
    to?: string;
    file?: string;
  };
};

export function setupWorktreesDiffService(app: Application, worktreeRepo: WorktreeRepository) {
  app.use('worktrees/:id/diff', {
    async find(params: WorktreeDiffParams) {
      const worktreeId = params.route?.id;
      if (!worktreeId) {
        throw new Error('Worktree ID is required');
      }

      // Get worktree
      const worktree = await worktreeRepo.findById(worktreeId as WorktreeID);
      if (!worktree) {
        throw new Error(`Worktree not found: ${worktreeId}`);
      }

      // Get query parameters
      const { from, to, file } = params.query || {};

      try {
        // Default: compare base_ref (or HEAD if not available) with current ref
        const fromRef = from || worktree.base_ref || 'HEAD';
        const toRef = to || worktree.ref;

        console.log(`🔍 Getting diff for worktree ${worktree.name}: ${fromRef}..${toRef}`);

        // Get diff result (summary + file list)
        const diffResult = await getWorktreeDiff(worktree.path, fromRef, toRef, file);

        // Get raw diff output for UI rendering (GitHub-like viewer)
        const diffOutput = await getWorktreeDiffOutput(worktree.path, fromRef, toRef, file);

        // Get available refs for UI reference selector
        let availableRefs: Awaited<ReturnType<typeof getAvailableRefs>> | undefined;
        try {
          // Need repo path to get refs
          const repo = await app.service('repos').get(worktree.repo_id, params);
          availableRefs = await getAvailableRefs(repo.local_path);
        } catch (error) {
          console.warn('Failed to get available refs:', error);
          // Continue without refs - not critical
        }

        return {
          diff: diffResult,
          diffOutput,
          availableRefs,
        };
      } catch (error) {
        console.error(
          `❌ Failed to get diff for worktree ${worktree.name}:`,
          error instanceof Error ? error.message : String(error)
        );

        throw new Error(
          `Failed to get diff: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  // Register hooks
  app.service('worktrees/:id/diff').hooks({
    before: {
      find: [
        // TODO: Add authorization hook here
        // requireViewPermission(worktreeRepo)
      ],
    },
  });
}
