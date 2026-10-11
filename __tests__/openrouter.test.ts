/**
 * Tests for the OpenRouter client. Wire-level shape pins:
 *
 *   - Endpoint, Bearer auth, and OpenRouter's app-attribution headers
 *     (which must never displace auth or content-type).
 *   - Token cap is always `max_tokens`, including for namespaced
 *     OpenAI reasoning ids that would need `max_completion_tokens`
 *     when called directly — OpenRouter normalises the field.
 *   - Image + history mapping identical to OpenAI's Chat Completions.
 *   - Response decoding, reasoning tokens, upstream model id.
 *   - Errors are prefixed `openrouter:` so the sanitised chat bubble
 *     names the right provider.
 *   - The shipped key-file template parses as a valid OpenRouter key.
 *
 * Provider-agnostic invariants (stop-reason mapping, hostile JSON,
 * no sampling parameters, registry) cover OpenRouter in
 * providers.test.ts alongside the other clients.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {createChatCompletionsClient} from '../src/providers/openai';
import {createOpenRouterClient} from '../src/providers/openrouter';
import {parseKeyFile} from '../src/storage/keyFiles';
import type {ProviderRequest} from '../src/providers/ProviderClient';
import {isImageCapableProvider} from '../src/types';
import {sanitizeProviderError} from '../src/ui/sanitizeProviderError';

type FetchSpy = jest.Mock<Promise<Response>, [string, RequestInit]>;

const buildOk = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);

const buildErr = (status: number, body: string): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response);

const okBody = {
  choices: [{message: {content: 'hi from openrouter'}, finish_reason: 'stop'}],
  usage: {prompt_tokens: 12, completion_tokens: 7},
  model: 'google/gemini-2.5-flash',
};

const baseReq = (): ProviderRequest => ({
  systemPrompt: 'You are a helpful assistant.',
  userText: 'Hello',
  maxTokens: 64,
  signal: new AbortController().signal,
});

const send = async (
  req = baseReq(),
  model = 'google/gemini-2.5-flash',
  body: unknown = okBody,
) => {
  const fetchFn: FetchSpy = jest.fn().mockResolvedValue(buildOk(body));
  const client = createOpenRouterClient(fetchFn as unknown as typeof fetch);
  const r = await client.send(req, {apiKey: 'sk-or-test', model});
  const [url, init] = fetchFn.mock.calls[0];
  return {r, url, init, body: JSON.parse(init.body as string)};
};

describe('createOpenRouterClient', () => {
  it('POSTs to openrouter.ai/api/v1/chat/completions with Bearer auth', async () => {
    const {r, url, init, body} = await send();
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'HTTP-Referer': 'https://github.com/j-raghavan/sn-copilot',
      'X-Title': 'SnCopilot',
      'content-type': 'application/json',
      Authorization: 'Bearer sk-or-test',
    });
    expect(body).toEqual({
      model: 'google/gemini-2.5-flash',
      max_tokens: 64,
      messages: [
        {role: 'system', content: 'You are a helpful assistant.'},
        {role: 'user', content: 'Hello'},
      ],
    });
    expect(r.text).toBe('hi from openrouter');
    expect(r.stopReason).toBe('complete');
    expect(r.usage).toEqual({inputTokens: 12, outputTokens: 7});
    expect(r.modelId).toBe('google/gemini-2.5-flash');
  });

  it('extra headers can never replace auth or content-type', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(buildOk(okBody));
    const client = createChatCompletionsClient(
      {
        id: 'openrouter',
        endpoint: 'https://example.test/v1/chat/completions',
        tokenCapField: () => 'max_tokens',
        extraHeaders: {Authorization: 'Bearer stolen', 'content-type': 'text/plain'},
      },
      fetchFn as unknown as typeof fetch,
    );
    await client.send(baseReq(), {apiKey: 'sk-real', model: 'm'});
    expect(fetchFn.mock.calls[0][1].headers).toEqual({
      'content-type': 'application/json',
      Authorization: 'Bearer sk-real',
    });
  });

  it('forwards the abort signal so the chat timeout cancels the request', async () => {
    const req = baseReq();
    const {init} = await send(req);
    expect(init.signal).toBe(req.signal);
  });

  it('uses globalThis.fetch when no fetchFn supplied', () => {
    expect(createOpenRouterClient().id).toBe('openrouter');
  });

  describe('token cap is always max_tokens', () => {
    it.each([
      'openai/gpt-5',
      'openai/gpt-5-mini',
      'openai/o3-mini',
      'gpt-5',
      'o1-mini',
      'anthropic/claude-sonnet-4.5',
      'deepseek/deepseek-chat',
    ])('%s sends max_tokens and no max_completion_tokens', async model => {
      const {body} = await send(baseReq(), model);
      expect(body.max_tokens).toBe(64);
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body.model).toBe(model);
    });
  });

  it('attaches the page image as an image_url data part before the text', async () => {
    const {body} = await send({...baseReq(), imageBase64: 'AAAA'});
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}},
        {type: 'text', text: 'Hello'},
      ],
    });
  });

  it('slots history between the system message and the current turn', async () => {
    const {body} = await send({
      ...baseReq(),
      history: [
        {role: 'user', text: 'Summarize this page'},
        {role: 'assistant', text: '• point one'},
      ],
    });
    expect(body.messages).toEqual([
      {role: 'system', content: 'You are a helpful assistant.'},
      {role: 'user', content: 'Summarize this page'},
      {role: 'assistant', content: '• point one'},
      {role: 'user', content: 'Hello'},
    ]);
  });

  it('reads reasoning tokens from completion_tokens_details', async () => {
    const {r} = await send(baseReq(), 'openai/o3-mini', {
      ...okBody,
      usage: {
        prompt_tokens: 3,
        completion_tokens: 40,
        completion_tokens_details: {reasoning_tokens: 32},
      },
    });
    expect(r.usage).toEqual({
      inputTokens: 3,
      outputTokens: 40,
      reasoningTokens: 32,
    });
  });

  it('falls back to the requested model id when the response omits it', async () => {
    const {r} = await send(baseReq(), 'openai/gpt-4o-mini', {choices: []});
    expect(r.text).toBe('');
    expect(r.stopReason).toBe('unknown');
    expect(r.usage).toEqual({inputTokens: 0, outputTokens: 0});
    expect(r.modelId).toBe('openai/gpt-4o-mini');
  });

  it("maps OpenRouter's normalised finish_reason 'error' to unknown", async () => {
    const {r} = await send(baseReq(), 'm', {
      choices: [{message: {content: ''}, finish_reason: 'error'}],
    });
    expect(r.stopReason).toBe('unknown');
  });

  it.each([
    [401, 'invalid key', 'openrouter: HTTP 401'],
    [402, 'insufficient credits', 'openrouter: HTTP 402'],
    [
      404,
      'No endpoints found that support image input',
      "openrouter: HTTP 404 — this model can't read images. Choose one that accepts image input.",
    ],
    [429, 'rate limited', 'openrouter: HTTP 429'],
  ])('HTTP %i throws an openrouter-prefixed error', async (status, text, shown) => {
    const fetchFn: FetchSpy = jest
      .fn()
      .mockResolvedValue(buildErr(status, text));
    const client = createOpenRouterClient(fetchFn as unknown as typeof fetch);
    const err = await client
      .send(baseReq(), {apiKey: 'k', model: 'm'})
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `openrouter: HTTP ${status} — ${text}`,
    );
    // The chat bubble shows the provider and status, not the raw body
    // (plus a fix-it hint when the model can't take the page image).
    expect(sanitizeProviderError(err)).toBe(shown);
  });
});

describe('OpenRouter as a configured provider', () => {
  it('is treated as image-capable', () => {
    expect(isImageCapableProvider('openrouter')).toBe(true);
  });

  it('the shipped template parses as a valid OpenRouter key file', () => {
    const path = join(__dirname, '..', 'templates', 'copilot-key-openrouter.txt');
    const logger = {log: jest.fn(), warn: jest.fn(), error: jest.fn()};
    const r = parseKeyFile(readFileSync(path, 'utf8'), path, logger);
    expect(r).toEqual({
      kind: 'ok',
      file: {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
        key: 'sk-or-REPLACE-ME',
        sourcePath: path,
      },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
