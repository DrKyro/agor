/**
 * Worktrees Service
 *
 * Provides REST + WebSocket API for worktree management.
 * Uses DrizzleService adapter with WorktreeRepository.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AgorConfig,
  type AgorIDESSHSettings,
  type AgorIDETunnelSettings,
  type AgorIDEVSCodeSettings,
  createUserProcessEnvironment,
  ENVIRONMENT,
  formatValidationErrors,
  resolveWorktreeEnvironment,
  validateEnvVar,
} from '@agor/core/config';
import { type Database, encryptApiKey, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { cleanWorktree, removeWorktree } from '@agor/core/git';
import type {
  BoardID,
  CodeServerOpenResult,
  Paginated,
  QueryParams,
  Repo,
  User,
  UserID,
  UserSSHConfig,
  UUID,
  VSCodeOpenMode,
  VSCodeOpenResult,
  Worktree,
  WorktreeID,
} from '@agor/core/types';
import { getNextRunTime, validateCron } from '@agor/core/utils/cron';
import { parse as parseDotenv } from 'dotenv';
import Handlebars from 'handlebars';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Worktree service params
 */
export type WorktreeParams = QueryParams<{
  repo_id?: UUID;
  name?: string;
  ref?: string;
  deleteFromFilesystem?: boolean;
}>;

/**
 * Process tracking for environment management
 */
interface ManagedProcess {
  process: ChildProcess;
  pid: number;
  worktreeId: WorktreeID;
  startedAt: Date;
  logPath: string;
}

/**
 * Extended worktrees service with custom methods
 */
export class WorktreesService extends DrizzleService<Worktree, Partial<Worktree>, WorktreeParams> {
  private worktreeRepo: WorktreeRepository;
  private db: Database;
  private app: Application;
  private config: AgorConfig;
  private processes = new Map<WorktreeID, ManagedProcess>();
  // Cache board-objects service reference (lazy-loaded to avoid circular deps)
  private boardObjectsService?: {
    findByWorktreeId: (worktreeId: WorktreeID) => Promise<unknown>;
    create: (data: unknown) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
  };

  constructor(db: Database, app: Application, config: AgorConfig) {
    const worktreeRepo = new WorktreeRepository(db);
    super(worktreeRepo, {
      id: 'worktree_id',
      resourceType: 'Worktree',
      paginate: {
        default: 50,
        max: 100,
      },
    });

    this.worktreeRepo = worktreeRepo;
    this.db = db;
    this.app = app;
    this.config = config;
  }

  /**
   * Get the latest config (updated via config service) with fallback to initial snapshot
   */
  private getLatestConfig(): AgorConfig {
    const updatedConfig = this.app.get('agorConfig') as AgorConfig | undefined;
    if (updatedConfig) {
      this.config = updatedConfig;
      return updatedConfig;
    }
    return this.config;
  }

  /**
   * Get board-objects service (lazy-loaded to prevent circular dependencies)
   * FIX: Cache service reference instead of calling this.app.service() repeatedly
   */
  private getBoardObjectsService() {
    if (!this.boardObjectsService) {
      this.boardObjectsService = this.app.service('board-objects') as unknown as {
        findByWorktreeId: (worktreeId: WorktreeID) => Promise<unknown>;
        create: (data: unknown) => Promise<unknown>;
        remove: (id: string) => Promise<unknown>;
      };
    }
    return this.boardObjectsService;
  }

  /**
   * Attach plaintext env vars (joined as .env) for UI display
   * If env_vars_text is not in the database, try to reconstruct from encrypted env_vars
   */
  private async attachEnvVarsText(worktree: Worktree): Promise<Worktree> {
    console.log('[attachEnvVarsText] Processing worktree:', {
      id: worktree.worktree_id.substring(0, 8),
      name: worktree.name,
      hasEnvVarsText: worktree.env_vars_text !== undefined,
      envVarsTextLength: worktree.env_vars_text?.length || 0,
    });

    // If env_vars_text already exists in the database, return as-is
    if (worktree.env_vars_text !== undefined) {
      console.log('[attachEnvVarsText] env_vars_text already exists, returning as-is');
      return worktree;
    }

    // Otherwise, try to reconstruct from encrypted env_vars
    try {
      console.log('[attachEnvVarsText] Reconstructing env_vars_text from encrypted data');
      const env = await resolveWorktreeEnvironment(worktree.worktree_id, this.db);
      const envText =
        Object.entries(env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') || undefined;

      console.log('[attachEnvVarsText] Reconstructed env_vars_text:', {
        hasText: envText !== undefined,
        length: envText?.length || 0,
      });

      return {
        ...worktree,
        env_vars_text: envText,
      };
    } catch (error) {
      console.error(
        `Failed to resolve worktree env vars for ${worktree.worktree_id}:`,
        error instanceof Error ? error.message : error
      );
      return worktree;
    }
  }

  /**
   * Override patch to handle board_objects when board_id changes and schedule validation
   */
  async patch(id: WorktreeID, data: Partial<Worktree>, params?: WorktreeParams): Promise<Worktree> {
    // Get current worktree to check if board_id is changing
    const currentWorktree = await this.get(id, params);
    const oldBoardId = currentWorktree.board_id;
    const boardIdProvided = Object.hasOwn(data, 'board_id');
    const newBoardId = data.board_id;

    // Handle worktree-scoped environment variables (raw .env text)
    if (Object.hasOwn(data as Record<string, unknown>, 'env_vars_text')) {
      const rawEnvText = (data as { env_vars_text?: string }).env_vars_text ?? '';
      const parsed = rawEnvText ? parseDotenv(rawEnvText) : {};
      const nextEnvVars: Record<string, string> = {};
      const errors: string[] = [];

      for (const [key, value] of Object.entries(parsed)) {
        const stringValue = value === undefined ? '' : String(value);
        const validationErrors = validateEnvVar(key, stringValue);

        if (validationErrors.length > 0) {
          errors.push(formatValidationErrors(validationErrors));
        } else {
          nextEnvVars[key] = stringValue;
        }
      }

      if (errors.length > 0) {
        throw new Error(`Invalid environment variables:\n${errors.join('\n')}`);
      }

      const encryptedEnvVars: Record<string, string> = {};
      for (const [key, value] of Object.entries(nextEnvVars)) {
        encryptedEnvVars[key] = encryptApiKey(value);
      }

      (
        data as Partial<Worktree> & { _encrypted_env_vars?: Record<string, string> }
      )._encrypted_env_vars = encryptedEnvVars;
    }

    // ===== SCHEDULER VALIDATION =====

    // Validate cron expression if schedule_cron is being updated
    if (data.schedule_cron !== undefined && data.schedule_cron !== null) {
      try {
        validateCron(data.schedule_cron);
      } catch (error) {
        throw new Error(
          `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Compute next_run_at if cron is valid
      try {
        const nextRunAt = getNextRunTime(data.schedule_cron);
        data.schedule_next_run_at = nextRunAt;
      } catch (error) {
        console.error('Failed to compute next_run_at:', error);
        // Don't fail the patch if next_run_at computation fails
        // Scheduler will handle it on next tick
      }
    }

    // If schedule_enabled is being set to true, ensure schedule config exists
    if (data.schedule_enabled === true && !currentWorktree.schedule && !data.schedule) {
      throw new Error(
        'Cannot enable schedule without schedule configuration. Please provide schedule config in data.schedule.'
      );
    }

    // If schedule_enabled is being set to false, clear next_run_at
    if (data.schedule_enabled === false) {
      data.schedule_next_run_at = undefined;
    }

    // Call parent patch
    const updatedWorktree = (await super.patch(id, data, params)) as Worktree;

    // Handle board_objects changes if board_id changed
    if (!boardIdProvided) {
      return updatedWorktree;
    }

    if (oldBoardId !== newBoardId) {
      const boardObjectsService = this.getBoardObjectsService();

      try {
        // First, check if a board_object already exists
        const existingObject = (await boardObjectsService.findByWorktreeId(id)) as {
          object_id: string;
        } | null;

        if (existingObject) {
          // Board object exists - delete it first
          await boardObjectsService.remove(existingObject.object_id);
        }

        // Now create new board_object if board_id is set
        if (newBoardId) {
          await boardObjectsService.create({
            board_id: newBoardId,
            worktree_id: id,
            position: { x: 100, y: 100 }, // Default position
          });
        }
      } catch (error) {
        console.error(
          `❌ Failed to manage board_objects for worktree ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
        // Don't throw - allow worktree patch to succeed even if board_object management fails
      }
    }

    return await this.attachEnvVarsText(updatedWorktree as Worktree);
  }

  /**
   * Override get to include plaintext env vars
   */
  async get(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await super.get(id, params);
    return await this.attachEnvVarsText(worktree as Worktree);
  }

  /**
   * Override find to support repo_id filter
   */
  async find(params?: WorktreeParams) {
    const { repo_id } = params?.query || {};

    // If repo_id filter is provided, use repository method
    if (repo_id) {
      const worktrees = await this.worktreeRepo.findAll({ repo_id });
      const worktreesWithEnv = await Promise.all(worktrees.map((w) => this.attachEnvVarsText(w)));

      // Return with pagination if enabled
      if (this.paginate) {
        return {
          total: worktreesWithEnv.length,
          limit: params?.query?.$limit || this.paginate.default || 50,
          skip: params?.query?.$skip || 0,
          data: worktreesWithEnv,
        };
      }

      return worktreesWithEnv;
    }

    // Otherwise, use default find
    const result = await super.find(params);

    // Paginated result
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as Paginated<Worktree>).data)
    ) {
      const dataWithEnv = await Promise.all(
        (result as Paginated<Worktree>).data.map((w) => this.attachEnvVarsText(w))
      );
      return { ...(result as Paginated<Worktree>), data: dataWithEnv };
    }

    // Non-paginated array
    if (Array.isArray(result)) {
      return await Promise.all(result.map((w) => this.attachEnvVarsText(w as Worktree)));
    }

    return result;
  }

  /**
   * Override remove to support filesystem deletion
   */
  async remove(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const { deleteFromFilesystem } = params?.query || {};

    // Get worktree details before deletion
    const worktree = await this.get(id, params);

    // Remove from database FIRST for instant UI feedback
    // CASCADE will clean up related comments automatically
    const result = await super.remove(id, params);

    // Then remove from filesystem (slower operation, happens in background)
    if (deleteFromFilesystem) {
      // Note: We don't await this - it happens asynchronously after DB deletion
      const repo = (await this.app.service('repos').get(worktree.repo_id, params)) as Repo;
      console.log(`🗑️  Removing worktree from filesystem: ${worktree.path}`);
      removeWorktree(repo.local_path, worktree.path)
        .then(() => {
          console.log(`✅ Worktree removed from filesystem successfully`);
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to remove worktree from filesystem:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    return result as Worktree;
  }

  /**
   * Custom method: Archive or delete worktree with filesystem options
   *
   * This method implements the archive/delete modal functionality.
   * Supports both soft delete (archive) and hard delete, with granular filesystem control.
   *
   * @param id - Worktree ID
   * @param options - Archive/delete configuration
   * @param params - Query params
   */
  async archiveOrDelete(
    id: WorktreeID,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    },
    params?: WorktreeParams
  ): Promise<Worktree | { deleted: true; worktree_id: WorktreeID }> {
    const { metadataAction, filesystemAction } = options;
    const worktree = await this.get(id, params);
    const currentUserId = 'anonymous' as UUID; // TODO: Get from auth context

    // Stop environment if running
    if (worktree.environment_instance?.status === 'running') {
      console.log(`⚠️  Stopping environment for worktree ${worktree.name} before ${metadataAction}`);
      try {
        await this.stopEnvironment(id, params);
      } catch (error) {
        console.warn(
          `Failed to stop environment, continuing with ${metadataAction}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Perform filesystem action first (before DB changes)
    let filesRemoved = 0;
    if (filesystemAction === 'cleaned') {
      console.log(`🧹 Cleaning worktree filesystem: ${worktree.path}`);
      try {
        const result = await cleanWorktree(worktree.path);
        filesRemoved = result.filesRemoved;
        console.log(`✅ Cleaned ${filesRemoved} files from ${worktree.name}`);
      } catch (error) {
        console.error(
          `⚠️  Failed to clean worktree:`,
          error instanceof Error ? error.message : String(error)
        );
        // Continue with archive/delete even if clean fails
      }
    } else if (filesystemAction === 'deleted') {
      console.log(`🗑️  Deleting worktree from filesystem: ${worktree.path}`);
      try {
        const repo = (await this.app.service('repos').get(worktree.repo_id, params)) as Repo;
        await removeWorktree(repo.local_path, worktree.path);
        console.log(`✅ Deleted worktree from filesystem: ${worktree.name}`);
      } catch (error) {
        console.error(
          `⚠️  Failed to delete worktree:`,
          error instanceof Error ? error.message : String(error)
        );
        // Continue with archive/delete even if filesystem deletion fails
      }
    }

    // Metadata action: archive or delete
    if (metadataAction === 'archive') {
      // Archive: Soft delete worktree and cascade to sessions
      console.log(`📦 Archiving worktree: ${worktree.name} (filesystem: ${filesystemAction})`);

      // Update worktree
      const archivedWorktree = await this.patch(
        id,
        {
          archived: true,
          archived_at: new Date().toISOString(),
          archived_by: currentUserId,
          filesystem_status: filesystemAction,
          board_id: undefined, // Remove from board
          updated_at: new Date().toISOString(),
        },
        params
      );

      // Archive all sessions in this worktree
      const sessionsService = this.app.service('sessions');
      const sessionsResult = await sessionsService.find({
        ...params,
        query: { worktree_id: id, $limit: 1000 },
        paginate: false,
      });
      const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

      for (const session of sessions) {
        await sessionsService.patch(
          session.session_id,
          {
            archived: true,
            archived_reason: 'worktree_archived',
          },
          params
        );
      }

      console.log(`✅ Archived worktree ${worktree.name} and ${sessions.length} session(s)`);
      return archivedWorktree as Worktree;
    } else {
      // Delete: Hard delete (CASCADE will remove sessions, messages, tasks)
      console.log(`🗑️  Permanently deleting worktree: ${worktree.name}`);

      await this.remove(id, params);

      console.log(`✅ Permanently deleted worktree ${worktree.name}`);
      return { deleted: true, worktree_id: id };
    }
  }

  /**
   * Custom method: Unarchive a worktree
   */
  async unarchive(
    id: WorktreeID,
    options?: { boardId?: BoardID },
    params?: WorktreeParams
  ): Promise<Worktree> {
    const worktree = await this.get(id, params);

    if (!worktree.archived) {
      throw new Error(`Worktree ${worktree.name} is not archived`);
    }

    console.log(`📦 Unarchiving worktree: ${worktree.name}`);

    // Update worktree - clear archive metadata
    const unarchivedWorktree = await this.patch(
      id,
      {
        archived: false,
        archived_at: undefined,
        archived_by: undefined,
        filesystem_status: undefined,
        board_id: options?.boardId, // Optionally restore to board
        updated_at: new Date().toISOString(),
      },
      params
    );

    // Unarchive all sessions that were archived due to worktree archival
    const sessionsService = this.app.service('sessions');
    const sessionsResult = await sessionsService.find({
      ...params,
      query: {
        worktree_id: id,
        archived: true,
        archived_reason: 'worktree_archived',
        $limit: 1000,
      },
      paginate: false,
    });
    const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

    for (const session of sessions) {
      await sessionsService.patch(
        session.session_id,
        {
          archived: false,
          archived_reason: undefined,
        },
        params
      );
    }

    console.log(`✅ Unarchived worktree ${worktree.name} and ${sessions.length} session(s)`);
    return unarchivedWorktree as Worktree;
  }

  /**
   * Custom method: Find worktree by repo_id and name
   */
  async findByRepoAndName(
    repoId: UUID,
    name: string,
    _params?: WorktreeParams
  ): Promise<Worktree | null> {
    return this.worktreeRepo.findByRepoAndName(repoId, name);
  }

  /**
   * Custom method: Add worktree to board
   *
   * Phase 0: Sets board_id on worktree
   * Phase 1: Will also create board_object entry for positioning
   */
  async addToBoard(id: WorktreeID, boardId: UUID, params?: WorktreeParams): Promise<Worktree> {
    // Set worktree.board_id
    const worktree = await this.patch(
      id,
      {
        board_id: boardId,
        updated_at: new Date().toISOString(),
      },
      params
    );

    // TODO (Phase 1): Create board_object entry for positioning
    // await this.app.service('board-objects').create({
    //   board_id: boardId,
    //   object_type: 'worktree',
    //   worktree_id: id,
    //   position: { x: 100, y: 100 }, // Default position
    // });

    return worktree as Worktree;
  }

  /**
   * Custom method: Remove worktree from board
   *
   * Phase 0: Clears board_id on worktree
   * Phase 1: Will also remove board_object entry
   */
  async removeFromBoard(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    // Clear worktree.board_id
    const worktree = await this.patch(
      id,
      {
        board_id: undefined,
        updated_at: new Date().toISOString(),
      },
      params
    );

    // TODO (Phase 1): Remove board_object entry
    // const objects = await this.app.service('board-objects').find({
    //   query: { worktree_id: id },
    // });
    // for (const obj of objects.data) {
    //   await this.app.service('board-objects').remove(obj.object_id);
    // }

    return worktree as Worktree;
  }

  /**
   * Custom method: Update environment status
   */
  async updateEnvironment(
    id: WorktreeID,
    environmentUpdate: Partial<Worktree['environment_instance']>,
    params?: WorktreeParams
  ): Promise<Worktree> {
    const existing = await this.get(id, params);

    const updatedEnvironment = {
      ...existing.environment_instance,
      ...environmentUpdate,
    } as Worktree['environment_instance'];

    // Check if environment state actually changed (ignoring timestamp-only updates)
    // For health checks, we only care about status and message changes, not timestamp
    const oldState = { ...existing.environment_instance };
    const newState = { ...updatedEnvironment };

    // Remove timestamps for comparison - create new objects without timestamp
    if (oldState?.last_health_check) {
      const { timestamp, ...healthCheck } = oldState.last_health_check;
      oldState.last_health_check = healthCheck as typeof oldState.last_health_check;
    }
    if (newState?.last_health_check) {
      const { timestamp, ...healthCheck } = newState.last_health_check;
      newState.last_health_check = healthCheck as typeof newState.last_health_check;
    }

    const hasChanged = JSON.stringify(oldState) !== JSON.stringify(newState);

    // Only emit WebSocket event if state changed
    if (!hasChanged) {
      return existing;
    }

    const worktree = await this.patch(
      id,
      {
        environment_instance: updatedEnvironment,
        updated_at: new Date().toISOString(),
      },
      params
    );

    return worktree as Worktree;
  }

  /**
   * Custom method: Start environment
   */
  async startEnvironment(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);

    // Validate static start command exists
    if (!worktree.start_command) {
      throw new Error('No start command configured for this worktree');
    }

    // Check if already running
    if (worktree.environment_instance?.status === 'running') {
      throw new Error('Environment is already running');
    }

    // Set status to 'starting'
    await this.updateEnvironment(
      id,
      {
        status: 'starting',
        last_health_check: undefined,
      },
      params
    );

    try {
      // Use static start_command (initialized from template at worktree creation)
      const command = worktree.start_command;

      console.log(`🚀 Starting environment for worktree ${worktree.name}: ${command}`);

      // Create log directory
      const logPath = join(
        homedir(),
        '.agor',
        'logs',
        'worktrees',
        worktree.worktree_id,
        'environment.log'
      );
      await mkdir(dirname(logPath), { recursive: true });

      // Create clean environment for user process (filters Agor-internal vars like NODE_ENV)
      const worktreeEnv = await resolveWorktreeEnvironment(worktree.worktree_id, this.db);
      const env = await createUserProcessEnvironment(worktree.created_by, this.db, worktreeEnv);

      // Execute command and wait for it to complete
      // The command should start services and return (e.g., docker-compose up -d)
      await new Promise<void>((resolve, reject) => {
        const childProcess = spawn(command, {
          cwd: worktree.path,
          shell: true,
          stdio: 'inherit', // Show output directly in daemon logs
          env, // Pass clean environment without Agor-internal variables
        });

        childProcess.on('exit', (code) => {
          if (code === 0) {
            console.log(`✅ Start command completed successfully for ${worktree.name}`);
            resolve();
          } else {
            reject(new Error(`Start command exited with code ${code}`));
          }
        });

        childProcess.on('error', reject);
      });

      // Use static app_url (initialized from template at worktree creation)
      let access_urls: Array<{ name: string; url: string }> | undefined;
      if (worktree.app_url) {
        access_urls = [{ name: 'App', url: worktree.app_url }];
      }

      // Keep status as 'starting' - let health checks transition to 'running'
      // The first successful health check will transition from 'starting' → 'running'
      // This prevents premature "healthy" status before app is truly ready
      return await this.updateEnvironment(
        id,
        {
          // Don't change status - keep as 'starting' until first successful health check
          access_urls,
        },
        params
      );
    } catch (error) {
      // Update status to 'error'
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Run install command now (manual trigger)
   */
  async installDependencies(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);

    if (!worktree.install_command) {
      throw new Error('No install command configured for this worktree');
    }

    const command = worktree.install_command;
    console.log(`📦 Installing dependencies for worktree ${worktree.name}: ${command}`);

    // Create clean environment for user process
    const worktreeEnv = await resolveWorktreeEnvironment(worktree.worktree_id, this.db);
    const env = await createUserProcessEnvironment(worktree.created_by, this.db, worktreeEnv);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        cwd: worktree.path,
        shell: true,
        stdio: 'inherit',
        env,
      });
      child.on('exit', (code) => {
        if (code === 0) {
          console.log(`✅ Install completed for ${worktree.name}`);
          resolve();
        } else {
          reject(new Error(`Install command exited with code ${code}`));
        }
      });
      child.on('error', reject);
    });

    // No status change, just bump updated_at
    return (await this.patch(id, { updated_at: new Date().toISOString() }, params)) as Worktree;
  }

  /**
   * Custom method: Stop environment
   */
  async stopEnvironment(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);

    // Set status to 'stopping'
    await this.updateEnvironment(
      id,
      {
        status: 'stopping',
      },
      params
    );

    try {
      // Check if we have a static stop command
      if (worktree.stop_command) {
        // Use static stop_command (initialized from template at worktree creation)
        const command = worktree.stop_command;

        console.log(`🛑 Stopping environment for worktree ${worktree.name}: ${command}`);

        // Create clean environment for user process (filters Agor-internal vars like NODE_ENV)
        const worktreeEnv = await resolveWorktreeEnvironment(worktree.worktree_id, this.db);
        const env = await createUserProcessEnvironment(worktree.created_by, this.db, worktreeEnv);

        // Execute down command
        await new Promise<void>((resolve, reject) => {
          const stopProcess = spawn(command, {
            cwd: worktree.path,
            shell: true,
            stdio: 'inherit',
            env, // Pass clean environment without Agor-internal variables
          });

          stopProcess.on('exit', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Down command exited with code ${code}`));
            }
          });

          stopProcess.on('error', reject);
        });
      } else {
        // No down command - kill the managed process if we have it
        const managedProcess = this.processes.get(id);
        if (managedProcess) {
          managedProcess.process.kill('SIGTERM');
          this.processes.delete(id);
        } else if (worktree.environment_instance?.process?.pid) {
          // Try to kill by PID stored in database
          try {
            process.kill(worktree.environment_instance.process.pid, 'SIGTERM');
          } catch (error) {
            console.warn(
              `Failed to kill process ${worktree.environment_instance.process.pid}: ${error}`
            );
          }
        }
      }

      // Update status to 'stopped'
      return await this.updateEnvironment(
        id,
        {
          status: 'stopped',
          process: undefined,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unknown',
            message: 'Environment stopped',
          },
        },
        params
      );
    } catch (error) {
      // Update status to 'error'
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Restart environment
   */
  async restartEnvironment(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);

    // Stop if running
    if (worktree.environment_instance?.status === 'running') {
      await this.stopEnvironment(id, params);

      // Wait a bit for processes to clean up
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Start
    return await this.startEnvironment(id, params);
  }

  /**
   * Custom method: Nuke environment (destructive operation)
   */
  async nukeEnvironment(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);

    // Require nuke_command to be configured
    if (!worktree.nuke_command) {
      throw new Error('No nuke_command configured for this worktree');
    }

    // Set status to 'stopping' (reuse stopping state for nuke)
    await this.updateEnvironment(
      id,
      {
        status: 'stopping',
      },
      params
    );

    try {
      const command = worktree.nuke_command;

      console.log(`💣 NUKING environment for worktree ${worktree.name}: ${command}`);
      console.warn('⚠️  This is a destructive operation!');

      // Create clean environment for user process (filters Agor-internal vars like NODE_ENV)
      const worktreeEnv = await resolveWorktreeEnvironment(worktree.worktree_id, this.db);
      const env = await createUserProcessEnvironment(worktree.created_by, this.db, worktreeEnv);

      // Execute nuke command
      await new Promise<void>((resolve, reject) => {
        const nukeProcess = spawn(command, {
          cwd: worktree.path,
          shell: true,
          stdio: 'inherit',
          env, // Pass clean environment without Agor-internal variables
        });

        nukeProcess.on('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Nuke command exited with code ${code}`));
          }
        });

        nukeProcess.on('error', reject);
      });

      // Clean up any managed process references
      const managedProcess = this.processes.get(id);
      if (managedProcess) {
        this.processes.delete(id);
      }

      // Update status to 'stopped' with clear nuke message
      return await this.updateEnvironment(
        id,
        {
          status: 'stopped',
          process: undefined,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unknown',
            message: 'Environment nuked - all data and volumes destroyed',
          },
        },
        params
      );
    } catch (error) {
      // Update status to 'error'
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error during nuke',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Check health
   */
  async checkHealth(id: WorktreeID, params?: WorktreeParams): Promise<Worktree> {
    const worktree = await this.get(id, params);
    const _repo = (await this.app.service('repos').get(worktree.repo_id, params)) as Repo;

    // Only check health for 'running' or 'starting' status
    const currentStatus = worktree.environment_instance?.status;
    if (currentStatus !== 'running' && currentStatus !== 'starting') {
      return worktree;
    }

    // Check if we have a health check URL (static field, not template)
    if (!worktree.health_check_url) {
      // No health check configured - stay in 'starting' forever (manual intervention required)
      // Don't auto-transition to 'running' without health check confirmation
      const managedProcess = this.processes.get(id);
      const isProcessAlive = managedProcess?.process && !managedProcess.process.killed;

      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: isProcessAlive ? 'healthy' : 'unknown',
            message: isProcessAlive ? 'Process running' : 'No health check configured',
          },
        },
        params
      );
    }

    // Use static health_check_url (initialized from template at worktree creation)
    const healthUrl = worktree.health_check_url;

    // Track previous health status to detect changes
    const previousHealthStatus = worktree.environment_instance?.last_health_check?.status;

    try {
      // Perform HTTP health check with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ENVIRONMENT.HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(healthUrl, {
        signal: controller.signal,
        method: 'GET',
      });

      clearTimeout(timeout);

      const isHealthy = response.ok;
      const newHealthStatus = isHealthy ? 'healthy' : 'unhealthy';

      // Only log if health status changed
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${worktree.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (HTTP ${response.status})`
        );
      }

      // If health check succeeds and we're in 'starting' state, transition to 'running'
      const shouldTransitionToRunning = isHealthy && currentStatus === 'starting';

      if (shouldTransitionToRunning) {
        console.log(
          `✅ First successful health check for ${worktree.name} - transitioning to 'running'`
        );
      }

      return await this.updateEnvironment(
        id,
        {
          status: shouldTransitionToRunning ? 'running' : currentStatus,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: newHealthStatus,
            message: isHealthy
              ? `HTTP ${response.status}`
              : `HTTP ${response.status} ${response.statusText}`,
          },
        },
        params
      );
    } catch (error) {
      // Health check failed
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? 'Timeout'
            : error.message
          : 'Unknown error';

      // During 'starting' state, don't mark as unhealthy - keep retrying
      // Only mark as unhealthy when transitioning from healthy->unhealthy in 'running' state
      if (currentStatus === 'starting') {
        // Don't update health check during startup - wait for first success
        // This prevents the UI from showing unhealthy state while environment is still starting
        return worktree;
      }

      const newHealthStatus = 'unhealthy';

      // Only log if health status changed or if this is an error
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${worktree.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (${message})`
        );
      }

      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message,
          },
        },
        params
      );
    }
  }

  /**
   * Custom method: Generate VS Code deep link for this worktree
   */
  async getVSCodeTarget(id: WorktreeID, params?: WorktreeParams): Promise<VSCodeOpenResult> {
    const worktree = await this.get(id, params);
    const { ide } = this.getLatestConfig();
    const vscodeConfig = ide?.vscode;
    const currentUserId = (params as WorktreeParams & { user?: { user_id?: UserID } })?.user
      ?.user_id;
    const userSshConfig = currentUserId
      ? await this.getUserSshConfig(currentUserId).catch(() => undefined)
      : undefined;

    if (vscodeConfig?.enabled === false) {
      return {
        enabled: false,
        reason: 'VS Code integration disabled via ide.vscode.enabled=false',
      };
    }

    const modeOrder = this.getVSCodeModeOrder(vscodeConfig);
    let fallbackReason: string | undefined;

    for (const mode of modeOrder) {
      if (mode === 'tunnel') {
        const tunnelResult = this.buildTunnelVSCodeResult(vscodeConfig?.tunnel, worktree.path);
        if (tunnelResult) return tunnelResult;
        if (vscodeConfig?.tunnel?.name) {
          fallbackReason = 'VS Code Tunnel 配置无效或无法解析，已尝试自动回退';
        }
      } else if (mode === 'remote-ssh') {
        const effectiveRemote = this.mergeRemoteConfig(vscodeConfig?.remote, userSshConfig);
        const remoteResult = this.buildRemoteVSCodeResult(effectiveRemote, worktree.path);
        if (remoteResult) return remoteResult;
        if (effectiveRemote) {
          const missingFields: string[] = [];
          if (!effectiveRemote.host)
            missingFields.push('SSH host（用户设置或 ide.vscode.remote.host）');
          if (!effectiveRemote.user)
            missingFields.push('SSH user（用户设置或 ide.vscode.remote.user）');
          if (missingFields.length > 0) {
            fallbackReason = `Remote SSH configuration incomplete (${missingFields.join(', ')})`;
          }
        }
      } else if (mode === 'local') {
        const strategy = vscodeConfig?.local_open_strategy || 'cli';
        if (strategy === 'cli') {
          const cliLaunched = await this.tryLaunchVSCodeCLI(worktree.path, currentUserId);
          if (cliLaunched) {
            return {
              enabled: true,
              mode: 'local',
              launchedCli: true,
              reason: fallbackReason,
            };
          }
          // If CLI launch fails, fall through to deeplink with reason
          const reason =
            fallbackReason || '无法通过本地 CLI 启动 VS Code，已回退为 vscode://file Deep Link';
          return this.buildLocalVSCodeResult(worktree.path, reason);
        }
        // When strategy is deeplink or unspecified fallback
        return this.buildLocalVSCodeResult(worktree.path, fallbackReason);
      }
    }

    // Final fallback: local open
    return this.buildLocalVSCodeResult(worktree.path, fallbackReason);
  }

  /**
   * Try to launch local VS Code via CLI: `code -n <path>`
   * Returns true if the spawn call succeeded (best-effort, non-blocking)
   */
  private async tryLaunchVSCodeCLI(path: string, userId?: UserID): Promise<boolean> {
    try {
      const env = await createUserProcessEnvironment(userId, this.db);
      const bin = process.platform === 'win32' ? 'code.cmd' : 'code';
      const child = spawn(bin, ['-n', path], {
        env,
        stdio: 'ignore',
        detached: false,
        shell: false,
      });

      // If spawn throws synchronously it will go to catch. Here we
      // assume success if we got a ChildProcess instance.
      // We avoid waiting for exit; VS Code typically daemonizes.
      // Guard against immediate error events without failing the request.
      child.on('error', (err) => {
        console.warn(`[WorktreesService] Failed to launch VS Code CLI: ${String(err)}`);
      });
      return true;
    } catch (err) {
      console.warn('[WorktreesService] VS Code CLI not available, fallback to deeplink:', err);
      return false;
    }
  }

  /**
   * Preferred VS Code mode ordering
   */
  private getVSCodeModeOrder(config?: AgorIDEVSCodeSettings): VSCodeOpenMode[] {
    const baseOrder: VSCodeOpenMode[] = ['tunnel', 'remote-ssh', 'local'];
    const preferred = config?.preferred_mode;
    if (!preferred || preferred === 'tunnel') {
      return baseOrder;
    }
    return [preferred, ...baseOrder.filter((mode) => mode !== preferred)];
  }

  /**
   * Merge global remote config with user-level SSH config (user overrides)
   */
  private mergeRemoteConfig(
    globalRemote: AgorIDESSHSettings | undefined,
    userSsh?: UserSSHConfig
  ): AgorIDESSHSettings | undefined {
    const userOverrides =
      userSsh?.host !== undefined ||
      userSsh?.port !== undefined ||
      userSsh?.user !== undefined ||
      userSsh?.target !== undefined;

    const merged: AgorIDESSHSettings = {
      host: userSsh?.host ?? globalRemote?.host,
      port: userSsh?.port ?? globalRemote?.port,
      user: userSsh?.user ?? globalRemote?.user,
      target: userOverrides ? userSsh?.target || undefined : globalRemote?.target,
    };

    const hasValue =
      merged.host !== undefined ||
      merged.port !== undefined ||
      merged.user !== undefined ||
      merged.target !== undefined;
    return hasValue ? merged : undefined;
  }

  /**
   * Fetch user-level SSH configuration (if available)
   */
  private async getUserSshConfig(userId: UserID): Promise<UserSSHConfig | undefined> {
    try {
      const usersService = this.app.service('users') as unknown as {
        get: (id: UserID, params?: WorktreeParams) => Promise<User>;
      };
      const user = await usersService.get(userId, { provider: undefined } as WorktreeParams);
      return user?.ssh_config;
    } catch (error) {
      console.warn(`[WorktreesService] Failed to load user SSH config for ${userId}:`, error);
      return undefined;
    }
  }

  /**
   * Encode filesystem path for vscode:// URIs
   */
  private getPathSuffix(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const segments = normalized.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return '/';
    }
    return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  }

  /**
   * Build vscode://vscode-remote/tunnel URI when VS Code Tunnel configured
   */
  private buildTunnelVSCodeResult(
    tunnel: AgorIDETunnelSettings | undefined,
    path: string
  ): VSCodeOpenResult | null {
    if (!tunnel || !tunnel.name?.trim()) {
      return null;
    }

    const name = tunnel.name.trim();
    const pathSuffix = this.getPathSuffix(path);
    const uri = `vscode://vscode-remote/tunnel+${encodeURIComponent(name)}${pathSuffix}`;

    return {
      enabled: true,
      mode: 'tunnel',
      uri,
      targetLabel: tunnel.displayName || name,
    };
  }

  /**
   * Build vscode://file URI for local fallback
   */
  private buildLocalVSCodeResult(path: string, reason?: string): VSCodeOpenResult {
    const pathSuffix = this.getPathSuffix(path);
    return {
      enabled: true,
      mode: 'local',
      uri: `vscode://file${pathSuffix}`,
      reason,
    };
  }

  /**
   * Build vscode://vscode-remote URI for Remote SSH (if configured)
   */
  private buildRemoteVSCodeResult(
    remote: AgorIDESSHSettings | undefined,
    path: string
  ): VSCodeOpenResult | null {
    if (!remote || !remote.host || !remote.user) {
      return null;
    }

    const host = remote.host;
    const user = remote.user;
    const port = remote.port ?? 22;
    const pathSuffix = this.getPathSuffix(path);
    const targetLabel =
      remote.target && remote.target.trim().length > 0
        ? remote.target.trim()
        : `${user}@${host}${port !== 22 ? `:${port}` : ''}`;

    const uri = `vscode://vscode-remote/ssh-remote+${targetLabel}${pathSuffix}`;
    const sshCommand = port === 22 ? `ssh ${user}@${host}` : `ssh -p ${port} ${user}@${host}`;

    return {
      enabled: true,
      mode: 'remote-ssh',
      uri,
      sshCommand,
      targetLabel,
    };
  }

  /**
   * Custom method: Generate code-server (web) URL for this worktree
   */
  async getCodeServerTarget(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<CodeServerOpenResult> {
    const worktree = await this.get(id, params);
    const { ide } = this.getLatestConfig();
    const codeServerConfig = ide?.code_server;

    if (codeServerConfig?.enabled === false) {
      return {
        enabled: false,
        reason: 'code-server 集成已关闭 (ide.code_server.enabled=false)',
      };
    }

    const template = codeServerConfig?.url_template?.trim();
    if (!template) {
      return {
        enabled: false,
        reason: '未配置 ide.code_server.url_template',
      };
    }

    const repo = (await this.app.service('repos').get(worktree.repo_id, params)) as Repo;

    try {
      const compiled = Handlebars.compile(template, { noEscape: true });
      const url = compiled({ worktree, repo });
      if (!url || typeof url !== 'string') {
        return { enabled: false, reason: 'code-server URL 模板未生成有效的字符串' };
      }
      return { enabled: true, url };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'code-server URL 模板渲染失败 (未知错误)';
      return { enabled: false, reason };
    }
  }

  /**
   * Custom method: Get environment logs
   */
  async getLogs(
    id: WorktreeID,
    params?: WorktreeParams
  ): Promise<{
    logs: string;
    timestamp: string;
    error?: string;
    truncated?: boolean;
  }> {
    const worktree = await this.get(id, params);

    // Check if static logs command is configured
    if (!worktree.logs_command) {
      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: 'No logs command configured',
      };
    }

    try {
      // Use static logs_command (initialized from template at worktree creation)
      const command = worktree.logs_command;

      console.log(`📋 Fetching logs for worktree ${worktree.name}: ${command}`);

      // Create clean environment for user process (filters Agor-internal vars like NODE_ENV)
      const env = await createUserProcessEnvironment(worktree.created_by, this.db);

      // Execute command with timeout and output limits
      const result = await new Promise<{
        stdout: string;
        stderr: string;
        truncated: boolean;
      }>((resolve, reject) => {
        const childProcess = spawn(command, {
          cwd: worktree.path,
          shell: true,
          env, // Pass clean environment without Agor-internal variables
        });

        let stdout = '';
        let stderr = '';
        let truncated = false;

        // Set timeout
        const timeout = setTimeout(() => {
          childProcess.kill('SIGTERM');
          reject(new Error(`Logs command timed out after ${ENVIRONMENT.LOGS_TIMEOUT_MS / 1000}s`));
        }, ENVIRONMENT.LOGS_TIMEOUT_MS);

        // Capture stdout with size limit
        childProcess.stdout?.on('data', (data: Buffer) => {
          const chunk = data.toString();
          if (stdout.length + chunk.length <= ENVIRONMENT.LOGS_MAX_BYTES) {
            stdout += chunk;
          } else {
            // Truncate to max bytes
            stdout += chunk.substring(0, ENVIRONMENT.LOGS_MAX_BYTES - stdout.length);
            truncated = true;
            childProcess.kill('SIGTERM');
          }
        });

        // Capture stderr
        childProcess.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        childProcess.on('exit', (code) => {
          clearTimeout(timeout);
          if (code === 0 || stdout.length > 0) {
            resolve({ stdout, stderr, truncated });
          } else {
            reject(new Error(stderr || `Logs command exited with code ${code}`));
          }
        });

        childProcess.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      // Process output: split into lines and keep last N lines
      const allLines = result.stdout.split('\n');
      let finalLines = allLines;
      let wasTruncatedByLines = false;

      if (allLines.length > ENVIRONMENT.LOGS_MAX_LINES) {
        finalLines = allLines.slice(-ENVIRONMENT.LOGS_MAX_LINES);
        wasTruncatedByLines = true;
      }

      const logs = finalLines.join('\n');
      const truncated = result.truncated || wasTruncatedByLines;

      console.log(
        `✅ Fetched ${allLines.length} lines (${logs.length} bytes) for ${worktree.name}${truncated ? ' [truncated]' : ''}`
      );

      return {
        logs,
        timestamp: new Date().toISOString(),
        truncated,
      };
    } catch (error) {
      console.error(
        `❌ Failed to fetch logs for ${worktree.name}:`,
        error instanceof Error ? error.message : String(error)
      );

      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Service factory function
 */
export function createWorktreesService(db: Database, app: Application): WorktreesService {
  const config = app.get('agorConfig') as AgorConfig | undefined;
  return new WorktreesService(db, app, config || {});
}
