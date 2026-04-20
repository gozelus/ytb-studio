# ytb-studio

把 YouTube 视频转成中文可读文章的 Cloudflare Worker，由 Gemini AI 驱动。

## 配置

只需要一个 Gemini API key：

```bash
wrangler secret put GEMINI_API_KEY
```

### 模型配置（鲁棒推荐）

默认自动按优先级级联 fallback：`gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.5-pro`

```toml
[vars]
GEMINI_MODELS = "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.5-pro"
```

当前 model 503 / 过载 / quota 时自动切换下一个，用户无感。顺序是"快 → 便宜 → 高能"，大多数用户不需要改。

单模型兼容：旧的 `GEMINI_MODEL = "gemini-2.5-flash"` 仍然有效（只用该单一模型）。

> **需要付费 Gemini tier**：免费档限 20 req/day，不够正常使用。
> 在 Google AI Studio 开启 billing 后同一个 key 即解除限制。

## 工作方式

1. `/api/inspect` 只校验 YouTube URL 并解析 videoId，不访问 YouTube
2. `/api/generate` 把用户输入的 YouTube URL 作为 Gemini `fileData.fileUri`
3. 默认用低媒体分辨率和低 FPS 降低长视频 token；若仍超出上下文，再用 `videoMetadata` 按时间片分段直读
4. Gemini 流式输出中文文章，以 SSE ndjson 事件流返回前端

### 长视频配置

长视频仍然只走 Gemini fileData，不抓取 YouTube。整段请求 75 秒仍没有首字节时会主动切到分段；默认先跑一个 300 秒快速首段，让文章尽早开始显示，再按 900 秒继续补全：

```toml
[vars]
LONG_VIDEO_FIRST_SEGMENT_SECONDS = "300"
LONG_VIDEO_SEGMENT_SECONDS = "900"
LONG_VIDEO_MAX_SEGMENTS = "16"
```

超过上限时前端会保留已生成片段，并提示 `GEMINI_LONG_VIDEO_LIMIT`。

## 本地开发

```bash
cp dev.vars.example .dev.vars   # 填入 GEMINI_API_KEY
npm run dev                      # wrangler dev
npm test                         # vitest
```

## 部署

```bash
wrangler secret put GEMINI_API_KEY
wrangler deploy
```

## Known Limitations

- 私密、年龄限制、地区不可用或 Gemini 不支持的视频可能无法直读；前端会显示对应的 Gemini 错误。
- 超长视频会触发分段兜底；处理时间和 Gemini 用量会随分段数线性增加。
