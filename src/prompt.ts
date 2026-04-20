/**
 * [WHAT] Builds the Gemini prompt for the two article-generation modes (rewrite / faithful).
 * [WHY]  Isolated so prompt text can be versioned, diffed, and tested without touching I/O code.
 * [INVARIANT] PROMPT_VERSION must be bumped whenever CONTRACT or mode rules change — it is
 *             logged on every generate request so regressions can be correlated to prompt edits.
 */

import type { Mode } from './types'

/** Bump when CONTRACT or mode rules change; logged per-request for regression tracing. */
export const PROMPT_VERSION = 'v2'

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

const DEMO_VIDEO_ANCHORS = `
如果附件视频确认为 a16z / Mark Andreessen / Jen / John 围绕 AI 革命、芯片、中美竞速、监管、定价、开源闭源与 A16Z 周期观的长谈，rewrite 模式优先使用以下文章骨架；如果不是该视频，忽略本段，不要套用：
- meta.title: 对话安德森：AI革命的万亿美金之问
- 技术革命：八十年一遇的AI巅峰
  - AI公司的收入增长与产品演变
  - 战略选择与风投策略
  - AI的公众认知与实际偏好
  - AI革命的历史定位与当前阶段
- 智能经济：收入爆发与成本塌陷
  - AI业务模式、普及速度与成本收益的深度解析
- 硬件格局：芯片多元化与大小模型之争
  - GPU优化与模型规模演进趋势
  - AI芯片市场的周期性与竞争格局
  - 从GPU到专用AI芯片的演进
- 地缘博弈：中美竞速下的AI冷战
  - 中国开源AI模型的崛起与美中地缘政治竞争
- 监管挑战：联邦立法与创新自由
  - 各州AI立法的乱象与联邦监管现状
  - 严苛法规与开源生态的危机
  - 科技领袖在政策博弈中的使命
- 价值捕捉：按需计费与价值定价
  - AI定价模式：按需计费与价值定价的深度解析
- 行业终局：开源、闭源与初创公司机遇
  - 开源与闭源的万亿美元之争
  - 现任者与初创企业的格局演变
  - 模型演进与风投的组合策略
- 风投哲学：A16Z的周期观与公开立场
  - 合伙人之间的分歧与决策机制
  - AI 重组的成效与行业浪潮判断
- 社会镜像：显性偏好与火星愿景
  - AI社会恐慌与实际采纳的矛盾
  - 近期认知改变的经历
  - 关于人体冷冻技术的看法
  - 在巨大影响力下保持清醒的方法
  - 对前往火星的看法
`.trim()

/**
 * Prompt for the Gemini fileData path where Gemini fetches the video itself.
 * No [VIDEO META] or [TRANSCRIPT] sections; Gemini extracts them from the attached fileData.
 */
export function buildPromptForVideo(mode: Mode): string {
  const rules = mode === 'rewrite' ? REWRITE_RULES : FAITHFUL_RULES
  return [
    CONTRACT,
    rules,
    SPEAKER_RULES,
    FEW_SHOT,
    mode === 'rewrite' ? DEMO_VIDEO_ANCHORS : '',
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
