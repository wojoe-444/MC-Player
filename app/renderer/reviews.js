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

// ---- behavior reviewer: findings per bot + Task Scheduler controls ----
function renderReviewer(r) {
  const box = document.getElementById('reviewer')
  if (!r.available) { box.replaceChildren(el('div', { className: 'err', textContent: 'The reviewer folder was not found next to the app.' })); return }
  const t = r.task || {}
  const minutes = el('input', { type: 'number', min: 1, max: 120, value: 10 })
  const install = el('button', { textContent: t.installed ? 'Reinstall task' : 'Install Task Scheduler job' })
  install.onclick = async () => { install.disabled = true; const x = await window.botApp.reviewerInstall(Number(minutes.value)); if (!x.ok) alert('Could not install: ' + x.error); else renderReviewer(x.state) }
  const remove = el('button', { textContent: 'Remove task', disabled: !t.installed })
  remove.onclick = async () => { const x = await window.botApp.reviewerUninstall(); if (x.state) renderReviewer(x.state) }
  const run = el('button', { textContent: 'Review now' })
  run.onclick = () => { run.disabled = true; run.textContent = 'Reviewing…'; window.botApp.reviewerRun() }
  const head = el('div', { className: 'card' },
    el('div', { className: 'row' }, el('b', { textContent: 'Haiku 5.5 (xhigh) spectator review' }), el('span', { className: 'grow' }), el('label', {}, 'every ', minutes, ' min'), install, remove, run),
    el('div', { className: 'muted', textContent: t.installed
      ? `Task "${r.taskName}": ${t.status || 'installed'}, next run ${t.nextRun || '?'}, last run ${t.lastRun || 'never'} (result ${t.lastResult ?? '?'}). Runs only while you are logged in, window hidden.`
      : t.unsupported ? 'Task Scheduler is Windows-only; "Review now" still works.' : `No scheduled task yet. Install creates one Windows Task Scheduler job named "${r.taskName}" for your user account (no admin, no password) that runs node reviewer/run.js every N minutes. Remove it here any time.` }))
  const cards = r.bots.map(b => {
    const f = b.findings, tel = b.telemetry
    const kids = [el('div', { className: 'row' }, el('b', { textContent: b.name }), el('span', { className: 'muted', textContent: f ? `${f.status} · reviewed ${when(f.updatedAt)}` : 'not reviewed yet' }))]
    if (tel && tel.last1min) kids.push(el('div', { className: 'muted', textContent: `telemetry: ${tel.last1min.jumpsPerMin} jumps/min, ${tel.last1min.blocksWalked} blocks walked, ${tel.last1min.idleSeconds}s idle in the last minute; ${tel.flags.length} detector flag(s) active` }))
    if (f && f.summary) kids.push(el('div', { className: 'muted', textContent: f.summary }))
    for (const x of (f && f.open) || []) kids.push(el('div', {}, el('span', { className: 'sev ' + x.severity, textContent: x.severity }), el('b', { textContent: x.title }),
      el('pre', { className: 'muted', textContent: `${x.evidence}\n→ ${x.suggestion}\n(${x.kind}, seen ${x.seenRuns}x since ${when(x.firstSeen)})` })))
    if (f && !f.open.length && f.status !== 'offline') kids.push(el('div', { className: 'muted', textContent: 'No open findings.' }))
    return el('div', { className: 'card' }, ...kids)
  })
  box.replaceChildren(head, ...cards)
}
window.botApp.onReviewer(renderReviewer)
window.botApp.reviewerState().then(renderReviewer)
setInterval(() => window.botApp.reviewerState().then(renderReviewer), 60000)
