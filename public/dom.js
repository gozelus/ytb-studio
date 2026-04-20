const VIEWS = ['prepView', 'revealView', 'articleView']

export const $ = (id) => document.getElementById(id)
export const byAll = (sel) => document.querySelectorAll(sel)

export function showView(which) {
  for (const v of VIEWS) $(v).classList.toggle('out', v !== which)
}

export function hideAllViews() {
  for (const v of VIEWS) $(v).classList.add('out')
}

export function setStatus(text, err = false) {
  const pill = $('statusPill')
  pill.textContent = text
  pill.classList.toggle('err', !!err)
}
