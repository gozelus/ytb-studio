/**
 * [WHAT] Builds the Gemini prompt for the two article-generation modes (rewrite / faithful).
 * [WHY]  Isolated so prompt text can be versioned, diffed, and tested without touching I/O code.
 * [INVARIANT] PROMPT_VERSION must be bumped whenever CONTRACT or mode rules change — it is
 *             logged on every generate request so regressions can be correlated to prompt edits.
 */

import type { Mode } from './types'

/** Bump when CONTRACT or mode rules change; logged per-request for regression tracing. */
export const PROMPT_VERSION = 'v4'

const CONTRACT = `
你是一位中文科技编辑，正在把一段 YouTube 对话重排成可读的中文文章。
只输出 newline-delimited JSON（ndjson），一行一个事件。
禁止 markdown 围栏、禁止前后闲聊、禁止任何 JSON 之外的文字。

事件类型：
  {"type":"meta","title":"...","subtitle":"..."}        // 第一条，唯一
  {"type":"h2","text":"..."}                            // 大章节标题（仅 rewrite 模式）
  {"type":"h3","text":"..."}                            // 小节主题
  {"type":"p","speaker":"...或null","text":"..."}        // 对话段落；speaker 来自视频内容
  {"type":"end"}                                        // 最后一条
`.trim()

const FIDELITY_RULES = `
内容忠实度硬约束：
- 文章必须基于视频字幕/音轨里的真实对话，不要把访谈改写成泛泛的观点摘要。
- 保留 Q&A 骨架：一个 h3 下通常先给提问者问题，再给回答者完整回答。
- rewrite 可以合并碎句、润色中文，但不能改变谁问、谁答、核心结论和先后顺序。
- 不要把有明确说话人的发言改成 speaker=null 的旁白；speaker=null 只用于极短过渡句。
- 回答较长时可以拆为连续多个同 speaker 段落；不要拆成无人物标签的条目清单。
`.trim()

const REWRITE_RULES = `
模式：rewrite（深度改写）
- 必须输出 6–9 个大章节（h2）完整覆盖对话主线；宁可每章简短，也要把视频后半段讲完，不许在前两章过度展开后被截断
- 每个 h2 下 2–4 个小节（h3）；每个 h3 下 2–4 段 p；单段 p 控制在 60–220 字
- h2 严格用「主题：副题」格式（中文全角冒号），如「技术革命：八十年一遇的AI巅峰」、「价值捕捉：按需计费与价值定价」
- h3 是章节内话题导读，10–22 字，简短紧凑
- 保留说话人姓名和问答关系；合并碎句；必要处插入极少量衔接说明（speaker=null）
- 全篇追求"精炼 + 全覆盖"：与其把某章写透，不如让所有主题都出场；风格参考：晚点 LatePost、虎嗅深度访谈稿
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
- 关键线索：若有人说出 "to your point, X" / "thanks for coming, X" 这类直呼姓名的句子，说明 X 是在场的另一位参与者，应作为独立 speaker 使用，即使其台词较少也要单列
- 若视频有多位主持人或嘉宾，分别给提问和回答段落分配不同姓名，不要把所有问题都归于同一位
- 若视频标题或描述能看出姓名，使用姓名；否则用 "Host"、"Guest"、"Speaker A"
- 不要只凭问号改写人物；如果上下文或画面显示某位嘉宾在提问，就使用那位嘉宾的姓名
- meta.subtitle 里体现出所有已识别的讲话人，例如 "Channel · Host × Guest / Co-host"
- 推断不出时 speaker 用 null
`.trim()

const FEW_SHOT_MULTI_SPEAKER = `
示例 1（多讲话人、命名清晰）：

{"type":"meta","title":"一场技术革命的商业拐点","subtitle":"Host × Guest"}
{"type":"h2","text":"技术革命：从概念到落地"}
{"type":"h3","text":"收入增长与产品演变"}
{"type":"p","speaker":"Host","text":"目前这个领域的商业表现和收入增长情况如何？"}
{"type":"p","speaker":"Guest","text":"新一波公司的收入增长正处于罕见的爆发期，这种增长来自真实客户需求。"}
{"type":"p","speaker":"Host","text":"这种产品形态未来会如何变化？"}
`.trim()

const FEW_SHOT_UNCLEAR_SPEAKER = `
示例 2（说话人不明时使用 null 或占位名）：

{"type":"h3","text":"主持人开场"}
{"type":"p","speaker":null,"text":"欢迎回到节目。今天我们要聊的话题，关乎未来十年的科技格局。"}
{"type":"p","speaker":"Guest","text":"谢谢邀请。这的确是一个值得深入讨论的时刻。"}
`.trim()

const FEW_SHOT_TOPIC_SHIFT = `
示例 3（话题转折用新 h3，并允许 speaker=null 的衔接）：

{"type":"p","speaker":"Guest","text":"所以综合来看，硬件供应紧张只是短期现象。"}
{"type":"p","speaker":null,"text":"话题随即转向地缘政治。"}
{"type":"h3","text":"中美芯片竞赛"}
{"type":"p","speaker":"Host","text":"那么某个地区的技术崛起，对行业意味着什么？"}
`.trim()

const FEW_SHOT = [
  FEW_SHOT_MULTI_SPEAKER,
  FEW_SHOT_UNCLEAR_SPEAKER,
  FEW_SHOT_TOPIC_SHIFT,
].join('\n\n')

/**
 * Prompt for the Gemini fileData path where Gemini fetches the video itself.
 * No [VIDEO META] or [TRANSCRIPT] sections; Gemini extracts them from the attached fileData.
 */
export function buildPromptForVideo(mode: Mode): string {
  const rules = mode === 'rewrite' ? REWRITE_RULES : FAITHFUL_RULES
  return [
    CONTRACT,
    FIDELITY_RULES,
    rules,
    SPEAKER_RULES,
    FEW_SHOT,
    '\n[VIDEO] 附件中是一段 YouTube 视频。请基于视频的字幕（优先）或音轨产出文章，遵守上述事件 schema 与模式规则。',
  ].filter(Boolean).join('\n\n')
}

export function buildPromptForVideoSegment(
  mode: Mode,
  opts: { segmentIndex: number; startSec: number; endSec: number; includeMeta: boolean },
): string {
  const base = buildPromptForVideo(mode)
  const start = fmtOffset(opts.startSec)
  const end = fmtOffset(opts.endSec)
  const metaRule = opts.includeMeta
    ? '这是第 1 个片段，必须先输出唯一的 meta 事件。'
    : '这不是第 1 个片段，禁止输出 meta 事件，直接延续正文结构。'
  return [
    base,
    [
      '[LONG VIDEO SEGMENT]',
      `当前只处理视频片段 ${opts.segmentIndex + 1}：${start} 到 ${end}。`,
      metaRule,
      '这是长视频分段任务，覆盖范围以当前片段为准；不需要在单个片段内满足全片 6–9 个 h2 的数量要求。',
      '你的输出会直接拼接到同一篇文章里；不要写独立开场、独立总结，禁止发明同义新标题。',
      '如需标题，只能使用上方全局骨架中与当前片段最匹配的原始 h2/h3 标题。',
      '只写当前片段里真实出现的内容，不要概括尚未看到的后续片段。',
      '如果当前片段没有可用语音或字幕，只输出 {"type":"end"}。',
    ].join('\n'),
  ].join('\n\n')
}

function fmtOffset(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}
