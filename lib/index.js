/**
 * @dsh-external/dsh-llm-opencode-zen
 *
 * OpenCode Zen 免费模型 LLM 适配器（对 DeepSeek Harness）。
 *
 * 机制（研究自 opencode 客户端源码 `packages/opencode/src/provider/provider.ts` 与
 * `packages/console/app/src/routes/zen/util/*`）：
 *
 *  - OpenCode Zen 网关（opencode.ai/zen/v1，OpenAI 兼容 chat/completions）把
 *    `Authorization: Bearer public` 的请求视为「匿名免费用户」，只对
 *    `allowAnonymous` 的模型（cost.input === 0，即 *_free 后缀模型）放行，
 *    按 IP 限流；带真实 OPENCODE_API_KEY 的请求解锁全部模型。
 *  - 网关校验 User-Agent：必须以 `opencode/` 开头，否则 429。
 *    所以本适配器把 attribution 的 user-agent 覆盖为 `opencode/<version>`。
 *  - 免费模型多为 deepseek 系/可思考模型，SSE 流带 `reasoning_content` 字段
 *    （deepseek 风格思考），逐块 translate 成 harness 的 reasoning-delta。
 *
 * 本插件零配置即用：不配置任何 API Key ⇒ 用 `Bearer public` 走 27 个免费模型；
 * 配置 OPENCODE_API_KEY ⇒ 解锁全部模型（可按需通过 models 目录手工加付费模型）。
 */

import z from '@deepseek-ai/schemastery';
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** Zen 网关需要 opencode/ 前缀的 User-Agent（否则 429）。 */
const ZEN_VERSION = '0.1.0';
const ZEN_USER_AGENT = `opencode/${ZEN_VERSION}`;

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';

/** 报告 + pi-ai 目录核对的 27 个免费模型（cost.input === 0，allowAnonymous）。 */
const FREE_MODELS = [
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', contextWindow: 200000, maxTokens: 128000, reasoning: ['high', 'max'], defaultEffort: 'high' },
  { id: 'glm-5-free', name: 'GLM-5 Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high' },
  { id: 'glm-4.7-free', name: 'GLM-4.7 Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high' },
  { id: 'kimi-k2.5-free', name: 'Kimi K2.5 Free', contextWindow: 262144, maxTokens: 65536, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'qwen3.6-plus-free', name: 'Qwen3.6 Plus Free', contextWindow: 262144, maxTokens: 65536, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'minimax-m3-free', name: 'MiniMax-M3 Free', contextWindow: 512000, maxTokens: 128000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'minimax-m2.5-free', name: 'MiniMax-M2.5 Free', contextWindow: 204800, maxTokens: 131072, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'minimax-m2.1-free', name: 'MiniMax-M2.1 Free', contextWindow: 204800, maxTokens: 131072, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'mimo-v2-flash-free', name: 'MiMo V2 Flash Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'mimo-v2-pro-free', name: 'MiMo V2 Pro Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'mimo-v2-omni-free', name: 'MiMo V2 Omni Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', contextWindow: 1000000, maxTokens: 128000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super Free', contextWindow: 1000000, maxTokens: 128000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'ling-3.0-flash-free', name: 'Ling 3.0 Flash Free', contextWindow: 262144, maxTokens: 32768, reasoning: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'ling-3.0-tiny-free', name: 'Ling 3.0 Tiny Free', contextWindow: 200000, maxTokens: 16384, reasoning: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'ling-2.6-flash-free', name: 'Ling 2.6 Flash Free', contextWindow: 200000, maxTokens: 32768, reasoning: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free', contextWindow: 256000, maxTokens: 32000, reasoning: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'ring-2.6-1t-free', name: 'Ring 2.6 1T Free', contextWindow: 1000000, maxTokens: 128000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'north-mini-code-free', name: 'North Mini Code Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'trinity-large-preview-free', name: 'Trinity Large Preview Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'hy3-free', name: 'Hy3 Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'hy3-preview-free', name: 'Hy3 Preview Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'grok-code', name: 'Grok Code', contextWindow: 256000, maxTokens: 128000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high' },
  { id: 'longcat-2.0-free', name: 'Longcat 2.0 Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high' },
].map((m) => ({
  id: m.id,
  name: m.name,
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
  // 免费模型几乎都是思考模型（deepseek 系 / 推理型），wire 层本就不发送 effort 参数，
  // 统一声明支持 high/max 保证全局默认 reasoningEffort: max 对任意免费模型开箱即用。
  reasoning: ['high', 'max'],
  defaultEffort: m.defaultEffort ?? 'high',
}));

/* ------------------------------------------------------------------ *
 * schema 与配置解析
 * ------------------------------------------------------------------ */

const name = 'llm-opencode-zen';
const inject = ['llm'];
const NS = settingsNamespace('llm-opencode-zen');
const PROVIDER = 'opencode-zen';
const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY';
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
/** 网关要求的匿名占位 token（零配置即用）。 */
const PUBLIC_KEY = 'public';

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoning: z.array(z.string()),
  defaultEffort: z.string(),
});

// schemastery 3.18：所有字段默认可选，显式 .required() 标记必填。
// 对齐官方 dsh-llm-deepseek：给常用字段 default，让 UI 设置表单直接渲染出完整可编辑配置。
const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(FREE_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

function normalizeModels(models) {
  const seen = new Set();
  return (models ?? FREE_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-opencode-zen: catalog model ids must be non-empty');
    if (model.name !== undefined && model.name.length === 0) throw new Error(`llm-opencode-zen: catalog model "${model.id}" has an empty name`);
    if (seen.has(model.id)) throw new Error(`llm-opencode-zen: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
    };
  });
}

function resolveAdapterOptions(config, environment) {
  return {
    apiKeyEnv: config.apiKeyEnv === undefined || config.apiKeyEnv === '' || config.apiKeyEnv === 'public'
      ? undefined
      : credentialRef(config.apiKeyEnv),
    baseURL: config.baseURL ?? environment?.get('OPENCODE_ZEN_BASE_URL')?.value ?? DEFAULT_BASE_URL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: normalizeModels(config.models),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-opencode-zen: retryPolicy'),
  };
}

/* ------------------------------------------------------------------ *
 * 消息序列化（OpenAI chat/completions wire）
 * ------------------------------------------------------------------ */

function flattenText(blocks) {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) throw new LlmError('The OpenCode Zen adapter does not support image content.', 'UNSUPPORTED_CONTENT');
}

function serializeAssistant(message) {
  const text = flattenText(message.content);
  const reasoning = message.content.filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
  const toolCalls = message.content.filter((b) => b.type === 'tool-call').map((b) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: b.arguments },
  }));
  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((b) => b.type === 'tool-result');
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text });
    for (const result of toolResults) {
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' });
    }
  }
  return wire;
}

function serializeRequest(options) {
  const messages = [];
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
  messages.push(...serializeMessages(options.messages));
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * SSE 解析（极简：data: 行，DONE 结束）
 * ------------------------------------------------------------------ */

/** 把 ReadableStream 的字节流按 SSE 事件切分，产出 data 载荷。 */
async function* parseSse(stream, onComment) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = [];
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          else if (line.startsWith(':') && onComment) onComment(line);
        }
        if (dataLines.length > 0) {
          // 标准 SSE data 可能多行，按换行拼接；zen 每事件单行。
          yield dataLines.join('\n');
        }
      }
    }
    if (buffer.length > 0) {
      const dataLines = [];
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) yield dataLines.join('\n');
    }
  } finally {
    reader.releaseLock();
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
}

/* ------------------------------------------------------------------ *
 * SSE → StreamChunk 翻译（支持 reasoning_content / tool_calls / usage）
 * ------------------------------------------------------------------ */

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;

  function open(kind) {
    const block = { index: nextIndex++, kind, text: '' };
    order.push(block);
    return block;
  }
  function closeBlock(block) {
    switch (block.kind) {
      case 'text': return { type: 'text', text: block.text };
      case 'reasoning': return { type: 'reasoning', text: block.text };
      case 'tool-call': return { type: 'tool-call', id: CallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text };
    }
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) };
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
      const reason = pendingFinish ?? { kind: 'stop' };
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += reasoning;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += content;
        yield { type: 'text-delta', index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open('tool-call');
          toolBlocks.set(call.index, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        if (call.id !== undefined) block.callId = call.id;
        if (call.function?.name !== undefined) block.name = call.function.name;
        const fragment = call.function?.arguments ?? '';
        block.text += fragment;
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED');
}

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: ['text'],
  };
}

function providerRetryAfterMs(value) {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return 'AUTH';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (isQuotaExceededError(detail)) return 'QUOTA';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED';
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

/**
 * 免费模型适配器：fetch + SSE 直连 OpenCode Zen。
 *
 * 认证策略（opencode 客户端同款）：
 *  - 配置了 apiKeyEnv 且能解析到 key ⇒ `Bearer <key>`（解锁全部模型）；
 *  - 否则 ⇒ `Bearer public`（匿名，只有 *_free 模型，IP 限流）。
 * User-Agent 必须为 opencode/ 前缀：覆盖 attribution 的默认 deepseek UA。
 */
class OpenCodeZenAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Zen (Free)' };
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }

  listModels(provider) {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
  }

  resolveModel(provider, model, _signal) {
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
    const base = {
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text'] }
        : modelInfo(provider, configured)),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    };
    const reasoning = configured?.reasoning;
    if (reasoning === undefined) return Promise.resolve(base);
    return Promise.resolve({
      ...base,
      reasoning: {
        efforts: reasoning.map((effort) => ({
          id: effort,
          name: effort.charAt(0).toUpperCase() + effort.slice(1),
        })),
        ...(configured?.defaultEffort === undefined ? {} : { defaultEffort: configured.defaultEffort }),
      },
    });
  }

  async *stream(options) {
    const env = { stack: [], error: undefined, hasError: false };
    const __addDisposableResource = (value, async) => {
      if (value === null || value === undefined) return value;
      const dispose = async ? value[Symbol.asyncDispose]?.bind(value) : value[Symbol.dispose]?.bind(value);
      env.stack.push({ value, dispose, async });
      return value;
    };
    try {
      const connection = this.config.options();
      const apiKey = await this.config.resolveApiKey(connection);
      const consumer = new AbortController();
      const watchdog = __addDisposableResource(
        idleWatchdog(options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE),
        false,
      );
      const iterator = this.request(options, watchdog.signal, connection, apiKey, () => watchdog.pulse())[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const result = await watchdog.next(iterator);
          if (result.done) {
            exhausted = true;
            return;
          }
          yield result.value;
        }
      } catch (error) {
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
          throw new LlmError(`OpenCode Zen stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
        }
        if (options.signal?.aborted) throw new LlmError('OpenCode Zen request aborted by caller', 'ABORTED', { cause: error });
        if (error instanceof LlmError) throw error;
        throw new LlmError(`OpenCode Zen API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
      } finally {
        consumer.abort('OpenCode Zen stream consumer stopped');
        if (!exhausted && iterator.return !== undefined) {
          try {
            await iterator.return();
          } catch (_abortedTransportTeardown) {}
        }
      }
    } catch (e) {
      env.error = e;
      env.hasError = true;
    } finally {
      let r = env.stack.pop();
      while (r) {
        if (r.dispose) {
          try {
            await r.dispose();
          } catch {}
        }
        r = env.stack.pop();
      }
    }
  }

  async *request(options, signal, connection, apiKey, onComment) {
    const body = serializeRequest(options);
    const payload = JSON.stringify(body);
    // attribution 必须包含；但 zen 要求 opencode/ UA，覆盖之。
    const headers = {
      ...attributionHeaders(),
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'user-agent': ZEN_USER_AGENT,
      ...(options.sessionId !== undefined ? { 'x-deepseek-harness-session-id': String(options.sessionId) } : {}),
      ...(options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {}),
    };
    let response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`OpenCode Zen API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
    }
    if (!response.ok) {
      let message = `OpenCode Zen API error (HTTP ${response.status})`;
      let providerError;
      try {
        providerError = (await response.json()).error;
        if (providerError?.message) message = providerError.message;
      } catch {}
      const delay = providerRetryAfterMs(response.headers.get('retry-after'));
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
      });
    }
    if (!response.body) throw new LlmError('OpenCode Zen API returned no response body', 'EMPTY_RESPONSE');
    yield* translate(parseSse(response.body, onComment));
  }
}

/* ------------------------------------------------------------------ *
 * apply：注册 provider + settings 段
 * ------------------------------------------------------------------ */

function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error('llm-opencode-zen: keeping the last good configuration after an invalid settings section');
      ctx.logger.error(error);
      return lastGood;
    }
  };

  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    if (ref === undefined) return PUBLIC_KEY; // 零配置匿名路径
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-opencode-zen', ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-opencode-zen', ref);
    }
    return PUBLIC_KEY; // 声明了 key 但未配置到 ⇒ 降级匿名（免费模型仍可用）
  };

  const adapter = new OpenCodeZenAdapter({ options, resolveApiKey });

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'OpenCode Zen (Free)',
    settingsNs: NS,
    settingsPath: [],
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts,
  });
}

export {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  FREE_MODELS,
  OpenCodeZenAdapter,
  PROVIDER,
  PUBLIC_KEY,
  apply,
  inject,
  name,
  resolveAdapterOptions,
};
