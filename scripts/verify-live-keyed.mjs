// 带 key 端到端验证：读 ~/.dsh/.credentials.yaml 的 OPENCODE_API_KEY，经适配器打 zen 免费模型
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodeZenAdapter, FREE_MODELS } from 'file:///C:/Users/zyq/Documents/dph-2/dsh-llm-opencode-zen/lib/index.js';

const cred = readFileSync(join(process.env.USERPROFILE, '.dsh', '.credentials.yaml'), 'utf8');
const m = cred.match(/OPENCODE_API_KEY:\s*([^\s]+)/);
const apiKey = m?.[1]?.trim?.().replace(/['"]/g, '');
if (!apiKey) { console.error('no OPENCODE_API_KEY found'); process.exit(1); }
console.log('using key:', apiKey.slice(0, 6) + '…' + apiKey.slice(-4));

const connection = {
  baseURL: 'https://opencode.ai/zen/v1',
  models: FREE_MODELS,
  defaultContextWindow: 200000,
  maxTokens: 64000,
  streamIdleTimeoutMs: 300000,
  retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } },
};

const adapter = new OpenCodeZenAdapter({
  options: () => connection,
  resolveApiKey: async () => apiKey,
});

const model = process.argv[2] ?? 'deepseek-v4-flash-free';
const request = {
  provider: 'opencode-zen',
  model,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: '用中文回答：1+1=？只回答=后面部分，不要思考过程。' }] }],
  reasoningEffort: 'high',
  maxTokens: 128,
};

console.log(`\n=== streaming model=${model} (KEYED) ===`);
let text = '';
try {
  for await (const chunk of adapter.stream(request)) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
} catch (e) {
  console.error('\nSTREAM ERROR:', e.message, e.code, e.failure);
  process.exit(1);
}
console.log('answer:', JSON.stringify(text));
console.log('==================================== KEYED OK');
