# ytb-studio

把 YouTube 视频转成中文可读文章的 Cloudflare Worker。

## 工作原理

1. `/api/inspect` — 解析 YouTube URL，抓取字幕轨道列表并计算 token 数
2. `/api/generate` — 下载字幕、构造 prompt、流式调用 LLM，以 SSE 返回 ndjson 事件流

## 配置 LLM 提供商

在 `wrangler.toml` 的 `[vars]` 中（或生产环境用 Wrangler secrets）设置以下变量：

### OpenRouter（推荐）

OpenRouter 支持统一 API 访问多家模型，免去管理多个 key 的麻烦。

```toml
[vars]
LLM_PROVIDER = "openrouter"
LLM_MODEL    = "google/gemini-2.5-flash"   # 或 anthropic/claude-sonnet-4-5 等
```

```bash
wrangler secret put LLM_API_KEY   # 粘贴 OpenRouter API key
```

### Google Gemini

```toml
[vars]
LLM_PROVIDER = "google"
LLM_MODEL    = "gemini-2.5-flash"
```

```bash
wrangler secret put LLM_API_KEY   # Google AI Studio API key
```

> **向后兼容**：也可直接设置 `GEMINI_API_KEY`（不需要 `LLM_PROVIDER`），行为等同于上面的 google 配置。

### OpenAI

```toml
[vars]
LLM_PROVIDER = "openai"
LLM_MODEL    = "gpt-4o"
```

```bash
wrangler secret put LLM_API_KEY   # OpenAI API key
```

### Anthropic

```toml
[vars]
LLM_PROVIDER = "anthropic"
LLM_MODEL    = "claude-sonnet-4-5"
```

```bash
wrangler secret put LLM_API_KEY   # Anthropic API key
```

### 自定义 Base URL

所有提供商都支持 `LLM_BASE_URL` 覆盖默认端点（例如代理或私有部署）：

```toml
[vars]
LLM_BASE_URL = "https://my-proxy.example.com/v1"
```

## 本地开发

```bash
cp dev.vars.example .dev.vars   # 填入 API key
npm run dev                      # wrangler dev
npm test                         # vitest
```

## 部署

```bash
wrangler deploy
```

## 已知限制

Cloudflare Workers 边缘 IP 被 YouTube 反爬系统拦截（429 / 无效 playerResponse），
因此 `/api/inspect` 在无法抓取 watch page 时返回 `502 YOUTUBE_BLOCKED`。
这是平台层面的限制，无法在 Worker 内部绕开。
