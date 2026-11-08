const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of kids) n.append(k)
  return n
}
const when = (iso) => iso ? new Date(iso).toLocaleString() : 'never'

function render(s) {
  document.getElementById('sub').textContent =
    `Headless runs: claude -p --model ${s.claude.model} (your Claude subscription). Dashboard ${s.dashboard.attached ? 'attached to' : 'started at'} ${s.dashboard.url}.`
  const tr = document.getElementById('triggers')
  tr.replaceChildren(...s.triggers.map(t => {
    const en = el('input', { type: 'checkbox', checked: t.enabled })
    en.onchange = () => window.botApp.setTrigger(t.id, { enabled: en.checked })
    const iv = el('input', { type: 'number', min: 1, max: 1440, value: t.intervalMin })
    iv.onchange = () => window.botApp.setTrigger(t.id, { intervalMin: Number(iv.value) })
    const run = el('button', { textContent: t.running ? 'Running…' : 'Run now', disabled: t.running })
    run.onclick = () => window.botApp.runTrigger(t.id)
    const res = t.lastResult
    return el('div', { className: 'card' },
      el('div', { className: 'row' }, el('label', {}, en, ' ', el('b', { textContent: t.title })), el('span', { className: 'grow' }),
        el('label', {}, 'every ', iv, ' min'), run),
      el('div', { className: 'muted', textContent: `last run: ${when(t.lastRun)}  ·  next: ${t.running ? 'running' : when(t.nextRun)}` }),
      res ? el('div', { className: res.ok ? 'muted' : 'err', textContent: (res.ok ? '' : 'Failed: ') + res.summary }) : '')
  }))
  const rv = document.getElementById('reviews')
  rv.replaceChildren(...(s.reviews.length ? s.reviews.map(r =>
    el('div', { className: 'card' }, el('div', { className: 'muted', textContent: when(r.at.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d+Z)$/, '$1:$2:$3.$4')) }), el('pre', { textContent: r.text })))
    : [el('div', { className: 'muted', textContent: 'No reviews yet. The first one runs shortly after startup.' })]))
}

window.botApp.onState(render)
window.botApp.state().then(render)
