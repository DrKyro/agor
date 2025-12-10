/**
 * Title Generation Service + helper
 *
 * Attempts to use Anthropic's Messages API (Claude) to synthesize a concise
 * session title. Falls back to deterministic heuristics when an API key or
 * fetch implementation is unavailable.
 */

import { type ApiKeyName, resolveApiKey } from '@agor/core/config';
import { type Database } from '@agor/core/db';
import type {
  AuthenticatedParams,
  ServiceMethods,
  TitleGenerationRequest,
  TitleGenerationResult,
  UUID,
} from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';

const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';

interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type MinimalFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<MinimalFetchResponse>;

interface TitleContext {
  db: Database;
  userId?: UUID;
}

export async function generateTitleFromPrompt(
  prompt: string,
  context: TitleContext
): Promise<TitleGenerationResult> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return {
      title: 'New Quick Task',
      usedAI: false,
      fallbackReason: 'Empty prompt',
    };
  }

  const fetchImpl = (globalThis as { fetch?: MinimalFetch }).fetch;
  if (!fetchImpl) {
    return fallbackTitle(trimmed, 'fetch unavailable');
  }

  const resolution = await resolveApiKey('ANTHROPIC_API_KEY' as ApiKeyName, {
    userId: context.userId,
    db: context.db,
  });

  if (!resolution.apiKey) {
    return fallbackTitle(trimmed, 'Missing Anthropic API key');
  }

  try {
    const aiTitle = await callAnthropic(trimmed, resolution.apiKey, fetchImpl);
    if (aiTitle) {
      return {
        title: normalizeTitle(aiTitle),
        usedAI: true,
        model: DEFAULT_MODEL,
      };
    }
    return fallbackTitle(trimmed, 'Empty AI response');
  } catch (error) {
    console.warn('⚠️  Title generation failed:', error instanceof Error ? error.message : error);
    return fallbackTitle(trimmed, error instanceof Error ? error.message : 'Anthropic error');
  }
}

async function callAnthropic(
  prompt: string,
  apiKey: string,
  fetchImpl: MinimalFetch
): Promise<string | null> {
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 120,
      system:
        'You generate concise, professional session titles for engineering tasks. Titles should be 5-15 words, actionable, and avoid filler phrases.',
      messages: [
        {
          role: 'user',
          content: `Task description:\n"""${prompt}"""\n\nRespond with only the title text.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic request failed (HTTP ${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{ text?: string }>;
  };

  const firstBlock = payload.content?.find((block) => typeof block.text === 'string');
  return firstBlock?.text?.trim() || null;
}

function fallbackTitle(prompt: string, reason: string): TitleGenerationResult {
  return {
    title: normalizeTitle(buildHeuristicTitle(prompt)),
    usedAI: false,
    fallbackReason: reason,
  };
}

function buildHeuristicTitle(prompt: string): string {
  const sanitized = prompt
    .replace(/[`"'#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const words = sanitized.split(' ').filter(Boolean);
  if (words.length === 0) {
    return 'Quick Task';
  }

  const limited = words.slice(0, 15);
  return limited.join(' ');
}

function normalizeTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'Quick Task';
  }

  const words = cleaned.split(' ').filter(Boolean);
  let normalized = words.slice(0, 15).join(' ');
  if (words.length < 5) {
    normalized = words.join(' ');
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

class TitleGenerationService
  implements Pick<ServiceMethods<TitleGenerationResult, TitleGenerationRequest>, 'create'>
{
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(
    data: TitleGenerationRequest,
    params?: AuthenticatedParams
  ): Promise<TitleGenerationResult> {
    ensureMinimumRole(params, 'member', 'generate session titles');
    return generateTitleFromPrompt(data.prompt, {
      db: this.db,
      userId: params?.user?.user_id as UUID | undefined,
    });
  }
}

export function createTitleGenerationService(db: Database): TitleGenerationService {
  return new TitleGenerationService(db);
}
