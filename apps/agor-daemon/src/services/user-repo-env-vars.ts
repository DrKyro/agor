/**
 * User-Repo Environment Variables Service
 *
 * Handles per-user, per-repo environment variables.
 * These override user global env vars but are overridden by worktree env vars.
 */

import { generateId } from '@agor/core';
import { getEnvVarBlockReason, isEnvVarAllowed, validateEnvVar } from '@agor/core/config';
import {
  and,
  type Database,
  decryptApiKey,
  deleteFrom,
  encryptApiKey,
  eq,
  insert,
  repos,
  select,
  update,
  userRepoEnvVars,
  users,
} from '@agor/core/db';
import type { Paginated, Params, RepoID, UserID, UUID } from '@agor/core/types';

/**
 * User-Repo Environment Variables response type
 * Returns boolean flags for env vars (not actual values)
 */
export interface UserRepoEnvVarsResponse {
  id: UUID;
  user_id: UserID;
  repo_id: RepoID;
  env_vars: Record<string, boolean>; // true = value exists
  created_at: Date;
  updated_at: Date;
}

/**
 * Create/update input
 */
interface SetUserRepoEnvVarsData {
  user_id: UserID;
  repo_id: RepoID;
  env_vars: Record<string, string | null>; // string = set, null = delete
}

/**
 * User-Repo Environment Variables Service
 */
export class UserRepoEnvVarsService {
  constructor(protected db: Database) {}

  /**
   * Find user-repo env vars (supports filtering by user_id and/or repo_id)
   */
  async find(params?: Params): Promise<Paginated<UserRepoEnvVarsResponse>> {
    const userId = params?.query?.user_id as string | undefined;
    const repoId = params?.query?.repo_id as string | undefined;

    let query = select(this.db).from(userRepoEnvVars);

    if (userId && repoId) {
      query = query.where(
        and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId))
      ) as typeof query;
    } else if (userId) {
      query = query.where(eq(userRepoEnvVars.user_id, userId)) as typeof query;
    } else if (repoId) {
      query = query.where(eq(userRepoEnvVars.repo_id, repoId)) as typeof query;
    }

    const rows = await query.all();
    const results = rows.map((row: typeof userRepoEnvVars.$inferSelect) => this.rowToResponse(row));

    return {
      total: results.length,
      limit: results.length,
      skip: 0,
      data: results,
    };
  }

  /**
   * Get user-repo env vars by ID
   */
  async get(id: UUID, _params?: Params): Promise<UserRepoEnvVarsResponse> {
    const row = await select(this.db).from(userRepoEnvVars).where(eq(userRepoEnvVars.id, id)).one();

    if (!row) {
      throw new Error(`User-repo env vars not found: ${id}`);
    }

    return this.rowToResponse(row);
  }

  /**
   * Get user-repo env vars by user and repo
   */
  async getByUserAndRepo(userId: UserID, repoId: RepoID): Promise<UserRepoEnvVarsResponse | null> {
    const row = await select(this.db)
      .from(userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .one();

    return row ? this.rowToResponse(row) : null;
  }

  /**
   * Get decrypted env vars for use in environment resolution
   */
  async getDecryptedEnvVars(userId: UserID, repoId: RepoID): Promise<Record<string, string>> {
    const row = await select(this.db)
      .from(userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .one();

    if (!row) return {};

    const encryptedVars = row.env_vars as Record<string, string>;
    const decryptedVars: Record<string, string> = {};

    for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
      try {
        decryptedVars[key] = decryptApiKey(encryptedValue);
      } catch (err) {
        console.error(`Failed to decrypt user-repo env var ${key}:`, err);
      }
    }

    return decryptedVars;
  }

  /**
   * Create or update user-repo env vars
   */
  async create(data: SetUserRepoEnvVarsData, _params?: Params): Promise<UserRepoEnvVarsResponse> {
    const { user_id, repo_id, env_vars } = data;

    // Validate user exists
    const userRow = await select(this.db).from(users).where(eq(users.user_id, user_id)).one();
    if (!userRow) {
      throw new Error(`User not found: ${user_id}`);
    }

    // Validate repo exists
    const repoRow = await select(this.db).from(repos).where(eq(repos.repo_id, repo_id)).one();
    if (!repoRow) {
      throw new Error(`Repo not found: ${repo_id}`);
    }

    // Check if record already exists
    const existing = await select(this.db)
      .from(userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, user_id), eq(userRepoEnvVars.repo_id, repo_id)))
      .one();

    if (existing) {
      // Update existing record
      return this.patch(existing.id as UUID, { env_vars });
    }

    // Validate and encrypt env vars
    const encryptedEnvVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(env_vars)) {
      if (value === null || value === undefined) continue;

      // Validate variable name
      if (!isEnvVarAllowed(key)) {
        const reason = getEnvVarBlockReason(key);
        throw new Error(`Cannot set environment variable "${key}": ${reason}`);
      }

      // Validate value
      const errors = validateEnvVar(key, value);
      if (errors.length > 0) {
        const message = errors.map((e) => e.message).join('; ');
        throw new Error(`Invalid environment variable: ${message}`);
      }

      // Encrypt
      encryptedEnvVars[key] = encryptApiKey(value);
    }

    const now = new Date();
    const id = generateId() as UUID;

    const row = await insert(this.db, userRepoEnvVars)
      .values({
        id,
        user_id,
        repo_id,
        env_vars: encryptedEnvVars,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .one();

    return this.rowToResponse(row);
  }

  /**
   * Update user-repo env vars (merges with existing)
   */
  async patch(
    id: UUID,
    data: { env_vars: Record<string, string | null> },
    _params?: Params
  ): Promise<UserRepoEnvVarsResponse> {
    const existing = await select(this.db)
      .from(userRepoEnvVars)
      .where(eq(userRepoEnvVars.id, id))
      .one();

    if (!existing) {
      throw new Error(`User-repo env vars not found: ${id}`);
    }

    const currentEnvVars = (existing.env_vars as Record<string, string>) || {};
    const updatedEnvVars = { ...currentEnvVars };

    for (const [key, value] of Object.entries(data.env_vars)) {
      if (value === null || value === undefined) {
        // Delete key
        delete updatedEnvVars[key];
        console.log(`🗑️  Cleared user-repo env var: ${key}`);
      } else {
        // Validate variable name
        if (!isEnvVarAllowed(key)) {
          const reason = getEnvVarBlockReason(key);
          throw new Error(`Cannot set environment variable "${key}": ${reason}`);
        }

        // Validate value
        const errors = validateEnvVar(key, value);
        if (errors.length > 0) {
          const message = errors.map((e) => e.message).join('; ');
          throw new Error(`Invalid environment variable: ${message}`);
        }

        // Encrypt and update
        updatedEnvVars[key] = encryptApiKey(value);
        console.log(`🔐 Encrypted user-repo env var: ${key}`);
      }
    }

    const now = new Date();

    const row = await update(this.db, userRepoEnvVars)
      .set({
        env_vars: updatedEnvVars,
        updated_at: now,
      })
      .where(eq(userRepoEnvVars.id, id))
      .returning()
      .one();

    if (!row) {
      throw new Error(`Failed to update user-repo env vars: ${id}`);
    }

    return this.rowToResponse(row);
  }

  /**
   * Delete user-repo env vars
   */
  async remove(id: UUID, _params?: Params): Promise<UserRepoEnvVarsResponse> {
    const existing = await this.get(id);

    await deleteFrom(this.db, userRepoEnvVars).where(eq(userRepoEnvVars.id, id)).run();

    return existing;
  }

  /**
   * Delete user-repo env vars by user and repo
   */
  async removeByUserAndRepo(userId: UserID, repoId: RepoID): Promise<void> {
    await deleteFrom(this.db, userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .run();
  }

  /**
   * Convert database row to response type
   */
  private rowToResponse(row: typeof userRepoEnvVars.$inferSelect): UserRepoEnvVarsResponse {
    const envVars = (row.env_vars as Record<string, string>) || {};

    return {
      id: row.id as UUID,
      user_id: row.user_id as UserID,
      repo_id: row.repo_id as RepoID,
      // Return boolean flags (not actual values)
      env_vars: Object.fromEntries(Object.keys(envVars).map((key) => [key, true])),
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}

/**
 * Create user-repo env vars service
 */
export function createUserRepoEnvVarsService(db: Database): UserRepoEnvVarsService {
  return new UserRepoEnvVarsService(db);
}
