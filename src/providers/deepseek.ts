import {
  finiteOr,
  finiteOrUndefined,
  mapChatCompletionsStopReason,
  throwHttpError,
} from './_http';
import {decodeUtf8} from '../sdk/utf8';
import type {ProviderClient, ProviderRequest, ProviderResponse} from './ProviderClient';

const ENDPOINT = 'https://api.deepseek.com/v1/responses';

type DeepSeekInputPart =
  | {type: 'input_text'; text: string}
  | {type: 'input_image'; image_url: string};

type DeepSeekInputItem = {
  role: 'system' | 'user' | 'assistant';
  content: DeepSeekInputPart[];
};

const mapDeepSeekStopReason = (
  status: unknown,
  finishReason: unknown,
): ProviderResponse['stopReason'] => {
  const mapped = mapChatCompletionsStopReason(finishReason);
  if (mapped !== 'unknown') {
    return mapped;
  }
  if (status === 'completed') {
    return 'complete';
  }
  if (status === 'incomplete') {
    return 'truncated';
  }
  return 'unknown';
};

const pickText = (payload: unknown): string => {
  if (payload === null || typeof payload !== 'object') {
    return '';
  }
  const o = payload as {
    output_text?: unknown;
    output?: Array<{content?: Array<{type?: string; text?: unknown}>}>;
  };
  if (typeof o.output_text === 'string') {
    return o.output_text;
  }
  const parts = o.output
    ?.flatMap((it) => it.content ?? [])
    .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  return parts?.join('') ?? '';
};

const extractDeltaText = (event: unknown): string => {
  if (event === null || typeof event !== 'object') {
    return '';
  }
  const o = event as {
    delta?: unknown;
    output_text?: unknown;
    output?: Array<{
      content?: Array<{
        delta?: unknown;
        text?: unknown;
      }>;
    }>;
  };
  if (typeof o.delta === 'string') {
    return o.delta;
  }
  if (typeof o.output_text === 'string') {
    return o.output_text;
  }
  return (
    o.output
      ?.flatMap((it) => it.content ?? [])
      .map((c) => {
        if (typeof c.delta === 'string') {
          return c.delta;
        }
        if (typeof c.text === 'string') {
          return c.text;
        }
        return '';
      })
      .join('') ?? ''
  );
};

const buildInput = (req: ProviderRequest): DeepSeekInputItem[] => {
  const out: DeepSeekInputItem[] = [
    {
      role: 'system',
      content: [{type: 'input_text', text: req.systemPrompt}],
    },
  ];
  const history = (req.history ?? []).map<DeepSeekInputItem>((turn) => ({
    role: turn.role,
    content: [{type: 'input_text', text: turn.text}],
  }));
  out.push(...history);
  const userContent: DeepSeekInputPart[] = [];
  if (req.imageBase64) {
    userContent.push({
      type: 'input_image',
      image_url: `data:image/png;base64,${req.imageBase64}`,
    });
  }
  userContent.push({type: 'input_text', text: req.userText});
  out.push({role: 'user', content: userContent});
  return out;
};

const streamResponse = async (
  res: Response,
  req: ProviderRequest,
): Promise<{text: string; stopReason: ProviderResponse['stopReason']; usage: ProviderResponse['usage']; modelId: string}> => {
  if (!res.body || req.onDelta === undefined) {
    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<{content?: Array<{type?: string; text?: string}>}>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        output_tokens_details?: {reasoning_tokens?: number};
      };
      model?: string;
      status?: string;
      finish_reason?: string;
    };
    return {
      text: pickText(data),
      stopReason: mapDeepSeekStopReason(data.status, data.finish_reason),
      usage: {
        inputTokens: finiteOr(data.usage?.input_tokens, 0),
        outputTokens: finiteOr(data.usage?.output_tokens, 0),
        reasoningTokens: finiteOrUndefined(
          data.usage?.output_tokens_details?.reasoning_tokens,
        ),
      },
      modelId: typeof data.model === 'string' ? data.model : '',
    };
  }

  const reader = res.body.getReader();
  let buffer = '';
  let combined = '';
  let usage: ProviderResponse['usage'] = {inputTokens: 0, outputTokens: 0};
  let modelId = '';
  let stopReason: ProviderResponse['stopReason'] = 'unknown';

  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    buffer += decodeUtf8(value);
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) {
        break;
      }
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        continue;
      }
      try {
        const event = JSON.parse(payload) as {
          model?: string;
          status?: string;
          finish_reason?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            output_tokens_details?: {reasoning_tokens?: number};
          };
        };
        const delta = extractDeltaText(event);
        if (delta.length > 0) {
          combined += delta;
          req.onDelta(delta);
        }
        if (typeof event.model === 'string') {
          modelId = event.model;
        }
        if (event.usage) {
          usage = {
            inputTokens: finiteOr(event.usage.input_tokens, usage.inputTokens),
            outputTokens: finiteOr(event.usage.output_tokens, usage.outputTokens),
            reasoningTokens: finiteOrUndefined(
              event.usage.output_tokens_details?.reasoning_tokens,
            ),
          };
        }
        stopReason = mapDeepSeekStopReason(event.status, event.finish_reason);
      } catch {
        continue;
      }
    }
  }

  return {text: combined, usage, modelId, stopReason};
};

export const createDeepSeekClient = (
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient => ({
  id: 'deepseek',
  async send(
    req: ProviderRequest,
    opts: {apiKey: string; model: string},
  ): Promise<ProviderResponse> {
    const start = Date.now();
    const body: Record<string, unknown> = {
      model: opts.model,
      input: buildInput(req),
      stream: req.onDelta !== undefined,
    };
    if (req.maxTokens !== undefined) {
      body.max_output_tokens = req.maxTokens;
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (req.reasoningEffort !== undefined) {
      body.reasoning = {effort: req.reasoningEffort};
    }
    const res = await fetchFn(ENDPOINT, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        Authorization: `******
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await throwHttpError('deepseek', res);
    }
    const decoded = await streamResponse(res, req);
    return {
      text: decoded.text,
      stopReason: decoded.stopReason,
      usage: decoded.usage,
      latencyMs: Date.now() - start,
      modelId: decoded.modelId.length > 0 ? decoded.modelId : opts.model,
    };
  },
});
