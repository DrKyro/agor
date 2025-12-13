/**
 * Repo Repository
 *
 * Type-safe CRUD operations for git repositories with short ID support.
 */

import type { Repo, UUID } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { getEnvVarBlockReason, isEnvVarAllowed, validateEnvVar } from '../../config';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { encryptApiKey } from '../encryption';
import { type RepoInsert, type RepoRow, repos } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';
import { deepMerge } from './merge-utils';

/**
 * Repo repository implementation
 */
export class RepoRepository implements BaseRepository<Repo, Partial<Repo>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to Repo type
   */
  private rowToRepo(row: RepoRow): Repo {
    return {
      repo_id: row.repo_id as UUID,
      slug: row.slug,
      repo_type: (row.repo_type as Repo['repo_type']) ?? 'remote',
      unix_group: row.unix_group ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      last_updated: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(row.created_at).toISOString(),
      ...row.data,
    };
  }

  /**
   * Convert Repo to database insert format
   */
  private repoToInsert(repo: Partial<Repo>): RepoInsert {
    const now = Date.now();
    const repoId = repo.repo_id ?? generateId();

    // Preserve existing nested data fields while normalizing core properties
    const existingData =
      (repo as { data?: Record<string, unknown> }).data &&
      typeof (repo as { data?: unknown }).data === 'object'
        ? ((repo as { data: Record<string, unknown> }).data as Record<string, unknown>)
        : {};

    if (!repo.slug) {
      throw new RepositoryError('slug is required when creating a repo');
    }

    if (!repo.repo_type) {
      throw new RepositoryError('repo_type is required when creating a repo');
    }

    if (!repo.local_path) {
      throw new RepositoryError('Repo must have a local_path');
    }

    if (repo.repo_type === 'remote' && !repo.remote_url) {
      throw new RepositoryError('Remote repos must have a remote_url');
    }

    // Repo env vars: either provided pre-encrypted (from update flow) or encrypt plaintext
    const preEncryptedEnvVars = (repo as { _encrypted_env_vars?: Record<string, string> })
      ._encrypted_env_vars;
    let envVars: Record<string, string> | undefined;

    if (preEncryptedEnvVars) {
      envVars = preEncryptedEnvVars;
    } else {
      envVars = {
        ...((existingData as { env_vars?: Record<string, string> }).env_vars || {}),
      };

      const incomingEnvVars = (repo as { env_vars?: Record<string, string | null> }).env_vars;
      if (incomingEnvVars) {
        for (const [key, value] of Object.entries(incomingEnvVars)) {
          if (!isEnvVarAllowed(key)) {
            const reason = getEnvVarBlockReason(key);
            throw new RepositoryError(`Cannot set environment variable "${key}": ${reason}`);
          }

          if (value === null || value === undefined) {
            delete envVars[key];
          } else {
            const errors = validateEnvVar(key, value);
            if (errors.length > 0) {
              const message = errors.map((e) => e.message).join('; ');
              throw new RepositoryError(`Invalid environment variable: ${message}`);
            }

            try {
              envVars[key] = encryptApiKey(value);
            } catch (err) {
              throw new RepositoryError(
                `Failed to encrypt environment variable ${key}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
      }
    }

    const mergedData = {
      ...existingData,
      name: repo.name ?? (existingData as { name?: string }).name ?? repo.slug,
      remote_url: repo.remote_url ?? (existingData as { remote_url?: string }).remote_url,
      local_path: repo.local_path ?? (existingData as { local_path?: string }).local_path,
      default_branch:
        repo.default_branch ?? (existingData as { default_branch?: string }).default_branch,
      environment_config:
        repo.environment_config ??
        (existingData as { environment_config?: Repo['environment_config'] }).environment_config,
      // Repo-level env configuration fields (preserve if present)
      env_vars: envVars && Object.keys(envVars).length > 0 ? envVars : undefined,
      env_file_name:
        (repo as { env_file_name?: string }).env_file_name ??
        (existingData as { env_file_name?: string }).env_file_name ??
        '.env',
      auto_write_env_file_on_create:
        (repo as { auto_write_env_file_on_create?: boolean }).auto_write_env_file_on_create ??
        (existingData as { auto_write_env_file_on_create?: boolean }).auto_write_env_file_on_create,
    };

    return {
      repo_id: repoId,
      slug: repo.slug,
      created_at: new Date(repo.created_at ?? now),
      updated_at: repo.last_updated ? new Date(repo.last_updated) : new Date(now),
      repo_type: repo.repo_type,
      unix_group: repo.unix_group ?? null,
      data: mergedData,
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db).from(repos).where(like(repos.repo_id, pattern)).all();

    if (results.length === 0) {
      throw new EntityNotFoundError('Repo', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Repo',
        id,
        results.map((r: { repo_id: string }) => formatShortId(r.repo_id as UUID))
      );
    }

    return results[0].repo_id as UUID;
  }

  /**
   * Create a new repo
   */
  async create(data: Partial<Repo>): Promise<Repo> {
    try {
      const insertData = this.repoToInsert(data);
      await insert(this.db, repos).values(insertData).run();

      const row = await select(this.db)
        .from(repos)
        .where(eq(repos.repo_id, insertData.repo_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created repo');
      }

      return this.rowToRepo(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find repo by ID (supports short ID)
   */
  async findById(id: string): Promise<Repo | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db).from(repos).where(eq(repos.repo_id, fullId)).one();

      return row ? this.rowToRepo(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find repo by slug (exact match)
   */
  async findBySlug(slug: string): Promise<Repo | null> {
    try {
      const row = await select(this.db).from(repos).where(eq(repos.slug, slug)).one();

      return row ? this.rowToRepo(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find repo by slug: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all repos
   */
  async findAll(): Promise<Repo[]> {
    try {
      const rows = await select(this.db).from(repos).all();
      return rows.map((row: RepoRow) => this.rowToRepo(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all repos: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find managed repos only (DEPRECATED: all repos are managed now)
   *
   * Kept for backwards compatibility - returns all repos.
   */
  async findManaged(): Promise<Repo[]> {
    return this.findAll();
  }

  /**
   * Update repo by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., permission_config updates).
   */
  async update(id: string, updates: Partial<Repo>): Promise<Repo> {
    try {
      const fullId = await this.resolveId(id);

      // Use transaction to make read-merge-write atomic
      return await this.db.transaction(async (tx) => {
        // STEP 1: Read current repo (within transaction)
        // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
        const currentRow = await select(tx as any)
          .from(repos)
          .where(eq(repos.repo_id, fullId))
          .one();

        if (!currentRow) {
          throw new EntityNotFoundError('Repo', id);
        }

        const current = this.rowToRepo(currentRow);
        const currentEncryptedEnvVars =
          (currentRow.data &&
            (currentRow.data as { env_vars?: Record<string, string> }).env_vars) ||
          {};

        // Extract env var updates (support both top-level and nested data.env_vars)
        const incomingEnvVars =
          (updates as { env_vars?: Record<string, string | null> }).env_vars ||
          ((updates as { data?: { env_vars?: Record<string, string | null> } }).data
            ? (updates as { data: { env_vars?: Record<string, string | null> } }).data.env_vars
            : undefined);

        // Avoid deepMerge swallowing env vars incorrectly by stripping them before merge
        const updatesWithoutEnvVars = { ...(updates as Record<string, unknown>) };
        delete (updatesWithoutEnvVars as { env_vars?: unknown }).env_vars;
        if (
          (updatesWithoutEnvVars as { data?: Record<string, unknown> }).data &&
          typeof (updatesWithoutEnvVars as { data?: unknown }).data === 'object'
        ) {
          const data = { ...(updatesWithoutEnvVars as { data: Record<string, unknown> }).data };
          delete (data as { env_vars?: unknown }).env_vars;
          (updatesWithoutEnvVars as { data?: Record<string, unknown> }).data = data;
        }

        // STEP 2: Deep merge updates into current repo (in memory)
        // Preserves nested objects like permission_config when doing partial updates
        const merged = deepMerge(current, updatesWithoutEnvVars);

        // Apply env var updates with encryption
        const nextEncryptedEnvVars = { ...currentEncryptedEnvVars };
        if (incomingEnvVars) {
          for (const [key, value] of Object.entries(incomingEnvVars)) {
            if (!isEnvVarAllowed(key)) {
              const reason = getEnvVarBlockReason(key);
              throw new RepositoryError(`Cannot set environment variable "${key}": ${reason}`);
            }

            if (value === null || value === undefined) {
              delete nextEncryptedEnvVars[key];
            } else {
              const errors = validateEnvVar(key, value);
              if (errors.length > 0) {
                const message = errors.map((e) => e.message).join('; ');
                throw new RepositoryError(`Invalid environment variable: ${message}`);
              }

              try {
                nextEncryptedEnvVars[key] = encryptApiKey(value);
              } catch (err) {
                throw new RepositoryError(
                  `Failed to encrypt environment variable ${key}: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
          }
        }

        // Attach pre-encrypted env vars for repoToInsert to persist
        (merged as { _encrypted_env_vars?: Record<string, string> })._encrypted_env_vars =
          nextEncryptedEnvVars;
        (merged as { env_vars?: Record<string, string> }).env_vars = nextEncryptedEnvVars;

        const insertData = this.repoToInsert(merged);

        // STEP 3: Write merged repo (within same transaction)
        // biome-ignore lint/suspicious/noExplicitAny: Transaction context requires type assertion for database wrapper functions
        await update(tx as any, repos)
          .set({
            slug: insertData.slug,
            updated_at: new Date(),
            repo_type: insertData.repo_type,
            unix_group: merged.unix_group ?? null,
            data: insertData.data,
          })
          .where(eq(repos.repo_id, fullId))
          .run();

        // Return merged repo with encrypted env vars (avoids leaking plaintext)
        const updatedRow = {
          ...currentRow,
          slug: insertData.slug,
          repo_type: insertData.repo_type,
          data: insertData.data,
          updated_at: new Date(),
        } as RepoRow;

        return this.rowToRepo(updatedRow);
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete repo by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, repos).where(eq(repos.repo_id, fullId)).run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Repo', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete repo: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * @deprecated Worktrees are now first-class entities in their own table.
   * Use WorktreeRepository instead.
   */
  async addWorktree(): Promise<never> {
    throw new Error('addWorktree is deprecated. Use WorktreeRepository.create() instead.');
  }

  /**
   * @deprecated Worktrees are now first-class entities in their own table.
   * Use WorktreeRepository instead.
   */
  async removeWorktree(): Promise<never> {
    throw new Error('removeWorktree is deprecated. Use WorktreeRepository.delete() instead.');
  }

  /**
   * Count total repos
   */
  async count(): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` }).from(repos).one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count repos: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
