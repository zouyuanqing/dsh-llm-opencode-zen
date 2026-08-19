# @dsh-external/dsh-llm-opencode-zen

> **OpenCode Zen 免费模型 LLM 适配器** —— 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接入 OpenCode Zen 网关的 27 个免费模型。零配置、零成本，`Bearer public` 匿名即用。

## ✨ 特性

- **零配置即用**：不配任何 API Key，插件自动以 `Authorization: Bearer public` 匿名请求，走 27 个免费模型（服务端按 IP 限流）
- **27 个免费模型**：DeepSeek / GLM / Kimi / MiniMax / MiMo / Nemotron / Ling / Laguna 等 `*-free` 模型，均 `cost=0`
- **完整适配器实现**：注册标准 `ctx.llm` provider 路由 `opencode-zen`，支持流式输出、工具调用（tool_calls）、思考过程（`reasoning_content` → reasoning-delta）、用量统计
- **思考模型开箱即用**：免费模型统一声明支持 `high/max` 思考强度，兼容全局 `reasoningEffort: max` 配置
- **可选付费解锁**：配置 `OPENCODE_API_KEY` 后按需在 `models` 目录追加付费模型
- **零依赖运行时**：纯 ESM JavaScript，直接 `fetch` + SSE，无第三方 SDK

## 🔬 工作原理（研究自 opencode 源码）

OpenCode Zen（`https://opencode.ai/zen/v1`，OpenAI 兼容协议）是 opencode 官方运营的 LLM 网关：

- 客户端无 Key 时，`packages/opencode/src/provider/provider.ts` 按 `cost.input === 0` 过滤出免费模型，以 `apiKey: "public"` 占位请求
- 服务端 `packages/console/app/src/routes/zen/util/handler.ts` 对 `public` + `allowAnonymous` 模型放行，并按 **IP 每日限流**（`ipRateLimiter.ts`），额度用尽返回 `429 FreeUsageLimitError`
- 网关要求 `User-Agent` 以 `opencode/` 开头（否则 429），本插件会覆盖 attribution 默认 UA 为 `opencode/0.1.0`

> 免费模型/额度由 opencode（SST/anomaly）补贴运营，**随时可能轮换或限流**，属官方设计。

## 📦 安装

本插件面向 DSH 的 **dsh-super-injector** 体系，运行时注入即完整生效（免重启、可热重载、卸载即净）：

```bash
# 注入器环境内（dsh-super-injector）
dev_inject_plugin {"dir": "<本插件目录绝对路径>"}
```

注入后插件注册 provider 路由 **`opencode-zen`**（显示名 *OpenCode Zen (Free)*）。

## ⚙️ 配置

### 1. 默认模型（`~/.dsh/settings.yaml`）

```yaml
agent-default-model:
  provider: opencode-zen
  model: deepseek-v4-flash-free   # 或其他 *_free 模型
  reasoningEffort: high           # high / max 均可
```

### 2. 完整配置段（可选；不写则全部使用内置默认）

```yaml
llm-opencode-zen:
  baseURL: https://opencode.ai/zen/v1   # 默认即此
  # apiKeyEnv: OPENCODE_API_KEY         # 留空 = 匿名免费；填写则带真实 Key 请求
  models:                               # 覆盖模型目录（默认 27 个免费模型）
    - id: deepseek-v4-flash-free
      name: DeepSeek V4 Flash Free
      contextWindow: 200000
      maxTokens: 128000
      reasoning: [high, max]
      defaultEffort: high
```

> **说明**：设置页（设置 → Models）里该 provider 卡片会显示"其余字段在 settings.yaml 中，请直接编辑对应段"——这是 DSH 前端对非官方 provider 的固定行为（前端只内置 `llm-deepseek` / `llm-pi-ai` 两套编辑表单），**不影响使用**。模型选择器（对话输入框旁）可直接选择免费模型。

## 🆓 免费模型清单（27 个）

| 模型 | 上下文 | 最大输出 | 思考 |
|---|---|---|---|
| `deepseek-v4-flash-free` | 200K | 128K | high/max |
| `glm-5-free` / `glm-4.7-free` | 200K | 64K | high/max |
| `kimi-k2.5-free` | 262K | 64K | high/max |
| `qwen3.6-plus-free` | 262K | 64K | high/max |
| `minimax-m3-free` | 512K | 128K | high/max |
| `minimax-m2.5-free` / `minimax-m2.1-free` | 204K | 131K | high/max |
| `mimo-v2-flash-free` / `mimo-v2-pro-free` / `mimo-v2-omni-free` / `mimo-v2.5-free` | 200K | 32-64K | high/max |
| `nemotron-3.5-lightning-free` / `nemotron-3-ultra-free` / `nemotron-3-super-free` | 200K–1M | 32-128K | high/max |
| `ling-3.0-flash-free` / `ling-3.0-tiny-free` / `ling-2.6-flash-free` | 200-262K | 16-32K | high/max |
| `laguna-s-2.1-free` | 256K | 32K | high/max |
| `ring-2.6-1t-free` | 1M | 128K | high/max |
| `north-mini-code-free` | 256K | 64K | high/max |
| `trinity-large-preview-free` | 200K | 64K | high/max |
| `hy3-free` / `hy3-preview-free` | 256K | 64K | high/max |
| `grok-code` | 256K | 128K | high/max |
| `big-pickle` | 200K | 32K | high/max |
| `longcat-2.0-free` | 200K | 32K | high/max |

> 免费模型清单来自公开目录快照，服务端可能轮换/下架（例如部分模型会返回 401/503），以实际可用为准。

## 🚨 免费额度说明（重要）

免费模型在服务端**无条件按 IP 每日限流**（源码 `handler.ts`：`allowAnonymous` 模型无论是否带 Key 都走 IP limiter）：

- 额度用尽 → `429` `{"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded..."}`
- 恢复方式：**更换出口 IP**（VPN / 手机热点 / 重拨宽带）立即恢复；或**等次日零点**自动重置
- 代理/VPN 环境下，出口 IP 以代理节点为准；家庭宽带 IPv4/IPv6 是两个独立出口额度

## 🧪 本地验证

```bash
# 匿名免费模型（Bearer public）
node scripts/verify-live.mjs deepseek-v4-flash-free

# 带 Key（从 ~/.dsh/.credentials.yaml 读取 OPENCODE_API_KEY）
node scripts/verify-live-keyed.mjs deepseek-v4-flash-free
```

## 📄 License

MIT
