const GEMINI_TIPS = [
  '分析视频节奏与画面节拍…',
  '读取视频语音与文本信号…',
  '识别每位讲话者的声纹与措辞风格…',
  '归纳话题转折与章节结构…',
  '选取最具代表性的对话片段…',
  '以中文深度访谈稿风格重写…',
  '调整段落的呼吸与节奏…',
  '校对事实与上下文一致性…',
  '润色过渡句与起承转合…',
]

const MAX_FALLBACK_LOGS = 5

export function createGeminiWaitUi({ $ }) {
  let tipTimerHandle = null
  let elapsedTimerHandle = null
  let tipIndexRef = 0
  let generateStartMs = 0
  let tipWarmLocked = false

  function setTipText(text) {
    const el = $('geminiTip')
    el.style.opacity = '0'
    setTimeout(() => { el.textContent = text; el.style.opacity = '' }, 400)
  }

  function startGeminiWait() {
    tipWarmLocked = false
    tipIndexRef = 0
    generateStartMs = Date.now()
    const tip = $('geminiTip')
    const timer = $('geminiTimer')
    clearFallbackLog()
    tip.hidden = false
    tip.className = 'gemini-tip'
    tip.textContent = GEMINI_TIPS[0]
    timer.hidden = false
    timer.textContent = '已等待 0s · 预估 1–3 分钟'
    tipTimerHandle = setInterval(() => {
      if (tipWarmLocked) return
      tipIndexRef = (tipIndexRef + 1) % GEMINI_TIPS.length
      setTipText(GEMINI_TIPS[tipIndexRef])
    }, 4000)
    elapsedTimerHandle = setInterval(() => {
      const s = Math.round((Date.now() - generateStartMs) / 1000)
      const est = s >= 180 ? '视频较长，请继续等待' : '预估 1–3 分钟'
      $('geminiTimer').textContent = `已等待 ${s}s · ${est}`
    }, 1000)
  }

  function stopGeminiWait() {
    if (tipTimerHandle) { clearInterval(tipTimerHandle); tipTimerHandle = null }
    if (elapsedTimerHandle) { clearInterval(elapsedTimerHandle); elapsedTimerHandle = null }
    tipWarmLocked = false
    $('geminiTip').hidden = true
    $('geminiTimer').hidden = true
    clearFallbackLog()
  }

  function setTipToWarm() {
    if (tipWarmLocked) return
    const el = $('geminiTip')
    if (el.hidden) return
    tipWarmLocked = true
    el.className = 'gemini-tip warm'
    setTipText('Gemini 仍在深度思考，长视频通常需要 1–3 分钟…')
  }

  function updatePrepHeartbeat(s, stage = '', ev = {}) {
    const isLongVideoStage = String(stage).startsWith('long_video_')
    const isFallbackStage = stage === 'long_video_fallback' || stage === 'model_fallback'
    if (isFallbackStage) {
      appendFallbackLog(stage, ev)
      return
    }
    if (!isLongVideoStage && s >= 20) setTipToWarm()
    const timer = $('geminiTimer')
    if (!timer.hidden) {
      timer.textContent = `已等待 ${Math.round((Date.now() - generateStartMs) / 1000)}s · Gemini 已静默 ${Math.round(s)}s`
    }
  }

  function appendFallbackLog(stage, ev) {
    const log = $('fallbackLog')
    if (!log) return
    const row = document.createElement('div')
    row.className = 'fallback-row'
    const time = document.createElement('span')
    time.className = 'time'
    time.textContent = fmtWaitElapsed()
    const text = document.createElement('span')
    text.textContent = fallbackLogText(stage, ev)
    row.append(time, text)
    log.appendChild(row)
    while (log.children.length > MAX_FALLBACK_LOGS) log.firstElementChild?.remove()
    log.hidden = false
  }

  function fallbackLogText(stage, ev) {
    if (stage === 'long_video_fallback') {
      return '发现长视频，处理可能需要更长的时间，请耐心等待...'
    }
    if (stage === 'model_fallback') {
      const from = ev.from || '当前模型'
      const to = ev.to || '备用模型'
      return `${from} 响应不佳，已切换到 ${to} 继续生成`
    }
    return '已调整生成策略，继续等待 Gemini 输出'
  }

  function fmtWaitElapsed() {
    const s = Math.max(0, Math.round((Date.now() - generateStartMs) / 1000))
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }

  function clearFallbackLog() {
    const log = $('fallbackLog')
    if (!log) return
    log.innerHTML = ''
    log.hidden = true
  }

  function clearPrepHeartbeat() {
    const timer = $('geminiTimer')
    if (!timer.hidden) {
      const elapsed = Math.round((Date.now() - generateStartMs) / 1000)
      timer.textContent = `已等待 ${elapsed}s`
    }
  }

  return {
    clearPrepHeartbeat,
    setTipToWarm,
    startGeminiWait,
    stopGeminiWait,
    updatePrepHeartbeat,
  }
}
