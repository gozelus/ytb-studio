# ytb-studio Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建单 Cloudflare Worker 应用，将"有字幕的 YouTube 视频"流式转写为精排中文文章。

**Architecture:** 一个 Worker 托管静态前端 + 两个 API（`POST /api/inspect` 一次性返回字幕轨清单，`POST /api/generate` 以 SSE 流式返回 ndjson 事件）。Gemini 2.5 Flash 通过结构化 prompt 输出 6 种事件类型（meta/h2/h3/p/end/error），前端按事件声明式构建 DOM 并挂载段落级淡入动画。

**Tech Stack:** TypeScript + Cloudflare Workers + Wrangler + `@cloudflare/vitest-pool-workers` + Gemini 2.5 Flash API（`streamGenerateContent` + `countTokens`）

**Spec:** [`docs/superpowers/specs/2026-04-20-ytb-studio-design.md`](../specs/2026-04-20-ytb-studio-design.md)

---

## File Structure

```
ytb-studio/
├── wrangler.toml                              # CF Worker 配置
├── package.json                               # deps + scripts
├── tsconfig.json                              # TypeScript 配置
├── vitest.config.ts                           # 测试配置
├── .dev.vars                                  # 本地密钥（gitignored）
├── src/
│   ├── index.ts                               # Worker 入口；路由；统一错误响应；日志字段组装
│   ├── types.ts                               # 共享类型（Event/CaptionTrack/Mode/...）
│   ├── parser.ts                              # 纯函数：ndjson → Event[]；容错丢弃
│   ├── prompt.ts                              # 纯数据：两模式 prompt 模板 + few-shot
│   ├── youtube.ts                             # URL→videoId · 抓 watch · 解 captionTracks · 下 timedtext · 清时间码
│   └── gemini.ts                              # streamGenerateContent SSE 客户端 + countTokens + 重试 + AbortController + keepalive
├── public/
│   ├── index.html                             # Hero + rail + main 完整布局 + 所有 CSS
│   └── app.js                                 # 前端状态机 + fetch 流消费 + DOM 渲染 + 动画挂载
├── tests/
│   ├── parser.test.ts
│   ├── prompt.test.ts
│   ├── youtube.test.ts
│   ├── gemini.test.ts
│   └── fixtures/
│       └── watch-xRh2sVcNXQ8.html             # 离线 watch 页 snapshot
└── docs/superpowers/
    ├── specs/2026-04-20-ytb-studio-design.md  # 设计（已存在）
    └── plans/2026-04-20-ytb-studio.md         # 本文件
```

**Responsibility boundaries:**
- `types.ts` 被所有模块 import，不 import 任何业务模块（避免环）
- `parser.ts`、`prompt.ts` 为**纯函数**，无 IO，无 fetch，极易单测
- `youtube.ts` 只懂 YouTube 页面结构；不触碰 Gemini
- `gemini.ts` 只懂 Gemini 协议；不触碰 YouTube
- `index.ts` 是唯一的编排层：路由 + 调模块 + 组日志

---

## Chunk 1: Bootstrap + 纯模块

### Task 1: 项目骨架 + deps + 空 Worker

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`
- Create: `src/index.ts` (最小占位)
- Create: `public/index.html` (最小占位)
- Modify: `.gitignore`

- [ ] **Step 1: 初始化 package.json + 装 deps**

```bash
cd /Users/zhengli/Desktop/ytb-studio
npm init -y
npm install --save-dev \
  wrangler@latest \
  typescript@^5.6 \
  @cloudflare/workers-types@latest \
  @cloudflare/vitest-pool-workers@latest \
  vitest@^2
```

Expected: `package.json` 与 `node_modules/` 出现，无 error。

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: 写 wrangler.toml**

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

- [ ] **Step 4: 写 vitest.config.ts**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
})
```

- [ ] **Step 5: 写最小 Worker 入口**

`src/index.ts`：
```ts
export interface Env {
  GEMINI_API_KEY: string
  ASSETS: Fetcher
  GEMINI_MODEL?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'NOT_IMPLEMENTED' }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      })
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
```

- [ ] **Step 6: 写最小 index.html**

`public/index.html`：
```html
<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"><title>ytb-studio</title></head>
<body><p>bootstrap ok</p></body></html>
```

- [ ] **Step 7: 更新 .gitignore**

追加：
```
node_modules/
.dev.vars
.wrangler/
```

- [ ] **Step 8: 加 npm scripts 到 package.json**

把 `scripts` 节点改为：
```json
"scripts": {
  "dev": "wrangler dev",
  "deploy": "wrangler deploy",
  "test": "vitest run",
  "test:watch": "vitest",
  "tail": "wrangler tail --format=pretty"
}
```

- [ ] **Step 9: 本地 smoke test**

Run: `npm run dev`
Expected: `⎔ Starting local server...`，浏览器访问 `http://localhost:8787` 见 "bootstrap ok"。
关闭 dev server（Ctrl+C）继续。

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json wrangler.toml vitest.config.ts src/index.ts public/index.html .gitignore
git commit -m "chore: scaffold cloudflare worker + vitest"
```

---

### Task 2: `src/types.ts` — 共享类型

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: 写 types**

```ts
export type Mode = 'rewrite' | 'faithful'

export type CaptionKind = 'manual' | 'auto'

export interface CaptionTrack {
  id: string
  lang: string
  label: string
  kind: CaptionKind
  baseUrl: string       // timedtext URL（对外不暴露，仅 Worker 内部使用）
  tokens?: number       // 由 Gemini countTokens 填充，可选
}

export interface VideoMeta {
  videoId: string
  title: string
  channel: string
  durationSec: number
}

export type StreamEvent =
  | { type: 'meta';  reqId: string; title: string; subtitle: string; durationSec: number }
  | { type: 'h2';    text: string }
  | { type: 'h3';    text: string }
  | { type: 'p';     speaker: string | null; text: string }
  | { type: 'end' }
  | { type: 'error'; code: string; message: string }

export type ErrorCode =
  | 'INVALID_URL'
  | 'VIDEO_NOT_FOUND'
  | 'NO_CAPTIONS'
  | 'YOUTUBE_BLOCKED'
  | 'GEMINI_AUTH'
  | 'GEMINI_RATE_LIMIT'
  | 'GEMINI_QUOTA'
  | 'GEMINI_SAFETY'
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_STREAM_DROP'
  | 'INTERNAL'
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): shared types for worker + events"
```

---

### Task 3: `src/parser.ts` — ndjson 容错解析器（TDD）

**Files:**
- Create: `tests/parser.test.ts`
- Create: `src/parser.ts`

- [ ] **Step 1: 写失败测试**

`tests/parser.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { createNdjsonParser } from '../src/parser'

describe('ndjson parser', () => {
  it('emits one event per valid JSON line', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('{"type":"h2","text":"A"}\n{"type":"h3","text":"B"}\n')
    expect(events).toEqual([
      { type: 'h2', text: 'A' },
      { type: 'h3', text: 'B' },
    ])
  })

  it('buffers partial lines across feeds', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('{"type":"h2",')
    p.feed('"text":"X"}\n')
    expect(events).toEqual([{ type: 'h2', text: 'X' }])
  })

  it('drops invalid JSON lines with warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('not json\n{"type":"h2","text":"ok"}\n{broken\n')
    expect(events).toEqual([{ type: 'h2', text: 'ok' }])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores empty lines', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('\n\n{"type":"end"}\n\n')
    expect(events).toEqual([{ type: 'end' }])
  })

  it('flushes remaining buffer on end()', () => {
    const events: any[] = []
    const p = createNdjsonParser(e => events.push(e))
    p.feed('{"type":"h2","text":"no-newline"}')
    p.end()
    expect(events).toEqual([{ type: 'h2', text: 'no-newline' }])
  })
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- parser`
Expected: FAIL（`createNdjsonParser is not a function`）。

- [ ] **Step 3: 实现 parser**

`src/parser.ts`：
```ts
import type { StreamEvent } from './types'

export interface NdjsonParser {
  feed(chunk: string): void
  end(): void
}

const VALID_TYPES = new Set(['meta', 'h2', 'h3', 'p', 'end', 'error'])

export function createNdjsonParser(
  onEvent: (e: StreamEvent) => void,
  onWarn: (msg: string, line: string) => void = (m, l) => console.warn(m, l),
): NdjsonParser {
  let buf = ''
  let warnCount = 0

  function processLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    if (!trimmed.startsWith('{')) return warn('parser.skip.not_object', trimmed)
    let obj: any
    try { obj = JSON.parse(trimmed) } catch { return warn('parser.skip.invalid_json', trimmed) }
    if (typeof obj?.type !== 'string' || !VALID_TYPES.has(obj.type)) {
      return warn('parser.skip.unknown_type', trimmed)
    }
    onEvent(obj as StreamEvent)
  }

  function warn(msg: string, line: string) {
    warnCount++
    if (warnCount <= 5) onWarn(msg, line)
    else if (warnCount === 6) onWarn('parser.warn.suppressed_further', '')
  }

  return {
    feed(chunk: string) {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        processLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    },
    end() {
      if (buf) { processLine(buf); buf = '' }
    },
  }
}
```

- [ ] **Step 4: 验证测试通过**

Run: `npm test -- parser`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add tests/parser.test.ts src/parser.ts
git commit -m "feat(parser): tolerant ndjson stream parser"
```

---

### Task 4: `src/prompt.ts` — 两模式 prompt 模板（快照测试）

**Files:**
- Create: `tests/prompt.test.ts`
- Create: `src/prompt.ts`

- [ ] **Step 1: 写 prompt.ts 实现**

`src/prompt.ts`：
```ts
import type { Mode, VideoMeta } from './types'

export const PROMPT_VERSION = 'v1'

const CONTRACT = `
你是一位中文科技编辑，正在把一段 YouTube 对话重排成可读的中文文章。
只输出 newline-delimited JSON（ndjson），一行一个事件。
禁止 markdown 围栏、禁止前后闲聊、禁止任何 JSON 之外的文字。

事件类型：
  {"type":"meta","title":"...","subtitle":"..."}        // 第一条，唯一
  {"type":"h2","text":"..."}                            // 大章节标题（仅 rewrite 模式）
  {"type":"h3","text":"..."}                            // 小节主题
  {"type":"p","speaker":"Jen"|null,"text":"..."}        // 对话段落
  {"type":"end"}                                        // 最后一条
`.trim()

const REWRITE_RULES = `
模式：rewrite（深度改写）
- 把整段对话聚合为 5–10 个大章节（h2），每章 2–5 个小节（h3）
- h2 用"主题：副题"格式，如「技术革命：八十年一遇的AI巅峰」
- h3 是章节内话题导读，简短紧凑
- 保留说话人姓名；合并碎句；必要处插入极少量衔接说明（speaker=null）
- 风格参考：晚点 LatePost、虎嗅深度访谈稿
`.trim()

const FAITHFUL_RULES = `
模式：faithful（忠实翻译）
- 不生成 h2；仅在明显话题转折处输出 h3
- 保留 Q&A 原貌；只翻译不改写；不做压缩或总结
- 不添加衔接段
`.trim()

const SPEAKER_RULES = `
字幕无讲话人标签，你需要从对话结构推断：
- 提问者常以 "How..." / "What about..." / 简短句式反复出现 → 视为主持人
- 若视频标题或描述能看出姓名，使用姓名；否则用 "Host"、"Guest"、"Speaker A"
- 推断不出时 speaker 用 null
`.trim()

const FEW_SHOT_MULTI_SPEAKER = `
示例 1（多讲话人、命名清晰）：

{"type":"meta","title":"对话安德森：AI革命的万亿美金之问","subtitle":"a16z · Mark Andreessen × Jen / John"}
{"type":"h2","text":"技术革命：八十年一遇的AI巅峰"}
{"type":"h3","text":"AI公司的收入增长与产品演变"}
{"type":"p","speaker":"Jen","text":"目前 AI 公司的商业表现和收入增长情况如何？"}
{"type":"p","speaker":"Mark","text":"新一波 AI 公司的收入增长正处于史无前例的爆发期，这种增长是真实的客户需求转化为银行账户中的资金。"}
{"type":"p","speaker":"John","text":"能否再具体说说与互联网早期相比的差异？"}
`.trim()

const FEW_SHOT_UNCLEAR_SPEAKER = `
示例 2（说话人不明时使用 null 或占位名）：

{"type":"h3","text":"主持人开场"}
{"type":"p","speaker":null,"text":"欢迎回到节目。今天我们要聊的话题，关乎未来十年的科技格局。"}
{"type":"p","speaker":"Guest","text":"谢谢邀请。这的确是一个值得深入讨论的时刻。"}
`.trim()

const FEW_SHOT_TOPIC_SHIFT = `
示例 3（话题转折用新 h3，并允许 speaker=null 的衔接）：

{"type":"p","speaker":"Mark","text":"所以综合来看，硬件供应紧张只是短期现象。"}
{"type":"p","speaker":null,"text":"话题随即转向地缘政治。"}
{"type":"h3","text":"中美芯片竞赛"}
{"type":"p","speaker":"Jen","text":"那么中国开源模型的崛起，对美国公司意味着什么？"}
`.trim()

const FEW_SHOT = [
  FEW_SHOT_MULTI_SPEAKER,
  FEW_SHOT_UNCLEAR_SPEAKER,
  FEW_SHOT_TOPIC_SHIFT,
].join('\n\n')

export function buildPrompt(mode: Mode, meta: VideoMeta, transcript: string): string {
  const rules = mode === 'rewrite' ? REWRITE_RULES : FAITHFUL_RULES
  return [
    CONTRACT,
    rules,
    SPEAKER_RULES,
    FEW_SHOT,
    `\n[VIDEO META]\ntitle: ${meta.title}\nchannel: ${meta.channel}\nduration: ${meta.durationSec}s`,
    `\n[TRANSCRIPT]\n${transcript}`,
  ].join('\n\n')
}
```

- [ ] **Step 2: 写快照测试**

`tests/prompt.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { buildPrompt, PROMPT_VERSION } from '../src/prompt'

const META = { videoId: 'x', title: 'T', channel: 'C', durationSec: 60 }

describe('buildPrompt', () => {
  it('contains contract + mode rules + few-shot + transcript', () => {
    const p = buildPrompt('rewrite', META, 'hello transcript')
    expect(p).toContain('ndjson')
    expect(p).toContain('rewrite')
    expect(p).toContain('hello transcript')
    expect(p).toContain('title: T')
  })

  it('switches rules when mode=faithful', () => {
    const p = buildPrompt('faithful', META, '')
    expect(p).toContain('faithful')
    expect(p).toContain('只翻译不改写')
    expect(p).not.toContain('5–10 个大章节')
  })

  it('exposes PROMPT_VERSION', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/)
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `npm test -- prompt`
Expected: 3 passed。

- [ ] **Step 4: Commit**

```bash
git add tests/prompt.test.ts src/prompt.ts
git commit -m "feat(prompt): two-mode prompt template v1"
```

---

**Chunk 1 boundary**: 此处停下，运行 plan-document-reviewer 检查 Chunk 1。通过后进入 Chunk 2。

---

## Chunk 2: IO 模块 + Worker 路由

### Task 5: `src/youtube.ts` — URL 解析（TDD）

**Files:**
- Create: `tests/youtube.test.ts`
- Create: `src/youtube.ts`

- [ ] **Step 1: 写失败测试**

`tests/youtube.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { parseVideoId } from '../src/youtube'

describe('parseVideoId', () => {
  const valid: [string, string][] = [
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtu.be/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtu.be/xRh2sVcNXQ8?t=120', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8&t=90s', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/embed/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/shorts/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://m.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
  ]
  for (const [url, id] of valid) {
    it(`accepts ${url}`, () => expect(parseVideoId(url)).toBe(id))
  }

  const invalid = [
    '',
    'not a url',
    'https://example.com/watch?v=xRh2sVcNXQ8',
    'https://www.youtube.com/watch',        // 无 v
    'https://www.youtube.com/watch?v=short', // 11 字符不够
    'https://vimeo.com/123',
  ]
  for (const url of invalid) {
    it(`rejects ${JSON.stringify(url)}`, () => expect(parseVideoId(url)).toBeNull())
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- youtube`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/youtube.ts`（初始版本，仅 URL 解析）：
```ts
const ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

export function parseVideoId(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }

  const host = u.hostname.replace(/^www\.|^m\./, '')

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1)
    return ID_PATTERN.test(id) ? id : null
  }
  if (host !== 'youtube.com') return null

  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v') ?? ''
    return ID_PATTERN.test(id) ? id : null
  }
  const m = u.pathname.match(/^\/(embed|shorts)\/([^/?]+)/)
  if (m && ID_PATTERN.test(m[2]!)) return m[2]!
  return null
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- youtube`
Expected: 14 passed。

- [ ] **Step 5: Commit**

```bash
git add tests/youtube.test.ts src/youtube.ts
git commit -m "feat(youtube): parse videoId from all URL forms"
```

---

### Task 6: `src/youtube.ts` — 抓 watch 页 + 解 captionTracks（fixture TDD）

**Files:**
- Create: `tests/fixtures/watch-xRh2sVcNXQ8.html`
- Modify: `src/youtube.ts`
- Modify: `tests/youtube.test.ts`

- [ ] **Step 1: 下载真实 watch 页作为 fixture**

```bash
mkdir -p tests/fixtures
curl -sL -A 'Mozilla/5.0' \
  'https://www.youtube.com/watch?v=xRh2sVcNXQ8' \
  > tests/fixtures/watch-xRh2sVcNXQ8.html
# 验证 fixture 里包含 ytInitialPlayerResponse
grep -c 'ytInitialPlayerResponse' tests/fixtures/watch-xRh2sVcNXQ8.html
# 期望：>= 1
```

Expected: 文件数百 KB，`grep` 数字 ≥ 1。若为 0 说明 YouTube 返回了 consent gate；换网络或加 `-H 'Cookie: CONSENT=YES+1'` 重抓。

- [ ] **Step 2: 写测试**

追加到 `tests/youtube.test.ts`：
```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractPlayerResponse, parseCaptionTracks } from '../src/youtube'

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/watch-xRh2sVcNXQ8.html'),
  'utf-8',
)

describe('watch page parsing', () => {
  it('extracts ytInitialPlayerResponse JSON', () => {
    const pr = extractPlayerResponse(FIXTURE)
    expect(pr).not.toBeNull()
    expect(pr!.videoDetails?.videoId).toBe('xRh2sVcNXQ8')
  })

  it('parses captionTracks from playerResponse', () => {
    const pr = extractPlayerResponse(FIXTURE)!
    const tracks = parseCaptionTracks(pr)
    expect(tracks.length).toBeGreaterThan(0)
    const first = tracks[0]!
    expect(first.id).toMatch(/^(a|asr)\./)
    expect(first.lang).toBeTruthy()
    expect(first.baseUrl).toMatch(/^https?:\/\//)
  })

  it('returns empty array when no captions', () => {
    expect(parseCaptionTracks({ videoDetails: {} } as any)).toEqual([])
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test -- youtube`
Expected: 新 3 个用例 FAIL（`extractPlayerResponse is not a function`）。

- [ ] **Step 4: 实现**

追加到 `src/youtube.ts`：
```ts
import type { CaptionTrack } from './types'

/** YouTube 页面中嵌入的 ytInitialPlayerResponse JSON（仅用到少量字段） */
interface PlayerResponse {
  videoDetails?: {
    videoId?: string
    title?: string
    author?: string
    lengthSeconds?: string
  }
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string
        languageCode: string
        name?: { simpleText?: string; runs?: Array<{ text: string }> }
        kind?: string          // "asr" 表示自动生成；缺失表示手动
        vssId?: string
      }>
    }
  }
}

const PR_REGEX = /var ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script>)/s

export function extractPlayerResponse(html: string): PlayerResponse | null {
  const m = html.match(PR_REGEX)
  if (!m) return null
  try { return JSON.parse(m[1]!) as PlayerResponse } catch { return null }
}

export function parseCaptionTracks(pr: PlayerResponse): CaptionTrack[] {
  const raw = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  return raw.map((t): CaptionTrack => {
    const isAuto = t.kind === 'asr'
    const label = t.name?.simpleText
      ?? t.name?.runs?.map(r => r.text).join('')
      ?? t.languageCode
    return {
      id: `${isAuto ? 'asr' : 'a'}.${t.languageCode}`,
      lang: t.languageCode,
      label,
      kind: isAuto ? 'auto' : 'manual',
      baseUrl: t.baseUrl,
    }
  })
}

/** 供 inspect 路由使用：返回完整元信息 + track 列表 */
export function extractVideoInfo(html: string) {
  const pr = extractPlayerResponse(html)
  if (!pr) return null
  const vd = pr.videoDetails ?? {}
  const tracks = parseCaptionTracks(pr)
  return {
    videoId: vd.videoId ?? '',
    title: vd.title ?? '',
    channel: vd.author ?? '',
    durationSec: Number(vd.lengthSeconds ?? 0),
    tracks,
  }
}
```

- [ ] **Step 5: 运行测试通过**

Run: `npm test -- youtube`
Expected: 17 passed（14 URL + 3 parse）。

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/watch-xRh2sVcNXQ8.html tests/youtube.test.ts src/youtube.ts
git commit -m "feat(youtube): extract playerResponse + caption tracks"
```

---

### Task 7: `src/youtube.ts` — 下载字幕 + XML→纯文本（TDD）

**Files:**
- Modify: `src/youtube.ts`
- Modify: `tests/youtube.test.ts`

- [ ] **Step 1: 写测试**

追加到 `tests/youtube.test.ts`：
```ts
import { timedTextToTranscript } from '../src/youtube'

describe('timedTextToTranscript', () => {
  it('strips tags + merges lines into paragraphs', () => {
    const xml = `<?xml version="1.0"?>
<transcript>
<text start="0" dur="2">Hello everyone.</text>
<text start="2" dur="3">Welcome to the show</text>
<text start="5" dur="4">where we discuss technology.</text>
<text start="9" dur="2">New topic starts now.</text>
</transcript>`
    const text = timedTextToTranscript(xml)
    expect(text).toContain('Hello everyone.')
    expect(text).toContain('Welcome to the show where we discuss technology.')
    expect(text).not.toContain('<text')
    expect(text).not.toContain('start=')
  })

  it('decodes HTML entities', () => {
    const xml = `<transcript><text>It&amp;#39;s great &quot;awesome&quot;.</text></transcript>`
    const text = timedTextToTranscript(xml)
    expect(text).toContain("It's great \"awesome\".")
  })

  it('returns empty string for malformed input', () => {
    expect(timedTextToTranscript('')).toBe('')
    expect(timedTextToTranscript('not xml')).toBe('')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- youtube`
Expected: 3 个新用例 FAIL。

- [ ] **Step 3: 实现**

追加到 `src/youtube.ts`：
```ts
const TEXT_RE = /<text[^>]*>([\s\S]*?)<\/text>/g

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function timedTextToTranscript(xml: string): string {
  if (!xml.includes('<text')) return ''
  const lines: string[] = []
  for (const m of xml.matchAll(TEXT_RE)) {
    const raw = m[1] ?? ''
    const text = decodeEntities(raw).trim().replace(/\s+/g, ' ')
    if (text) lines.push(text)
  }
  // 按句末标点合并：不以 . ! ? ; 。 ！ ？ 结尾的句子，与下一句接在一起
  const merged: string[] = []
  let cur = ''
  for (const line of lines) {
    cur = cur ? `${cur} ${line}` : line
    if (/[.!?;。！？]$/.test(line)) {
      merged.push(cur)
      cur = ''
    }
  }
  if (cur) merged.push(cur)
  return merged.join('\n')
}

/** 从 CF Worker 内拉 watch 页 */
export async function fetchWatchPage(videoId: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'accept-language': 'en-US,en;q=0.9',
      'cookie': 'CONSENT=YES+1',
    },
    signal,
  })
  if (!res.ok) throw new YoutubeError(res.status === 404 ? 'VIDEO_NOT_FOUND' : 'YOUTUBE_BLOCKED')
  return await res.text()
}

/** 从 timedtext baseUrl 下载字幕 */
export async function fetchTimedText(baseUrl: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(baseUrl, { signal })
  if (!res.ok) throw new YoutubeError('YOUTUBE_BLOCKED')
  return await res.text()
}

export class YoutubeError extends Error {
  constructor(public code: 'INVALID_URL' | 'VIDEO_NOT_FOUND' | 'NO_CAPTIONS' | 'YOUTUBE_BLOCKED') {
    super(code)
  }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- youtube`
Expected: 20 passed。

- [ ] **Step 5: Commit**

```bash
git add src/youtube.ts tests/youtube.test.ts
git commit -m "feat(youtube): timedtext parsing + worker fetch helpers"
```

---

### Task 8: `src/gemini.ts` — countTokens + 重试（TDD with mock fetch）

**Files:**
- Create: `tests/gemini.test.ts`
- Create: `src/gemini.ts`

- [ ] **Step 1: 写测试**

`tests/gemini.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { countTokens, GeminiError } from '../src/gemini'

function mockFetch(impl: (req: Request) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const req = input instanceof Request ? input : new Request(input as any)
    return impl(req)
  }))
}

describe('countTokens', () => {
  const env = { GEMINI_API_KEY: 'fake', GEMINI_MODEL: 'gemini-2.5-flash' }

  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to :countTokens and returns token count', async () => {
    mockFetch(async req => {
      expect(req.url).toContain(':countTokens')
      expect(req.url).toContain('key=fake')
      return new Response(JSON.stringify({ totalTokens: 42 }), { status: 200 })
    })
    const n = await countTokens(env, 'hello world')
    expect(n).toBe(42)
  })

  it('throws GeminiError on 401', async () => {
    mockFetch(() => new Response('nope', { status: 401 }))
    await expect(countTokens(env, 'x')).rejects.toThrow(GeminiError)
    await expect(countTokens(env, 'x')).rejects.toMatchObject({ code: 'GEMINI_AUTH' })
  })

  it('retries once on 429 then succeeds (fast sleep)', async () => {
    let attempt = 0
    mockFetch(() => {
      attempt++
      if (attempt === 1) return new Response('rate limit', { status: 429 })
      return new Response(JSON.stringify({ totalTokens: 7 }), { status: 200 })
    })
    // 让 countTokens 可以接受 fast sleep：通过 opts 传入
    const n = await countTokens(env, 'x', undefined, { sleepFn: async () => {} })
    expect(n).toBe(7)
    expect(attempt).toBe(2)
  })

  it('throws GEMINI_RATE_LIMIT after exhausting 429 retries', async () => {
    let attempt = 0
    mockFetch(() => { attempt++; return new Response('', { status: 429 }) })
    await expect(countTokens(env, 'x', undefined, { sleepFn: async () => {} }))
      .rejects.toMatchObject({ code: 'GEMINI_RATE_LIMIT' })
    expect(attempt).toBe(3)  // 初次 + 2 次重试
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- gemini`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/gemini.ts`：
```ts
import type { ErrorCode } from './types'

const API = 'https://generativelanguage.googleapis.com/v1beta'

export class GeminiError extends Error {
  constructor(public code: ErrorCode, message?: string) { super(message ?? code) }
}

interface Env {
  GEMINI_API_KEY: string
  GEMINI_MODEL?: string
}

function model(env: Env) { return env.GEMINI_MODEL ?? 'gemini-2.5-flash' }

/**
 * 429 → 指数退避重试，最多 2 次重试（总 3 次请求；1s → 3s）
 * 5xx → 重试 1 次（总 2 次请求；1s 后）
 * 401/403 → 立即抛 GEMINI_AUTH（不重试）
 * 其它 4xx → 立即抛 GEMINI_TIMEOUT（携带 status）
 * sleepFn 可注入，便于测试加速
 */
async function retryingFetch(
  url: string,
  init: RequestInit,
  opts: { retries429?: number; retries5xx?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const { retries429 = 2, retries5xx = 1, sleepFn = sleep } = opts
  let attempt429 = 0
  let attempt5xx = 0
  let delay = 1000
  while (true) {
    const res = await fetch(url, init)
    if (res.ok) return res
    if (res.status === 401 || res.status === 403) throw new GeminiError('GEMINI_AUTH')
    if (res.status === 429 && attempt429 < retries429) {
      await sleepFn(delay); delay *= 3; attempt429++; continue
    }
    if (res.status >= 500 && attempt5xx < retries5xx) {
      await sleepFn(1000); attempt5xx++; continue
    }
    if (res.status === 429) throw new GeminiError('GEMINI_RATE_LIMIT')
    throw new GeminiError('GEMINI_TIMEOUT', `status ${res.status}`)
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function countTokens(
  env: Env,
  text: string,
  signal?: AbortSignal,
  opts: { sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const url = `${API}/models/${model(env)}:countTokens?key=${env.GEMINI_API_KEY}`
  const res = await retryingFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    signal,
  }, { sleepFn: opts.sleepFn })
  const data = await res.json() as { totalTokens?: number }
  return data.totalTokens ?? 0
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- gemini`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add tests/gemini.test.ts src/gemini.ts
git commit -m "feat(gemini): countTokens + shared retry helper"
```

---

### Task 9: `src/gemini.ts` — streamGenerateContent SSE + AbortController（TDD）

**Files:**
- Modify: `src/gemini.ts`
- Modify: `tests/gemini.test.ts`

- [ ] **Step 1: 写测试**

追加到 `tests/gemini.test.ts`（复用文件顶部已有的 `mockFetch` 帮手）：
```ts
import { streamGenerate } from '../src/gemini'

describe('streamGenerate', () => {
  const env = { GEMINI_API_KEY: 'fake', GEMINI_MODEL: 'gemini-2.5-flash' }

  it('yields concatenated text parts from SSE body', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"{\\"type\\":"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"\\"h2\\",\\"text\\":\\"A\\"}\\n"}]}}]}',
      '',
    ].join('\n')
    mockFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const chunks: string[] = []
    for await (const chunk of streamGenerate(env, 'prompt')) chunks.push(chunk)
    expect(chunks.join('')).toBe('{"type":"h2","text":"A"}\n')
  })

  it('handles SSE frames split across reader.read() boundaries', async () => {
    // 构造一个分成多块到达的 ReadableStream，模拟真实网络分片
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"'))
        ctrl.enqueue(enc.encode('hello"}]}}]}\n\n'))
        ctrl.close()
      },
    })
    mockFetch(() => new Response(body, { status: 200 }))
    const chunks: string[] = []
    for await (const c of streamGenerate(env, 'p')) chunks.push(c)
    expect(chunks.join('')).toBe('hello')
  })

  it('refuses to start when signal already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    mockFetch(() => new Response('', { status: 200 }))
    const gen = streamGenerate(env, 'p', ctrl.signal)
    await expect(gen.next()).rejects.toMatchObject({ code: 'GEMINI_STREAM_DROP' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- gemini`
Expected: 新 2 个 FAIL。

- [ ] **Step 3: 实现**

追加到 `src/gemini.ts`：
```ts
/** async generator，流式产出 Gemini 的文本增量片段 */
export async function* streamGenerate(
  env: Env,
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) throw new GeminiError('GEMINI_STREAM_DROP', 'aborted before start')
  const url = `${API}/models/${model(env)}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`
  const res = await retryingFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 32768 },
    }),
    signal,
  }, { retries429: 2, retries5xx: 1 })

  if (!res.body) throw new GeminiError('GEMINI_STREAM_DROP', 'no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      if (signal?.aborted) throw new GeminiError('GEMINI_STREAM_DROP', 'aborted')
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const text = extractText(frame)
        if (text) yield text
      }
    }
  } finally {
    try { reader.cancel() } catch { /* ignore */ }
  }
}

function extractText(frame: string): string {
  // SSE frame: multiple 'data: ...' lines
  const out: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      for (const c of obj.candidates ?? []) {
        for (const p of c.content?.parts ?? []) {
          if (p.text) out.push(p.text)
        }
      }
    } catch { /* skip malformed frame */ }
  }
  return out.join('')
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- gemini`
Expected: 7 passed（4 countTokens + 3 stream）。

- [ ] **Step 5: Commit**

```bash
git add tests/gemini.test.ts src/gemini.ts
git commit -m "feat(gemini): streamGenerateContent async iterator + abort"
```

---

### Task 10: `src/gemini.ts` — SSE keepalive TransformStream

**Files:**
- Modify: `src/gemini.ts`
- Modify: `tests/gemini.test.ts`

- [ ] **Step 1: 写测试**

追加到 `tests/gemini.test.ts`（**用真实定时器**，因为 `vi.useFakeTimers()` 在 `@cloudflare/vitest-pool-workers` 里无法控制 Workers runtime 侧的 `setTimeout`）：
```ts
import { keepaliveTransform } from '../src/gemini'

describe('keepaliveTransform', () => {
  it('inserts keepalive comment after idle (real timers)', async () => {
    const ts = keepaliveTransform(40)   // 40ms 间隔，测试加速
    const writer = ts.writable.getWriter()
    const reader = ts.readable.getReader()
    const dec = new TextDecoder()
    const chunks: string[] = []

    const drain = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(dec.decode(value))
      }
    })()

    await writer.write(new TextEncoder().encode('data: x\n\n'))
    await new Promise(r => setTimeout(r, 120))  // 等足至少 2 个 interval
    await writer.close()
    await drain

    const all = chunks.join('')
    expect(all).toContain('data: x\n\n')
    expect(all).toMatch(/: keepalive\n\n/)
    // 期望 keepalive 至少出现 1 次（120/40 = 3，容许抖动取 >=1）
    expect((all.match(/: keepalive\n\n/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- gemini`
Expected: FAIL。

- [ ] **Step 3: 实现**

追加到 `src/gemini.ts`：
```ts
/**
 * 包一层 TransformStream：上游空闲超过 intervalMs 时，向下游注入 SSE 注释行
 * `: keepalive\n\n`，避免代理层断开长连接。
 * 有真数据通过时会重置计时器；keepalive 自身也会重新排期，保持循环。
 */
export function keepaliveTransform(intervalMs = 15_000) {
  const enc = new TextEncoder()
  const keepalive = enc.encode(': keepalive\n\n')
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let ctrlRef: TransformStreamDefaultController<Uint8Array> | null = null

  const schedule = () => {
    if (closed) return
    timer = setTimeout(() => {
      if (closed || !ctrlRef) return
      ctrlRef.enqueue(keepalive)
      schedule()   // 循环下一次
    }, intervalMs)
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      ctrlRef = controller
      schedule()
    },
    transform(chunk, controller) {
      if (timer) { clearTimeout(timer); timer = null }
      controller.enqueue(chunk)
      schedule()   // 每次真数据后重排
    },
    flush() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  })
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- gemini`
Expected: 8 passed（真实定时器会让这条用例耗时 ~120ms，可接受）。

- [ ] **Step 5: Commit**

```bash
git add src/gemini.ts tests/gemini.test.ts
git commit -m "feat(gemini): SSE keepalive transform stream"
```

---

### Task 11: `src/index.ts` — `POST /api/inspect` 路由 + reqId + 结构化日志

**Files:**
- Modify: `src/index.ts`
- Create: `src/log.ts`

- [ ] **Step 1: 写 log.ts**

`src/log.ts`：
```ts
export function newReqId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 6)
}

export function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }))
}

export function logError(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...fields }))
}
```

- [ ] **Step 2: 写 /api/inspect 实现**

替换 `src/index.ts` 全文：
```ts
import { parseVideoId, fetchWatchPage, extractVideoInfo, timedTextToTranscript, YoutubeError } from './youtube'
import { countTokens, GeminiError } from './gemini'
import { log, logError, newReqId } from './log'
import type { ErrorCode } from './types'

export interface Env {
  GEMINI_API_KEY: string
  GEMINI_MODEL?: string
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'POST' && url.pathname === '/api/inspect') return await inspect(request, env)
      if (request.method === 'POST' && url.pathname === '/api/generate') return new Response('not yet', { status: 501 })
      return env.ASSETS.fetch(request)
    } catch (err) {
      logError({ phase: 'unhandled', err: String(err) })
      return json(500, { error: 'INTERNAL' as ErrorCode })
    }
  },
} satisfies ExportedHandler<Env>

async function inspect(request: Request, env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()
  let body: { url?: string }
  try { body = await request.json() } catch { return json(400, { reqId, error: 'INVALID_URL' }) }
  const videoId = parseVideoId(body.url ?? '')
  if (!videoId) { log({ reqId, route: '/api/inspect', phase: 'invalid_url' }); return json(400, { reqId, error: 'INVALID_URL' }) }

  log({ reqId, route: '/api/inspect', phase: 'start', videoId })
  try {
    const html = await fetchWatchPage(videoId, request.signal)
    log({ reqId, phase: 'youtube.fetch', durMs: Date.now() - started, bytes: html.length })
    const info = extractVideoInfo(html)
    if (!info || !info.videoId) return json(404, { reqId, error: 'VIDEO_NOT_FOUND' })
    if (info.tracks.length === 0) return json(404, { reqId, error: 'NO_CAPTIONS' })

    // 并行对每条 track 的 baseUrl 内容走 countTokens（下载 + 清洗 + 计数）
    const tracks = await Promise.all(info.tracks.map(async t => {
      try {
        const res = await fetch(t.baseUrl, { signal: request.signal })
        if (!res.ok) throw new Error(`timedtext status ${res.status}`)
        const xml = await res.text()
        const transcript = timedTextToTranscript(xml)
        const tokens = await countTokens(env, transcript, request.signal)
        return { id: t.id, lang: t.lang, label: t.label, kind: t.kind, tokens }
      } catch (err) {
        logError({ reqId, phase: 'inspect.track.error', trackId: t.id, err: String(err) })
        return { id: t.id, lang: t.lang, label: t.label, kind: t.kind, tokens: 0 }
      }
    }))

    log({ reqId, phase: 'done', durMs: Date.now() - started, trackCount: tracks.length })
    return json(200, { reqId, videoId: info.videoId, title: info.title, channel: info.channel, durationSec: info.durationSec, tracks })
  } catch (err) {
    const code: ErrorCode = err instanceof YoutubeError ? err.code
      : err instanceof GeminiError ? err.code
      : 'INTERNAL'
    logError({ reqId, phase: 'inspect.error', code, durMs: Date.now() - started, err: String(err) })
    return json(code === 'VIDEO_NOT_FOUND' ? 404 : code === 'NO_CAPTIONS' ? 404 : code === 'INVALID_URL' ? 400 : 502, { reqId, error: code })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
```

- [ ] **Step 3: 本地 smoke test**

```bash
# 在 .dev.vars 里放 GEMINI_API_KEY=<真实 key>
npm run dev
# 另一个终端
curl -s -X POST http://localhost:8787/api/inspect \
  -H 'content-type: application/json' \
  -d '{"url":"https://youtu.be/xRh2sVcNXQ8"}' | jq .
```

Expected: JSON 响应含 `videoId`、`tracks[]`，每条 track 有 `tokens` > 0。若 `tokens` 全为 0，说明 key 或 countTokens 调用有问题。

- [ ] **Step 4: Commit**

```bash
git add src/log.ts src/index.ts
git commit -m "feat(api): /api/inspect route + structured logging"
```

---

### Task 12: `src/index.ts` — `POST /api/generate` 路由（SSE + 编排）

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 写实现**

替换 `src/index.ts` 中 `/api/generate` 的 501 分支为完整实现（在文件末尾追加 `generate` 函数并修改路由）：

```ts
// 路由改为：
if (request.method === 'POST' && url.pathname === '/api/generate') return await generate(request, env)
```

在文件顶部补齐 imports：
```ts
import { fetchTimedText } from './youtube'
import { streamGenerate, keepaliveTransform } from './gemini'
import { buildPrompt, PROMPT_VERSION } from './prompt'
import { createNdjsonParser } from './parser'
import type { Mode, StreamEvent } from './types'
```

追加 `generate` 函数：
```ts
async function generate(request: Request, env: Env): Promise<Response> {
  const reqId = newReqId()
  const started = Date.now()

  // 客户端关闭时记一条 cancelled 日志（独立于 UI 错误）
  request.signal.addEventListener('abort',
    () => log({ reqId, phase: 'cancelled', durMs: Date.now() - started }),
    { once: true })

  let body: { url?: string; trackId?: string; mode?: Mode }
  try { body = await request.json() } catch { return json(400, { reqId, error: 'INVALID_URL' }) }
  const videoId = parseVideoId(body.url ?? '')
  const mode: Mode = body.mode === 'faithful' ? 'faithful' : 'rewrite'
  if (!videoId || !body.trackId) return json(400, { reqId, error: 'INVALID_URL' })

  log({ reqId, route: '/api/generate', phase: 'start', videoId, mode, trackId: body.trackId, promptVer: PROMPT_VERSION })

  // 先同步拿到 meta + 选中 track 的 transcript（narrowing：info 不能为 null 才能继续）
  let title: string, channel: string, durationSec: number, transcript: string
  try {
    const html = await fetchWatchPage(videoId, request.signal)
    const info = extractVideoInfo(html)
    if (!info) return json(404, { reqId, error: 'VIDEO_NOT_FOUND' })
    if (info.tracks.length === 0) return json(404, { reqId, error: 'NO_CAPTIONS' })
    const track = info.tracks.find(t => t.id === body.trackId)
    if (!track) return json(404, { reqId, error: 'NO_CAPTIONS' })
    title = info.title; channel = info.channel; durationSec = info.durationSec
    log({ reqId, phase: 'youtube.fetch', durMs: Date.now() - started })
    const captionXml = await fetchTimedText(track.baseUrl, request.signal)
    transcript = timedTextToTranscript(captionXml)
    log({ reqId, phase: 'caption.download', bytes: captionXml.length, chars: transcript.length })
  } catch (err) {
    const code: ErrorCode = err instanceof YoutubeError ? err.code : 'INTERNAL'
    logError({ reqId, phase: 'pre.error', code, err: String(err) })
    return json(code === 'VIDEO_NOT_FOUND' ? 404 : 502, { reqId, error: code })
  }

  const prompt = buildPrompt(mode, { videoId, title, channel, durationSec }, transcript)

  // SSE 输出：直接用 keepalive 的 writable 写入，返回它的 readable
  const ka = keepaliveTransform(15_000)
  const writer = ka.writable.getWriter()
  const enc = new TextEncoder()
  const writeEvent = (e: StreamEvent) =>
    writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {/* client gone */})

  ;(async () => {
    let firstChunk = true
    let events = 0
    try {
      await writeEvent({ type: 'meta', reqId, title, subtitle: channel, durationSec })
      const parser = createNdjsonParser(e => {
        if (e.type === 'meta') return   // 丢弃模型重复的 meta
        writeEvent(e)                   // 已做 .catch，不再额外处理
        events++
      })
      for await (const chunk of streamGenerate(env, prompt, request.signal)) {
        if (firstChunk) { log({ reqId, phase: 'gemini.first', durMs: Date.now() - started }); firstChunk = false }
        parser.feed(chunk)
      }
      parser.end()
      await writeEvent({ type: 'end' })
      log({ reqId, phase: 'done', durMs: Date.now() - started, events })
    } catch (err) {
      const code: ErrorCode = err instanceof GeminiError ? err.code : 'GEMINI_STREAM_DROP'
      logError({ reqId, phase: 'generate.error', code, durMs: Date.now() - started, err: String(err) })
      await writeEvent({ type: 'error', code, message: String(err).slice(0, 200) })
    } finally {
      try { await writer.close() } catch { /* ignore */ }
    }
  })()

  return new Response(ka.readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}
```

- [ ] **Step 2: 本地 smoke test**

先跑一次 inspect 拿到真实 trackId：

```bash
npm run dev
# 另一终端
curl -s -X POST http://localhost:8787/api/inspect \
  -H 'content-type: application/json' \
  -d '{"url":"https://youtu.be/xRh2sVcNXQ8"}' | jq '.tracks[].id'
# 从输出中挑一个（通常是 "a.en" 或 "asr.en"）
```

再用该 id 触发生成：

```bash
curl -N -X POST http://localhost:8787/api/generate \
  -H 'content-type: application/json' \
  -d '{"url":"https://youtu.be/xRh2sVcNXQ8","trackId":"<上面拿到的 id>","mode":"rewrite"}'
```

Expected: 逐行流出 `data: {"type":"meta",...}` 等 SSE 帧。Ctrl+C 中断后 `wrangler tail` 应看到 `phase:"cancelled"` 日志行。

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(api): /api/generate SSE route with keepalive + parser"
```

---

**Chunk 2 boundary**: 停下运行 plan-document-reviewer 检查 Chunk 2。

---

## Chunk 3: 前端基础（HTML + CSS + 状态机 + 事件渲染）

**测试策略说明**：`public/app.js` 跑在浏览器 realm，不在 vitest-pool-workers 能直接测试的范围。本 chunk 不写单元测试，靠 Chunk 4 的手动 smoke test 覆盖 UI。逻辑上有必要单测的纯函数（URL 校验等）放在 `src/` 下让 worker pool 测试。

### Task 13: `public/index.html` — 骨架 + 主题变量 + 布局

**Files:**
- Modify: `public/index.html` （全文替换）

- [ ] **Step 1: 写 index.html 结构与基础样式**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1024">
  <title>ytb-studio</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#0e0d0b; --fg:#e8e3d6; --subtle:#7a7465;
      --rail:#14130f; --border:#26241d; --accent:#d9cfb2;
      --warn:#e8a06f; --warn-border:#8f5a3d;
    }
    html.light {
      --bg:#f8f6f0; --fg:#1a1812; --subtle:#7a7465;
      --rail:#efece3; --border:#dcd8cb; --accent:#1a1812;
      --warn:#b46a36; --warn-border:#d8b890;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body {
      background:var(--bg); color:var(--fg);
      font-family:'Noto Serif SC', serif;
      transition:background .5s, color .5s;
      overflow:hidden;
    }
    .frame { height:100vh; display:flex; position:relative; overflow:hidden; }

    /* Tools */
    .tools { position:fixed; top:12px; right:14px; z-index:100;
      display:flex; gap:8px; font-family:'JetBrains Mono', monospace; font-size:11px; }
    .tools button { background:transparent; color:var(--subtle);
      border:1px solid var(--border); border-radius:4px;
      padding:4px 10px; cursor:pointer; font:inherit;
      transition:color .2s, border-color .2s; }
    .tools button:hover { color:var(--fg); border-color:var(--fg); }

    /* Rail */
    .rail { width:260px; background:var(--rail); border-right:1px solid var(--border);
      padding:54px 18px 20px; display:flex; flex-direction:column; gap:14px;
      transition:width .5s ease, padding .5s ease, transform .6s cubic-bezier(.22,1,.36,1);
      overflow:hidden; flex-shrink:0; transform:translateX(-100%);
      position:relative; }
    .rail.in { transform:none; }
    .rail.collapsed { width:40px; padding:54px 6px 20px; }
    .rail.collapsed > :not(.rail-toggle) { opacity:0; pointer-events:none; }
    .rail.dimmed { opacity:.38; pointer-events:none; filter:saturate(.4); }
    .rail-toggle { position:absolute; top:14px; left:14px;
      background:transparent; color:var(--subtle); border:none; cursor:pointer;
      font-size:16px; padding:4px; }
    .rail-label { font-size:10px; text-transform:uppercase; letter-spacing:1.5px;
      color:var(--subtle); margin-bottom:6px; font-family:'JetBrains Mono', monospace; }
    .mini-input { background:transparent; color:var(--fg);
      border:1px solid var(--border); border-radius:4px; padding:7px 10px;
      font:12px/1.4 'JetBrains Mono', monospace;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .mode { display:flex; flex-direction:column; gap:4px; font-size:13px; }
    .mode .opt { padding:4px 0; cursor:pointer; color:var(--subtle);
      display:flex; align-items:center; gap:8px; }
    .mode .opt.on { color:var(--fg); }
    .mode .opt::before { content:'○'; font-size:11px; color:var(--subtle); }
    .mode .opt.on::before { content:'●'; color:var(--accent); }

    /* Main + topbar */
    .main { flex:1; position:relative; overflow:hidden; }
    .topbar { position:absolute; top:0; left:0; right:0; height:54px;
      display:flex; align-items:center; padding:0 24px; gap:12px;
      border-bottom:1px solid var(--border);
      background:color-mix(in srgb, var(--bg) 85%, transparent);
      backdrop-filter:blur(10px);
      transform:translateY(-100%);
      transition:transform .55s cubic-bezier(.22,1,.36,1);
      z-index:10; }
    .topbar.in { transform:none; }
    .topbar .mini-url { flex:1; max-width:560px;
      font:12px/1 'JetBrains Mono', monospace; color:var(--fg);
      padding:7px 12px; border:1px solid var(--border); border-radius:20px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.75; }
    .topbar .status-pill { margin-left:auto;
      font:11px/1 'JetBrains Mono', monospace; color:var(--subtle);
      padding:5px 10px; border-radius:14px; border:1px solid var(--border); }
    .topbar .status-pill.err { color:var(--warn); border-color:var(--warn-border); }
    .topbar .status-pill.err::before { content:'● '; color:var(--warn); }

    /* Hero */
    .hero { position:absolute; inset:0; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:22px; padding:40px;
      transition:opacity .5s, transform .5s; }
    .hero.out { opacity:0; transform:translateY(-12px); pointer-events:none; }
    .hero .h-title { font-size:32px; font-weight:600; letter-spacing:2px; }
    .hero .h-sub { font-family:'JetBrains Mono', monospace; font-size:13px;
      color:var(--subtle); letter-spacing:1px; margin-top:6px; }
    .hero .input-wrap { width:560px; max-width:88%; display:flex; gap:10px; }
    .hero input { flex:1; background:transparent; color:var(--fg);
      border:1px solid var(--border); border-radius:8px; padding:14px 16px;
      font:15px/1.4 'JetBrains Mono', monospace; transition:border-color .2s; }
    .hero input:focus { outline:none; border-color:var(--fg); }
    .hero .go { background:var(--accent); color:var(--bg); border:none; cursor:pointer;
      padding:0 24px; border-radius:8px;
      font:600 14px 'Noto Serif SC', serif; letter-spacing:2px;
      transition:opacity .2s, transform .2s; }
    .hero .go:hover { opacity:.88; }
    .hero .go:active { transform:scale(.97); }
    .hero .go:disabled { opacity:.4; cursor:not-allowed; }
    .hero .mode-inline { display:flex; gap:20px; font-size:13px; }
    .hero .mode-inline .opt { cursor:pointer; color:var(--subtle); }
    .hero .mode-inline .opt.on { color:var(--fg); }
    .hero .hint-err { color:var(--warn); font-family:'JetBrains Mono', monospace;
      font-size:12px; min-height:16px; margin-top:-10px; }
  </style>
</head>
<body>
<div class="frame">
  <aside class="rail" id="rail">
    <button class="rail-toggle" id="railToggle" aria-label="折叠侧栏">‹</button>
    <div><div class="rail-label">URL</div><div class="mini-input" id="railUrl">—</div></div>
    <div>
      <div class="rail-label">模式</div>
      <div class="mode" id="railMode">
        <div class="opt on" data-mode="rewrite">深度改写</div>
        <div class="opt" data-mode="faithful">忠实翻译</div>
      </div>
    </div>
    <div style="margin-top:auto;">
      <div class="rail-label">生成信息</div>
      <div style="color:var(--subtle); font-size:12px; font-family:'JetBrains Mono', monospace;" id="railReq">—</div>
    </div>
  </aside>
  <main class="main">
    <div class="topbar" id="topbar">
      <svg class="sparkle brand-sm" id="brandLogo" viewBox="-50 -50 100 100"><g class="spin"><g class="breath"><path class="bar-h" d="M-46 0 C-16 -2 -2 -16 0 -46 C2 -16 16 -2 46 0 C16 2 2 16 0 46 C-2 16 -16 2 -46 0 Z"/><circle class="small" cx="30" cy="30" r="3"/><circle class="small" cx="-30" cy="-30" r="3"/><circle class="small" cx="30" cy="-30" r="2"/><circle class="small" cx="-30" cy="30" r="2"/></g></g></svg>
      <div class="mini-url" id="topUrl">—</div>
      <div class="status-pill" id="statusPill">idle</div>
    </div>
    <!-- Hero -->
    <div class="hero" id="hero">
      <svg class="sparkle hero" id="heroLogo" viewBox="-50 -50 100 100"><g class="spin"><g class="breath"><path class="bar-h" d="M-46 0 C-16 -2 -2 -16 0 -46 C2 -16 16 -2 46 0 C16 2 2 16 0 46 C-2 16 -16 2 -46 0 Z"/><circle class="small" cx="30" cy="30" r="3"/><circle class="small" cx="-30" cy="-30" r="3"/><circle class="small" cx="30" cy="-30" r="2"/><circle class="small" cx="-30" cy="30" r="2"/></g></g></svg>
      <div style="text-align:center;">
        <div class="h-title">ytb-studio</div>
        <div class="h-sub">把 YouTube 对话，变成一篇可读的中文文章</div>
      </div>
      <div class="input-wrap">
        <input id="url" placeholder="粘贴一个有字幕的 YouTube 链接" autofocus>
        <button class="go" id="go">生成</button>
      </div>
      <div class="hint-err" id="hintErr"></div>
      <div class="mode-inline" id="heroMode">
        <div class="opt on" data-mode="rewrite">深度改写</div>
        <div class="opt" data-mode="faithful">忠实翻译</div>
      </div>
    </div>
    <!-- Stages & article 占位，由 Task 14 填充 -->
  </main>
</div>
<div class="tools">
  <button id="themeBtn" aria-label="切换主题">☾</button>
</div>
<script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 建空 app.js**

`public/app.js`：
```js
// placeholder，Task 15 填充
document.getElementById('go').addEventListener('click', () => alert('not yet'))
```

- [ ] **Step 3: 本地看外观**

Run: `npm run dev` → 打开 `http://localhost:8787`
Expected: Dark 主题 hero 页面，居中 "ytb-studio" + slogan + 输入框 + 生成按钮 + 模式切换；顶部和 hero 中心各有一个 SVG sparkle 占位（未上 CSS 动画前为静态）。**此时不要点"生成"**——Task 15 前该按钮只弹 alert，没用。

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat(ui): hero skeleton + theme variables + layout shell"
```

---

### Task 14: `public/index.html` — sparkle SVG + stage/picker/reveal/article CSS

**Files:**
- Modify: `public/index.html` （在 `<head>` 末追加样式；body 内加 SVG symbol + 五个 view 节点）

- [ ] **Step 1: `<head>` 末追加样式**

在 `</style>` 前插入（**sparkle 用直接内联 SVG 实现**，不走 `mask: url(#id)`——后者引用 `<symbol>` 在所有浏览器都不起效）：
```css
/* Sparkle logo (inline SVG inside .sparkle elements) */
.sparkle { display:inline-block; }
.sparkle .bar-h { fill:var(--accent); }
.sparkle .small { fill:var(--accent); opacity:.5; }
.sparkle .spin { animation:spin 12s linear infinite; transform-origin:center; transform-box:view-box; }
.sparkle .breath { animation:breath 2.2s ease-in-out infinite; transform-origin:center; transform-box:view-box; }
.sparkle.hero { width:72px; height:72px; }
.sparkle.stage-logo { width:56px; height:56px; }
.sparkle.brand-sm { width:22px; height:22px; }
@keyframes spin { to { transform:rotate(360deg); } }
@keyframes breath { 0%,100% { opacity:.85; transform:scale(.95);} 50%{opacity:1; transform:scale(1.05);} }

/* Stage */
.stage { position:absolute; inset:54px 0 0 0; display:flex;
  align-items:center; justify-content:center; padding:40px; }
.view { transition:opacity .5s; }
.view.out { opacity:0; pointer-events:none; }

.prep-col { display:flex; flex-direction:column; align-items:center; gap:22px; }
.prep-title { font-size:20px; font-weight:600; letter-spacing:1.5px; text-align:center; }
.prep-meta { font-family:'JetBrains Mono', monospace; color:var(--subtle);
  font-size:12px; text-align:center; margin-top:4px; }
.step-list { width:380px; max-width:85vw; margin-top:6px; }
.step-row { display:flex; align-items:center; gap:14px; padding:7px 2px;
  font-size:13px; transition:opacity .4s; }
.step-row.pending { opacity:.3; }
.step-row.done { opacity:.65; }
.step-row.active { opacity:1; }
.step-row.err { opacity:1; color:var(--warn); }
.dot { width:8px; height:8px; border-radius:50%; background:var(--border);
  flex-shrink:0; transition:background .3s; }
.step-row.done .dot { background:var(--accent); }
.step-row.active .dot { background:var(--fg); animation:dotBreath 1.3s ease-in-out infinite; }
.step-row.err .dot { background:var(--warn); box-shadow:0 0 0 4px color-mix(in srgb, var(--warn) 20%, transparent); }
@keyframes dotBreath {
  0%,100% { box-shadow:0 0 0 2px color-mix(in srgb, var(--fg) 12%, transparent); }
  50%     { box-shadow:0 0 0 6px color-mix(in srgb, var(--fg) 4%, transparent); }
}
.step-t { min-width:100px; }
.step-meta { font-family:'JetBrains Mono', monospace; font-size:11px; color:var(--subtle); }

/* Picker */
.picker { width:420px; max-width:88%; display:flex; flex-direction:column; gap:10px; align-items:center; }
.cap { width:100%; border:1px solid var(--border); border-radius:6px;
  padding:10px 14px; display:flex; align-items:center; gap:12px;
  font-size:14px; cursor:pointer;
  transition:border-color .2s, background .2s;
  opacity:0; transform:translateY(6px); filter:blur(2px);
  animation:capIn .7s cubic-bezier(.22,1,.36,1) forwards; }
.cap:nth-child(2) { animation-delay:.12s; }
.cap:nth-child(3) { animation-delay:.22s; }
.cap:nth-child(4) { animation-delay:.32s; }
@keyframes capIn { to { opacity:1; transform:none; filter:none; } }
.cap:hover { border-color:var(--fg); }
.cap.primary { border-color:var(--accent); }
.cap.picked { background:color-mix(in srgb, var(--accent) 12%, transparent); }
.cap .k { font-family:'JetBrains Mono', monospace; font-size:11px; color:var(--accent); width:28px; }
.cap .l { flex:1; }
.cap .r { font-family:'JetBrains Mono', monospace; font-size:11px; color:var(--subtle); }

/* Reveal */
.reveal { position:absolute; inset:54px 0 0 0; display:flex;
  flex-direction:column; align-items:center; justify-content:center;
  pointer-events:none; overflow:hidden; }
.sparkle-burst { position:absolute; width:180px; height:180px; top:50%; left:50%;
  transform:translate(-50%,-50%); }
.sparkle-burst .ring { position:absolute; inset:0; border-radius:50%;
  border:1px solid var(--accent); opacity:0; transform:scale(.4); }
.reveal.play .sparkle-burst .ring { animation:ring 1.6s cubic-bezier(.22,1,.36,1) forwards; }
.reveal.play .sparkle-burst .ring.r2 { animation-delay:.15s; }
.reveal.play .sparkle-burst .ring.r3 { animation-delay:.3s; }
@keyframes ring {
  0% { opacity:1; transform:scale(.15); border-width:2px; }
  70% { opacity:.35; }
  100% { opacity:0; transform:scale(2.2); border-width:.5px; }
}
.ink-line { position:absolute; height:1px; background:var(--fg);
  left:50%; top:50%; transform:translate(-50%, 0);
  width:0; transition:width 1.1s cubic-bezier(.22,1,.36,1); }
.ink-line.top { margin-top:-48px; }
.ink-line.bot { margin-top:38px; }
.reveal.play .ink-line.top { width:480px; max-width:80%; transition-delay:.8s; }
.reveal.play .ink-line.bot { width:240px; max-width:50%; transition-delay:1.4s; }
.reveal .h1 { position:absolute; top:50%; left:50%;
  transform:translate(-50%,-50%);
  font-size:32px; font-weight:700; letter-spacing:2px; text-align:center;
  opacity:0; filter:blur(10px); padding:0 24px; }
.reveal.play .h1 { animation:h1In 1.3s cubic-bezier(.22,1,.36,1) 1.1s forwards; }
@keyframes h1In { to { opacity:1; filter:blur(0); } }
.reveal .sub { position:absolute; top:50%; left:50%;
  transform:translate(-50%, 18px);
  font-family:'JetBrains Mono', monospace; color:var(--subtle); font-size:12px; letter-spacing:1.5px;
  opacity:0; }
.reveal.play .sub { animation:subIn 1s cubic-bezier(.22,1,.36,1) 1.8s forwards; }
@keyframes subIn { to { opacity:1; } }

/* Article */
.article { position:absolute; inset:54px 0 0 0; overflow-y:auto;
  padding:56px 72px 80px;
  opacity:0; transition:opacity .8s; }
.article.show { opacity:1; }
.article-inner { max-width:720px; margin:0 auto; }
.article h1 { font-size:30px; font-weight:700; letter-spacing:1px; margin-bottom:6px; padding-bottom:14px; }
.article .meta { font-family:'JetBrains Mono', monospace; color:var(--subtle);
  font-size:12px; margin-bottom:36px; padding-bottom:20px;
  border-bottom:1px solid var(--border); }
.article h2 { font-size:22px; font-weight:700; margin:38px 0 10px; letter-spacing:.5px; }
.article h3 { font-size:12px; font-weight:500; color:var(--subtle);
  margin:18px 0 8px; letter-spacing:2px;
  font-family:'JetBrains Mono', monospace; text-transform:uppercase; }
.article p { font-size:16px; line-height:1.9; margin:0 0 14px; }
.article p .sp { font-weight:700; color:var(--fg); margin-right:6px; }
.fade-node { opacity:0; filter:blur(3px); transform:translateY(6px);
  animation:nodein 1.1s cubic-bezier(.22,1,.36,1) forwards; }
@keyframes nodein { to { opacity:1; filter:blur(0); transform:none; } }
.caret { display:inline-block; width:3px; height:1em;
  background:var(--accent); vertical-align:text-bottom;
  margin-left:2px; border-radius:1px;
  animation:blink 1.1s steps(2,end) infinite; }
@keyframes blink { 50% { opacity:0; } }

/* Interrupt block */
.interrupt { margin:26px 0 10px; padding-top:18px;
  border-top:1px solid var(--warn-border); position:relative; }
.interrupt::before { content:''; position:absolute; left:0; top:-1px;
  width:20%; height:1px; background:var(--warn); }
.interrupt .label-err { font-family:'JetBrains Mono', monospace;
  font-size:10px; color:var(--warn); letter-spacing:1px; margin-bottom:4px; }
.interrupt .msg { font-family:'Noto Serif SC', serif; font-size:13px;
  color:var(--subtle); margin-bottom:10px; }
.interrupt .actions { display:flex; gap:10px; }
.interrupt .btn { font-size:12px; padding:6px 14px; border-radius:4px; cursor:pointer; }
.interrupt .btn-primary { background:var(--accent); color:var(--bg); border:none; }
.interrupt .btn-ghost { background:transparent; color:var(--subtle);
  border:1px solid var(--border); }
```

- [ ] **Step 2: 不需要 SVG symbol 定义**

Task 13 已经在每处 `.sparkle` 元素内联了完整 SVG 内容，无需额外 `<symbol>`。跳过本步。

- [ ] **Step 3: 在 `<main>` 内 hero 之后追加 5 个 view 节点**

```html
<!-- Prep -->
<div class="stage view out" id="prepView">
  <div class="prep-col">
    <svg class="sparkle stage-logo" viewBox="-50 -50 100 100"><g class="spin"><g class="breath"><path class="bar-h" d="M-46 0 C-16 -2 -2 -16 0 -46 C2 -16 16 -2 46 0 C16 2 2 16 0 46 C-2 16 -16 2 -46 0 Z"/><circle class="small" cx="30" cy="30" r="3"/><circle class="small" cx="-30" cy="-30" r="3"/><circle class="small" cx="30" cy="-30" r="2"/><circle class="small" cx="-30" cy="30" r="2"/></g></g></svg>
    <div>
      <div class="prep-title" id="prepTitle">正在准备</div>
      <div class="prep-meta" id="prepMeta"></div>
    </div>
    <div class="step-list">
      <div class="step-row pending" data-step="1"><span class="dot"></span><span class="step-t">连接视频</span><span class="step-meta" id="m1"></span></div>
      <div class="step-row pending" data-step="2"><span class="dot"></span><span class="step-t">解析字幕轨</span><span class="step-meta" id="m2"></span></div>
      <div class="step-row pending" data-step="3"><span class="dot"></span><span class="step-t">下载字幕</span><span class="step-meta" id="m3"></span></div>
      <div class="step-row pending" data-step="4"><span class="dot"></span><span class="step-t">唤醒 Gemini</span><span class="step-meta" id="m4"></span></div>
    </div>
  </div>
</div>

<!-- Picker -->
<div class="stage view out" id="pickView">
  <div class="picker">
    <svg class="sparkle stage-logo" viewBox="-50 -50 100 100"><g class="spin"><g class="breath"><path class="bar-h" d="M-46 0 C-16 -2 -2 -16 0 -46 C2 -16 16 -2 46 0 C16 2 2 16 0 46 C-2 16 -16 2 -46 0 Z"/><circle class="small" cx="30" cy="30" r="3"/><circle class="small" cx="-30" cy="-30" r="3"/><circle class="small" cx="30" cy="-30" r="2"/><circle class="small" cx="-30" cy="30" r="2"/></g></g></svg>
    <div class="prep-title" id="pickTitle">—</div>
    <div class="prep-meta" id="pickMeta">选择一条字幕继续</div>
    <div id="capList" style="width:100%; display:flex; flex-direction:column; gap:10px;"></div>
  </div>
</div>

<!-- Reveal -->
<div class="reveal view out" id="revealView">
  <div class="sparkle-burst"><div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div></div>
  <div class="ink-line top"></div>
  <div class="ink-line bot"></div>
  <div class="h1" id="revealH1"></div>
  <div class="sub" id="revealSub"></div>
</div>

<!-- Article -->
<div class="article view out" id="articleView">
  <div class="article-inner">
    <h1 id="articleH1"></h1>
    <div class="meta" id="articleMeta"></div>
    <div id="articleBody"></div>
  </div>
</div>
```

- [ ] **Step 4: 本地看外观（手工切换 view 的 `.out` class 验证）**

Run: `npm run dev`
打开 DevTools Console，粘贴：
```js
document.getElementById('hero').classList.add('out')
document.getElementById('rail').classList.add('in')
document.getElementById('topbar').classList.add('in')
document.getElementById('prepView').classList.remove('out')
```
Expected: hero 淡出，rail/topbar 滑入，prep 阶段中间出现旋转的 sparkle + 四步列表。

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): sparkle sprite + stage/picker/reveal/article CSS"
```

---

### Task 15: `public/app.js` — 状态机骨架 + view 切换 + 主题

**Files:**
- Modify: `public/app.js` （全文替换）

- [ ] **Step 1: 写骨架**

```js
// ---------- State ----------
const state = {
  mode: 'rewrite',         // 'rewrite' | 'faithful'
  reqId: null,             // 当前请求的 id
  aborter: null,           // AbortController
  stage: 'idle',           // 'idle'|'prep'|'pick'|'reveal'|'article'|'error'
  tracks: null,            // 字幕清单
  meta: null,              // { title, subtitle, durationSec }
  articleEnded: false,     // end 事件到达后置 true
  cancelled: false,        // 用户主动中止，错误 UI 应静默
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id)
const $$ = (sel) => document.querySelector(sel)
const byAll = (sel) => document.querySelectorAll(sel)
const VIEWS = ['prepView', 'pickView', 'revealView', 'articleView']

function showView(which) {
  for (const v of VIEWS) $(v).classList.toggle('out', v !== which)
}
function hideAllViews() { for (const v of VIEWS) $(v).classList.add('out') }

function setStatus(text, err = false) {
  const pill = $('statusPill')
  pill.textContent = text
  pill.classList.toggle('err', !!err)
}

function setModeEverywhere(mode) {
  state.mode = mode
  byAll('[data-mode]').forEach(el => el.classList.toggle('on', el.dataset.mode === mode))
}

// ---------- Mode selection (hero + rail) ----------
byAll('[data-mode]').forEach(el => {
  el.addEventListener('click', () => setModeEverywhere(el.dataset.mode))
})

// ---------- Theme ----------
const savedTheme = localStorage.getItem('ytb-theme')
if (savedTheme === 'light') {
  document.documentElement.classList.add('light')
  $('themeBtn').textContent = '☀'
}
$('themeBtn').addEventListener('click', () => {
  const isLight = document.documentElement.classList.toggle('light')
  $('themeBtn').textContent = isLight ? '☀' : '☾'
  localStorage.setItem('ytb-theme', isLight ? 'light' : 'dark')
})

// ---------- Rail toggle ----------
$('railToggle').addEventListener('click', () => {
  const collapsed = $('rail').classList.toggle('collapsed')
  $('railToggle').textContent = collapsed ? '›' : '‹'
})

// ---------- Submit / flow (to be filled in Task 16) ----------
$('go').addEventListener('click', () => start())
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })

async function start() {
  // stub: will be implemented in Task 16
  console.log('start clicked, mode=', state.mode)
}
```

- [ ] **Step 2: 本地验证**

Run: `npm run dev` 打开 `http://localhost:8787`。测试：
- 点模式切换，rail 与 hero 两处的选中态应同步
- 点 ☾/☀ 主题切换，刷新后保持
- rail 此时未 in，看不到；可以用 console `$('rail').classList.add('in')` 测折叠按钮

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): state scaffold + mode sync + theme persistence"
```

---

### Task 16: `public/app.js` — fetch 流消费 + 事件 DOM 渲染

**Files:**
- Modify: `public/app.js` （追加）

- [ ] **Step 1: 实现 inspect / generate / 事件渲染**

追加到 `public/app.js`（替换 `start()` 存根并增加辅助函数）：

```js
// ---------- URL validation ----------
function validateUrl(raw) {
  try {
    const u = new URL(raw.trim())
    const host = u.hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtu.be') return u.pathname.length >= 12
    if (host === 'youtube.com') {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return true
      return /^\/(embed|shorts)\/[a-zA-Z0-9_-]{11}/.test(u.pathname)
    }
    return false
  } catch { return false }
}

// ---------- Flow ----------
async function start() {
  const url = $('url').value
  const hintErr = $('hintErr')
  if (!validateUrl(url)) { hintErr.textContent = '这不像是 YouTube 链接'; return }
  hintErr.textContent = ''
  $('url').disabled = true
  $('go').disabled = true

  // 入场：hero 淡出 → rail/topbar 滑入
  $('hero').classList.add('out')
  $('rail').classList.add('in')
  $('topbar').classList.add('in')
  $('topUrl').textContent = url
  $('railUrl').textContent = url
  $('rail').classList.add('dimmed')

  try {
    await runInspect(url)
  } catch (err) {
    showInlineError(err)
  }
}

async function runInspect(url) {
  showView('prepView')
  setStatus('连接视频')
  activateStep(1)
  const res = await fetch('/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const data = await res.json()
  state.reqId = data.reqId
  $('railReq').textContent = `req · ${data.reqId ?? '—'}`
  if (!res.ok) throw { code: data.error ?? 'INTERNAL', step: parseInt($$('.step-row.active')?.dataset?.step ?? '1', 10) }

  state.tracks = data.tracks
  state.meta = { title: data.title, channel: data.channel, durationSec: data.durationSec }
  $('m1').textContent = `${fmtDur(data.durationSec)} · ${data.channel}`
  doneStep(1); activateStep(2)
  setStatus('解析字幕')
  $('m2').textContent = `发现 ${data.tracks.length} 条`
  doneStep(2)

  showPicker(data)
}

function showPicker(data) {
  showView('pickView')
  setStatus('等待选择字幕')
  $('pickTitle').textContent = data.title
  $('pickMeta').textContent = `${fmtDur(data.durationSec)} · 共 ${data.tracks.length} 条字幕`
  const list = $('capList'); list.innerHTML = ''
  const sorted = [...data.tracks].sort((a, b) => (a.kind === 'manual' ? -1 : 1))
  sorted.forEach((t, i) => {
    const el = document.createElement('div')
    el.className = 'cap' + (i === 0 ? ' primary' : '')
    el.innerHTML = ''
    const k = document.createElement('span'); k.className = 'k'; k.textContent = t.lang.toUpperCase()
    const l = document.createElement('span'); l.className = 'l'
    l.textContent = `${t.label} · ${t.kind === 'manual' ? '手动' : '自动'}`
    const r = document.createElement('span'); r.className = 'r'
    r.textContent = t.tokens ? `${t.tokens.toLocaleString()} tok` : '—'
    el.append(k, l, r)
    el.addEventListener('click', () => { el.classList.add('picked'); pickTrack(t.id) })
    list.appendChild(el)
  })
}

async function pickTrack(trackId) {
  setStatus('下载字幕')
  activateStep(3)
  showView('prepView')
  try {
    await runGenerate(trackId)
  } catch (err) {
    showInlineError(err)
  }
}

async function runGenerate(trackId) {
  state.aborter = new AbortController()
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: $('url').value, trackId, mode: state.mode }),
    signal: state.aborter.signal,
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: 'INTERNAL' }))
    throw { code: data.error, step: 3 }
  }
  doneStep(3); activateStep(4)
  setStatus('唤醒 Gemini')
  $('m3').textContent = `track ${trackId}`

  await consumeSse(res.body)
}

async function consumeSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let gotMeta = false
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      const payload = frame.replace(/^data:\s*/, '')
      if (!payload || payload.startsWith(':')) continue  // SSE 注释（keepalive）
      let ev; try { ev = JSON.parse(payload) } catch { continue }
      if (!gotMeta && ev.type === 'meta') {
        gotMeta = true
        doneStep(4)
        setStatus('生成中')
        enterArticle(ev)
      } else {
        renderEvent(ev)
      }
    }
  }
  // 流结束但未收到 end 视为中断（由 error event / 无 end 判定）
  if (!state.articleEnded) showInterrupt('GEMINI_STREAM_DROP')
}

// ---------- Article rendering ----------
function enterArticle(metaEv) {
  $('revealH1').textContent = metaEv.title
  $('revealSub').textContent = metaEv.subtitle
  $('articleH1').textContent = metaEv.title
  $('articleMeta').textContent = metaEv.subtitle + ' · ' + fmtDur(metaEv.durationSec)
  document.title = metaEv.title
  hideAllViews()
  const rv = $('revealView'); rv.classList.remove('out')
  requestAnimationFrame(() => rv.classList.add('play'))
  setTimeout(() => {
    rv.classList.add('out')
    $('articleView').classList.remove('out')
    $('articleView').classList.add('show')
  }, 3200)  // reveal 序列总长 ~3.2s
}

function renderEvent(ev) {
  const body = $('articleBody')
  removeCaret()
  let node
  if (ev.type === 'h2') { node = document.createElement('h2'); node.textContent = ev.text }
  else if (ev.type === 'h3') { node = document.createElement('h3'); node.textContent = ev.text }
  else if (ev.type === 'p') {
    node = document.createElement('p')
    if (ev.speaker) {
      const sp = document.createElement('span'); sp.className = 'sp'
      sp.textContent = ev.speaker + '：'
      node.appendChild(sp)
    }
    node.appendChild(document.createTextNode(ev.text ?? ''))
    const caret = document.createElement('span'); caret.className = 'caret'; caret.id = 'liveCaret'
    node.appendChild(caret)
  } else if (ev.type === 'end') {
    setStatus('完成')
    state.articleEnded = true
    return
  } else if (ev.type === 'error') {
    showInterrupt(ev.code ?? 'INTERNAL', ev.message)
    return
  } else {
    return
  }
  node.classList.add('fade-node')
  body.appendChild(node)
  node.scrollIntoView({ behavior: 'smooth', block: 'end' })
}

function removeCaret() {
  const c = document.getElementById('liveCaret')
  if (c) c.remove()
}

// ---------- Step controls ----------
function activateStep(n) {
  byAll('.step-row').forEach(r => {
    const s = +r.dataset.step
    r.classList.remove('pending', 'active', 'done', 'err')
    if (s < n) r.classList.add('done')
    else if (s === n) r.classList.add('active')
    else r.classList.add('pending')
  })
}
function doneStep(n) {
  const r = document.querySelector(`.step-row[data-step="${n}"]`)
  if (r) { r.classList.remove('active', 'pending'); r.classList.add('done') }
}
function errorStep(n, text) {
  const r = document.querySelector(`.step-row[data-step="${n}"]`)
  if (r) { r.classList.remove('active', 'pending'); r.classList.add('err') }
  const metaEl = document.getElementById('m' + n)
  if (metaEl && text) metaEl.textContent = text
}

// ---------- Error UI（Task 17 会美化） ----------
function showInlineError(err) {
  // 占位：Chunk 4 Task 17 会替换为带按钮的中断块
  setStatus('⚠ 已中断', true)
  errorStep(3, err.code ?? 'ERROR')
}
function showInterrupt(code, msg) {
  // 占位：Chunk 4 Task 18 填充
  setStatus('⚠ 已中断', true)
  console.error('interrupt:', code, msg)
}

// ---------- Utils ----------
function fmtDur(sec) {
  if (!sec) return ''
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
```

- [ ] **Step 2: 本地端到端验证**

1. 在 `.dev.vars` 写入真实 `GEMINI_API_KEY=...`
2. Run: `npm run dev`
3. 打开 `http://localhost:8787`
4. 粘贴 `https://youtu.be/xRh2sVcNXQ8`，点"生成"

Expected 逐步：
- hero 淡出，rail + topbar 出现
- 中央 sparkle 转动、4 步列表点亮到第 2 步
- 展开 3 条字幕的选择卡，点第一条（English · 手动）
- 第 3/4 步点亮，reveal 动画播放（圆环 + 墨线 + 标题）
- 3.2s 后切到 article 页，开始逐段 fade-in 文字；末尾 caret 跟随
- 完成后 caret 消失，status pill 显示 "完成"

手工中断：打开 DevTools → Network → 右键正在 pending 的 generate → "Block request URL"。Expected：最后一段下方出现简单的 "已中断" 提示（本 Task 是占位；真正中断块在 Task 18）。

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): full inspect→pick→generate flow with event rendering"
```

---

**Chunk 3 boundary**: 停下，跑 plan-document-reviewer 检查 Chunk 3。

---

## Chunk 4: 错误态 + 取消 + 手动 smoke + 部署

### Task 17: 错误 UI（hero 输入 / prep 阶段 / 流中中断）+ 状态重置

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 替换 showInlineError / showInterrupt + 加 state 重置**

在 `public/app.js` 中找到 Task 16 的 `showInlineError` 和 `showInterrupt` 占位，整体替换为：

```js
// ---------- Reset between runs ----------
function resetRun() {
  state.reqId = null; state.tracks = null; state.meta = null
  state.articleEnded = false; state.cancelled = false
  state.aborter = null
  $('hintErr').textContent = ''
  $('articleBody').innerHTML = ''
  $('m1').textContent = ''; $('m2').textContent = ''
  $('m3').textContent = ''; $('m4').textContent = ''
  byAll('.step-row').forEach(r => { r.classList.remove('active','done','err'); r.classList.add('pending') })
  $('statusPill').classList.remove('err')
  setStatus('idle')
}

// ---------- Inline error helpers ----------
function ensureInlineActions(container, buttons) {
  // 清理已有的 .interrupt；插入新的
  container.querySelectorAll('.interrupt').forEach(n => n.remove())
  const box = document.createElement('div')
  box.className = 'interrupt'
  const label = document.createElement('div'); label.className = 'label-err'; label.textContent = '—— 中断'
  const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = buttons.msg
  const actions = document.createElement('div'); actions.className = 'actions'
  for (const b of buttons.list) {
    const btn = document.createElement('button')
    btn.className = 'btn ' + (b.primary ? 'btn-primary' : 'btn-ghost')
    btn.textContent = b.text
    btn.addEventListener('click', b.onClick)
    actions.appendChild(btn)
  }
  box.append(label, msg, actions)
  container.appendChild(box)
  return box
}

const ERROR_COPY = {
  INVALID_URL: '这不是一个合法的 YouTube 链接',
  VIDEO_NOT_FOUND: '视频不存在或已删除',
  NO_CAPTIONS: '这个视频没有可用字幕',
  YOUTUBE_BLOCKED: 'YouTube 拒绝了请求，请稍后再试',
  GEMINI_AUTH: 'Gemini 配置异常（API key 无效或过期）',
  GEMINI_RATE_LIMIT: 'Gemini 速率限制，请稍后再试',
  GEMINI_QUOTA: 'Gemini 免费额度已用尽',
  GEMINI_SAFETY: '内容触发了 Gemini 的安全拦截',
  GEMINI_TIMEOUT: 'Gemini 超时',
  GEMINI_STREAM_DROP: 'Gemini 连接断开',
  INTERNAL: '内部错误',
}
function errorMsg(code) { return ERROR_COPY[code] ?? `错误（${code ?? '未知'}）` }

// ---------- Hero validation error（替换之前的 hintErr = '这不像是...' 行不需动） ----------

// ---------- Prep-phase error (未进入流) ----------
function showInlineError(err) {
  // stop logo animation semantics by switching status pill
  setStatus('⚠ 已中断', true)
  const stepN = err.step ?? parseInt($$('.step-row.active')?.dataset?.step ?? '1', 10)
  errorStep(stepN, err.code)
  // 用现成的 picker/prep 区域底部，挂一个 inline 操作
  const anchor = $('prepView').classList.contains('out') ? $('pickView') : $('prepView')
  // 如果 picker 尚未出现也以 prepView 为底
  const host = anchor.querySelector('.prep-col') || anchor.querySelector('.picker')
  if (!host) return
  ensureInlineActions(host, {
    msg: errorMsg(err.code),
    list: [
      { text: '换视频', onClick: backToHero },
      { text: '重试', primary: true, onClick: retry },
    ],
  })
}

// ---------- Stream-phase interrupt (已进入流) ----------
function showInterrupt(code, message) {
  if (state.cancelled) return   // 用户主动取消时静默
  setStatus('⚠ 已中断', true)
  removeCaret()
  const body = $('articleBody')
  const estimatedPct = estimateProgress()
  ensureInlineActions(body, {
    msg: `${errorMsg(code)}（已生成约 ${estimatedPct}%）${message ? ' · ' + message : ''}`,
    list: [
      { text: '保留此片段', onClick: dismissInterrupt },
      { text: '重新生成完整版', primary: true, onClick: regenerate },
    ],
  })
}

function estimateProgress() {
  const paras = $('articleBody').querySelectorAll('p,h2,h3').length
  // 非常粗略：把节点数映射到 0–85%（真实完成率无法计算）
  return Math.min(85, 10 + paras * 3)
}

// ---------- Error action handlers ----------
function backToHero() {
  // 动画回 hero：rail/topbar 收起、hero 淡入
  if (state.aborter) { state.cancelled = true; state.aborter.abort() }
  $('rail').classList.remove('in')
  $('topbar').classList.remove('in')
  hideAllViews()
  $('hero').classList.remove('out')
  $('url').disabled = false; $('go').disabled = false
  resetRun()
}

function retry() {
  // 重新跑 inspect→pick→generate；复用 URL
  resetRun()
  $('rail').classList.add('dimmed')
  runInspect($('url').value).catch(showInlineError)
}

function regenerate() {
  // 流中错误：从头再跑一次完整流程（LLM 无法断点续传）
  resetRun()
  // 重置 article 视图
  $('articleBody').innerHTML = ''
  $('articleView').classList.add('out')
  $('articleView').classList.remove('show')
  showView('prepView')
  activateStep(1)
  $('rail').classList.add('dimmed')
  runInspect($('url').value).catch(showInlineError)
}

function dismissInterrupt() {
  $('articleBody').querySelectorAll('.interrupt').forEach(n => n.remove())
  setStatus('已保留片段')
}
```

- [ ] **Step 2: 完整替换 `runGenerate` 与 `consumeSse`**

关键变化：
- `runGenerate` fetch 外包 AbortError 捕获 → 静默返回
- `consumeSse` 内部区分"首 meta 前错误"与"首 meta 后错误"：
  - 首 meta 到达前：向上抛，由上层 `showInlineError` 显示 prep 阶段中断 UI
  - 首 meta 到达后：就地显示 `showInterrupt`（暖琥珀横线挂在文章末尾）
- 正常收到 `end` 事件 → `articleEnded=true`，自然结束
- 用户主动取消 → `cancelled=true`，静默

将 Task 16 写的 `runGenerate` 与 `consumeSse` 整段替换为：

```js
async function runGenerate(trackId) {
  state.aborter = new AbortController()
  let res
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: $('url').value, trackId, mode: state.mode }),
      signal: state.aborter.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError' || state.cancelled) return
    throw err
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: 'INTERNAL' }))
    throw { code: data.error, step: 3 }
  }
  doneStep(3); activateStep(4)
  setStatus('唤醒 Gemini')
  $('m3').textContent = `track ${trackId}`

  await consumeSse(res.body)
}

async function consumeSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let gotMeta = false

  const readNext = async () => {
    try { return await reader.read() }
    catch (err) {
      if (state.cancelled) return { done: true, value: undefined }
      throw err
    }
  }

  try {
    while (true) {
      const { value, done } = await readNext()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2)
        const payload = frame.replace(/^data:\s*/, '')
        if (!payload || payload.startsWith(':')) continue   // 空行或 SSE 注释（keepalive）
        let ev; try { ev = JSON.parse(payload) } catch { continue }
        if (!gotMeta && ev.type === 'meta') {
          gotMeta = true
          doneStep(4); setStatus('生成中')
          enterArticle(ev)
        } else {
          renderEvent(ev)
        }
      }
    }
  } catch (err) {
    if (state.cancelled) return
    if (!gotMeta) throw err                          // 首 meta 前：上抛，由上层显示 prep 阶段中断
    showInterrupt('GEMINI_STREAM_DROP', String(err))  // 首 meta 后：就地插文章末尾中断块
    return
  }
  // 流自然结束
  if (state.cancelled) return
  if (!gotMeta) throw { code: 'GEMINI_STREAM_DROP' }  // 连 meta 都没出过：按 prep 阶段处理
  if (!state.articleEnded) showInterrupt('GEMINI_STREAM_DROP')
}
```

**不需要改动 Task 16 写的其它函数**——仅这两个整替换即可。

- [ ] **Step 3: 本地验证三种错误路径**

Run: `npm run dev`

1. **输入非法 URL**（hero）：粘贴 `https://vimeo.com/1`，点"生成"。Expected：hero 下方出现红色小字"这不像是 YouTube 链接"，页面不跳转。

2. **视频无字幕**（prep）：找一个没字幕的视频 URL（音乐视频常无字幕）。Expected：prep 第 2 步小圆点变暖琥珀色 + 错因；下方出现"换视频 / 重试"按钮。

3. **流中中断**（stream）：用 `https://youtu.be/xRh2sVcNXQ8` 正常启动，等文章开始流出 2–3 段后，DevTools → Network → 右键 pending 的 generate → "Block request URL"。Expected：最新段末尾出现暖琥珀横线与"保留此片段 / 重新生成完整版"按钮；已读内容保留。

4. **主动取消**（silent）：正常跑到文章流入阶段，直接刷新浏览器（`⌘R`）。Expected：`npm run tail` 里应看到 `{"phase":"cancelled","reqId":"..."}` 日志；重新打开页面是干净的 hero，**无任何错误弹出**（页面 reload 导致 fetch 的 AbortError 被静默处理）。

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): inline error states + interrupt block + state reset"
```

---

### Task 18: 端到端 smoke test + 部署

**Files:**
- Create: `GEMINI_API_KEY` 通过 `wrangler secret put`
- No code changes; 仅是部署 + 验证

- [ ] **Step 1: 跑所有单测**

Run: `npm test`
Expected: parser 5 + prompt 3 + youtube 20 + gemini 8 = **36 passed**。

- [ ] **Step 2: 本地端到端 smoke**

依照 spec Verification 章节逐条跑（`http://localhost:8787`）：

1. 打开页面 → Hero + sparkle 呼吸旋转
2. 粘 `https://www.youtube.com/watch?v=xRh2sVcNXQ8`，点"生成"
3. hero 淡出、rail 滑入、URL pill 下沉、prep 四步点亮
4. 字幕选择卡出现 → 点 English · 手动
5. reveal 动画完整播放（圆环 + 墨线 + 标题浮现 + 副标 + 消散）
6. 文章开始段落级淡入
7. 对照参考稿风格：应能看出 h2 大章节 + h3 小节 + 说话人前缀
8. 切主题 ☾ ↔ ☀ 平滑
9. 断网中断测试：出现暖琥珀中断块，已读保留
10. `npm run tail` 应看到 per-req 的结构化日志链（`start → youtube.fetch → caption.download → gemini.first → done`）

每一条不通过就记录并回到对应 Task 修。

- [ ] **Step 3: 推 secret 到线上**

```bash
npx wrangler secret put GEMINI_API_KEY
# 粘贴真实 key；按 Enter
```

- [ ] **Step 4: 部署**

```bash
npm run deploy
```

Expected: 输出形如 `Published ytb-studio → https://ytb-studio.<account>.workers.dev`。

- [ ] **Step 5: 线上 smoke**

在新浏览器标签打开部署 URL，重跑 Step 2 的验证序列。特别关注：
- 首页加载时间 ≤ 500ms
- Gemini 首 chunk 延迟（wrangler tail 里的 `gemini.first` durMs 字段）通常 < 3000ms
- 完整一个 60min 视频的生成 `done` durMs 通常 40–90s

- [ ] **Step 6: 更新 README + commit**

`README.md` 在初始 bootstrap 时已创建（单行占位）；此处整篇替换为：

```markdown
# ytb-studio

把 YouTube 对话变成一篇可读的中文文章。流式生成，支持深度改写与忠实翻译两种模式。

- 🌐 **线上地址**：https://ytb-studio.<account>.workers.dev
- 📄 **设计文档**：[`docs/superpowers/specs/2026-04-20-ytb-studio-design.md`](docs/superpowers/specs/2026-04-20-ytb-studio-design.md)
- 🧪 **本地跑**：`npm install && echo "GEMINI_API_KEY=xxx" > .dev.vars && npm run dev`
- 🚀 **部署**：`npm run deploy`

基于 Cloudflare Workers + Gemini 2.5 Flash。
```

```bash
git add README.md
git commit -m "docs: link deployed URL in README"
git push origin main
```

---

**Chunk 4 boundary**: 跑 plan-document-reviewer 检查最后一块。通过即可进入执行。

