/**
 * OpenRouter client — one key, many upstream models.
 *
 * Endpoint: POST https://openrouter.ai/api/v1/chat/completions
 * Auth:     Authorization: Bearer <key>
 *
 * OpenRouter speaks OpenAI's Chat Completions wire format, so the
 * request and response handling is the shared one in ./openai. Two
 * things differ:
 *
 *   - Token cap: OpenRouter normalises `max_tokens` across every
 *     upstream (including OpenAI's reasoning models, which reject it
 *     when called directly), so it is always `max_tokens` here. The
 *     OpenAI prefix classifier would also misfire on namespaced ids
 *     like `openai/gpt-5`.
 *   - Attribution headers: `HTTP-Referer` and `X-Title` are OpenRouter's
 *     optional app identification, so usage shows up under SnCopilot
 *     in the user's OpenRouter activity log.
 *
 * Model ids are namespaced (`anthropic/claude-sonnet-4.5`,
 * `google/gemini-2.5-flash`). Whether a model accepts the page image
 * depends on the model, not on OpenRouter; a text-only model rejects
 * an image request with an HTTP error, which surfaces like any other.
 */

import {createChatCompletionsClient} from './openai';
import type {ProviderClient} from './ProviderClient';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const APP_HEADERS: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://github.com/j-raghavan/sn-copilot',
  'X-Title': 'SnCopilot',
};

export const createOpenRouterClient = (
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient =>
  createChatCompletionsClient(
    {
      id: 'openrouter',
      endpoint: ENDPOINT,
      tokenCapField: () => 'max_tokens',
      extraHeaders: APP_HEADERS,
    },
    fetchFn,
  );
