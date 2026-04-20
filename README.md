# ytb-studio

把 YouTube 视频转成中文可读文章的 Cloudflare Worker。

## 工作原理

1. `/api/inspect` — 解析 YouTube URL，抓取字幕轨道列表并计算 token 数
2. `/api/generate` — 下载字幕、构造 prompt、流式调用 LLM，以 SSE 返回 ndjson 事件流

## 部署行为矩阵

Cloudflare Workers 边缘 IP 经常被 YouTube 限流（429 / 无字幕数据）。
下表说明不同配置组合下的行为：

| LLM 提供商 | 配置了 PROXY_URLS | 未配置 PROXY_URLS |
|---|---|---|
| `google`（Gemini） | ✅ 通过代理正常抓取；失败可 Gemini 直读兜底 | 抓取失败 → **自动切换 Gemini 直读**（前端显示警告 banner） |
| `openai` / `openrouter` / `anthropic` | ✅ 通过代理正常抓取 | 抓取失败 → **硬错误 `PROXY_REQUIRED`**，需配置代理或换 google provider |

**结论**：最省事的部署是 `LLM_PROVIDER=google`（无需代理，Gemini 自己拉视频）；
追求最高质量字幕则配 `PROXY_URLS`（任何 provider 都可用真实字幕）。

## 配置 LLM 提供商

在 `wrangler.toml` 的 `[vars]` 中（或生产环境用 `wrangler secret put`）设置：

### OpenRouter（推荐，需配 PROXY_URLS）

```toml
[vars]
LLM_PROVIDER = "openrouter"
LLM_MODEL    = "google/gemini-2.5-flash"   # 或 anthropic/claude-sonnet-4-5 等
```

```bash
wrangler secret put LLM_API_KEY   # OpenRouter API key
```

### Google Gemini（无代理也可用）

```toml
[vars]
LLM_PROVIDER = "google"
LLM_MODEL    = "gemini-2.5-flash"
```

```bash
wrangler secret put LLM_API_KEY   # Google AI Studio API key
```

> **向后兼容**：也可直接设置 `GEMINI_API_KEY`（不需要 `LLM_PROVIDER`），行为等同于 google 配置。

### OpenAI

```toml
[vars]
LLM_PROVIDER = "openai"
LLM_MODEL    = "gpt-4o"
```

```bash
wrangler secret put LLM_API_KEY
```

### Anthropic

```toml
[vars]
LLM_PROVIDER = "anthropic"
LLM_MODEL    = "claude-sonnet-4-5"
```

```bash
wrangler secret put LLM_API_KEY
```

### 自定义 Base URL

```toml
[vars]
LLM_BASE_URL = "https://my-proxy.example.com/v1"
```

## 配置 SOCKS5 代理（可选）<a name="proxy-setup"></a>

如使用非 google provider，或希望获取真实字幕而非 Gemini 直读，需配置住宅静态 IP 代理。

推荐：[iproyal](https://iproyal.com) Static Residential Proxies（按量计费，$2.4/GB 起）。

### 注册与获取凭证

1. 注册 iproyal 账号，购买 Static Residential 套餐
2. 在控制台创建代理凭证，选择 **SOCKS5** 协议
3. 复制多个 endpoint（不同 IP），格式为：
   ```
   socks5h://<user>:<pass>@<host>:<port>
   ```

### 注入到 Worker

```bash
# 多个 endpoint 用换行分隔（单行也可以，用 PROXY_URL）
printf 'socks5h://user:pass@host1:1234\nsocks5h://user:pass@host2:1234' \
  | wrangler secret put PROXY_URLS
```

Worker 会**顺序重试**每个 endpoint，失败才换下一个（不并发，节省连接额度）。

### 本地测试代理连通性

```bash
# 用 curl 验证代理能拉到 YouTube watch page
curl -x socks5h://user:pass@host:port \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  -s "https://www.youtube.com/watch?v=dQw4w9WgXcQ" | grep -o '"videoId":"[^"]*"'
```

成功应输出 `"videoId":"dQw4w9WgXcQ"`。

## 本地开发

```bash
cp dev.vars.example .dev.vars   # 填入 API key（和可选的 PROXY_URLS）
npm run dev                      # wrangler dev
npm test                         # vitest
```

## 部署

```bash
wrangler deploy
```
