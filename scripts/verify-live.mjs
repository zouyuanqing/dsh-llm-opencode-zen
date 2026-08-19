// 端到端验证：用 OpenCodeZenAdapter 直接调真实 zen 免费模型
import { OpenCodeZenAdapter, FREE_MODELS } from 'file:///C:/Users/zyq/Documents/dph-2/dsh-llm-opencode-zen/lib/index.js';

const connection = {
  baseURL: 'https://opencode.ai/zen/v1',
  models: FREE_MODELS,
  defaultContextWindow: 200000,
  maxTokens: 64000,
  streamIdleTimeoutMs: 300000,
  retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'], backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } },
};

const adapter = new OpenCodeZenAdapter({
  options: () => connection,
  resolveApiKey: async () => 'public', // 匿名免费
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

console.log(`\n=== streaming model=${model} (anonymous public) ===`);
const chunks = [];
try {
  for await (const chunk of adapter.stream(request)) {
    chunks.push(chunk);
    if (chunk.type === 'text-delta') process.stdout.write(chunk.text);
    else if (chunk.type === 'reasoning-delta' && chunk.text.trim().length > 0) process.stdout.write(`[思考:${chunk.text.slice(0, 20).replace(/\n/g, ' ')}...]`);
  }
} catch (e) {
  console.error('\nSTREAM ERROR:', e.message, e.code);
  process.exit(1);
}
console.log('\n');
console.log('chunk types:', [...new Set(chunks.map((c) => c.type))].join(', '));
const finish = chunks.find((c) => c.type === 'finish');
console.log('finish:', JSON.stringify(finish?.reason));
const usage = chunks.find((c) => c.type === 'usage');
console.log('usage:', JSON.stringify(usage?.usage));
console.log('==================================== OK');
