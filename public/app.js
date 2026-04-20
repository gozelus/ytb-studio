/**
 * [WHAT]  Front-end state machine for ytb-studio.
 * [WHY]   Single JS file — no build step, served as a static asset.
 *         Handles the full user flow: hero → inspect → generate (SSE) → article.
 * [INVARIANT] Meta alone never opens the article view; reveal starts only when the
 *             first renderable article event arrives.
 *             state.cancelled is set to true before abort() and cleared only at the
 *             entry of a new run (start/retry/regenerate), never inside resetRun().
 */

// ---------- State ----------
const state = {
  mode: 'rewrite',
  reqId: null,
  aborter: null,
  revealTimer: null,     // setTimeout handle for the reveal→article transition
  articleEnded: false,
  cancelled: false,
  revealDone: false,     // true once reveal animation hands off to articleView
  renderQueue: [],       // body events buffered during reveal
  renderTickHandle: null, // setInterval handle for throttled paragraph rendering
  navItems: [],          // streaming article headings rendered in the rail TOC
  nextHeadingId: 1,
  navSyncFrame: null,
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id)
const $$ = (sel) => document.querySelector(sel)
const byAll = (sel) => document.querySelectorAll(sel)
const VIEWS = ['prepView', 'revealView', 'articleView']

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
  setRailCollapsed(!$('rail').classList.contains('collapsed'))
})

function setRailCollapsed(collapsed) {
  $('rail').classList.toggle('collapsed', collapsed)
  $('railToggle').textContent = collapsed ? '›' : '‹'
  $('railToggle').setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏')
}

function resetRailArticle() {
  state.navItems = []
  state.nextHeadingId = 1
  if (state.navSyncFrame) { cancelAnimationFrame(state.navSyncFrame); state.navSyncFrame = null }
  $('railArticle').hidden = true
  $('railArticleTitle').textContent = '—'
  $('railToc').innerHTML = ''
  $('rail').classList.remove('reading')
}

function showRailArticle(metaEv) {
  resetRailArticle()
  $('rail').classList.add('reading')
  $('railArticle').hidden = false
  $('railArticleTitle').textContent = metaEv.title || '正在生成文章'
  appendRailNav('articleH1', '文章开头', 'top')
  activateRailNav('articleH1')
}

function registerRailHeading(node, ev) {
  if (ev.type !== 'h2' && ev.type !== 'h3') return
  node.id = node.id || `section-${state.nextHeadingId++}`
  appendRailNav(node.id, ev.text || '未命名章节', ev.type)
  scheduleRailActiveSync()
}

function appendRailNav(targetId, text, level) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `toc-item toc-${level}`
  btn.dataset.target = targetId
  btn.textContent = text
  btn.addEventListener('click', () => jumpToRailTarget(targetId))
  $('railToc').appendChild(btn)
  state.navItems.push({ targetId, btn })
}

function jumpToRailTarget(targetId) {
  const target = $(targetId)
  const article = $('articleView')
  if (!target || !article) return
  article.scrollTop = Math.max(0, target.offsetTop - 28)
  activateRailNav(targetId)
}

function activateRailNav(targetId) {
  for (const item of state.navItems) item.btn.classList.toggle('active', item.targetId === targetId)
}

function scheduleRailActiveSync() {
  if (state.navSyncFrame) return
  state.navSyncFrame = requestAnimationFrame(() => {
    state.navSyncFrame = null
    const article = $('articleView')
    let active = state.navItems[0]?.targetId
    for (const item of state.navItems) {
      const node = $(item.targetId)
      if (node && node.offsetTop - 80 <= article.scrollTop) active = item.targetId
    }
    if (active) activateRailNav(active)
  })
}

$('articleView').addEventListener('scroll', scheduleRailActiveSync)

// ---------- URL validation ----------
function validateUrl(raw) {
  try {
    const u = new URL(raw.trim())
    const host = u.hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtu.be') return /^\/[a-zA-Z0-9_-]{11}$/.test(u.pathname)
    if (host === 'youtube.com') {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return true
      return /^\/(embed|shorts)\/[a-zA-Z0-9_-]{11}(?:[?/]|$)/.test(u.pathname)
    }
    return false
  } catch { return false }
}

// ---------- Submit ----------
$('go').addEventListener('click', () => start())
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })

async function start() {
  state.cancelled = false
  const url = $('url').value
  const hintErr = $('hintErr')
  if (!validateUrl(url)) { hintErr.textContent = '这不像是 YouTube 链接'; return }
  hintErr.textContent = ''
  $('url').disabled = true
  $('go').disabled = true

  $('hero').classList.add('out')
  $('rail').classList.add('in')
  setRailCollapsed(false)
  resetRailArticle()
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

// ---------- Inspect ----------
async function runInspect(url) {
  showView('prepView')
  setStatus('连接视频')
  const res = await fetch('/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const data = await res.json()
  state.reqId = data.reqId ?? null
  renderRailReq()
  if (!res.ok) throw { code: data.error ?? 'INTERNAL' }

  setStatus('生成中')
  showView('prepView')
  try {
    await runGenerate()
  } catch (err) {
    showInlineError(err)
  }
}

// ---------- Generate ----------
async function runGenerate() {
  state.aborter = new AbortController()
  let res
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: $('url').value, mode: state.mode }),
      signal: state.aborter.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError' || state.cancelled) return
    throw err
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: 'INTERNAL' }))
    throw { code: data.error ?? 'INTERNAL' }
  }
  const streamReqId = res.headers.get('x-req-id')
  if (streamReqId) {
    state.reqId = streamReqId
    renderRailReq()
  }
  setStatus('唤醒 Gemini')
  startGeminiWait()

  await consumeSse(res.body)
}

// ---------- SSE consumer ----------
async function consumeSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let gotMeta = false
  let enteredArticle = false
  let streamEnded = false
  let metaEv = null

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      // SSE frames are delimited by double newlines
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2)
        const payload = frame.replace(/^data:\s*/, '')
        if (!payload || payload.startsWith(':')) continue  // skip keepalive lines
        let ev; try { ev = JSON.parse(payload) } catch { continue }
        if (ev.type === 'meta') {
          gotMeta = true
          metaEv = ev
          setStatus('生成正文')
          continue
        }
        if (!enteredArticle && ev.type === 'heartbeat') {
          updatePrepHeartbeat(ev.idleSeconds ?? 0, ev.stage, ev)
          continue
        }
        if (!enteredArticle && (ev.type === 'h2' || ev.type === 'h3' || ev.type === 'p')) {
          enteredArticle = true
          stopGeminiWait()
          clearPrepHeartbeat()
          setStatus('生成中')
          enterArticle(metaEv ?? fallbackMeta())
          renderEvent(ev)
          continue
        }
        if (!enteredArticle && ev.type === 'error') {
          state.articleEnded = true  // prevent GEMINI_STREAM_DROP throw at loop exit
          showInlineError({ code: ev.code ?? 'INTERNAL', message: ev.message })
          return
        }
        if (!enteredArticle && ev.type === 'end') {
          state.articleEnded = true
          showInlineError({ code: 'EMPTY_ARTICLE' })
          return
        }
        if (ev.type === 'end') streamEnded = true
        renderEvent(ev)
      }
    }
  } catch (err) {
    if (state.cancelled) return
    if (!enteredArticle) throw err
    showInterrupt('GEMINI_STREAM_DROP')
    return
  }

  if (state.cancelled) return
  if (!enteredArticle) throw { code: gotMeta ? 'EMPTY_ARTICLE' : 'GEMINI_STREAM_DROP' }
  if (!streamEnded && !state.articleEnded) showInterrupt('GEMINI_STREAM_DROP')
}

// ---------- Article ----------
function enterArticle(metaEv) {
  const title = metaEv.title || '(未命名)'
  const metaParts = [metaEv.subtitle, fmtDur(metaEv.durationSec)].filter(Boolean)
  $('revealH1').textContent = title
  $('revealSub').textContent = metaEv.subtitle ?? ''
  $('articleH1').textContent = title
  $('articleMeta').textContent = metaParts.join(' · ')
  document.title = title
  showRailArticle({ ...metaEv, title })
  setRailCollapsed(true)
  hideAllViews()
  const rv = $('revealView')
  // Reset animation state so replay works (CSS keyframes won't restart if .play already present)
  rv.classList.remove('play')
  void rv.offsetWidth
  rv.classList.remove('out')
  requestAnimationFrame(() => rv.classList.add('play'))
  state.revealTimer = setTimeout(() => {
    state.revealTimer = null
    rv.classList.add('out')
    $('articleView').classList.remove('out')
    $('articleView').classList.add('show')
    state.revealDone = true
    startRenderTick()
  }, 3200)
}

function fallbackMeta() {
  return { title: '正在生成文章', subtitle: '', durationSec: null }
}

function renderEvent(ev) {
  if (ev.type === 'heartbeat') {
    updateStallIndicator(ev.idleSeconds ?? 0)
    if ((ev.idleSeconds ?? 0) >= 20) setTipToWarm()
    return
  }
  if (state.articleEnded && ev.type !== 'end') return
  if (ev.type === 'error') { showInterrupt(ev.code ?? 'INTERNAL', ev.message); return }
  if (ev.type === 'end') {
    if (state.articleEnded) return
    state.articleEnded = true
    const finalize = () => {
      removeCaret(); clearStallIndicator(); setStatus('完成')
      stopRenderTick(); finishRun()
    }
    if (state.renderQueue.length === 0 && state.revealDone) finalize()
    else state.renderQueue.push({ type: '__end', finalize })
    return
  }
  // h2/h3/p: buffer during reveal, drain via tick once revealDone
  state.renderQueue.push(ev)
  if (state.revealDone) startRenderTick()
}

function renderEventNow(ev) {
  if (ev.type === '__end') { ev.finalize(); return }
  // textContent / createTextNode throughout — never innerHTML on LLM output (XSS prevention)
  const body = $('articleBody')
  removeCaret()
  let node
  if (ev.type === 'h2') {
    clearStallIndicator()
    node = document.createElement('h2'); node.textContent = ev.text
  } else if (ev.type === 'h3') {
    clearStallIndicator()
    node = document.createElement('h3'); node.textContent = ev.text
  } else if (ev.type === 'p') {
    clearStallIndicator()
    node = document.createElement('p')
    if (ev.speaker) {
      const sp = document.createElement('span'); sp.className = 'sp'
      sp.textContent = ev.speaker + '：'
      node.appendChild(sp)
    }
    node.appendChild(document.createTextNode(ev.text ?? ''))
    const caret = document.createElement('span'); caret.className = 'caret'; caret.id = 'liveCaret'
    node.appendChild(caret)
  } else {
    return
  }
  node.classList.add('fade-node')
  body.appendChild(node)
  registerRailHeading(node, ev)
}

function removeCaret() {
  const c = document.getElementById('liveCaret')
  if (c) c.remove()
}

function startRenderTick() {
  if (state.renderTickHandle) return
  state.renderTickHandle = setInterval(() => {
    if (state.renderQueue.length === 0) return
    renderEventNow(state.renderQueue.shift())
  }, 350)
}

function stopRenderTick() {
  if (state.renderTickHandle) { clearInterval(state.renderTickHandle); state.renderTickHandle = null }
}

// ---------- Stall indicator ----------
function clearStallIndicator() {
  const el = $('stallIndicator')
  el.hidden = true
  el.className = 'stall-indicator'
  el.textContent = ''
}

function updateStallIndicator(s) {
  const el = $('stallIndicator')
  if (s < 20) { el.hidden = true; return }
  el.hidden = false
  el.textContent = ''
  const pulse = document.createElement('span'); pulse.className = 'stall-pulse'
  if (s >= 90) {
    el.className = 'stall-indicator stall-warm stall-critical'
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px'
    const txt = document.createElement('span')
    txt.textContent = `⚠ Gemini 已静默 ${s}s，可能生成堵塞`
    row.append(pulse, txt)
    const actions = document.createElement('div'); actions.className = 'stall-actions'
    const keepBtn = document.createElement('button')
    keepBtn.className = 'btn btn-ghost'; keepBtn.textContent = '继续等待'
    keepBtn.addEventListener('click', clearStallIndicator)
    const abortBtn = document.createElement('button')
    abortBtn.className = 'btn btn-primary'; abortBtn.textContent = '中止并保留片段'
    abortBtn.addEventListener('click', () => {
      state.cancelled = true
      if (state.aborter) state.aborter.abort()
      clearStallIndicator()
      setStatus('⚠ 已中断', true)
      finishRun()
    })
    actions.append(keepBtn, abortBtn)
    el.append(row, actions)
  } else {
    el.className = 'stall-indicator' + (s >= 45 ? ' stall-warm' : '')
    const txt = document.createElement('span')
    txt.textContent = s >= 45
      ? `Gemini 仍在处理（视频较长，请再等等） · ${s}s`
      : `Gemini 正在思考 · ${s}s`
    el.append(pulse, txt)
  }
}

// ---------- Gemini wait tips ----------
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
let tipTimerHandle = null, elapsedTimerHandle = null
let tipIndexRef = 0, generateStartMs = 0, tipWarmLocked = false
const MAX_FALLBACK_LOGS = 5

function setTipText(text) {
  const el = $('geminiTip')
  el.style.opacity = '0'
  setTimeout(() => { el.textContent = text; el.style.opacity = '' }, 400)
}

function startGeminiWait() {
  tipWarmLocked = false; tipIndexRef = 0; generateStartMs = Date.now()
  const tip = $('geminiTip'), timer = $('geminiTimer')
  clearFallbackLog()
  tip.hidden = false; tip.className = 'gemini-tip'; tip.textContent = GEMINI_TIPS[0]
  timer.hidden = false; timer.textContent = '已等待 0s · 预估 1–3 分钟'
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
  $('geminiTip').hidden = true; $('geminiTimer').hidden = true
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

// ---------- Step controls (no-op: step list removed) ----------
function activateStep() {}
function doneStep() {}
function errorStep() {}

// ---------- Error copy ----------
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
function errorMsg(code) { return ERROR_COPY[code] ?? `错误（${code ?? '未知'}）` }

// ---------- Reset ----------
function resetRun() {
  // Cancel any in-flight reveal→article transition timer
  if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null }
  state.reqId = null
  renderRailReq()
  state.articleEnded = false
  state.revealDone = false
  state.renderQueue = []
  stopRenderTick()
  state.aborter = null
  $('hintErr').textContent = ''
  $('articleBody').innerHTML = ''
  $('prepView').querySelectorAll('.interrupt').forEach(n => n.remove())
  clearStallIndicator()
  stopGeminiWait()
  $('newRunBtn').hidden = true
  // Reset reveal/article classes so replay works cleanly
  $('revealView').classList.remove('play')
  $('articleView').classList.remove('show')
  $('statusPill').classList.remove('err')
  resetRailArticle()
  setRailCollapsed(false)
  setStatus('idle')
}

// ---------- Interrupt block builder ----------
function ensureInlineActions(container, buttons) {
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
  if (state.reqId) {
    const reqLine = document.createElement('div')
    reqLine.className = 'interrupt-req'
    reqLine.textContent = `req · ${state.reqId}`
    reqLine.title = '点击复制'
    reqLine.style.cursor = 'pointer'
    reqLine.addEventListener('click', () => copyReqId(reqLine))
    box.appendChild(reqLine)
  }
  container.appendChild(box)
  return box
}

// ---------- Prep-phase error ----------
function showInlineError(err) {
  stopGeminiWait()
  setStatus('⚠ 已中断', true)
  const msg = err.message ? `${errorMsg(err.code)} · ${err.message}` : errorMsg(err.code)
  const host = $('prepView').querySelector('.prep-col')
  if (!host) return
  const actionList = [
    { text: '换视频', onClick: backToHero },
    { text: '重试', primary: true, onClick: retry },
  ]
  ensureInlineActions(host, { msg, list: actionList })
}

// ---------- Stream-phase interrupt ----------
function showInterrupt(code, message) {
  if (state.cancelled) return
  state.articleEnded = true
  setStatus('⚠ 已中断', true)
  removeCaret()
  finishRun()
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
  return Math.min(85, 10 + paras * 3)
}

// ---------- Run completion ----------
function finishRun() {
  $('rail').classList.remove('dimmed')
  $('url').disabled = false
  $('go').disabled = false
  $('newRunBtn').hidden = false
}

$('newRunBtn').addEventListener('click', () => {
  $('url').value = ''
  backToHero()
})

// ---------- Error action handlers ----------
function backToHero() {
  // Set cancelled before abort() so any async catch in-flight sees it immediately
  state.cancelled = true
  if (state.aborter) state.aborter.abort()
  $('rail').classList.remove('in')
  setRailCollapsed(false)
  $('topbar').classList.remove('in')
  hideAllViews()
  $('hero').classList.remove('out')
  $('url').disabled = false; $('go').disabled = false
  resetRun()  // does NOT touch cancelled — flag stays true until next start()/retry()/regenerate()
}

function retry() {
  state.cancelled = false
  resetRun()
  $('rail').classList.add('dimmed')
  runInspect($('url').value).catch(showInlineError)
}

function regenerate() {
  state.cancelled = false
  resetRun()
  $('articleView').classList.add('out')
  showView('prepView')
  $('rail').classList.add('dimmed')
  runInspect($('url').value).catch(showInlineError)
}

function dismissInterrupt() {
  $('articleBody').querySelectorAll('.interrupt').forEach(n => n.remove())
  setStatus('已保留片段')
}

// ---------- Rail req display ----------
function renderRailReq() {
  const el = $('railReq')
  if (!state.reqId) { el.textContent = '—'; el.onclick = null; el.style.cursor = ''; return }
  el.textContent = `req · ${state.reqId}`
  el.title = '点击复制 reqId'
  el.style.cursor = 'pointer'
  el.onclick = () => copyReqId(el)
}

async function copyReqId(el) {
  if (!state.reqId) return
  const original = el.textContent
  try {
    await navigator.clipboard.writeText(state.reqId)
    el.textContent = '已复制 ✓'
    el.classList.add('copied')
    setTimeout(() => { el.textContent = original; el.classList.remove('copied') }, 1200)
  } catch {
    // Fallback for old browsers / non-HTTPS: select text so user can copy manually
    const range = document.createRange(); range.selectNodeContents(el)
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  }
}

// ---------- Utils ----------
function fmtDur(sec) {
  if (!sec) return ''
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
