/**
 * Git Info Service
 *
 * Exposes lightweight git metadata for repositories so the UI can
 * auto-detect branches when creating Quick Tasks or worktrees.
 */

import { type Database, RepoRepository } from '@agor/core/db';
import {
  getCurrentBranch,
  getCurrentSha,
  getDefaultBranch,
  getGitState,
  isClean,
} from '@agor/core/git';
import type { QueryParams, Repo, RepoGitInfo, ServiceMethods } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';

export type GitInfoParams = QueryParams<{
  repo_id?: string;
}>;

class GitInfoService implements Pick<ServiceMethods<RepoGitInfo>, 'find'> {
  private repoRepo: RepoRepository;

  constructor(repoRepo: RepoRepository) {
    this.repoRepo = repoRepo;
  }

  async find(params?: GitInfoParams): Promise<RepoGitInfo[]> {
    ensureMinimumRole(params, 'member', 'read repository git info');

    const repoId = params?.query?.repo_id;
    if (repoId) {
      const info = await this.getInfo(repoId);
      return info ? [info] : [];
    }

    const repos = await this.repoRepo.findAll();
    const results: RepoGitInfo[] = [];
    for (const repo of repos) {
      try {
        const info = await this.buildInfo(repo);
        results.push(info);
      } catch (error) {
        console.warn(
          `⚠️  Failed to load git info for ${repo.slug}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    return results;
  }

  private async getInfo(repoId: string): Promise<RepoGitInfo | null> {
    const repo = await this.repoRepo.findById(repoId);
    if (!repo) {
      return null;
    }

    return this.buildInfo(repo);
  }

  private async buildInfo(repo: Repo): Promise<RepoGitInfo> {
    try {
      const [currentBranch, gitState, sha, clean] = await Promise.all([
        getCurrentBranch(repo.local_path),
        getGitState(repo.local_path),
        getCurrentSha(repo.local_path),
        isClean(repo.local_path),
      ]);

      const defaultBranch = repo.default_branch || (await getDefaultBranch(repo.local_path));

      return {
        repo_id: repo.repo_id,
        slug: repo.slug,
        currentBranch: currentBranch || defaultBranch || 'main',
        defaultBranch,
        gitState,
        headSha: sha || undefined,
        isClean: clean,
        path: repo.local_path,
      };
    } catch (error) {
      throw new Error(
        `Failed to read git info for ${repo.slug}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export function createGitInfoService(db: Database): GitInfoService {
  const repoRepo = new RepoRepository(db);
  return new GitInfoService(repoRepo);
}
