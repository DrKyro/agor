/**
 * Quick Task Service
 *
 * Creates a worktree, session, and immediately executes the provided prompt.
 * Used by the Quick Task modal for one-click automation.
 */

import { randomBytes } from 'node:crypto';
import { type Database, WorktreeRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { getCurrentBranch, getCurrentSha, getGitState } from '@agor/core/git';
import type {
  AgenticToolName,
  AuthenticatedParams,
  PermissionMode,
  QuickTaskRequest,
  QuickTaskResponse,
  Repo,
  ServiceMethods,
  TaskID,
  UUID,
  Worktree,
} from '@agor/core/types';
import { getDefaultPermissionMode, SessionStatus } from '@agor/core/types';
import type { ReposServiceImpl } from '../declarations';
import { ensureMinimumRole } from '../utils/authorization';
import { generateTitleFromPrompt } from './title-generation';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'from',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

interface PromptService {
  create(
    data: { prompt: string; permissionMode?: PermissionMode; stream?: boolean },
    params: AuthenticatedParams & { route: { id: string } }
  ): Promise<{
    success: boolean;
    taskId?: string;
    status?: string;
    streaming?: boolean;
  }>;
}

class QuickTaskService
  implements Pick<ServiceMethods<QuickTaskResponse, QuickTaskRequest>, 'create'>
{
  private app: Application;
  private db: Database;
  private worktreeRepo: WorktreeRepository;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;
    this.worktreeRepo = new WorktreeRepository(db);
  }

  private get reposService(): ReposServiceImpl {
    return this.app.service('repos') as unknown as ReposServiceImpl;
  }

  async create(data: QuickTaskRequest, params?: AuthenticatedParams): Promise<QuickTaskResponse> {
    ensureMinimumRole(params, 'member', 'run quick task');

    if (!data.repo_id) {
      throw new Error('repo_id is required');
    }

    if (!data.agent) {
      throw new Error('agent is required');
    }

    const prompt = data.prompt?.trim();
    if (!prompt) {
      throw new Error('Task prompt is required');
    }

    const repo = (await this.reposService.get(data.repo_id)) as Repo;
    const baseBranch = data.base_branch?.trim() || repo.default_branch || 'dev';
    const agent = data.agent as AgenticToolName;
    const permissionMode: PermissionMode = data.permissionMode || getDefaultPermissionMode(agent);

    const worktreeName = await this.generateWorktreeName(repo.repo_id, prompt);

    const worktree = (await this.reposService.createWorktree(
      repo.repo_id,
      {
        name: worktreeName,
        ref: worktreeName,
        createBranch: true,
        sourceBranch: baseBranch,
        pullLatest: true,
        boardId: data.board_id,
      },
      params
    )) as Worktree;

    const titleGeneration = await generateTitleFromPrompt(prompt, {
      db: this.db,
      userId: params?.user?.user_id as UUID | undefined,
    });

    const [_gitState, currentSha, currentBranch] = await Promise.all([
      getGitState(worktree.path),
      getCurrentSha(worktree.path),
      getCurrentBranch(worktree.path),
    ]);

    const session = await this.app.service('sessions').create(
      {
        agentic_tool: agent,
        status: SessionStatus.IDLE,
        title: titleGeneration.title,
        description: prompt,
        worktree_id: worktree.worktree_id,
        permission_config: {
          mode: permissionMode,
        },
        git_state: {
          ref: currentBranch || worktree.ref || baseBranch,
          base_sha: currentSha || 'unknown',
          current_sha: currentSha || 'unknown',
        },
        genealogy: { children: [] },
        contextFiles: [],
        tasks: [],
        message_count: 0,
      },
      params
    );

    let executionStatus: string | undefined;
    let executionError: string | undefined;
    let taskId: string | undefined;

    try {
      const promptService = this.app.service('/sessions/:id/prompt') as PromptService;

      const promptParams = {
        ...(params || {}),
        route: { id: session.session_id },
      } as AuthenticatedParams & { route: { id: string } };
      if ('provider' in promptParams) {
        // Treat as internal call to avoid re-running provider hooks
        // biome-ignore lint/performance/noDelete: removing provider key for clarity
        delete (promptParams as { provider?: string }).provider;
      }

      const result = await promptService.create(
        {
          prompt,
          permissionMode,
          stream: true,
        },
        promptParams
      );

      executionStatus = result.status;
      taskId = result.taskId;
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
      console.error(
        `❌ Failed to execute quick task for session ${session.session_id.substring(0, 8)}:`,
        executionError
      );
    }

    return {
      worktree,
      session,
      taskId: taskId as TaskID | undefined,
      executionStatus,
      executionError,
      titleGeneration,
    };
  }

  private async generateWorktreeName(repoId: UUID, prompt: string): Promise<string> {
    const tokens = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token && !STOP_WORDS.has(token))
      .slice(0, 4);

    const base = sanitizeSlug(tokens.join('-') || 'quick-task');

    const makeCandidate = () => {
      const randomSuffix = randomBytes(2).toString('hex');
      return sanitizeSlug(`${base}-${randomSuffix}`);
    };

    let candidate = makeCandidate() || `quick-task-${randomBytes(2).toString('hex')}`;

    while (await this.worktreeRepo.findByRepoAndName(repoId, candidate)) {
      candidate = makeCandidate();
    }

    return candidate;
  }
}

function sanitizeSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'quick-task'
  );
}

export function createQuickTaskService(app: Application, db: Database) {
  return new QuickTaskService(app, db);
}
