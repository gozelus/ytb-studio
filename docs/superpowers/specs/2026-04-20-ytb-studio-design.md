# ytb-studio · 设计

**Date**: 2026-04-20
**Status**: Design (pending review)
**Repo**: https://github.com/gozelus/ytb-studio

## Context

把一个"有字幕的 YouTube 视频链接"变成一篇可读的中文深度文章，网页端即时可读，流式生成、排版讲究。

触发这个项目的是一份参考稿（「对话安德森：AI革命的万亿美金之问」，基于 `https://www.youtube.com/watch?v=xRh2sVcNXQ8` 生成），它展示了一种**编辑视角的改写**：章节 / 副章节 / 保留对话结构 / 中文编辑腔，不是直译。这是"产出质量"的标尺。

**为什么值得做**：现存工具要么只做字幕转文字（无结构）、要么是通用摘要（丢失对话感）。这个应用在"精读长视频"这个很窄的场景下做到极致。

**意图的副产物**：通过这次实现展示"技术审美"——模块划分是否克制、代码是否优雅、动效是否克制而有仪式感、错误态是否体贴、日志是否能支撑排障。

## Goals & Non-Goals

**In scope**
- 单页 Web 应用，部署到 Cloudflare Worker，公开可访问
- 两种改写模式：**深度改写**（默认）、**忠实翻译**
- 字幕来源：YouTube 手动字幕优先、自动字幕兜底、用户必须确认
- 流式生成：ndjson 结构化事件 → 段落级淡入动画 + 光标
- Dark / Light 双主题
- 日志可追溯（per-request id）

**Out of scope（刻意不做）**
- 无字幕视频的多模态处理（Gemini 直接读视频）
- 用户账户 / 历史 / 持久化存储
- 分享导出（浏览器自带 "保存 PDF" 即可）
- 多语言输出（只做中文）
- 移动端响应式优化（桌面 first，不为小屏专门改）
- 付费功能 / API 限流（YAGNI）

## User Flow

```
1. 打开页面 → Hero 态：居中 logo + 标题 + 输入框 + 模式选择
2. 粘贴 URL + 点击"生成"
3. Hero 淡出；左栏从左侧滑入；URL "收齐到顶部" pill；sparkle logo 缩到中心
4. 预处理 4 步（logo 持续旋转呼吸）：
     ① 连接视频   ② 解析字幕轨   ③ 下载字幕   ④ 唤醒 Gemini
5. ② 完成后若发现多条字幕：展开选择卡（手动字幕置顶带星标），用户选一条继续
6. ④ 完成、首 chunk 到达 → 转场动画：
     圆环发散 → 墨线画开 → H1 标题居中浮现 → 副标题淡入 → 全部消散
7. 文章主页浮出；事件流逐个以"段落级淡入 + 微虚化上滑" 1.1s 入场
     每个新段落末尾挂一根呼吸光标，表示"仍在流入"
8. 收到 end 事件 → 光标消失；顶栏 status pill: "完成"
9. 任何环节出错 → 暖琥珀色（非告警红）中断提示 + 行动按钮；已生成内容永不清除
```

## Architecture

单 CF Worker 承担前端派发 + 两个 API；无持久化。

```
┌──────────────────────────────────────┐
│  Cloudflare Worker (single entry)    │
│                                      │
│  GET  /*           → ASSETS          │
│  POST /api/inspect → youtube.ts      │
│  POST /api/generate→ youtube.ts      │
│                     + prompt.ts      │
│                     + gemini.ts      │
│                     + parser.ts      │
│                     → SSE stream     │
└──────────────────────────────────────┘
           ↕ fetch
    YouTube watch page + timedtext
           ↕ fetch (SSE)
    generativelanguage.googleapis.com
```

## Module Layout

```
ytb-studio/
├── wrangler.toml
├── package.json
├── src/
│   ├── index.ts          # Worker 入口；路由；统一错误响应
│   ├── youtube.ts        # URL→videoId · 抓 watch HTML · 解 captionTracks · 下载 timedtext · 清理时间码
│   ├── gemini.ts         # 调 Gemini streamGenerateContent SSE · 重试
│   ├── parser.ts         # 纯函数：ndjson 流 → Event[]；容错
│   ├── prompt.ts         # 两模式 prompt 模板 + few-shot；纯数据
│   └── types.ts          # 共享类型
├── public/
│   ├── index.html        # hero + rail + main 完整布局 + 内联 CSS
│   └── app.js            # 状态机 + fetch stream 消费 + DOM 渲染 + 动画挂载
├── tests/
│   ├── youtube.test.ts
│   ├── parser.test.ts
│   └── prompt.test.ts
└── docs/superpowers/specs/2026-04-20-ytb-studio-design.md   # 本文件
```

**职责边界**（每个文件单一职责）：

- `youtube.ts` 只懂 YouTube 页面结构；不碰 Gemini
- `gemini.ts` 只懂 Gemini 的 SSE；不碰 YouTube
- `parser.ts` 纯函数，无 IO
- `prompt.ts` 纯数据 + 模板函数，无 IO
- `index.ts` 路由编排 + 日志字段组装

## API Contract

### `POST /api/inspect`

一次性响应（非流）。从 URL 取视频元信息与字幕轨清单。**不消耗 Gemini 额度**。

```jsonc
// Request
{ "url": "https://youtu.be/xRh2sVcNXQ8" }

// Response 200
{
  "reqId": "a1f3e7",
  "videoId": "xRh2sVcNXQ8",
  "title": "The Trillion Dollar Questions of the AI Revolution",
  "channel": "a16z",
  "durationSec": 3502,
  "tracks": [
    { "id":"a.en",   "lang":"en", "label":"English", "kind":"manual", "tokenEstimate":12400 },
    { "id":"asr.en", "lang":"en", "label":"English", "kind":"auto",   "tokenEstimate":12100 },
    { "id":"asr.zh", "lang":"zh", "label":"中文",    "kind":"auto",   "tokenEstimate":14000 }
  ]
}

// Errors (4xx/5xx)
{ "reqId":"…", "error":"INVALID_URL"|"VIDEO_NOT_FOUND"|"NO_CAPTIONS"|"YOUTUBE_BLOCKED" }
```

### `POST /api/generate`

SSE 流式响应。

```
Request:
  { "url":"…", "trackId":"a.en", "mode":"rewrite"|"faithful" }

Response:
  Content-Type: text/event-stream
  Cache-Control: no-cache

Body (按 SSE 帧组织，每帧 data: 一个 ndjson event):
  data: {"type":"meta","reqId":"9d2b4c","title":"…","subtitle":"…","durationSec":3502}

  data: {"type":"h2","text":"技术革命：八十年一遇的AI巅峰"}

  data: {"type":"h3","text":"AI公司的收入增长与产品演变"}

  data: {"type":"p","speaker":"Jen","text":"目前 AI 公司……"}

  data: {"type":"p","speaker":"Mark","text":"新一波 AI 公司……"}

  data: {"type":"end"}

错误:
  data: {"type":"error","code":"GEMINI_TIMEOUT","message":"…"}
  (close)
```

**为何选 SSE 包裹 ndjson**：
1. DevTools Network 可读性极佳，调试成本低
2. 行边界明确（`\n\n`），客户端解析器 20 行搞定
3. 服务端与客户端都不用自创协议

**为何不用 `EventSource`**：EventSource 只支持 GET、无法自定义 header。前端走 `fetch + ReadableStream.getReader()` 手读即可。

## Event Schema

```ts
type Event =
  | { type: 'meta';  reqId: string; title: string; subtitle: string; durationSec: number }
  | { type: 'h2';    text: string }
  | { type: 'h3';    text: string }
  | { type: 'p';     speaker: string | null; text: string }
  | { type: 'end' }
  | { type: 'error'; code: string; message: string }
```

**契约承诺**：
- `meta` 必然第一个（用于触发转场动画）
- `end` 必然最后一个（用于判定自然结束 vs 中断）
- 连接关闭且未收到 `end` = 流中断
- `p.speaker` 缺失时用 `null`（模型推断不出说话人时）

## Prompt Design

**模型**：`gemini-2.5-flash`（env `GEMINI_MODEL` 可覆盖）

**不使用** Gemini 的 `responseSchema`——那会强制完整 JSON 返回，破坏流式。改为**自由文本 + 强约束 prompt + 容错 parser**。

**Prompt 分段**：

1. **Role & contract**：声明"中文科技编辑"身份；强调"只输出 ndjson，禁止 markdown 围栏"
2. **Event schema**：把上面 6 种事件类型以 JSON 示例列全
3. **Mode rules**：
   - `rewrite`：5–10 个 h2 大章节（「主题：副题」格式）、每章 2–5 个 h3；保留说话人；合并碎句；必要处加衔接（speaker=null）；风格对齐晚点/虎嗅
   - `faithful`：无 h2；仅在话题转折处 h3；保留 Q&A 原貌；只翻译不改写
4. **Speaker inference**：字幕无讲话人标签，从 Q&A 结构推断；优先使用视频标题/描述里能看出的姓名；否则 `Host`/`Guest`/`Speaker A`
5. **Few-shot**：3 组 input → ndjson 对照，覆盖"多讲话人"、"说话人不明"、"话题转折"三种 edge case
6. **Video meta + transcript**：结构化地注入

**Prompt 版本号**：代码里常量 `PROMPT_VERSION = "v1"`，日志里写出，方便回溯 bug 归属。

**Transcript 预处理**（在 Worker 里做，送进 Gemini 前）：
- timedtext XML / VTT → 纯文本
- 去时间戳、去空白噪声
- 按句末标点和停顿合并为段（每段 20–80 字左右）

## Streaming & Rendering

**Worker 端**：
```
YouTube transcript
   ↓ (preprocess)
prompt.ts 组装
   ↓
gemini.ts 发起 streamGenerateContent (SSE)
   ↓ token chunks
parser 增量拼 JSON 行（等 \n）
   ↓ (valid) 每行事件
以 SSE data: line 的形式转发给浏览器
```

**浏览器端**（`public/app.js`）：

```js
const res = await fetch('/api/generate', ...)
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {     // SSE frame boundary
    const frame = buf.slice(0, i); buf = buf.slice(i + 2)
    const payload = frame.replace(/^data:\s*/, '')
    if (!payload) continue
    const event = safeParseJson(payload)
    if (event) dispatchEvent(event)              // 渲染
  }
}
```

**渲染策略**（方案 2·结构化事件流）：

| Event | DOM 动作 | 动画 |
|---|---|---|
| `meta`     | 设 `<title>`；填 reveal 的 H1/副标 | 触发 reveal 序列（圆环 → 墨线 → H1 → 副标 → 消散） |
| `h2`       | 文章区 `<h2>` 追加 | 段落级 `fade-node` |
| `h3`       | 文章区 `<h3>` 追加 | 同上 |
| `p`        | 文章区 `<p>` 追加，内嵌 `<span class=sp>Jen：</span>` + 文本 + 呼吸 `<span class=caret>` | 淡入；caret 跟随最新 p |
| `end`      | 移除 caret；status pill → "完成" | 无 |
| `error`    | 插入"暖琥珀"中断块 + 行动按钮；保留已有内容 | 无 |

**动画语言**：所有新节点统一 `opacity 0 + translateY 6px + blur 3px` → `opacity 1 + 无位移 + blur 0`，1.1s `cubic-bezier(.22,1,.36,1)` 曲线。节奏：每 `p` 约 1.2–1.4s 间隔（给阅读呼吸），`h3` ~0.85s，`h2` ~1.4s。

## Error Handling

### 分类

| 位置 | 典型错误 | 自动重试 |
|---|---|---|
| 用户输入 | 格式非法、非 YouTube | 否（客户端拦） |
| Inspect | 404、无字幕、网络闪断 | 闪断重试 1 次（延迟 500ms） |
| Generate 前 | timedtext 失效、Gemini 401/429/5xx、首 chunk 前超时 | 首 chunk 前：429 指数退避 1s→3s 最多 2 次；网络错 1 次；401/quota 不重试 |
| Generate 流中 | 流断、malformed 行、安全拦截 | **不重试**，避免已读内容重复 |
| 用户主动 | 取消 | 静默结束 |

### UX 呈现

**a. Hero 态输入错误**：输入框下方长出一行小字 `"这不像是 YouTube 链接"`；logo 不启动。

**b. Prep 阶段失败**（未进入流式）：失败步骤的圆点变**暖琥珀静止**、meta 换为错因；logo 停止呼吸；下方两按钮 `换视频` / `重试`；req id 小字显示。

**c. 流中失败**：**不清空已读内容**。在最后一段之下长出一条暖琥珀细横线，线下小字注明错因与进度百分比，两按钮 `重新生成完整版` / `保留此片段`（仅关闭错误提示）。

**顶栏 status pill** 全程同步：`连接视频` / `解析字幕` / `生成中` / **`⚠ 已中断`**。

**无声重试**：Worker 内重试对 UI 不可见，不闪烁、不变 status，彻底失败才浮现。

**错误配色**：暖琥珀 `#e8a06f`（非告警红），与整体 Dark 主题的米白 `#d9cfb2` 协调；断裂墨线与正常排版语言一致。

## Observability

**per-req id**：`/api/inspect` 或 `/api/generate` 进来即生成 6 位 base32 `reqId`，贯穿整条链路：日志每行、meta event、错误 UI 都带。

**结构化日志**（`console.log` 单行 JSON）：

```jsonc
{"ts":"...","reqId":"a1f3e7","route":"/api/generate","phase":"start","url":"...","mode":"rewrite","trackId":"a.en"}
{"ts":"...","reqId":"a1f3e7","phase":"youtube.fetch","durMs":420,"videoId":"xRh2s…"}
{"ts":"...","reqId":"a1f3e7","phase":"caption.download","durMs":180,"bytes":34221}
{"ts":"...","reqId":"a1f3e7","phase":"gemini.first","durMs":1800,"retries":0}
{"ts":"...","reqId":"a1f3e7","phase":"done","durMs":54200,"events":87,"tokens":{"in":12400,"out":8900}}
```

错误行加 `level:"error"` + `code` 字段。

**刻意不做**：不打字幕原文、不打 prompt 原文、不打 API key、不做客户端埋点、不搭 Logpush。

**排障通路**：
- 开发：`wrangler tail --format=pretty`
- 线上：Cloudflare Dashboard → Workers → Logs（近 1h 免费）
- 用户报 bug：截图带 reqId → `wrangler tail --format=json | grep <reqId>` 即拉上下文

**模型侧**：每次 Gemini 调用完把 `finishReason`（STOP / SAFETY / MAX_TOKENS）写日志；429/5xx 重试次数也写。

## Deployment

`wrangler.toml`：

```toml
name = "ytb-studio"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "public"
binding = "ASSETS"

[observability]
enabled = true
```

**Secrets**：
- 本地：`.dev.vars`（已 gitignore）放 `GEMINI_API_KEY=…`
- 线上：`npx wrangler secret put GEMINI_API_KEY`
- 代码里通过 `env.GEMINI_API_KEY` 读取，绝不出现明文

**命令**：
- `npx wrangler dev` — 本地 http://localhost:8787（带 hot reload）
- `npx wrangler deploy` — 推到 `ytb-studio.<account>.workers.dev`
- `npx wrangler tail` — 实时日志

**Worker 限制**：
- 免费档 CPU 10ms/请求；SSE 流的连接时长不计入 CPU
- Worker 主体是转发 + 轻量解析，CPU 压力集中在 timedtext XML→纯文本预处理（通常 <5ms）
- 如未来遇到 CPU 超限，升级付费档（CPU 30s），代码零改动

## Testing

**原则**：测脆弱、测关键、不测显而易见。不追求覆盖率。

| 模块 | 测什么 | 怎么测 |
|---|---|---|
| `youtube.ts` URL 解析 | 10+ 合法/非法 URL（`youtu.be/ID`、`watch?v=ID&t=`、shorts、embed） | vitest 纯函数 |
| `youtube.ts` HTML 解析 | 从 `ytInitialPlayerResponse` 抠 `captionTracks`；fixture HTML 离线跑 | vitest + fixture |
| `parser.ts` ndjson | 合法 / 空行 / 半截 JSON / 非 JSON 噪声 / 超长 | vitest 纯函数，边界齐 |
| `prompt.ts` | 两模式 prompt 字段完整；transcript 注入正确 | 快照测试 |
| 端到端 | 金标视频 xRh2sVcNXQ8 的 inspect + generate 跑通 | 手动 smoke（部署前） |

**框架**：`vitest` + `@cloudflare/vitest-pool-workers`（官方 pool，让测试跑在真 Worker runtime）。

**不测**：Gemini 响应（外部）、动画（人眼）、UI 布局（浏览器）。

## Verification (End-to-End)

部署后用以下步骤验证是否达成目标：

1. 浏览器打开 `https://ytb-studio.<account>.workers.dev` → Hero 态可见、sparkle logo 呼吸旋转正常
2. 粘贴 `https://www.youtube.com/watch?v=xRh2sVcNXQ8` → 点"生成"
3. 观察：Hero 淡出 → 左栏从左滑入 → URL pill 从顶部下沉 → prep 四步依次点亮
4. 字幕选择卡出现 → 选"English · 手动" → Gemini 唤醒
5. 转场动画完整播放（圆环 + 墨线 + 标题浮现）→ 文章开始段落级淡入
6. 章节标题、说话人前缀、段落节奏应贴近参考稿「对话安德森：AI革命的万亿美金之问」
7. 切主题 Dark ↔ Light 平滑
8. 手动断网模拟流中中断 → 出现暖琥珀中断块 + 行动按钮，已读内容保留
9. `wrangler tail` 看到 per-req 的 5 条结构化日志，phase 与时长合理

## Prompt Version

本设计对应 `PROMPT_VERSION = "v1"`。

## Open Questions (可在实现阶段确定)

- few-shot 的 3 组具体样例内容（暂从参考稿抽 3 段即可）
- Worker 免费档 CPU 时间的实际压测结果（真实 60min 视频跑一次看日志）
- Hero 的 slogan 文案（`"把 YouTube 对话，变成一篇可读的中文文章"` 是占位，后续可调）

## Mockups

- `demo-v2.html`（完整交互原型：hero → 预处理 → 字幕选择 → 转场 → 流式出文 + 暗/亮主题切换）
- `error-states.html`（prep 失败 + 流中中断两种错误态）

位置：`.superpowers/brainstorm/<session>/` — 仅 brainstorm 期保留，不入 git。
