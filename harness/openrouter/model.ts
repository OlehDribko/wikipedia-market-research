import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import type { ChatMessages } from '@openrouter/sdk/models';
import { TOOL_DEFINITIONS } from './tools.ts';

export type Message = ChatMessages;

export interface AssistantReply {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string | null;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Measurements for evidence: HTTP status, the model OpenRouter actually served, wall-clock latency. */
  httpStatus?: number;
  servedModel?: string;
  latencyMs?: number;
}

/** The only thing the agent needs from a model. Mocked tests provide a scripted implementation. */
export interface ModelClient {
  readonly model: string;
  complete(messages: readonly Message[]): Promise<AssistantReply>;
}

export type ModelErrorKind = 'model_unavailable' | 'rate_limited' | 'payment_required' | 'unauthorized' | 'bad_request' | 'provider_error' | 'network';

/** A model call failed; `kind` tells whether the model, the account, the request or the network is at fault. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;

  constructor(kind: ModelErrorKind, message: string, status: number | null) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
  }
}

export function classifyModelError(error: unknown, model: string): ModelError {
  if (error instanceof OpenRouterError) {
    const status = error.statusCode;
    // Account identifiers in provider errors are not needed as evidence.
    const body = error.body.replace(/"user_id"\s*:\s*"[^"]*"?/g, '"user_id":"[REDACTED]"').slice(0, 600);
    const kind: ModelErrorKind =
      status === 404 ? 'model_unavailable' : status === 429 ? 'rate_limited' : status === 402 ? 'payment_required' : status === 401 || status === 403 ? 'unauthorized' : status === 400 ? 'bad_request' : 'provider_error';
    return new ModelError(kind, `OpenRouter returned HTTP ${status} for model ${model}: ${body}`, status);
  }
  return new ModelError('network', `Model call failed for ${model}: ${error instanceof Error ? error.message : String(error)}`, null);
}

const APP_URL = 'https://github.com/OlehDribko/wikipedia-market-research';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Non-streaming OpenRouter chat completions with the skill tools. Retries only rate limits, never switches models. */
export class OpenRouterModelClient implements ModelClient {
  readonly model: string;
  readonly #client: OpenRouter;
  readonly #rateLimitRetries: number;
  #lastStatus: number | undefined;

  constructor(options: { apiKey: string; model: string; rateLimitRetries?: number }) {
    this.model = options.model;
    const httpClient = new HTTPClient();
    httpClient.addHook('response', (response) => {
      this.#lastStatus = response.status;
    });
    this.#client = new OpenRouter({ apiKey: options.apiKey, timeoutMs: 180_000, httpClient });
    this.#rateLimitRetries = options.rateLimitRetries ?? 3;
  }

  async complete(messages: readonly Message[]): Promise<AssistantReply> {
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      this.#lastStatus = undefined;
      try {
        const result = await this.#client.chat.send({
          // Truthful app identification (OpenRouter app attribution headers): this harness is a CLI tool-calling agent.
          httpReferer: APP_URL,
          appTitle: 'wikipedia-market-research harness',
          appCategories: 'cli-agent',
          chatRequest: {
            model: this.model,
            messages: [...messages],
            tools: [...TOOL_DEFINITIONS] as never,
            toolChoice: 'auto',
            temperature: 0.2,
            maxTokens: 4096,
            stream: false,
          },
        });
        if (!('choices' in result)) throw new ModelError('bad_request', 'Unexpected streaming response.', null);
        const choice = result.choices[0];
        if (!choice) throw new ModelError('provider_error', 'The model returned no choices.', null);
        const message = choice.message;
        const content = typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
        return {
          content,
          toolCalls: (message.toolCalls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
          finishReason: choice.finishReason ?? null,
          ...(this.#lastStatus !== undefined && { httpStatus: this.#lastStatus }),
          servedModel: result.model,
          latencyMs: Date.now() - started,
          ...(result.usage && { usage: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } }),
        };
      } catch (error) {
        const classified = error instanceof ModelError ? error : classifyModelError(error, this.model);
        if (classified.kind === 'rate_limited' && attempt < this.#rateLimitRetries) {
          await sleep(Math.min(15_000 * (attempt + 1), 60_000));
          continue;
        }
        throw classified;
      }
    }
  }
}
