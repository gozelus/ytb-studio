// ---------- State ----------
const state = {
  mode: 'rewrite',
  reqId: null,
  aborter: null,
  revealTimer: null,   // setTimeout handle for the reveal→article transition
  tracks: null,
  meta: null,
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
    if (host === 'youtu.be') return u.pathname.length >= 12
    if (host === 'youtube.com') {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return true
      return /^\/(embed|shorts)\/[a-zA-Z0-9_-]{11}/.test(u.pathname)
    }
    return false
  } catch { return false }
}

// ---------- Submit ----------
$('go').addEventListener('click', () => start())
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })

async function start() {
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

// ---------- Picker ----------
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
        if (!payload || payload.startsWith(':')) continue
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
    showInterrupt('GEMINI_STREAM_DROP', String(err))
    return
  }

  if (state.cancelled) return
  if (!gotMeta) throw { code: 'GEMINI_STREAM_DROP' }
  if (!state.articleEnded) showInterrupt('GEMINI_STREAM_DROP')
}

// ---------- Article ----------
function enterArticle(metaEv) {
  $('revealH1').textContent = metaEv.title
  $('revealSub').textContent = metaEv.subtitle
  $('articleH1').textContent = metaEv.title
  $('articleMeta').textContent = metaEv.subtitle + ' · ' + fmtDur(metaEv.durationSec)
  document.title = metaEv.title
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
  state.reqId = null; state.tracks = null; state.meta = null
  state.articleEnded = false; state.cancelled = false
  state.aborter = null
  $('hintErr').textContent = ''
  $('articleBody').innerHTML = ''
  $('m1').textContent = ''; $('m2').textContent = ''
  $('m3').textContent = ''; $('m4').textContent = ''
  byAll('.step-row').forEach(r => { r.classList.remove('active', 'done', 'err'); r.classList.add('pending') })
  // Reset reveal animation class so it can replay on next run
  $('revealView').classList.remove('play')
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
  container.appendChild(box)
  return box
}

// ---------- Prep-phase error ----------
function showInlineError(err) {
  setStatus('⚠ 已中断', true)
  const stepN = err.step ?? parseInt($$('.step-row.active')?.dataset?.step ?? '1', 10)
  errorStep(stepN, errorMsg(err.code))
  const anchor = $('prepView').classList.contains('out') ? $('pickView') : $('prepView')
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
  if (state.aborter) state.aborter.abort()
  $('rail').classList.remove('in')
  $('topbar').classList.remove('in')
  hideAllViews()
  $('hero').classList.remove('out')
  $('url').disabled = false; $('go').disabled = false
  resetRun()
  // Set cancelled AFTER resetRun so late-arriving AbortError in consumeSse is still silenced
  state.cancelled = true
}

function retry() {
  resetRun()
  $('rail').classList.add('dimmed')
  runInspect($('url').value).catch(showInlineError)
}

function regenerate() {
  resetRun()
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

// ---------- Utils ----------
function fmtDur(sec) {
  if (!sec) return ''
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
