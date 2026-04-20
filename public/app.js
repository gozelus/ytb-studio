/**
 * [WHAT]  Front-end state machine for ytb-studio.
 * [WHY]   Single JS file — no build step, served as a static asset.
 *         Handles the full user flow: hero → inspect → pick → generate (SSE) → article.
 * [INVARIANT] The first SSE event from /api/generate is always "meta"; only after
 *             receiving it does the reveal animation play and the article view appear.
 *             state.cancelled is set to true before abort() and cleared only at the
 *             entry of a new run (start/retry/regenerate), never inside resetRun().
 */

// ---------- State ----------
const state = {
  mode: 'rewrite',
  reqId: null,
  isFallback: false,   // true when inspect couldn't reach YouTube metadata
  aborter: null,
  revealTimer: null,   // setTimeout handle for the reveal→article transition
  articleEnded: false,
  cancelled: false,
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
  activateStep(1)
  const res = await fetch('/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const data = await res.json()
  state.reqId = data.reqId ?? null
  state.isFallback = data.fallback ?? false
  renderRailReq()
  if (!res.ok) throw { code: data.error ?? 'INTERNAL', step: parseInt($$('.step-row.active')?.dataset?.step ?? '1', 10) }

  $('m1').textContent = data.channel ? `${fmtDur(data.durationSec)} · ${data.channel}` : '—'
  doneStep(1); activateStep(2)
  setStatus('解析字幕')
  $('m2').textContent = `发现 ${data.tracks.length} 条`
  doneStep(2)

  showPicker(data)
}

// ---------- Picker ----------
function showPicker(data) {
  showView('pickView')
  setStatus('等待选择字幕')
  if (data.fallback || !data.title) {
    $('pickTitle').textContent = '视频信息暂不可用'
    $('pickMeta').textContent = '无法从 CF 边缘连接 YouTube 元数据；可继续 AI 直读，标题将在生成时确定'
  } else {
    $('pickTitle').textContent = data.title
    $('pickMeta').textContent = `${fmtDur(data.durationSec)} · 共 ${data.tracks.length} 条字幕`
  }
  const list = $('capList'); list.innerHTML = ''
  const sorted = [...data.tracks].sort((a, b) => (a.kind === 'manual' ? -1 : 1))
  sorted.forEach((t, i) => {
    const el = document.createElement('div')
    el.className = 'cap' + (i === 0 ? ' primary' : '')
    const k = document.createElement('span'); k.className = 'k'
    const l = document.createElement('span'); l.className = 'l'
    const r = document.createElement('span'); r.className = 'r'
    if (t.id === 'gemini.direct') {
      // fallback card: "AI" badge, no caption-language jargon (AUTO/自动 don't apply)
      k.textContent = 'AI'
      l.textContent = t.label
      r.textContent = '由 AI 直接解析'
    } else {
      k.textContent = t.lang.toUpperCase()
      l.textContent = `${t.label} · ${t.kind === 'manual' ? '手动' : '自动'}`
      r.textContent = t.tokens ? `${t.tokens.toLocaleString()} tok` : '—'
    }
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

// ---------- Generate ----------
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

// ---------- SSE consumer ----------
async function consumeSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let gotMeta = false

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
    if (!gotMeta) throw err
    showInterrupt('GEMINI_STREAM_DROP')
    return
  }

  if (state.cancelled) return
  if (!gotMeta) throw { code: 'GEMINI_STREAM_DROP' }
  if (!state.articleEnded) showInterrupt('GEMINI_STREAM_DROP')
}

// ---------- Article ----------
function enterArticle(metaEv) {
  const title = metaEv.title || '(未命名)'
  const metaParts = [metaEv.subtitle, fmtDur(metaEv.durationSec)].filter(Boolean)
  $('revealH1').textContent = title
  $('revealSub').textContent = metaEv.subtitle ?? ''
  $('articleH1').textContent = title
  $('articleMeta').textContent = metaParts.join(' · ')
  $('articleDisclaimer').textContent = state.isFallback
    ? '本次生成走 AI 直读（YouTube 元信息抓取失败），标题由 AI 在生成时给出'
    : ''
  document.title = title
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
  }, 3200)
}

function renderEvent(ev) {
  // textContent / createTextNode throughout — never innerHTML on LLM output (XSS prevention)
  const body = $('articleBody')
  removeCaret()
  let node
  if (ev.type === 'h2') {
    node = document.createElement('h2'); node.textContent = ev.text
  } else if (ev.type === 'h3') {
    node = document.createElement('h3'); node.textContent = ev.text
  } else if (ev.type === 'p') {
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
    removeCaret()
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

// ---------- Error copy ----------
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

// ---------- Reset ----------
function resetRun() {
  // Cancel any in-flight reveal→article transition timer
  if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null }
  state.reqId = null
  state.isFallback = false
  renderRailReq()
  state.articleEnded = false
  state.aborter = null
  $('hintErr').textContent = ''
  $('articleBody').innerHTML = ''
  $('m1').textContent = ''; $('m2').textContent = ''
  $('m3').textContent = ''; $('m4').textContent = ''
  byAll('.step-row').forEach(r => { r.classList.remove('active', 'done', 'err'); r.classList.add('pending') })
  // Reset reveal/article classes so replay works cleanly
  $('revealView').classList.remove('play')
  $('articleView').classList.remove('show')
  $('articleDisclaimer').textContent = ''
  $('statusPill').classList.remove('err')
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
  setStatus('⚠ 已中断', true)
  const msg = errorMsg(err.code)
  const stepN = err.step ?? parseInt($$('.step-row.active')?.dataset?.step ?? '1', 10)
  errorStep(stepN, msg)
  const anchor = $('prepView').classList.contains('out') ? $('pickView') : $('prepView')
  const host = anchor.querySelector('.prep-col') || anchor.querySelector('.picker')
  if (!host) return
  ensureInlineActions(host, {
    msg,
    list: [
      { text: '换视频', onClick: backToHero },
      { text: '重试', primary: true, onClick: retry },
    ],
  })
}

// ---------- Stream-phase interrupt ----------
function showInterrupt(code, message) {
  if (state.cancelled) return
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
  return Math.min(85, 10 + paras * 3)
}

// ---------- Error action handlers ----------
function backToHero() {
  // Set cancelled before abort() so any async catch in-flight sees it immediately
  state.cancelled = true
  if (state.aborter) state.aborter.abort()
  $('rail').classList.remove('in', 'collapsed')
  $('railToggle').textContent = '‹'
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
  activateStep(1)
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
