const ERROR_COPY = {
  INVALID_URL: '这不是一个合法的 YouTube 链接',
  EMPTY_ARTICLE: 'Gemini 没有返回正文，请重试或换一个公开视频。',
  GEMINI_AUTH: 'Gemini API Key 无效或已过期，请检查部署的 GEMINI_API_KEY 配置。',
  GEMINI_QUOTA: 'Gemini 免费额度已用尽（免费档每天仅 20 次）。请为 Gemini key 开启付费计划后重试。',
  GEMINI_CONTEXT_LIMIT: '视频太长，已超出 Gemini 单次上下文上限。',
  GEMINI_LONG_VIDEO_LIMIT: '长视频已达到当前分段处理上限。',
  GEMINI_RATE_LIMIT: 'Gemini 当前限流，请 30 秒后重试。',
  GEMINI_SAFETY: '内容触发了 Gemini 的安全策略，该视频无法处理。',
  GEMINI_VIDEO_UNSUPPORTED: '该视频 Gemini 无法直读（私密 / 年龄限制 / 格式不支持）。',
  GEMINI_STREAM_DROP: 'Gemini 连接中断（通常是网络或超时），请重试。',
  GEMINI_TIMEOUT: 'Gemini 请求超时，请重试。',
  GEMINI_OVERLOADED: 'Gemini 模型当前过载（Google 侧临时排队，通常 30 秒内缓解）。请稍后重试。',
  INTERNAL: '内部错误',
}

export function errorMsg(code) {
  return ERROR_COPY[code] ?? `错误（${code ?? '未知'}）`
}
