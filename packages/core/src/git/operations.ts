/**
 * Git Operations for Worktrees
 *
 * Advanced git operations like rebase, merge, branch rename for use in worktree context.
 * All operations use simple-git library (never subprocess).
 */

import { existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';

/**
 * Get git binary path
 */
function getGitBinary(): string | undefined {
  const commonPaths = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];

  for (const path of commonPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
}

/**
 * Create a configured simple-git instance
 */
function createGit(baseDir: string, env?: Record<string, string>) {
  const gitBinary = getGitBinary();

  const config = [
    'core.sshCommand=ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
  ];

  if (env?.GITHUB_TOKEN) {
    const token = env.GITHUB_TOKEN;
    const credentialHelper = `!f() { echo username=x-access-token; echo password=${token}; }; f`;
    config.push(`credential.helper=${credentialHelper}`);
  } else if (env?.GH_TOKEN) {
    const token = env.GH_TOKEN;
    const credentialHelper = `!f() { echo username=x-access-token; echo password=${token}; }; f`;
    config.push(`credential.helper=${credentialHelper}`);
  }

  return simpleGit({
    baseDir,
    binary: gitBinary,
    config,
    spawnOptions: env
      ? ({
          env: { ...process.env, ...env } as NodeJS.ProcessEnv,
          // biome-ignore lint/suspicious/noExplicitAny: simple-git types don't expose env in spawnOptions
        } as any)
      : undefined,
  });
}

export interface RebaseResult {
  success: boolean;
  error?: string;
  conflicted?: boolean;
  conflictedFiles?: string[];
}

/**
 * Rebase current branch onto target branch
 */
export async function rebaseBranch(
  worktreePath: string,
  onto: string,
  env?: Record<string, string>
): Promise<RebaseResult> {
  const git = createGit(worktreePath, env);

  try {
    // Fetch latest first
    try {
      await git.fetch(['origin']);
    } catch (e) {
      console.warn('Failed to fetch, continuing with local refs:', e);
    }

    // Perform rebase
    await git.rebase([`origin/${onto}`]);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Check for conflicts
    if (message.includes('CONFLICT') || message.includes('could not apply')) {
      // Abort the rebase to leave clean state
      try {
        await git.rebase(['--abort']);
      } catch {
        // Ignore abort errors
      }

      return {
        success: false,
        conflicted: true,
        error: 'Rebase has conflicts. Please resolve manually in terminal.',
      };
    }

    return { success: false, error: message };
  }
}

export interface MergeResult {
  success: boolean;
  error?: string;
  conflicted?: boolean;
}

/**
 * Merge a branch into current branch
 */
export async function mergeBranch(
  worktreePath: string,
  from: string,
  env?: Record<string, string>
): Promise<MergeResult> {
  const git = createGit(worktreePath, env);

  try {
    // Fetch latest first
    try {
      await git.fetch(['origin']);
    } catch (e) {
      console.warn('Failed to fetch, continuing with local refs:', e);
    }

    // Check if it's a remote branch
    const branches = await git.branch(['-r']);
    const isRemote = branches.all.includes(`origin/${from}`);

    const mergeTarget = isRemote ? `origin/${from}` : from;
    await git.merge([mergeTarget]);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('CONFLICT')) {
      // Abort merge to leave clean state
      try {
        await git.merge(['--abort']);
      } catch {
        // Ignore abort errors
      }

      return {
        success: false,
        conflicted: true,
        error: 'Merge has conflicts. Please resolve manually in terminal.',
      };
    }

    return { success: false, error: message };
  }
}

export interface RenameBranchResult {
  success: boolean;
  error?: string;
  newName?: string;
}

/**
 * Rename current branch
 */
export async function renameBranch(
  worktreePath: string,
  newName: string,
  env?: Record<string, string>
): Promise<RenameBranchResult> {
  const git = createGit(worktreePath, env);

  try {
    // Get current branch name
    const status = await git.status();
    const oldName = status.current;

    if (!oldName) {
      return { success: false, error: 'Not on a branch (detached HEAD)' };
    }

    // Validate new name
    if (!newName || newName.trim() === '') {
      return { success: false, error: 'Branch name cannot be empty' };
    }

    if (!/^[a-zA-Z0-9._/-]+$/.test(newName)) {
      return { success: false, error: 'Branch name contains invalid characters' };
    }

    // Rename the branch
    await git.branch(['-m', oldName, newName]);

    return { success: true, newName };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CreatePRResult {
  success: boolean;
  error?: string;
  prUrl?: string;
  prNumber?: number;
}

/**
 * Create a pull request using GitHub CLI
 *
 * Requires `gh` CLI to be installed and authenticated.
 */
export async function createPullRequest(
  worktreePath: string,
  options: {
    title: string;
    body?: string;
    base?: string;
  },
  env?: Record<string, string>
): Promise<CreatePRResult> {
  const { spawn } = await import('node:child_process');

  return new Promise((resolve) => {
    const args = ['pr', 'create', '--title', options.title];

    if (options.body) {
      args.push('--body', options.body);
    }

    if (options.base) {
      args.push('--base', options.base);
    }

    const ghEnv = { ...process.env, ...env };

    const child = spawn('gh', args, {
      cwd: worktreePath,
      env: ghEnv,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        // Parse PR URL from stdout
        const prUrl = stdout.trim();
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
        const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

        resolve({
          success: true,
          prUrl,
          prNumber,
        });
      } else {
        resolve({
          success: false,
          error: stderr || stdout || `gh pr create exited with code ${code}`,
        });
      }
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        error: `Failed to run gh: ${error.message}. Is GitHub CLI installed?`,
      });
    });
  });
}

/**
 * Push current branch to remote
 */
export async function pushBranch(
  worktreePath: string,
  force: boolean = false,
  env?: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const git = createGit(worktreePath, env);

  try {
    const status = await git.status();
    const branch = status.current;

    if (!branch) {
      return { success: false, error: 'Not on a branch' };
    }

    const args = ['-u', 'origin', branch];
    if (force) {
      args.unshift('--force-with-lease');
    }

    await git.push(args);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get list of local and remote branches
 */
export async function listBranches(
  worktreePath: string
): Promise<{ local: string[]; remote: string[]; current?: string }> {
  const git = createGit(worktreePath);

  try {
    const localBranches = await git.branchLocal();
    const remoteBranches = await git.branch(['-r']);

    return {
      local: localBranches.all,
      remote: remoteBranches.all
        .filter((b) => !b.includes('HEAD'))
        .map((b) => b.replace(/^origin\//, '')),
      current: localBranches.current || undefined,
    };
  } catch (error) {
    console.error('Error listing branches:', error);
    return { local: [], remote: [] };
  }
}
