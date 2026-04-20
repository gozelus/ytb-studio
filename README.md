# ytb-studio

把 YouTube 视频转成中文可读文章的 Cloudflare Worker，由 Gemini AI 驱动。

## Features

- 输入一个 YouTube 链接，直接使用 Gemini `fileData.fileUri` 读取视频内容。
- 生成中文长文章，并用 SSE 一边生成一边渲染。
- 长视频自动 fallback 为 Gemini `videoMetadata` 分段处理，不抓取 YouTube。
- `SHARECODE` 门禁用于降低公网暴露后 API key 被滥用的风险。
- 部署目标是 Cloudflare Workers + Workers Assets，无额外后端服务。

## Prerequisites

- Node.js 20+。
- 一个 Cloudflare 账号，并已登录 Wrangler：`npx wrangler login`。
- 一个 Google AI Studio / Gemini API key。
- 一个自定义 `SHARECODE`。建议使用高熵随机字符串，不要使用可猜测短词。

## Quick Start

```bash
git clone https://github.com/gozelus/ytb-studio.git
cd ytb-studio
npm install
cp dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```bash
GEMINI_API_KEY=your-gemini-api-key-here
SHARECODE=your-private-sharecode
```

启动本地开发：

```bash
npm run dev
```

打开 `http://localhost:8787`。首次访问会要求输入 `SHARECODE`；也可以用分享链接自动写入：

```text
http://localhost:8787/?sharecode=your-private-sharecode
```

运行测试：

```bash
npm test
npx tsc --noEmit
```

## Configuration

### Required Secrets

生产环境必须配置两个 Cloudflare secrets：

```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put SHARECODE
```

`SHARECODE` 不应该写进仓库。代码在缺少 `SHARECODE` 时会 fail closed，所有 API 请求都会返回 `无效的 sharecode`。

### Model Fallback

默认自动按优先级级联 fallback：`gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.5-pro`

```toml
[vars]
GEMINI_MODELS = "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.5-pro"
```

当前 model 503 / 过载 / quota 时自动切换下一个，用户无感。顺序是"快 → 便宜 → 高能"，大多数用户不需要改。

单模型兼容：旧的 `GEMINI_MODEL = "gemini-2.5-flash"` 仍然有效（只用该单一模型）。

> **需要付费 Gemini tier**：免费档限 20 req/day，不够正常使用。
> 在 Google AI Studio 开启 billing 后同一个 key 即解除限制。

### Long Video Fallback

长视频仍然只走 Gemini fileData，不抓取 YouTube。整段请求 75 秒仍没有首字节时会主动切到分段；默认先跑一个 300 秒快速首段，让文章尽早开始显示，再按 900 秒继续补全：

```toml
[vars]
LONG_VIDEO_FIRST_SEGMENT_SECONDS = "300"
LONG_VIDEO_SEGMENT_SECONDS = "900"
LONG_VIDEO_MAX_SEGMENTS = "16"
```

超过上限时前端会保留已生成片段，并提示 `GEMINI_LONG_VIDEO_LIMIT`。

## How It Works

1. `/api/inspect` 先校验 `SHARECODE`，再校验 YouTube URL 并解析 videoId，不访问 YouTube
2. `/api/generate` 先校验 `SHARECODE`，再把用户输入的 YouTube URL 作为 Gemini `fileData.fileUri`
3. 默认用低媒体分辨率和低 FPS 降低长视频 token；若仍超出上下文，再用 `videoMetadata` 按时间片分段直读
4. Gemini 流式输出中文文章，以 SSE ndjson 事件流返回前端

## Deploy to Cloudflare Workers

1. 安装依赖并登录 Cloudflare：

```bash
npm install
npx wrangler login
```

2. 配置生产 secrets：

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SHARECODE
```

3. 如果你 fork 了此项目，先修改 `wrangler.toml` 里的 Worker 名称：

```toml
name = "your-worker-name"
workers_dev = true
```

4. 部署：

```bash
npm run deploy -- --keep-vars
```

`--keep-vars` 可以避免误删 Dashboard 中手工配置的非 secret vars；secrets 不会被普通 deploy 删除。

5. 验证：

- `https://your-worker-name.<your-subdomain>.workers.dev`

### Optional Custom Domain

如果你的域名已经托管在 Cloudflare，可以把 Worker 绑定到自定义域名：

```bash
npm run deploy -- --keep-vars --domain your-domain.com
```

也可以把域名写入 `wrangler.toml`，让以后每次 deploy 都同步 trigger：

```toml
workers_dev = true
routes = [
  { pattern = "your-domain.com", custom_domain = true },
]
```

不要把不属于你的真实域名提交到 fork 的默认配置里。`workers_dev = true` 用来保留 `workers.dev` 访问地址；否则 Wrangler 在存在 routes 时可能关闭 workers.dev trigger。

## Sharecode Security Model

- `SHARECODE` 是共享 bearer token，不是用户级账号系统。
- 前端会把 token 保存在 `localStorage`，并通过 `x-sharecode` header 发送给后端。
- 带 `?sharecode=` 的链接方便转发，但 token 会出现在地址栏、浏览器历史记录和首个 HTML 请求日志里。
- 页面使用 `Referrer-Policy: no-referrer`，避免后续资源请求继续携带完整 URL。
- 如果 sharecode 泄露，请轮换 Cloudflare secret：

```bash
npx wrangler secret put SHARECODE
npm run deploy -- --keep-vars
```

## Project Structure

- `src/index.ts`：Cloudflare Worker 入口。
- `src/routes.ts`：API 路由、鉴权、请求校验。
- `src/gemini-video.ts`：整段 Gemini fileData 生成路径。
- `src/long-video.ts`：长视频分段 fallback。
- `src/video-ndjson.ts`：把 Gemini 流解析成前端事件。
- `src/prompt.ts`：文章结构与输出协议 prompt。
- `public/app.js`：前端状态机。
- `public/article-renderer.js`：文章渲染与 speaker turn 聚合。
- `public/article-tail.js`：文章尾部生成状态。
- `tests/`：Worker API、parser、prompt、前端渲染单元测试。

## Known Limitations

- 私密、年龄限制、地区不可用或 Gemini 不支持的视频可能无法直读；前端会显示对应的 Gemini 错误。
- 超长视频会触发分段兜底；处理时间和 Gemini 用量会随分段数线性增加。
- 生成内容依赖 Gemini 对视频的理解能力；同一个视频在不同模型或重试时可能有轻微差异。
