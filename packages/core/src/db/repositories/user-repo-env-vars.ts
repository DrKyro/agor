/**
 * User-Repo Environment Variables Repository
 *
 * Type-safe CRUD operations for per-user, per-repo environment variables.
 * Stores encrypted environment variables that users can set for specific repositories.
 */

import type { RepoID, UserID, UUID } from '../../types';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { repos, userRepoEnvVars, users, type UserRepoEnvVarsRow } from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

/**
 * User-Repo Environment Variables type (API-safe, with boolean flags for values)
 */
export interface UserRepoEnvVars {
  id: UUID;
  user_id: UserID;
  repo_id: RepoID;
  env_vars: Record<string, boolean>; // true = value exists, false = deleted
  created_at: Date;
  updated_at: Date;
}

/**
 * User-Repo Environment Variables repository implementation
 */
export class UserRepoEnvVarsRepository {
  constructor(private db: Database) {}

  /**
   * Convert database row to UserRepoEnvVars type
   * Note: Converts encrypted env vars to boolean flags for API exposure
   */
  private rowToUserRepoEnvVars(row: UserRepoEnvVarsRow): UserRepoEnvVars {
    return {
      id: row.id as UUID,
      user_id: row.user_id as UserID,
      repo_id: row.repo_id as RepoID,
      // Convert encrypted values to boolean flags
      env_vars: Object.fromEntries(
        Object.entries(row.env_vars || {}).map(([k, v]) => [k, !!v])
      ) as Record<string, boolean>,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  /**
   * Create a new user-repo env vars record
   */
  async create(
    userId: UserID,
    repoId: RepoID,
    envVars: Record<string, string>
  ): Promise<UserRepoEnvVars> {
    // Validate user exists
    const userRow = await select(this.db).from(users).where(eq(users.user_id, userId)).one();
    if (!userRow) {
      throw new EntityNotFoundError('User', userId);
    }

    // Validate repo exists
    const repoRow = await select(this.db).from(repos).where(eq(repos.repo_id, repoId)).one();
    if (!repoRow) {
      throw new EntityNotFoundError('Repo', repoId);
    }

    // Check if record already exists
    const existing = await select(this.db)
      .from(userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .one();

    if (existing) {
      throw new RepositoryError(
        `User-repo env vars record already exists for user ${userId} and repo ${repoId}. Use update instead.`
      );
    }

    // Encrypt all env var values
    const encryptedEnvVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(envVars)) {
      if (value && value.trim() !== '') {
        encryptedEnvVars[key] = encryptApiKey(value);
      }
    }

    const now = new Date();
    const id = generateId();

    await insert(this.db, userRepoEnvVars)
      .values({
        id,
        user_id: userId,
        repo_id: repoId,
        env_vars: encryptedEnvVars,
        created_at: now,
        updated_at: now,
      })
      .run();

    const row = await select(this.db).from(userRepoEnvVars).where(eq(userRepoEnvVars.id, id)).one();

    if (!row) {
      throw new RepositoryError('Failed to retrieve created user-repo env vars');
    }

    return this.rowToUserRepoEnvVars(row as UserRepoEnvVarsRow);
  }

  /**
   * Get user-repo env vars by user and repo
   */
  async get(userId: UserID, repoId: RepoID): Promise<UserRepoEnvVars | null> {
    const row = await select(this.db)
      .from(userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .one();

    if (!row) {
      return null;
    }

    return this.rowToUserRepoEnvVars(row as UserRepoEnvVarsRow);
  }

  /**
   * Get raw (encrypted) env vars for use in environment resolution
   */
  async getRawEnvVars(userId: UserID, repoId: RepoID): Promise<Record<string, string> | null> {
    const row = await select(this.db)
      .from(userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .one();

    if (!row) {
      return null;
    }

    return row.env_vars as Record<string, string>;
  }

  /**
   * Get decrypted env vars for use in environment resolution
   */
  async getDecryptedEnvVars(userId: UserID, repoId: RepoID): Promise<Record<string, string>> {
    const encryptedVars = await this.getRawEnvVars(userId, repoId);
    if (!encryptedVars) {
      return {};
    }

    const decryptedVars: Record<string, string> = {};
    for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
      try {
        const decryptedValue = decryptApiKey(encryptedValue);
        if (decryptedValue && decryptedValue.trim() !== '') {
          decryptedVars[key] = decryptedValue;
        }
      } catch (err) {
        console.error(`Failed to decrypt user-repo env var ${key} for user ${userId}:`, err);
      }
    }

    return decryptedVars;
  }

  /**
   * Update user-repo env vars (merges with existing)
   */
  async update(
    userId: UserID,
    repoId: RepoID,
    envVars: Record<string, string>
  ): Promise<UserRepoEnvVars> {
    const existing = await this.getRawEnvVars(userId, repoId);

    if (!existing) {
      // Create if doesn't exist
      return this.create(userId, repoId, envVars);
    }

    // Merge new env vars with existing (encrypted)
    const mergedEnvVars = { ...existing };
    for (const [key, value] of Object.entries(envVars)) {
      if (value && value.trim() !== '') {
        mergedEnvVars[key] = encryptApiKey(value);
      } else {
        // Empty value = delete the key
        delete mergedEnvVars[key];
      }
    }

    const now = new Date();

    await update(this.db, userRepoEnvVars)
      .set({
        env_vars: mergedEnvVars,
        updated_at: now,
      })
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .run();

    const row = await select(this.db)
      .from(userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .one();

    if (!row) {
      throw new RepositoryError('Failed to retrieve updated user-repo env vars');
    }

    return this.rowToUserRepoEnvVars(row as UserRepoEnvVarsRow);
  }

  /**
   * Set a single env var
   */
  async setEnvVar(userId: UserID, repoId: RepoID, key: string, value: string): Promise<void> {
    await this.update(userId, repoId, { [key]: value });
  }

  /**
   * Delete a single env var
   */
  async deleteEnvVar(userId: UserID, repoId: RepoID, key: string): Promise<void> {
    const existing = await this.getRawEnvVars(userId, repoId);
    if (!existing || !(key in existing)) {
      return; // Nothing to delete
    }

    const updatedEnvVars = { ...existing };
    delete updatedEnvVars[key];

    const now = new Date();

    await update(this.db, userRepoEnvVars)
      .set({
        env_vars: updatedEnvVars,
        updated_at: now,
      })
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .run();
  }

  /**
   * Delete all user-repo env vars for a user and repo
   */
  async delete(userId: UserID, repoId: RepoID): Promise<void> {
    await deleteFrom(this.db, userRepoEnvVars)
      .where(and(eq(userRepoEnvVars.user_id, userId), eq(userRepoEnvVars.repo_id, repoId)))
      .run();
  }

  /**
   * List all user-repo env vars for a user
   */
  async listByUser(userId: UserID): Promise<UserRepoEnvVars[]> {
    const rows = await select(this.db)
      .from(userRepoEnvVars)
      .where(eq(userRepoEnvVars.user_id, userId))
      .all();

    return rows.map((row: UserRepoEnvVarsRow) => this.rowToUserRepoEnvVars(row));
  }

  /**
   * List all user-repo env vars for a repo
   */
  async listByRepo(repoId: RepoID): Promise<UserRepoEnvVars[]> {
    const rows = await select(this.db)
      .from(userRepoEnvVars)
      .where(eq(userRepoEnvVars.repo_id, repoId))
      .all();

    return rows.map((row: UserRepoEnvVarsRow) => this.rowToUserRepoEnvVars(row));
  }
}
