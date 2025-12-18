/**
 * MCP HTTP Routes
 *
 * Exposes MCP server via HTTP endpoint for Claude Agent SDK.
 * Uses session tokens for authentication.
 */

import { loadConfig } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import type { AgenticToolName, Board, Repo, Session, Worktree } from '@agor/core/types';
import { normalizeOptionalHttpUrl } from '@agor/core/utils/url';

import type { Request, Response } from 'express';

import type { ReposServiceImpl, SessionsServiceImpl } from '../declarations.js';
import { validateSessionToken } from './tokens.js';

const WORKTREE_NAME_PATTERN = /^[a-z0-9-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

type MCPAuthMode = 'sessionToken' | 'jwt' | 'globalToken';

type MCPRequestContext = {
  userId: string;
  sessionId?: string;
  authMode: MCPAuthMode;
};

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function redactToken(value: string, visiblePrefix: number = 6): string {
  if (!value) return '';
  if (value.length <= visiblePrefix) return `${value}…`;
  return `${value.slice(0, visiblePrefix)}…`;
}

function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  return coerceString(match[1]);
}

let cachedConfig:
  | {
      loadedAt: number;
      globalToken?: string;
      globalUserId?: string;
    }
  | undefined;

async function getMcpAuthConfig(): Promise<{ globalToken?: string; globalUserId?: string }> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.loadedAt < 30_000) {
    return { globalToken: cachedConfig.globalToken, globalUserId: cachedConfig.globalUserId };
  }

  const config = await loadConfig();
  const globalToken =
    coerceString(config.daemon?.mcpGlobalToken) ?? coerceString(process.env.AGOR_MCP_GLOBAL_TOKEN);
  const globalUserId = coerceString(config.daemon?.mcpGlobalUserId);

  cachedConfig = { loadedAt: now, globalToken, globalUserId };
  return { globalToken, globalUserId };
}

async function resolveMcpContext(
  app: Application,
  req: Request
): Promise<MCPRequestContext | null> {
  // 1) Session-scoped token (backwards compatible)
  const sessionToken = coerceString(req.query.sessionToken);
  if (sessionToken) {
    const context = await validateSessionToken(app, sessionToken);
    if (!context) return null;
    return { userId: context.userId, sessionId: context.sessionId, authMode: 'sessionToken' };
  }

  // 2) Authorization: Bearer <...> (JWT or global MCP token)
  const bearer = parseBearerToken(req.header('authorization'));

  // 3) X-Agor-MCP-Token: <...> (global MCP token)
  const headerToken = coerceString(req.header('x-agor-mcp-token'));

  // 4) Query token (global MCP token or JWT), useful for clients that can't set headers
  const queryToken = coerceString(req.query.mcpToken);

  const token = bearer ?? headerToken ?? queryToken;
  if (!token) return null;

  // Try JWT first (global user auth)
  try {
    const authResult = (await app.service('authentication').create(
      { strategy: 'jwt', accessToken: token },
      // provider='rest' ensures the auth service treats this as an external credential check.
      { provider: 'rest' } as unknown as Record<string, unknown>
    )) as { user?: { user_id?: string } };

    const userId = coerceString(authResult?.user?.user_id);
    if (userId) {
      return { userId, authMode: 'jwt' };
    }
  } catch {
    // Not a valid JWT (or auth service disabled) - fall through to global token check
  }

  // Global MCP token (static secret)
  const { globalToken, globalUserId } = await getMcpAuthConfig();
  if (globalToken && token === globalToken) {
    return { userId: globalUserId ?? 'anonymous', authMode: 'globalToken' };
  }

  return null;
}

function slugifyWorktreeName(input: string): string {
  const lower = input.toLowerCase();
  const slug = lower
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug;
}

/**
 * Setup MCP routes on FeathersJS app
 */
export function setupMCPRoutes(app: Application): void {
  // MCP endpoint: POST /mcp
  // Expects: sessionToken query param
  // Returns: MCP JSON-RPC response

  // Use Express middleware directly
  const handler = async (req: Request, res: Response) => {
    try {
      const method = coerceString(req.body?.method) ?? 'unknown';
      const requestId = req.body?.id;

      // Avoid logging credentials (sessionToken / Authorization headers).
      console.log(`🔌 Incoming MCP request: ${req.method} /mcp (${method})`);

      // Resolve auth context (session token OR global bearer/JWT token)
      const context = await resolveMcpContext(app, req);
      if (!context) {
        const authHeader = req.header('authorization');
        const xToken = req.header('x-agor-mcp-token');
        console.warn(
          `⚠️  MCP auth failed (hasSessionToken=${Boolean(req.query.sessionToken)}, hasAuthorization=${Boolean(
            authHeader
          )}, hasXToken=${Boolean(xToken)}, hasMcpToken=${Boolean(req.query.mcpToken)}, authorizationPrefix=${authHeader ? redactToken(authHeader, 14) : 'n/a'})`
        );
        return res.status(401).json({
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32001,
            message:
              'Authentication required: provide either ?sessionToken=... or Authorization: Bearer <jwt|global-token> (or X-Agor-MCP-Token / ?mcpToken=...)',
          },
        });
      }

      console.log(
        `🔌 MCP authenticated (mode=${context.authMode}, user=${context.userId.substring(0, 8)}${
          context.sessionId ? `, session=${context.sessionId.substring(0, 8)}` : ''
        })`
      );

      // Handle the MCP request
      // The SDK expects JSON-RPC format in request body
      const mcpRequest = req.body;

      // Process request based on method
      let mcpResponse: unknown;

      if (mcpRequest.method === 'initialize') {
        // MCP initialization handshake
        console.log(
          `🔌 MCP initialize request (${context.sessionId ? `session ${context.sessionId.substring(0, 8)}` : 'global'})`
        );
        mcpResponse = {
          protocolVersion: mcpRequest.params.protocolVersion || '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'agor',
            version: '0.1.0',
          },
        };
        console.log(
          `✅ MCP initialized successfully (protocol: ${(mcpResponse as { protocolVersion: string }).protocolVersion})`
        );
      } else if (mcpRequest.method === 'tools/list') {
        // Return list of available tools
        console.log(
          `🔧 MCP tools/list request (${context.sessionId ? `session ${context.sessionId.substring(0, 8)}` : 'global'})`
        );
        mcpResponse = {
          tools: [
            // Session tools
            {
              name: 'agor_sessions_list',
              description: 'List all sessions accessible to the current user',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    description: 'Maximum number of sessions to return (default: 50)',
                  },
                  status: {
                    type: 'string',
                    enum: ['idle', 'running', 'completed', 'failed'],
                    description: 'Filter by session status',
                  },
                  boardId: {
                    type: 'string',
                    description: 'Filter sessions by board ID (UUIDv7 or short ID)',
                  },
                  worktreeId: {
                    type: 'string',
                    description: 'Filter sessions by worktree ID',
                  },
                },
              },
            },
            {
              name: 'agor_sessions_get',
              description:
                'Get detailed information about a specific session, including genealogy and current state',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID (UUIDv7 or short ID like 01a1b2c3)',
                  },
                },
                required: ['sessionId'],
              },
            },
            {
              name: 'agor_sessions_get_current',
              description:
                'Get information about the current session (only available when authenticated with a session-scoped token). Useful for introspection.',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'agor_sessions_spawn',
              description:
                'Spawn a child session (subsession) for delegating work to another agent. Requires a parent session: defaults to the current session when using a session token, or pass parentSessionId in global mode.',
              inputSchema: {
                type: 'object',
                properties: {
                  parentSessionId: {
                    type: 'string',
                    description:
                      'Parent session ID to spawn from (required when using global MCP authentication; optional when using a session-scoped token).',
                  },
                  prompt: {
                    type: 'string',
                    description: 'The prompt/task for the subsession agent to execute',
                  },
                  title: {
                    type: 'string',
                    description:
                      'Optional title for the session (defaults to first 100 chars of prompt)',
                  },
                  agenticTool: {
                    type: 'string',
                    enum: ['claude-code', 'codex', 'gemini', 'opencode'],
                    description:
                      'Which agent to use for the subsession (defaults to same as parent)',
                  },
                  permissionMode: {
                    type: 'string',
                    enum: [
                      'default',
                      'acceptEdits',
                      'bypassPermissions',
                      'plan',
                      'ask',
                      'auto',
                      'on-failure',
                      'allow-all',
                    ],
                    description: 'Permission mode override (defaults based on config preset)',
                  },
                  modelConfig: {
                    type: 'object',
                    properties: {
                      mode: {
                        type: 'string',
                        enum: ['alias', 'exact'],
                      },
                      model: {
                        type: 'string',
                      },
                      thinkingMode: {
                        type: 'string',
                        enum: ['auto', 'manual', 'off'],
                      },
                      manualThinkingTokens: {
                        type: 'number',
                      },
                    },
                    description: 'Model configuration override',
                  },
                  codexSandboxMode: {
                    type: 'string',
                    enum: ['read-only', 'workspace-write', 'danger-full-access'],
                    description: 'Codex sandbox mode (codex only)',
                  },
                  codexApprovalPolicy: {
                    type: 'string',
                    enum: ['untrusted', 'on-request', 'on-failure', 'never'],
                    description: 'Codex approval policy (codex only)',
                  },
                  codexNetworkAccess: {
                    type: 'boolean',
                    description: 'Codex network access (codex only)',
                  },
                  mcpServerIds: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    description: 'MCP server IDs to attach to spawned session',
                  },
                  enableCallback: {
                    type: 'boolean',
                    description: 'Enable callback to parent on completion (default: true)',
                  },
                  includeLastMessage: {
                    type: 'boolean',
                    description: "Include child's final result in callback (default: true)",
                  },
                  includeOriginalPrompt: {
                    type: 'boolean',
                    description: 'Include original spawn prompt in callback (default: false)',
                  },
                  extraInstructions: {
                    type: 'string',
                    description: 'Extra instructions appended to spawn prompt',
                  },
                  taskId: {
                    type: 'string',
                    description: 'Optional task ID to link the spawned session to',
                  },
                },
                required: ['prompt'],
              },
            },
            {
              name: 'agor_sessions_prompt',
              description:
                'Prompt an existing session to continue work. Supports three modes: continue (append to conversation), fork (branch at decision point), or subsession (delegate to child agent).',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID to prompt (UUIDv7 or short ID)',
                  },
                  prompt: {
                    type: 'string',
                    description: 'The prompt/task to execute',
                  },
                  mode: {
                    type: 'string',
                    enum: ['continue', 'fork', 'subsession'],
                    description:
                      'How to route the work: continue (add to existing session), fork (create sibling session), subsession (create child session)',
                  },
                  agenticTool: {
                    type: 'string',
                    enum: ['claude-code', 'codex', 'gemini'],
                    description:
                      'Override parent agent (for fork/subsession only, defaults to parent agent)',
                  },
                  permissionMode: {
                    type: 'string',
                    enum: [
                      'default',
                      'acceptEdits',
                      'bypassPermissions',
                      'plan',
                      'ask',
                      'auto',
                      'on-failure',
                      'allow-all',
                    ],
                    description:
                      'Override permission mode (for fork/subsession only, defaults to parent mode)',
                  },
                  title: {
                    type: 'string',
                    description: 'Session title (for fork/subsession only)',
                  },
                  taskId: {
                    type: 'string',
                    description: 'Fork/spawn point task ID (optional)',
                  },
                },
                required: ['sessionId', 'prompt', 'mode'],
              },
            },
            {
              name: 'agor_sessions_create',
              description:
                'Create a new session in an existing worktree. Useful for starting fresh work in the same codebase without forking or spawning.',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID where the session will run (required)',
                  },
                  agenticTool: {
                    type: 'string',
                    enum: ['claude-code', 'codex', 'gemini'],
                    description: 'Which agent to use for this session (required)',
                  },
                  title: {
                    type: 'string',
                    description: 'Session title (optional)',
                  },
                  description: {
                    type: 'string',
                    description: 'Session description (optional)',
                  },
                  permissionMode: {
                    type: 'string',
                    enum: [
                      'default',
                      'acceptEdits',
                      'bypassPermissions',
                      'plan',
                      'ask',
                      'auto',
                      'on-failure',
                      'allow-all',
                    ],
                    description:
                      'Permission mode for tool approval (optional, defaults based on agenticTool)',
                  },
                  contextFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Context file paths to load (optional)',
                  },
                  mcpServerIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'MCP server IDs to attach (optional)',
                  },
                  initialPrompt: {
                    type: 'string',
                    description:
                      'Initial prompt to execute immediately after creating the session (optional)',
                  },
                },
                required: ['worktreeId', 'agenticTool'],
              },
            },
            {
              name: 'agor_sessions_update',
              description:
                'Update session metadata (title, description, status, permissions). Useful for agents to self-document their work or adjust permissions.',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID to update (UUIDv7 or short ID)',
                  },
                  title: {
                    type: 'string',
                    description: 'New session title (optional)',
                  },
                  description: {
                    type: 'string',
                    description: 'New session description (optional)',
                  },
                  status: {
                    type: 'string',
                    enum: ['idle', 'running', 'completed', 'failed'],
                    description: 'New session status (optional)',
                  },
                  permissionMode: {
                    type: 'string',
                    enum: [
                      'default',
                      'acceptEdits',
                      'bypassPermissions',
                      'plan',
                      'ask',
                      'auto',
                      'on-failure',
                      'allow-all',
                    ],
                    description: 'New permission mode (optional)',
                  },
                },
                required: ['sessionId'],
              },
            },

            // Worktree tools
            {
              name: 'agor_worktrees_get',
              description:
                'Get detailed information about a worktree, including path, branch, and git state',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },
            // Repo tools (global project management)
            {
              name: 'agor_repos_list',
              description: 'List repositories (projects) registered in Agor',
              inputSchema: {
                type: 'object',
                properties: {
                  slug: {
                    type: 'string',
                    description: 'Filter by repo slug (exact match)',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_repos_get',
              description: 'Get repository details by repoId',
              inputSchema: {
                type: 'object',
                properties: {
                  repoId: {
                    type: 'string',
                    description: 'Repository ID (UUIDv7)',
                  },
                },
                required: ['repoId'],
              },
            },
            {
              name: 'agor_repos_clone',
              description: 'Clone a remote repository into Agor and register it as a project',
              inputSchema: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    description: 'Git remote URL (https or ssh)',
                  },
                  slug: {
                    type: 'string',
                    description:
                      'Optional repo slug override (lowercase letters, numbers, hyphens)',
                  },
                  name: {
                    type: 'string',
                    description: 'Optional human-readable name',
                  },
                },
                required: ['url'],
              },
            },
            {
              name: 'agor_repos_add_local',
              description: 'Register an existing local git repository as an Agor project',
              inputSchema: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description: 'Absolute filesystem path to a local git repository',
                  },
                  slug: {
                    type: 'string',
                    description: 'Optional repo slug override',
                  },
                },
                required: ['path'],
              },
            },
            {
              name: 'agor_worktrees_list',
              description: 'List all worktrees in a repository',
              inputSchema: {
                type: 'object',
                properties: {
                  repoId: {
                    type: 'string',
                    description: 'Repository ID to filter by',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_worktrees_create',
              description:
                'Create a worktree (and optional branch) for a repository, with optional board/issue/PR links',
              inputSchema: {
                type: 'object',
                properties: {
                  repoId: {
                    type: 'string',
                    description: 'Repository ID where the worktree will be created',
                  },
                  worktreeName: {
                    type: 'string',
                    description:
                      'Slug name for the worktree directory (lowercase letters, numbers, hyphens)',
                  },
                  ref: {
                    type: 'string',
                    description:
                      'Git ref to checkout. Defaults to the worktree name when creating a new branch.',
                  },
                  refType: {
                    type: 'string',
                    enum: ['branch', 'tag'],
                    description: 'Type of ref (branch or tag). Defaults to branch.',
                  },
                  createBranch: {
                    type: 'boolean',
                    description:
                      'Whether to create a new branch. Defaults to true unless ref is a commit SHA.',
                  },
                  sourceBranch: {
                    type: 'string',
                    description:
                      'Base branch when creating a new branch (defaults to the repo default branch).',
                  },
                  pullLatest: {
                    type: 'boolean',
                    description:
                      'Pull latest from remote before creating the branch (defaults to true for new branches).',
                  },
                  boardId: {
                    type: 'string',
                    description:
                      "Board ID to immediately place the worktree on (positions to default coordinates). If not specified, defaults to the current session's board.",
                  },
                  issueUrl: {
                    type: 'string',
                    description: 'Issue URL to associate with the worktree.',
                  },
                  pullRequestUrl: {
                    type: 'string',
                    description: 'Pull request URL to associate with the worktree.',
                  },
                },
                required: ['repoId', 'worktreeName'],
              },
            },
            {
              name: 'agor_worktrees_update',
              description:
                'Update metadata for an existing worktree (issue/PR URLs, notes, board placement, custom context)',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description:
                      'Worktree ID to update. Optional when calling from a session with a bound worktree.',
                  },
                  issueUrl: {
                    type: ['string', 'null'],
                    description:
                      'Issue URL to associate. Pass null to clear. Must be http(s) when provided.',
                  },
                  pullRequestUrl: {
                    type: ['string', 'null'],
                    description:
                      'Pull request URL to associate. Pass null to clear. Must be http(s) when provided.',
                  },
                  notes: {
                    type: ['string', 'null'],
                    description:
                      'Freeform notes about the worktree. Pass null or empty string to clear.',
                  },
                  boardId: {
                    type: ['string', 'null'],
                    description:
                      'Board ID to place this worktree on. Pass null to remove from any board.',
                  },
                  customContext: {
                    type: ['object', 'null'],
                    additionalProperties: true,
                    description:
                      'Custom context object for templates and automations. Pass null to clear existing context.',
                  },
                },
              },
            },

            // Environment tools
            {
              name: 'agor_environment_start',
              description:
                'Start the environment for a worktree by running its configured start command',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },
            {
              name: 'agor_environment_stop',
              description:
                'Stop the environment for a worktree by running its configured stop command',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },
            {
              name: 'agor_environment_health',
              description:
                'Check the health status of a worktree environment by running its configured health command',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },
            {
              name: 'agor_environment_logs',
              description:
                'Fetch recent logs from a worktree environment (non-streaming, last ~100 lines)',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },
            {
              name: 'agor_environment_open_app',
              description: 'Open the application URL for a worktree environment in the browser',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },
            {
              name: 'agor_environment_nuke',
              description:
                'Nuke the environment for a worktree (destructive operation - typically removes volumes and all data)',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },

            // Board tools
            {
              name: 'agor_boards_get',
              description: 'Get information about a board, including zones and layout',
              inputSchema: {
                type: 'object',
                properties: {
                  boardId: {
                    type: 'string',
                    description: 'Board ID (UUIDv7 or short ID)',
                  },
                },
                required: ['boardId'],
              },
            },
            {
              name: 'agor_boards_list',
              description: 'List all boards accessible to the current user',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_boards_create',
              description: 'Create a new board (canvas)',
              inputSchema: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Board name',
                  },
                  slug: {
                    type: 'string',
                    description: 'Optional board slug (URL-friendly identifier)',
                  },
                  description: {
                    type: 'string',
                    description: 'Optional board description',
                  },
                },
                required: ['name'],
              },
            },
            // Board object tools (worktree cards on boards)
            {
              name: 'agor_board_objects_list',
              description: 'List positioned worktree cards on boards (board_objects)',
              inputSchema: {
                type: 'object',
                properties: {
                  boardId: {
                    type: 'string',
                    description: 'Filter by board ID',
                  },
                  worktreeId: {
                    type: 'string',
                    description: 'Filter by worktree ID',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 100)',
                  },
                  skip: {
                    type: 'number',
                    description: 'Number of results to skip (default: 0)',
                  },
                },
              },
            },
            {
              name: 'agor_board_objects_create',
              description: 'Place a worktree card onto a board at a position',
              inputSchema: {
                type: 'object',
                properties: {
                  boardId: {
                    type: 'string',
                    description: 'Board ID',
                  },
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID to place on the board',
                  },
                  position: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                    },
                    required: ['x', 'y'],
                  },
                  zoneId: {
                    type: ['string', 'null'],
                    description: 'Optional zone ID to pin to (null clears)',
                  },
                },
                required: ['boardId', 'worktreeId', 'position'],
              },
            },
            {
              name: 'agor_board_objects_patch',
              description: 'Update a board object (position and/or zone pinning)',
              inputSchema: {
                type: 'object',
                properties: {
                  objectId: {
                    type: 'string',
                    description: 'Board object ID',
                  },
                  position: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                    },
                  },
                  zoneId: {
                    type: ['string', 'null'],
                    description: 'Zone ID (null clears)',
                  },
                },
                required: ['objectId'],
              },
            },

            // Task tools
            {
              name: 'agor_tasks_list',
              description: 'List tasks (user prompts) in a session',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID to get tasks from',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_tasks_get',
              description: 'Get detailed information about a specific task',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task ID (UUIDv7 or short ID)',
                  },
                },
                required: ['taskId'],
              },
            },
            // Message tools (chat history)
            {
              name: 'agor_messages_list',
              description: 'List conversation messages by sessionId or taskId',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID to fetch messages from',
                  },
                  taskId: {
                    type: 'string',
                    description: 'Task ID to fetch messages from',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 100)',
                  },
                  skip: {
                    type: 'number',
                    description: 'Number of results to skip (default: 0)',
                  },
                },
              },
            },
            {
              name: 'agor_messages_get',
              description: 'Get a single message by messageId',
              inputSchema: {
                type: 'object',
                properties: {
                  messageId: {
                    type: 'string',
                    description: 'Message ID (UUIDv7)',
                  },
                },
                required: ['messageId'],
              },
            },
            {
              name: 'agor_sessions_transcript',
              description:
                'Convenience: get a simplified transcript (role/type/content) for a session',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 200)',
                  },
                  skip: {
                    type: 'number',
                    description: 'Number of results to skip (default: 0)',
                  },
                },
                required: ['sessionId'],
              },
            },
            // Context/file helpers (read-only)
            {
              name: 'agor_context_list',
              description: 'List markdown context files under a worktree (context/)',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID',
                  },
                },
                required: ['worktreeId'],
              },
            },
            {
              name: 'agor_context_get',
              description: 'Read a markdown context file under a worktree (context/...)',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID',
                  },
                  path: {
                    type: 'string',
                    description: 'Relative path like context/concepts/core.md',
                  },
                },
                required: ['worktreeId', 'path'],
              },
            },
            {
              name: 'agor_file_get',
              description: 'Read a file from a worktree (read-only, with preview if text)',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID',
                  },
                  path: {
                    type: 'string',
                    description: 'Relative file path like README.md or src/index.ts',
                  },
                },
                required: ['worktreeId', 'path'],
              },
            },
            // Quick task orchestration (global workflow)
            {
              name: 'agor_quick_task_create',
              description:
                'One-shot: resolve/create repo → create worktree (+branch) → create session → run prompt. Returns worktreeId/sessionId/taskId for follow-up.',
              inputSchema: {
                type: 'object',
                properties: {
                  // Repo resolution (choose one)
                  repoId: { type: 'string', description: 'Existing repo ID' },
                  repoSlug: { type: 'string', description: 'Existing repo slug' },
                  repoUrl: { type: 'string', description: 'Clone remote repo URL (creates repo)' },
                  localPath: {
                    type: 'string',
                    description: 'Register local repo path (creates repo)',
                  },
                  repoSlugOverride: {
                    type: 'string',
                    description: 'Slug when creating repo via repoUrl/localPath',
                  },
                  repoName: {
                    type: 'string',
                    description: 'Name when creating repo via repoUrl',
                  },

                  // Worktree
                  worktreeName: {
                    type: 'string',
                    description:
                      'Worktree slug name (lowercase letters, numbers, hyphens). If omitted, derived from title/prompt.',
                  },
                  baseBranch: {
                    type: 'string',
                    description:
                      'Base branch when creating a new branch (defaults to repo default branch)',
                  },
                  pullLatest: {
                    type: 'boolean',
                    description: 'Pull latest before creating branch (default: true)',
                  },
                  issueUrl: { type: 'string', description: 'Optional issue URL' },
                  pullRequestUrl: { type: 'string', description: 'Optional PR URL' },

                  // Board placement (optional)
                  boardId: { type: 'string', description: 'Board ID to place worktree on' },
                  boardSlug: { type: 'string', description: 'Board slug to place worktree on' },
                  createBoard: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      slug: { type: 'string' },
                      description: { type: 'string' },
                    },
                    description: 'If provided, creates a new board and uses it for placement',
                  },
                  position: {
                    type: 'object',
                    properties: { x: { type: 'number' }, y: { type: 'number' } },
                    description: 'Optional board position for the new worktree card',
                  },

                  // Session/task
                  agenticTool: {
                    type: 'string',
                    enum: ['claude-code', 'codex', 'gemini', 'opencode'],
                    description: 'Which internal agent executor to use (default: claude-code)',
                  },
                  permissionMode: {
                    type: 'string',
                    enum: [
                      'default',
                      'acceptEdits',
                      'bypassPermissions',
                      'plan',
                      'ask',
                      'auto',
                      'on-failure',
                      'allow-all',
                    ],
                    description: 'Permission mode override',
                  },
                  title: {
                    type: 'string',
                    description: 'Session title (defaults to derived title)',
                  },
                  description: { type: 'string', description: 'Session description (optional)' },
                  prompt: { type: 'string', description: 'Initial task prompt to run' },
                  contextFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional context files to load into the session',
                  },
                  mcpServerIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional MCP server IDs to attach to the created session',
                  },

                  // Environment
                  startEnvironment: {
                    type: 'boolean',
                    description: 'Start worktree environment after creation (default: false)',
                  },
                },
                required: ['prompt'],
              },
            },

            // User tools
            {
              name: 'agor_users_list',
              description: 'List all users in the system',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_users_get',
              description: 'Get detailed information about a specific user',
              inputSchema: {
                type: 'object',
                properties: {
                  userId: {
                    type: 'string',
                    description: 'User ID (UUIDv7)',
                  },
                },
                required: ['userId'],
              },
            },
            {
              name: 'agor_users_get_current',
              description:
                'Get information about the current authenticated user (the user associated with this MCP session)',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'agor_users_update_current',
              description:
                'Update the current user profile (name, emoji, avatar, preferences). Can only update own profile.',
              inputSchema: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Display name',
                  },
                  emoji: {
                    type: 'string',
                    description: 'User emoji (single emoji character)',
                  },
                  avatar: {
                    type: 'string',
                    description: 'Avatar URL',
                  },
                  preferences: {
                    type: 'object',
                    description: 'User preferences (JSON object)',
                  },
                },
              },
            },
            {
              name: 'agor_user_create',
              description:
                'Create a new user account. Requires email and password. Optionally set name, emoji, avatar, and role.',
              inputSchema: {
                type: 'object',
                properties: {
                  email: {
                    type: 'string',
                    description: 'User email address (must be unique)',
                  },
                  password: {
                    type: 'string',
                    description: 'User password (will be hashed)',
                  },
                  name: {
                    type: 'string',
                    description: 'Display name (optional)',
                  },
                  emoji: {
                    type: 'string',
                    description:
                      'User emoji for visual identity (optional, single emoji character)',
                  },
                  avatar: {
                    type: 'string',
                    description: 'Avatar URL (optional)',
                  },
                  role: {
                    type: 'string',
                    enum: ['owner', 'admin', 'member', 'viewer'],
                    description:
                      'User role (optional, defaults to "member"). Roles: owner=full system access, admin=manage most resources, member=standard user, viewer=read-only',
                  },
                },
                required: ['email', 'password'],
              },
            },

            // Analytics tools
            {
              name: 'agor_analytics_leaderboard',
              description:
                'Get usage analytics leaderboard showing token and cost breakdown. Supports dynamic grouping by user, worktree, or repo (or combinations). Use groupBy parameter to control aggregation level.',
              inputSchema: {
                type: 'object',
                properties: {
                  userId: {
                    type: 'string',
                    description: 'Filter by user ID (optional)',
                  },
                  worktreeId: {
                    type: 'string',
                    description: 'Filter by worktree ID (optional)',
                  },
                  repoId: {
                    type: 'string',
                    description: 'Filter by repository ID (optional)',
                  },
                  startDate: {
                    type: 'string',
                    description: 'Filter by start date (ISO 8601 format, optional)',
                  },
                  endDate: {
                    type: 'string',
                    description: 'Filter by end date (ISO 8601 format, optional)',
                  },
                  groupBy: {
                    type: 'string',
                    enum: [
                      'user',
                      'worktree',
                      'repo',
                      'user,worktree',
                      'user,repo',
                      'worktree,repo',
                      'user,worktree,repo',
                    ],
                    description:
                      'Group by dimension(s). Examples: "user" for per-user totals, "worktree" for per-worktree, "user,worktree" for user+worktree breakdown (default: user,worktree,repo)',
                  },
                  sortBy: {
                    type: 'string',
                    enum: ['tokens', 'cost'],
                    description: 'Sort by tokens or cost (default: cost)',
                  },
                  sortOrder: {
                    type: 'string',
                    enum: ['asc', 'desc'],
                    description: 'Sort order ascending or descending (default: desc)',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                  offset: {
                    type: 'number',
                    description: 'Number of results to skip for pagination (default: 0)',
                  },
                },
              },
            },
          ],
        };
      } else if (mcpRequest.method === 'notifications/initialized') {
        // Client notifying us that initialization is complete
        console.log(
          `📬 MCP notifications/initialized (${context.sessionId ? `session ${context.sessionId.substring(0, 8)}` : 'global'})`
        );
        // No response needed for notifications
        return res.status(204).send();
      } else if (mcpRequest.method === 'tools/call') {
        // Handle tool call
        const { name, arguments: args } = mcpRequest.params || {};
        console.log(`🔧 MCP tool call: ${name}`);
        console.log(`   Arguments:`, JSON.stringify(args || {}).substring(0, 200));
        const baseServiceParams = {
          user: context.userId ? { user_id: context.userId } : undefined,
          authenticated: true,
        };

        // Session tools
        if (name === 'agor_sessions_list') {
          // Build query
          const query: Record<string, unknown> = {};
          if (args?.limit) query.$limit = args.limit;
          if (args?.status) query.status = args.status;
          if (args?.boardId) query.board_id = args.boardId;
          if (args?.worktreeId) query.worktree_id = args.worktreeId;

          const sessions = await app.service('sessions').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(sessions, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_get') {
          if (!args?.sessionId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: sessionId is required',
              },
            });
          }

          const session = await app.service('sessions').get(args.sessionId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_get_current') {
          if (!context.sessionId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'agor_sessions_get_current requires a session-scoped token. Use agor_sessions_get with an explicit sessionId when using global MCP auth.',
              },
            });
          }

          // Get current session using token context
          const session = await app.service('sessions').get(context.sessionId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_spawn') {
          // Spawn a child session (subsession)
          if (!args?.prompt) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: prompt is required',
              },
            });
          }

          const parentSessionId = coerceString(args?.parentSessionId) ?? context.sessionId;
          if (!parentSessionId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: parentSessionId is required when using global MCP authentication',
              },
            });
          }

          const spawnData: Partial<import('@agor/core/types').SpawnConfig> = {
            prompt: args.prompt,
            title: args.title,
            agent: args.agenticTool as AgenticToolName | undefined,
            permissionMode: args.permissionMode,
            modelConfig: args.modelConfig,
            codexSandboxMode: args.codexSandboxMode,
            codexApprovalPolicy: args.codexApprovalPolicy,
            codexNetworkAccess: args.codexNetworkAccess,
            mcpServerIds: args.mcpServerIds,
            enableCallback: args.enableCallback,
            includeLastMessage: args.includeLastMessage,
            includeOriginalPrompt: args.includeOriginalPrompt,
            extraInstructions: args.extraInstructions,
            task_id: args.taskId,
          };

          // Call spawn method on sessions service
          console.log(`🌱 MCP spawning subsession from ${parentSessionId.substring(0, 8)}`);
          const childSession = await (
            app.service('sessions') as unknown as SessionsServiceImpl
          ).spawn(parentSessionId, spawnData, baseServiceParams);
          console.log(`✅ Subsession created: ${childSession.session_id.substring(0, 8)}`);

          // Trigger child execution (spawns start fresh by default - see query-builder.ts)
          console.log(
            `🚀 Triggering prompt execution for subsession ${childSession.session_id.substring(0, 8)}`
          );

          // Call the prompt endpoint as a FeathersJS service (not HTTP fetch)
          // This uses the same event emission context and ensures WebSocket broadcasting
          const promptResponse = await app.service('/sessions/:id/prompt').create(
            {
              prompt: args.prompt,
              permissionMode: childSession.permission_config?.mode || 'acceptEdits',
              stream: true,
            },
            {
              ...baseServiceParams,
              route: { id: childSession.session_id },
            }
          );

          console.log(`✅ Prompt execution started: task ${promptResponse.taskId.substring(0, 8)}`);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session: childSession,
                    taskId: promptResponse.taskId,
                    status: promptResponse.status,
                    note: 'Subsession created and prompt execution started in background.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (name === 'agor_sessions_prompt') {
          // Prompt an existing session with routing mode
          if (!args?.sessionId || !args?.prompt || !args?.mode) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: sessionId, prompt, and mode are required',
              },
            });
          }

          const mode = args.mode as 'continue' | 'fork' | 'subsession';

          if (mode === 'continue') {
            // Mode: continue - add to existing conversation
            console.log(
              `➡️  MCP continuing session ${args.sessionId.substring(0, 8)} with new prompt`
            );

            const promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.prompt,
                permissionMode: args.permissionMode,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: args.sessionId },
              }
            );

            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      taskId: promptResponse.taskId,
                      status: promptResponse.status,
                      note: 'Prompt added to existing session and execution started.',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } else if (mode === 'fork') {
            // Mode: fork - create sibling session
            console.log(`🔀 MCP forking session ${args.sessionId.substring(0, 8)}`);

            const forkData: {
              prompt: string;
              task_id?: string;
            } = {
              prompt: args.prompt,
            };

            if (args.taskId) {
              forkData.task_id = args.taskId;
            }

            // Call fork method on sessions service
            const forkedSession = await (
              app.service('sessions') as unknown as SessionsServiceImpl
            ).fork(args.sessionId, forkData, baseServiceParams);

            // Override agentic tool if specified
            if (args.agenticTool) {
              await app
                .service('sessions')
                .patch(
                  forkedSession.session_id,
                  { agentic_tool: args.agenticTool as AgenticToolName },
                  baseServiceParams
                );
            }

            // Override permission mode if specified
            if (args.permissionMode) {
              const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');
              const mappedMode = mapPermissionMode(args.permissionMode, forkedSession.agentic_tool);
              await app.service('sessions').patch(
                forkedSession.session_id,
                {
                  permission_config: {
                    ...forkedSession.permission_config,
                    mode: mappedMode,
                  },
                },
                baseServiceParams
              );
            }

            // Set custom title if provided
            if (args.title) {
              await app
                .service('sessions')
                .patch(forkedSession.session_id, { title: args.title }, baseServiceParams);
            }

            // Get updated session
            const updatedSession = await app
              .service('sessions')
              .get(forkedSession.session_id, baseServiceParams);

            // Trigger prompt execution
            console.log(`🚀 Triggering prompt execution for forked session`);
            const promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.prompt,
                permissionMode: updatedSession.permission_config?.mode,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: forkedSession.session_id },
              }
            );

            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      session: updatedSession,
                      taskId: promptResponse.taskId,
                      status: promptResponse.status,
                      note: 'Forked session created and prompt execution started.',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } else if (mode === 'subsession') {
            // Mode: subsession - spawn child session (reuse existing spawn logic)
            console.log(`🌱 MCP spawning subsession from ${args.sessionId.substring(0, 8)}`);

            const spawnData: {
              prompt: string;
              title?: string;
              agentic_tool?: AgenticToolName;
              task_id?: string;
            } = {
              prompt: args.prompt,
            };

            if (args.title) {
              spawnData.title = args.title;
            }

            if (args.agenticTool) {
              spawnData.agentic_tool = args.agenticTool as AgenticToolName;
            }

            if (args.taskId) {
              spawnData.task_id = args.taskId;
            }

            // Call spawn method on sessions service
            const childSession = await (
              app.service('sessions') as unknown as SessionsServiceImpl
            ).spawn(args.sessionId, spawnData, baseServiceParams);

            // Override permission mode if specified
            if (args.permissionMode) {
              const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');
              const mappedMode = mapPermissionMode(args.permissionMode, childSession.agentic_tool);
              await app.service('sessions').patch(
                childSession.session_id,
                {
                  permission_config: {
                    ...childSession.permission_config,
                    mode: mappedMode,
                  },
                },
                baseServiceParams
              );
            }

            // Get updated session
            const updatedSession = await app
              .service('sessions')
              .get(childSession.session_id, baseServiceParams);

            // Trigger prompt execution (spawns start fresh by default - see query-builder.ts)
            console.log(`🚀 Triggering prompt execution for subsession`);
            const promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.prompt,
                permissionMode: updatedSession.permission_config?.mode,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: childSession.session_id },
              }
            );

            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      session: updatedSession,
                      taskId: promptResponse.taskId,
                      status: promptResponse.status,
                      note: 'Subsession created and prompt execution started.',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_sessions_create') {
          // Create a new session in an existing worktree
          if (!args?.worktreeId || !args?.agenticTool) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId and agenticTool are required',
              },
            });
          }

          console.log(`✨ MCP creating new session in worktree ${args.worktreeId.substring(0, 8)}`);

          // Get worktree to extract repo context
          const worktree = await app.service('worktrees').get(args.worktreeId, baseServiceParams);

          // Get current git state
          const { getGitState, getCurrentBranch } = await import('@agor/core/git');
          const currentSha = await getGitState(worktree.path);
          const currentRef = await getCurrentBranch(worktree.path);

          // Determine permission mode (default or user-specified)
          const { getDefaultPermissionMode } = await import('@agor/core/types');
          const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');
          const agenticTool = args.agenticTool as AgenticToolName;
          const requestedMode = args.permissionMode || getDefaultPermissionMode(agenticTool);
          const permissionMode = mapPermissionMode(requestedMode, agenticTool);

          // Create session
          const sessionData: Record<string, unknown> = {
            worktree_id: args.worktreeId,
            agentic_tool: agenticTool,
            status: 'idle',
            title: args.title,
            description: args.description,
            permission_config: {
              mode: permissionMode,
              allowedTools: [],
            },
            contextFiles: args.contextFiles || [],
            git_state: {
              ref: currentRef,
              base_sha: currentSha,
              current_sha: currentSha,
            },
            genealogy: { children: [] },
            tasks: [],
            message_count: 0,
          };

          const session = await app.service('sessions').create(sessionData, baseServiceParams);
          console.log(`✅ Session created: ${session.session_id.substring(0, 8)}`);

          // Attach MCP servers if specified
          if (args.mcpServerIds && Array.isArray(args.mcpServerIds)) {
            for (const mcpServerId of args.mcpServerIds) {
              await app.service('session-mcp-servers').create(
                {
                  session_id: session.session_id,
                  mcp_server_id: mcpServerId,
                },
                baseServiceParams
              );
            }
            console.log(`✅ Attached ${args.mcpServerIds.length} MCP servers`);
          }

          // Execute initial prompt if provided
          let promptResponse = null;
          if (args.initialPrompt) {
            console.log(`🚀 Executing initial prompt`);
            promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.initialPrompt,
                permissionMode: permissionMode,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: session.session_id },
              }
            );
          }

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session,
                    taskId: promptResponse?.taskId,
                    note: args.initialPrompt
                      ? 'Session created and initial prompt execution started.'
                      : 'Session created successfully.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (name === 'agor_sessions_update') {
          // Update session metadata
          if (!args?.sessionId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: sessionId is required',
              },
            });
          }

          // Validate at least one field is provided
          if (!args.title && !args.description && !args.status && !args.permissionMode) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: at least one field (title, description, status, permissionMode) must be provided',
              },
            });
          }

          console.log(`📝 MCP updating session ${args.sessionId.substring(0, 8)}`);

          // Build update object
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.description !== undefined) updates.description = args.description;
          if (args.status !== undefined) updates.status = args.status;

          // Handle permission mode update
          if (args.permissionMode !== undefined) {
            const currentSession = await app
              .service('sessions')
              .get(args.sessionId, baseServiceParams);
            const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');
            const mappedMode = mapPermissionMode(args.permissionMode, currentSession.agentic_tool);
            updates.permission_config = {
              ...currentSession.permission_config,
              mode: mappedMode,
            };
          }

          // Update session
          const session = await app
            .service('sessions')
            .patch(args.sessionId, updates, baseServiceParams);
          console.log(`✅ Session updated`);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session,
                    note: 'Session updated successfully.',
                  },
                  null,
                  2
                ),
              },
            ],
          };

          // Repo tools
        } else if (name === 'agor_repos_list') {
          const query: Record<string, unknown> = {};
          if (args?.limit) query.$limit = args.limit;
          if (args?.slug) query.slug = args.slug;

          const repos = await app.service('repos').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(repos, null, 2),
              },
            ],
          };
        } else if (name === 'agor_repos_get') {
          const repoId = coerceString(args?.repoId);
          if (!repoId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: repoId is required' },
            });
          }

          const repo = await app.service('repos').get(repoId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(repo, null, 2),
              },
            ],
          };
        } else if (name === 'agor_repos_clone') {
          const url = coerceString(args?.url);
          if (!url) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: url is required' },
            });
          }

          const slug = coerceString(args?.slug);
          const nameValue = coerceString(args?.name);
          const reposService = app.service('repos') as unknown as ReposServiceImpl;
          const repo = await reposService.cloneRepository(
            { url, ...(slug ? { slug } : {}), ...(nameValue ? { name: nameValue } : {}) },
            baseServiceParams
          );

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(repo, null, 2),
              },
            ],
          };
        } else if (name === 'agor_repos_add_local') {
          const pathValue = coerceString(args?.path);
          if (!pathValue) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: path is required' },
            });
          }

          const slug = coerceString(args?.slug);
          const reposService = app.service('repos') as unknown as ReposServiceImpl;
          const repo = await reposService.addLocalRepository(
            { path: pathValue, ...(slug ? { slug } : {}) },
            baseServiceParams
          );

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(repo, null, 2),
              },
            ],
          };

          // Worktree tools
        } else if (name === 'agor_worktrees_get') {
          if (!args?.worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktree = await app.service('worktrees').get(args.worktreeId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(worktree, null, 2),
              },
            ],
          };
        } else if (name === 'agor_worktrees_list') {
          const query: Record<string, unknown> = {};
          if (args?.repoId) query.repo_id = args.repoId;
          if (args?.limit) query.$limit = args.limit;

          const worktrees = await app.service('worktrees').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(worktrees, null, 2),
              },
            ],
          };
        } else if (name === 'agor_worktrees_create') {
          const repoId = coerceString(args?.repoId);
          if (!repoId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: repoId is required',
              },
            });
          }

          const worktreeName = coerceString(args?.worktreeName);
          if (!worktreeName) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeName is required',
              },
            });
          }

          if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: worktreeName must use lowercase letters, numbers, or hyphens',
              },
            });
          }

          const reposService = app.service('repos') as unknown as ReposServiceImpl;
          let repo: unknown;
          try {
            repo = await reposService.get(repoId);
          } catch {
            return res.status(404).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: `Repository ${repoId} not found`,
              },
            });
          }
          const defaultBranch =
            coerceString((repo as { default_branch?: unknown }).default_branch) ?? 'main';

          const refType = (coerceString(args?.refType) as 'branch' | 'tag') || 'branch';
          let createBranch = typeof args?.createBranch === 'boolean' ? args.createBranch : true;
          let ref = coerceString(args?.ref);
          let sourceBranch = coerceString(args?.sourceBranch);
          let pullLatest = typeof args?.pullLatest === 'boolean' ? args.pullLatest : undefined;

          if (ref && GIT_SHA_PATTERN.test(ref)) {
            createBranch = false;
            pullLatest = false;
            sourceBranch = undefined;
          }

          if (createBranch) {
            if (!ref) {
              ref = worktreeName;
            }
            if (!sourceBranch) {
              sourceBranch = defaultBranch;
            }
            if (pullLatest === undefined) {
              pullLatest = true;
            }
          } else {
            if (!ref) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: ref is required when createBranch is false',
                },
              });
            }
            sourceBranch = undefined;
            if (pullLatest === undefined) {
              pullLatest = false;
            }
          }

          // Default to current session's board if not specified
          let boardId = coerceString(args?.boardId);
          if (!boardId && context.sessionId) {
            const currentSession = await app.service('sessions').get(context.sessionId);
            boardId = currentSession.board_id ?? undefined;
          }

          let issueUrl: string | undefined;
          let pullRequestUrl: string | undefined;

          try {
            issueUrl = normalizeOptionalHttpUrl(args?.issueUrl, 'issueUrl');
            pullRequestUrl = normalizeOptionalHttpUrl(args?.pullRequestUrl, 'pullRequestUrl');
          } catch (validationError) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  validationError instanceof Error
                    ? validationError.message
                    : 'Invalid URL parameter',
              },
            });
          }

          const worktree = await reposService.createWorktree(
            repoId,
            {
              name: worktreeName,
              ref,
              createBranch,
              refType,
              ...(pullLatest !== undefined ? { pullLatest } : {}),
              ...(sourceBranch ? { sourceBranch } : {}),
              ...(issueUrl ? { issue_url: issueUrl } : {}),
              ...(pullRequestUrl ? { pull_request_url: pullRequestUrl } : {}),
              ...(boardId ? { boardId } : {}),
            },
            baseServiceParams
          );

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(worktree, null, 2),
              },
            ],
          };
        } else if (name === 'agor_worktrees_update') {
          const requestedWorktreeId = coerceString(args?.worktreeId);
          let resolvedWorktreeId = requestedWorktreeId;

          if (!resolvedWorktreeId) {
            if (!context.sessionId) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message:
                    'Invalid params: worktreeId is required when using global MCP authentication',
                },
              });
            }

            const currentSession = await app.service('sessions').get(context.sessionId);
            const sessionWorktreeId = currentSession.worktree_id;

            if (!sessionWorktreeId) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message:
                    'Invalid params: worktreeId is required when current session is not bound to a worktree',
                },
              });
            }

            resolvedWorktreeId = sessionWorktreeId;
          }

          if (!resolvedWorktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId could not be resolved',
              },
            });
          }

          const worktreeId = resolvedWorktreeId;

          let fieldsProvided = 0;
          const updates: Record<string, unknown> = {};

          try {
            if (args && Object.hasOwn(args, 'issueUrl')) {
              fieldsProvided++;
              const rawIssueUrl = args.issueUrl;
              if (rawIssueUrl === null) {
                updates.issue_url = null;
              } else {
                const normalizedIssueUrl = normalizeOptionalHttpUrl(rawIssueUrl, 'issueUrl');
                updates.issue_url = normalizedIssueUrl ?? null;
              }
            }

            if (args && Object.hasOwn(args, 'pullRequestUrl')) {
              fieldsProvided++;
              const rawPullRequestUrl = args.pullRequestUrl;
              if (rawPullRequestUrl === null) {
                updates.pull_request_url = null;
              } else {
                const normalizedPullRequestUrl = normalizeOptionalHttpUrl(
                  rawPullRequestUrl,
                  'pullRequestUrl'
                );
                updates.pull_request_url = normalizedPullRequestUrl ?? null;
              }
            }
          } catch (validationError) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  validationError instanceof Error
                    ? validationError.message
                    : 'Invalid URL parameter',
              },
            });
          }

          if (args && Object.hasOwn(args, 'notes')) {
            fieldsProvided++;
            const rawNotes = args.notes;
            if (rawNotes === null) {
              updates.notes = null;
            } else if (typeof rawNotes === 'string') {
              const trimmedNotes = rawNotes.trim();
              updates.notes = trimmedNotes.length > 0 ? trimmedNotes : null;
            } else {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: notes must be a string or null',
                },
              });
            }
          }

          if (args && Object.hasOwn(args, 'boardId')) {
            fieldsProvided++;
            const rawBoardId = args.boardId;
            if (rawBoardId === null) {
              updates.board_id = null;
            } else {
              const boardId = coerceString(rawBoardId);
              if (!boardId) {
                return res.status(400).json({
                  jsonrpc: '2.0',
                  id: mcpRequest.id,
                  error: {
                    code: -32602,
                    message: 'Invalid params: boardId must be a non-empty string or null',
                  },
                });
              }
              updates.board_id = boardId;
            }
          }

          if (args && Object.hasOwn(args, 'customContext')) {
            fieldsProvided++;
            const rawCustomContext = args.customContext;
            if (rawCustomContext === null) {
              updates.custom_context = null;
            } else if (
              rawCustomContext &&
              typeof rawCustomContext === 'object' &&
              !Array.isArray(rawCustomContext)
            ) {
              updates.custom_context = rawCustomContext;
            } else {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: customContext must be an object or null',
                },
              });
            }
          }

          if (fieldsProvided === 0) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: provide at least one field to update (issueUrl, pullRequestUrl, notes, boardId, customContext)',
              },
            });
          }

          console.log(`📝 MCP updating worktree ${worktreeId.substring(0, 8)}`);
          const worktree = await app
            .service('worktrees')
            .patch(worktreeId, updates, baseServiceParams);
          console.log(`✅ Worktree updated`);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    worktree,
                    note: 'Worktree metadata updated successfully.',
                  },
                  null,
                  2
                ),
              },
            ],
          };

          // Environment tools
        } else if (name === 'agor_environment_start') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          try {
            const worktree = await worktreesService.startEnvironment(
              worktreeId as import('@agor/core/types').WorktreeID,
              baseServiceParams
            );
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      worktree,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_environment_stop') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          try {
            const worktree = await worktreesService.stopEnvironment(
              worktreeId as import('@agor/core/types').WorktreeID,
              baseServiceParams
            );
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      worktree,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_environment_health') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          const worktree = await worktreesService.checkHealth(
            worktreeId as import('@agor/core/types').WorktreeID,
            baseServiceParams
          );
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: worktree.environment_instance?.status || 'unknown',
                    lastHealthCheck: worktree.environment_instance?.last_health_check,
                    worktree,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (name === 'agor_environment_logs') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          const logsResult = await worktreesService.getLogs(
            worktreeId as import('@agor/core/types').WorktreeID,
            baseServiceParams
          );
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(logsResult, null, 2),
              },
            ],
          };
        } else if (name === 'agor_environment_open_app') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          const worktree = await worktreesService.get(
            worktreeId as import('@agor/core/types').WorktreeID,
            baseServiceParams
          );

          const appUrl = worktree.environment_instance?.access_urls?.[0]?.url;
          if (!appUrl) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: 'No app URL configured for this worktree',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } else {
            // Note: We can't actually open the browser from server-side, but we can return the URL
            // The agent can use this URL to inform the user or take other actions
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      url: appUrl,
                      message: `App URL: ${appUrl}`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_environment_nuke') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          try {
            const worktree = await worktreesService.nukeEnvironment(
              worktreeId as import('@agor/core/types').WorktreeID,
              baseServiceParams
            );
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      worktree,
                      message: 'Environment nuked successfully - all data and volumes destroyed',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          // Board tools
        } else if (name === 'agor_boards_get') {
          if (!args?.boardId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: boardId is required',
              },
            });
          }

          const board = await app.service('boards').get(args.boardId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(board, null, 2),
              },
            ],
          };
        } else if (name === 'agor_boards_list') {
          const query: Record<string, unknown> = {};
          if (args?.limit) query.$limit = args.limit;

          const boards = await app.service('boards').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(boards, null, 2),
              },
            ],
          };
        } else if (name === 'agor_boards_create') {
          const nameValue = coerceString(args?.name);
          if (!nameValue) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: name is required' },
            });
          }

          const slug = coerceString(args?.slug);
          const description = coerceString(args?.description);

          const board = await app.service('boards').create(
            {
              name: nameValue,
              ...(slug ? { slug } : {}),
              ...(description ? { description } : {}),
            },
            baseServiceParams
          );

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(board, null, 2),
              },
            ],
          };
        } else if (name === 'agor_board_objects_list') {
          const query: Record<string, unknown> = {};
          if (args?.boardId) query.board_id = args.boardId;
          if (args?.worktreeId) query.worktree_id = args.worktreeId;
          if (args?.limit) query.$limit = args.limit;
          if (args?.skip) query.$skip = args.skip;

          const objects = await app.service('board-objects').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(objects, null, 2),
              },
            ],
          };
        } else if (name === 'agor_board_objects_create') {
          const boardId = coerceString(args?.boardId);
          const worktreeId = coerceString(args?.worktreeId);
          const position = args?.position as { x?: unknown; y?: unknown } | undefined;

          if (!boardId || !worktreeId || !position) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: boardId, worktreeId, and position are required',
              },
            });
          }

          const x = typeof position.x === 'number' ? position.x : undefined;
          const y = typeof position.y === 'number' ? position.y : undefined;
          if (x === undefined || y === undefined) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: position.x and position.y must be numbers',
              },
            });
          }

          const zoneIdRaw = args?.zoneId;
          const zone_id =
            zoneIdRaw === null ? null : typeof zoneIdRaw === 'string' ? zoneIdRaw : undefined;

          const object = await app.service('board-objects').create(
            {
              board_id: boardId,
              worktree_id: worktreeId,
              position: { x, y },
              ...(zone_id !== undefined ? { zone_id } : {}),
            },
            baseServiceParams
          );

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(object, null, 2),
              },
            ],
          };
        } else if (name === 'agor_board_objects_patch') {
          const objectId = coerceString(args?.objectId);
          if (!objectId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: objectId is required' },
            });
          }

          const patch: Record<string, unknown> = {};
          if (args && Object.hasOwn(args, 'position')) {
            const position = args.position as { x?: unknown; y?: unknown } | null | undefined;
            if (position && typeof position === 'object') {
              const x = typeof position.x === 'number' ? position.x : undefined;
              const y = typeof position.y === 'number' ? position.y : undefined;
              if (x === undefined || y === undefined) {
                return res.status(400).json({
                  jsonrpc: '2.0',
                  id: mcpRequest.id,
                  error: { code: -32602, message: 'Invalid params: position.x/y must be numbers' },
                });
              }
              patch.position = { x, y };
            }
          }

          if (args && Object.hasOwn(args, 'zoneId')) {
            const zoneIdRaw = args.zoneId;
            patch.zone_id =
              zoneIdRaw === null ? null : typeof zoneIdRaw === 'string' ? zoneIdRaw : undefined;
          }

          if (Object.keys(patch).length === 0) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: no patch fields provided' },
            });
          }

          const object = await app
            .service('board-objects')
            .patch(objectId, patch, baseServiceParams);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(object, null, 2),
              },
            ],
          };

          // Task tools
        } else if (name === 'agor_tasks_list') {
          const query: Record<string, unknown> = {};
          if (args?.sessionId) query.session_id = args.sessionId;
          if (args?.limit) query.$limit = args.limit;

          const tasks = await app.service('tasks').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(tasks, null, 2),
              },
            ],
          };
        } else if (name === 'agor_tasks_get') {
          if (!args?.taskId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: taskId is required',
              },
            });
          }

          const task = await app.service('tasks').get(args.taskId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(task, null, 2),
              },
            ],
          };

          // Message tools
        } else if (name === 'agor_messages_list') {
          const query: Record<string, unknown> = {};
          if (args?.sessionId) query.session_id = args.sessionId;
          if (args?.taskId) query.task_id = args.taskId;
          if (args?.limit) query.$limit = args.limit;
          if (args?.skip) query.$skip = args.skip;

          if (!query.session_id && !query.task_id) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: sessionId or taskId is required',
              },
            });
          }

          const messages = await app.service('messages').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(messages, null, 2),
              },
            ],
          };
        } else if (name === 'agor_messages_get') {
          const messageId = coerceString(args?.messageId);
          if (!messageId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: messageId is required' },
            });
          }

          const message = await app.service('messages').get(messageId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(message, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_transcript') {
          const sessionId = coerceString(args?.sessionId);
          if (!sessionId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: sessionId is required' },
            });
          }

          const query: Record<string, unknown> = { session_id: sessionId };
          if (args?.limit) query.$limit = args.limit;
          if (args?.skip) query.$skip = args.skip;

          const result = await app.service('messages').find({ query });
          const data = (result as { data?: unknown[] }).data ?? result;
          const messages = Array.isArray(data) ? data : [];

          const transcript = messages.map((m) => {
            const msg = m as {
              message_id?: unknown;
              task_id?: unknown;
              type?: unknown;
              role?: unknown;
              content?: unknown;
              created_at?: unknown;
            };
            return {
              messageId: msg.message_id,
              taskId: msg.task_id,
              type: msg.type,
              role: msg.role,
              content: msg.content,
              createdAt: msg.created_at,
            };
          });

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ sessionId, transcript }, null, 2),
              },
            ],
          };

          // Context/File tools (read-only)
        } else if (name === 'agor_context_list') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: worktreeId is required' },
            });
          }

          const files = await app.service('context').find({
            ...baseServiceParams,
            query: { worktree_id: worktreeId },
          });

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(files, null, 2),
              },
            ],
          };
        } else if (name === 'agor_context_get') {
          const worktreeId = coerceString(args?.worktreeId);
          const pathValue = coerceString(args?.path);
          if (!worktreeId || !pathValue) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: worktreeId and path are required' },
            });
          }

          const detail = await app.service('context').get(pathValue, {
            ...baseServiceParams,
            query: { worktree_id: worktreeId },
          });

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(detail, null, 2),
              },
            ],
          };
        } else if (name === 'agor_file_get') {
          const worktreeId = coerceString(args?.worktreeId);
          const pathValue = coerceString(args?.path);
          if (!worktreeId || !pathValue) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: worktreeId and path are required' },
            });
          }

          const detail = await app.service('file').get(pathValue, {
            ...baseServiceParams,
            query: { worktree_id: worktreeId },
          });

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(detail, null, 2),
              },
            ],
          };

          // Quick task orchestration
        } else if (name === 'agor_quick_task_create') {
          const prompt = coerceString(args?.prompt);
          if (!prompt) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32602, message: 'Invalid params: prompt is required' },
            });
          }

          // Resolve/create repo
          const repoId = coerceString(args?.repoId);
          const repoSlug = coerceString(args?.repoSlug);
          const repoUrl = coerceString(args?.repoUrl);
          const localPath = coerceString(args?.localPath);
          const repoSlugOverride = coerceString(args?.repoSlugOverride);
          const repoName = coerceString(args?.repoName);

          const selectionCount = [repoId, repoSlug, repoUrl, localPath].filter(Boolean).length;
          if (selectionCount === 0) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: one of repoId, repoSlug, repoUrl, or localPath is required',
              },
            });
          }
          if (selectionCount > 1) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: provide only one of repoId, repoSlug, repoUrl, or localPath',
              },
            });
          }

          const reposService = app.service('repos') as unknown as ReposServiceImpl;
          let repo: Repo | null;

          if (repoId) {
            repo = await app.service('repos').get(repoId);
          } else if (repoSlug) {
            const found = await app.service('repos').find({ query: { slug: repoSlug, $limit: 1 } });
            const data = (found as { data?: unknown[] }).data ?? found;
            repo = Array.isArray(data) ? data[0] : null;
            if (!repo) {
              return res.status(404).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: { code: -32602, message: `Repo slug not found: ${repoSlug}` },
              });
            }
          } else if (repoUrl) {
            repo = await reposService.cloneRepository(
              {
                url: repoUrl,
                ...(repoSlugOverride ? { slug: repoSlugOverride } : {}),
                ...(repoName ? { name: repoName } : {}),
              },
              baseServiceParams
            );
          } else if (localPath) {
            repo = await reposService.addLocalRepository(
              { path: localPath, ...(repoSlugOverride ? { slug: repoSlugOverride } : {}) },
              baseServiceParams
            );
          }

          // TypeScript can't infer that exactly one of repoId/repoSlug/repoUrl/localPath is provided
          // We verified this with selectionCount check above, so we can assert repo is not null
          const resolvedRepoId = coerceString(repo!.repo_id);
          if (!resolvedRepoId) {
            return res.status(500).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32603, message: 'Failed to resolve repoId' },
            });
          }

          // Resolve/create board (optional)
          let boardId: string | undefined = coerceString(args?.boardId);
          const boardSlug = coerceString(args?.boardSlug);
          const createBoard = args?.createBoard as
            | { name?: unknown; slug?: unknown; description?: unknown }
            | undefined;

          if (!boardId && boardSlug) {
            const found = await app
              .service('boards')
              .find({ query: { slug: boardSlug, $limit: 1 } });
            const data = (found as { data?: unknown[] }).data ?? found;
            const board = (Array.isArray(data) ? data[0] : null) as Board | null;
            boardId = board ? coerceString(board.board_id) : undefined;
            if (!boardId) {
              return res.status(404).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: { code: -32602, message: `Board slug not found: ${boardSlug}` },
              });
            }
          }

          if (!boardId && createBoard) {
            const nameValue = coerceString(createBoard.name);
            if (!nameValue) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: { code: -32602, message: 'Invalid params: createBoard.name is required' },
              });
            }
            const created = (await app.service('boards').create(
              {
                name: nameValue,
                ...(coerceString(createBoard.slug) ? { slug: coerceString(createBoard.slug) } : {}),
                ...(coerceString(createBoard.description)
                  ? { description: coerceString(createBoard.description) }
                  : {}),
              },
              baseServiceParams
            )) as Board;
            boardId = coerceString(created.board_id);
          }

          // Worktree naming / base branch
          const requestedWorktreeName = coerceString(args?.worktreeName);
          const title = coerceString(args?.title) ?? coerceString(args?.description) ?? prompt;
          let worktreeName = requestedWorktreeName ?? slugifyWorktreeName(title).slice(0, 48);
          if (!worktreeName) {
            worktreeName = `task-${Date.now()}`;
          }
          if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: worktreeName must use lowercase letters, numbers, or hyphens',
              },
            });
          }

          const baseBranch =
            coerceString(args?.baseBranch) ?? coerceString(repo!.default_branch) ?? 'main';
          const pullLatest = typeof args?.pullLatest === 'boolean' ? args.pullLatest : true;

          let issueUrl: string | undefined;
          let pullRequestUrl: string | undefined;
          try {
            issueUrl = normalizeOptionalHttpUrl(args?.issueUrl, 'issueUrl');
            pullRequestUrl = normalizeOptionalHttpUrl(args?.pullRequestUrl, 'pullRequestUrl');
          } catch (validationError) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  validationError instanceof Error
                    ? validationError.message
                    : 'Invalid URL parameter',
              },
            });
          }

          const position = args?.position as { x?: unknown; y?: unknown } | undefined;
          const positionValue =
            position && typeof position.x === 'number' && typeof position.y === 'number'
              ? { x: position.x, y: position.y }
              : undefined;

          const worktree = (await reposService.createWorktree(
            resolvedRepoId,
            {
              name: worktreeName,
              ref: worktreeName,
              createBranch: true,
              refType: 'branch',
              pullLatest,
              sourceBranch: baseBranch,
              ...(issueUrl ? { issue_url: issueUrl } : {}),
              ...(pullRequestUrl ? { pull_request_url: pullRequestUrl } : {}),
              ...(boardId ? { boardId } : {}),
              ...(positionValue ? { position: positionValue } : {}),
            },
            baseServiceParams
          )) as Worktree;

          // Create session in the new worktree and run the prompt
          const worktreeId = coerceString(worktree.worktree_id);
          if (!worktreeId) {
            return res.status(500).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: { code: -32603, message: 'Worktree created but worktree_id missing' },
            });
          }

          const agenticTool =
            (coerceString(args?.agenticTool) as AgenticToolName | undefined) ?? 'claude-code';
          const { getDefaultPermissionMode } = await import('@agor/core/types');
          const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');
          const requestedMode = args?.permissionMode || getDefaultPermissionMode(agenticTool);
          const permissionMode = mapPermissionMode(requestedMode, agenticTool);

          const { getGitState, getCurrentBranch } = await import('@agor/core/git');
          const currentSha = await getGitState(worktree.path);
          const currentRef = await getCurrentBranch(worktree.path);

          const sessionTitle =
            coerceString(args?.title) ??
            `Task: ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`;

          const sessionData: Record<string, unknown> = {
            worktree_id: worktreeId,
            agentic_tool: agenticTool,
            status: 'idle',
            title: sessionTitle,
            description: coerceString(args?.description),
            permission_config: {
              mode: permissionMode,
              allowedTools: [],
            },
            contextFiles: Array.isArray(args?.contextFiles) ? args.contextFiles : [],
            git_state: {
              ref: currentRef,
              base_sha: currentSha,
              current_sha: currentSha,
            },
            genealogy: { children: [] },
            tasks: [],
            message_count: 0,
          };

          const session = (await app
            .service('sessions')
            .create(sessionData, baseServiceParams)) as Session;

          // Attach MCP servers if specified
          if (args?.mcpServerIds && Array.isArray(args.mcpServerIds)) {
            for (const mcpServerId of args.mcpServerIds) {
              await app.service('session-mcp-servers').create(
                {
                  session_id: session.session_id,
                  mcp_server_id: mcpServerId,
                },
                baseServiceParams
              );
            }
          }

          // Kick off prompt execution
          const promptResponse = await app
            .service('/sessions/:id/prompt')
            .create(
              { prompt, permissionMode, stream: true },
              { ...baseServiceParams, route: { id: session.session_id } }
            );

          // Optionally start environment
          let environment: unknown = undefined;
          if (args?.startEnvironment === true) {
            try {
              const worktreesService = app.service(
                'worktrees'
              ) as unknown as import('../declarations').WorktreesServiceImpl;
              environment = await worktreesService.startEnvironment(
                worktreeId as import('@agor/core/types').WorktreeID,
                baseServiceParams
              );
            } catch (error) {
              environment = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    repo: repo!,
                    worktree,
                    session,
                    taskId: promptResponse?.taskId,
                    taskStatus: promptResponse?.status,
                    environment,
                    note: 'Quick task created. Use agor_sessions_prompt to continue, and agor_messages_list/agor_sessions_transcript to fetch results.',
                  },
                  null,
                  2
                ),
              },
            ],
          };

          // User tools
        } else if (name === 'agor_users_list') {
          const query: Record<string, unknown> = {};
          if (args?.limit) query.$limit = args.limit;

          const users = await app.service('users').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(users, null, 2),
              },
            ],
          };
        } else if (name === 'agor_users_get') {
          if (!args?.userId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: userId is required',
              },
            });
          }

          const user = await app.service('users').get(args.userId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(user, null, 2),
              },
            ],
          };
        } else if (name === 'agor_users_get_current') {
          // Get current user from context (authenticated via MCP token)
          const user = await app.service('users').get(context.userId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(user, null, 2),
              },
            ],
          };
        } else if (name === 'agor_users_update_current') {
          // Update current user profile
          // Only allow updating name, emoji, avatar, preferences
          const updateData: Record<string, unknown> = {};
          if (args?.name !== undefined) updateData.name = args.name;
          if (args?.emoji !== undefined) updateData.emoji = args.emoji;
          if (args?.avatar !== undefined) updateData.avatar = args.avatar;
          if (args?.preferences !== undefined) updateData.preferences = args.preferences;

          const updatedUser = await app.service('users').patch(context.userId, updateData);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(updatedUser, null, 2),
              },
            ],
          };
        } else if (name === 'agor_user_create') {
          // Create a new user
          if (!args?.email) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: email is required',
              },
            });
          }

          if (!args?.password) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: password is required',
              },
            });
          }

          // Build user creation data
          const createData: Record<string, unknown> = {
            email: args.email,
            password: args.password,
          };

          // Add optional fields
          if (args?.name !== undefined) createData.name = args.name;
          if (args?.emoji !== undefined) createData.emoji = args.emoji;
          if (args?.avatar !== undefined) createData.avatar = args.avatar;
          if (args?.role !== undefined) createData.role = args.role;

          const newUser = await app.service('users').create(createData);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(newUser, null, 2),
              },
            ],
          };
        } else if (name === 'agor_analytics_leaderboard') {
          // Get usage analytics leaderboard
          const query: Record<string, unknown> = {};

          // Add filters
          if (args?.userId) query.userId = args.userId;
          if (args?.worktreeId) query.worktreeId = args.worktreeId;
          if (args?.repoId) query.repoId = args.repoId;
          if (args?.startDate) query.startDate = args.startDate;
          if (args?.endDate) query.endDate = args.endDate;

          // Add groupBy
          if (args?.groupBy) query.groupBy = args.groupBy;

          // Add sorting
          if (args?.sortBy) query.sortBy = args.sortBy;
          if (args?.sortOrder) query.sortOrder = args.sortOrder;

          // Add pagination
          if (args?.limit) query.$limit = args.limit;
          if (args?.offset) query.$skip = args.offset;

          const leaderboard = await app.service('leaderboard').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(leaderboard, null, 2),
              },
            ],
          };
        } else {
          return res.status(400).json({
            jsonrpc: '2.0',
            id: mcpRequest.id,
            error: {
              code: -32601,
              message: `Unknown tool: ${name}`,
            },
          });
        }
      } else {
        return res.status(400).json({
          error: 'Unknown method',
          message: `Method ${mcpRequest.method} not supported`,
        });
      }

      // Return MCP JSON-RPC response
      return res.json({
        jsonrpc: '2.0',
        id: mcpRequest.id,
        result: mcpResponse,
      });
    } catch (error) {
      console.error('❌ MCP request failed:', error);
      return res.status(500).json({
        error: 'Internal error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Register as Express POST route
  // @ts-expect-error - FeathersJS app extends Express
  app.post('/mcp', handler);

  console.log('✅ MCP routes registered at POST /mcp');
}
