import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { select } from '../db/database-wrapper';
import { decryptApiKey } from '../db/encryption';
import { UserRepoEnvVarsRepository } from '../db/repositories/user-repo-env-vars';
import { repos, users, worktrees } from '../db/schema';
import type { RepoID, UserID, WorktreeID } from '../types';

/**
 * Environment variables used internally by Agor daemon that should NOT be passed
 * to user processes (worktree environments, terminals, etc.)
 *
 * These variables control Agor daemon behavior and would interfere with
 * user applications if inherited (e.g., NODE_ENV='production' breaks dev servers).
 */
export const AGOR_INTERNAL_ENV_VARS = new Set([
  // Node.js environment control
  'NODE_ENV', // Agor daemon runs in production, but user apps should control this

  // Agor-specific variables
  'AGOR_USE_EXECUTOR', // Controls executor process spawning
  'AGOR_MASTER_SECRET', // Encryption key (also in blocklist, defense in depth)

  // Agor daemon ports
  'PORT', // Daemon port (user apps should use their own ports)
  'UI_PORT', // UI port (internal to Agor)
  'VITE_DAEMON_URL', // UI-to-daemon connection
  'VITE_DAEMON_PORT', // UI-to-daemon port

  // Deployment detection (used for security checks)
  'CODESPACES', // GitHub Codespaces detection
  'RAILWAY_ENVIRONMENT', // Railway deployment detection
  'RENDER', // Render deployment detection
]);

/**
 * Resolve user environment variables (decrypted from database, no system env vars)
 * Includes both env_vars and api_keys from user data
 */
export async function resolveUserEnvironment(
  userId: UserID,
  db: Database
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();

    if (row) {
      const data = row.data as {
        env_vars?: Record<string, string>;
        api_keys?: Record<string, string>;
      };

      // Decrypt and merge user environment variables (e.g., GITHUB_TOKEN)
      // Only override if the decrypted value is non-empty
      const encryptedVars = data.env_vars;
      if (encryptedVars) {
        for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
          try {
            const decryptedValue = decryptApiKey(encryptedValue);
            if (decryptedValue && decryptedValue.trim() !== '') {
              env[key] = decryptedValue;
            }
          } catch (err) {
            console.error(`Failed to decrypt env var ${key} for user ${userId}:`, err);
          }
        }
      }

      // Decrypt and merge user API keys (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY)
      // Only override if the decrypted value is non-empty
      const encryptedApiKeys = data.api_keys;
      if (encryptedApiKeys) {
        for (const [key, encryptedValue] of Object.entries(encryptedApiKeys)) {
          try {
            const decryptedValue = decryptApiKey(encryptedValue);
            if (decryptedValue && decryptedValue.trim() !== '') {
              env[key] = decryptedValue;
            }
          } catch (err) {
            console.error(`Failed to decrypt API key ${key} for user ${userId}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to resolve environment for user ${userId}:`, err);
  }

  return env;
}

/**
 * Resolve worktree-scoped environment variables (decrypted from database)
 */
export async function resolveWorktreeEnvironment(
  worktreeId: WorktreeID,
  db: Database
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const row = await select(db).from(worktrees).where(eq(worktrees.worktree_id, worktreeId)).one();

    if (row?.data && typeof row.data === 'object') {
      const data = row.data as {
        env_vars?: Record<string, string>;
      };

      const encryptedVars = data.env_vars;
      if (encryptedVars) {
        for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
          try {
            const decryptedValue = decryptApiKey(encryptedValue);
            if (decryptedValue && decryptedValue.trim() !== '') {
              env[key] = decryptedValue;
            }
          } catch (err) {
            console.error(`Failed to decrypt worktree env var ${key} for ${worktreeId}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to resolve environment for worktree ${worktreeId}:`, err);
  }

  return env;
}

/**
 * Synchronous version - returns system env only
 */
export function resolveSystemEnvironment(): Record<string, string> {
  return { ...process.env } as Record<string, string>;
}

/**
 * Create a clean environment for user processes (worktrees, terminals, etc.)
 *
 * This function:
 * 1. Starts with system environment (process.env)
 * 2. Filters out Agor-internal variables (NODE_ENV, AGOR_*, etc.)
 * 3. Resolves and merges user-specific encrypted environment variables
 * 4. Optionally merges additional environment variables
 *
 * @param userId - User ID to resolve environment for (optional)
 * @param db - Database instance (required if userId provided)
 * @param additionalEnv - Additional env vars to merge (optional, highest priority)
 * @returns Clean environment object ready for child process spawning
 *
 * @example
 * // For worktree environment startup (with user)
 * const env = await createUserProcessEnvironment(worktree.created_by, db);
 * spawn(command, { cwd, shell: true, env });
 *
 * @example
 * // For worktree environment with custom NODE_ENV
 * const env = await createUserProcessEnvironment(worktree.created_by, db, {
 *   NODE_ENV: 'development',
 * });
 *
 * @example
 * // For daemon-spawned processes without user context
 * const env = await createUserProcessEnvironment();
 * spawn(command, { env });
 */
export async function createUserProcessEnvironment(
  userId?: UserID,
  db?: Database,
  additionalEnv?: Record<string, string>
): Promise<Record<string, string>> {
  // Start with system environment
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  // Filter out Agor-internal variables
  for (const internalVar of AGOR_INTERNAL_ENV_VARS) {
    delete env[internalVar];
  }

  // Resolve and merge user environment variables (if userId provided)
  // Only override if values are non-empty
  if (userId && db) {
    const userEnv = await resolveUserEnvironment(userId, db);
    for (const [key, value] of Object.entries(userEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
      }
    }
  }

  // Merge additional environment variables (highest priority)
  // Only override if values are non-empty
  if (additionalEnv) {
    for (const [key, value] of Object.entries(additionalEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Resolve repo-level environment variables (decrypted from database)
 *
 * These are default env vars set by the repo maintainer, available to all users.
 * Lowest priority after system env vars.
 */
export async function resolveRepoEnvironment(
  repoId: RepoID,
  db: Database
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const row = await select(db).from(repos).where(eq(repos.repo_id, repoId)).one();

    if (row?.data && typeof row.data === 'object') {
      const data = row.data as {
        env_vars?: Record<string, string>;
      };

      const encryptedVars = data.env_vars;
      if (encryptedVars) {
        for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
          try {
            const decryptedValue = decryptApiKey(encryptedValue);
            if (decryptedValue && decryptedValue.trim() !== '') {
              env[key] = decryptedValue;
            }
          } catch (err) {
            console.error(`Failed to decrypt repo env var ${key} for ${repoId}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to resolve environment for repo ${repoId}:`, err);
  }

  return env;
}

/**
 * Resolve user-repo environment variables (decrypted from database)
 *
 * These are per-user, per-repo env vars that override user global env vars.
 */
export async function resolveUserRepoEnvironment(
  userId: UserID,
  repoId: RepoID,
  db: Database
): Promise<Record<string, string>> {
  try {
    const repository = new UserRepoEnvVarsRepository(db);
    return await repository.getDecryptedEnvVars(userId, repoId);
  } catch (err) {
    console.error(
      `Failed to resolve user-repo environment for user ${userId}, repo ${repoId}:`,
      err
    );
    return {};
  }
}

/**
 * Get the repo ID for a worktree
 */
export async function getRepoIdForWorktree(
  worktreeId: WorktreeID,
  db: Database
): Promise<RepoID | null> {
  try {
    const row = await select(db).from(worktrees).where(eq(worktrees.worktree_id, worktreeId)).one();
    return row?.repo_id as RepoID | null;
  } catch (err) {
    console.error(`Failed to get repo ID for worktree ${worktreeId}:`, err);
    return null;
  }
}

/**
 * Create a complete worktree process environment with full hierarchy resolution
 *
 * This function builds the environment using the complete priority hierarchy:
 * 1. System environment (process.env) - lowest priority
 * 2. Repo default env vars (repo.data.env_vars)
 * 3. User global env vars (user.data.env_vars + api_keys)
 * 4. User-repo env vars (user_repo_env_vars table)
 * 5. Worktree env vars (worktree.data.env_vars)
 * 6. Additional env vars parameter - highest priority
 *
 * Filters out Agor-internal variables that shouldn't be passed to user processes.
 *
 * @param userId - User ID to resolve environment for (optional)
 * @param db - Database instance (required if userId provided)
 * @param worktreeId - Worktree ID to resolve environment for (optional)
 * @param additionalEnv - Additional env vars to merge (optional, highest priority)
 * @returns Complete environment object ready for child process spawning
 *
 * @example
 * // For worktree environment startup with full hierarchy
 * const env = await createWorktreeProcessEnvironment(worktree.created_by, db, worktree.worktree_id);
 * spawn(command, { cwd, shell: true, env });
 */
export async function createWorktreeProcessEnvironment(
  userId?: UserID,
  db?: Database,
  worktreeId?: WorktreeID,
  additionalEnv?: Record<string, string>
): Promise<Record<string, string>> {
  // Start with system environment
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  // Filter out Agor-internal variables
  for (const internalVar of AGOR_INTERNAL_ENV_VARS) {
    delete env[internalVar];
  }

  // If we have a worktree, resolve the full hierarchy
  if (worktreeId && db) {
    // Get repo ID for the worktree
    const repoId = await getRepoIdForWorktree(worktreeId, db);

    if (repoId) {
      // 1. Repo default env vars (lowest priority after system)
      const repoEnv = await resolveRepoEnvironment(repoId, db);
      for (const [key, value] of Object.entries(repoEnv)) {
        if (value && value.trim() !== '') {
          env[key] = value;
        }
      }

      // 2. User global env vars
      if (userId) {
        const userEnv = await resolveUserEnvironment(userId, db);
        for (const [key, value] of Object.entries(userEnv)) {
          if (value && value.trim() !== '') {
            env[key] = value;
          }
        }

        // 3. User-repo env vars
        const userRepoEnv = await resolveUserRepoEnvironment(userId, repoId, db);
        for (const [key, value] of Object.entries(userRepoEnv)) {
          if (value && value.trim() !== '') {
            env[key] = value;
          }
        }
      }
    } else if (userId && db) {
      // No repo context, just use user global env vars
      const userEnv = await resolveUserEnvironment(userId, db);
      for (const [key, value] of Object.entries(userEnv)) {
        if (value && value.trim() !== '') {
          env[key] = value;
        }
      }
    }

    // 4. Worktree env vars (high priority)
    const worktreeEnv = await resolveWorktreeEnvironment(worktreeId, db);
    for (const [key, value] of Object.entries(worktreeEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
      }
    }
  } else if (userId && db) {
    // No worktree context, just use user global env vars
    const userEnv = await resolveUserEnvironment(userId, db);
    for (const [key, value] of Object.entries(userEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
      }
    }
  }

  // 5. Additional environment variables (highest priority)
  if (additionalEnv) {
    for (const [key, value] of Object.entries(additionalEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Get environment variables by layer for display purposes
 *
 * Returns a breakdown of where each env var comes from, useful for
 * UI display and debugging.
 */
export async function getEnvironmentByLayer(
  userId: UserID | undefined,
  repoId: RepoID | undefined,
  worktreeId: WorktreeID | undefined,
  db: Database
): Promise<{
  repo: Record<string, string>;
  userGlobal: Record<string, string>;
  userRepo: Record<string, string>;
  worktree: Record<string, string>;
  merged: Record<string, string>;
}> {
  const result = {
    repo: {} as Record<string, string>,
    userGlobal: {} as Record<string, string>,
    userRepo: {} as Record<string, string>,
    worktree: {} as Record<string, string>,
    merged: {} as Record<string, string>,
  };

  // Repo env vars
  if (repoId) {
    result.repo = await resolveRepoEnvironment(repoId, db);
  }

  // User global env vars
  if (userId) {
    result.userGlobal = await resolveUserEnvironment(userId, db);
  }

  // User-repo env vars
  if (userId && repoId) {
    result.userRepo = await resolveUserRepoEnvironment(userId, repoId, db);
  }

  // Worktree env vars
  if (worktreeId) {
    result.worktree = await resolveWorktreeEnvironment(worktreeId, db);
  }

  // Merged (in priority order)
  result.merged = {
    ...result.repo,
    ...result.userGlobal,
    ...result.userRepo,
    ...result.worktree,
  };

  return result;
}
