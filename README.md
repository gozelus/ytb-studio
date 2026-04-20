# ytb-studio

把 YouTube 视频转成中文可读文章的 Cloudflare Worker，由 Gemini AI 驱动。

## 配置

只需要一个 Gemini API key：

```bash
wrangler secret put GEMINI_API_KEY
```

可选：指定模型（默认 `gemini-2.5-flash`）：

```toml
[vars]
GEMINI_MODEL = "gemini-2.5-flash"   # 或 gemini-2.5-pro
```

> **需要付费 Gemini tier**：免费档限 20 req/day，不够正常使用。
> 在 Google AI Studio 开启 billing 后同一个 key 即解除限制。

## 工作方式

1. `/api/inspect` 尝试从 CF 边缘抓取 YouTube watch 页面
2. CF 边缘 IP 通常被 YouTube 拦截 → 自动切换到 **Gemini fileData 路径**
3. `/api/generate` 把 YouTube URL 作为 fileData 喂给 Gemini，由 Google 自家 IP 拉取视频和字幕
4. Gemini 流式输出中文文章，以 SSE ndjson 事件流返回前端

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

- **CF Workers `startTls` on SOCKS5 tunnels**：CF Workers 的 `connect()` API 支持 `secureTransport:'starttls'`，但在先完成 SOCKS5 握手再升级 TLS 的场景下，`startTls()` 的 TLS 握手会失败（"TLS Handshake Failed"）。这是 CF Workers runtime 的已知限制，非代码 bug。
  因此，通过 SOCKS5 住宅代理绕过 YouTube IP 封锁的方案不可行；改用 Gemini fileData 让 Google 自家服务器拉取视频是目前唯一可靠路径。
