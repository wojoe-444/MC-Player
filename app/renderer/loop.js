// The Memory loop tab: the loop's scheduled jobs (install, remove, run now), the ranked work orders, each bot's memory file with what the last
// check changed, and one line per run. Everything shown is read from this computer by the main process (app/lib/loop.js).
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of kids) if (k !== null && k !== undefined && k !== '') n.append(k)
  return n
}
const when = (iso) => iso ? new Date(iso).toLocaleString() : 'never'
const mins = (n) => `${Math.round((n || 0) * 10) / 10} min`
const money = (n) => (typeof n === 'number' && n > 0 ? `$${n.toFixed(3)}` : '')

function jobCard(j) {
  const t = j.task || {}
  const every = el('input', { type: 'number', min: 10, max: j.maxMinutes, value: j.minutes })
  const install = el('button', { textContent: t.installed ? 'Reinstall task' : 'Install Task Scheduler job' })
  install.onclick = async () => { install.disabled = true; const x = await window.botApp.loopInstall(j.id, Number(every.value)); if (!x.ok) alert('Could not install: ' + x.error); if (x.state) render(x.state) }
  const remove = el('button', { textContent: 'Remove task', disabled: !t.installed })
  remove.onclick = async () => { const x = await window.botApp.loopUninstall(j.id); if (x.state) render(x.state) }
  const run = el('button', { textContent: j.running ? 'Running…' : 'Run now', disabled: j.running })
  run.onclick = () => { run.disabled = true; run.textContent = 'Running…'; window.botApp.loopRun(j.id) }
  return el('div', { className: 'card' },
    el('div', { className: 'row' }, el('b', { textContent: j.title }), el('span', { className: 'grow' }), el('label', {}, 'every ', every, ' min'), install, remove, run),
    el('div', { className: 'muted', textContent: t.installed
      ? `Task "${j.taskName}": ${t.status || 'installed'}, next run ${t.nextRun || '?'}, last run ${t.lastRun || 'never'} (result ${t.lastResult ?? '?'}). Runs only while you are logged in, window hidden.`
      : t.unsupported ? 'Task Scheduler is Windows-only; "Run now" still works.'
        : `Not installed. Install creates one Windows Task Scheduler job named "${j.taskName}" for your user account (no admin, no password). It runs Haiku 5.5 at xhigh on your Claude login, a few short calls per bot, and skips a bot whose journal has nothing new. "Run now" takes about five minutes per bot.` }))
}

function orderCard(o) {
  const open = o.status === 'open' || o.status === 'parked'
  const kids = [el('div', {}, el('span', { className: 'pill ' + (open ? 'cost' : 'closed'), textContent: open ? mins(o.costMin) : o.status }), el('b', { textContent: o.title }))]
  kids.push(el('div', { className: 'muted', textContent: `${o.key} · ${o.kind} · ${o.status} · opened ${when(o.openedAt)} · seen in ${o.seenDreams} check(s)${o.reopens ? ` · reopened ${o.reopens}x` : ''}${o.pr ? ` · PR #${o.pr}` : ''}${o.closed ? ` · ${o.closed.reason}` : ''}` }))
  if (o.problem) kids.push(el('pre', { textContent: o.problem }))
  const lines = Object.entries(o.bots || {}).map(([b, n]) => `${b}: ${n.line} (${mins(n.costMin)} lost)` + (n.evidence || []).map(e => `\n    ${e}`).join(''))
  if (o.suggestion) lines.push(`Where to look: ${o.suggestion}`)
  if ((o.findings || []).length) lines.push(`Reviewer findings: ${o.findings.join(', ')}`)
  kids.push(el('details', {}, el('summary', { textContent: 'Numbers and evidence' }), el('pre', { className: 'muted', textContent: lines.join('\n') })))
  return el('div', { className: 'card' }, ...kids)
}

function botCard(b) {
  const kids = [el('div', { className: 'row' }, el('b', { textContent: b.name }), el('span', { className: 'muted', textContent: b.brief ? `last plan ${when(b.brief.at)}, in-game day ${b.brief.day}` : 'no dawn brief yet' }))]
  if (b.brief) {
    kids.push(el('div', { textContent: b.brief.intent || '' }))
    const holds = (b.brief.holds || []).map(h => `${h.step} (until day ${h.untilDay}: ${h.why})`)
    kids.push(el('div', { className: 'muted', textContent: `focus: ${(b.brief.focus || []).join(', ') || 'none'} · holds: ${holds.join('; ') || 'none'} · free time: ${b.brief.freeTime ? `${b.brief.freeTime.choice}${b.brief.freeTime.note ? ` (${b.brief.freeTime.note})` : ''}` : 'none'}` }))
    if (b.brief.ask) kids.push(el('div', {}, el('b', { textContent: `${b.name} asks: ` }), b.brief.ask))
  }
  if (b.memory) kids.push(el('details', { open: true }, el('summary', { textContent: 'global.md, the file it reads every dawn' }), el('pre', { className: 'file', textContent: b.memory })))
  else kids.push(el('div', { className: 'muted', textContent: 'No memory folder. It appears once this bot runs code with the dawn brief on (on for the hillclimber, off for the assistant).' }))
  const c = b.lastCheck
  if (c) {
    const steps = (c.calls || []).map(x => `${x.step} ${x.ok ? 'ok' : 'failed'}`).concat(Object.keys(c.skippedSteps || {}).map(s => `${s} skipped`))
    kids.push(el('div', { className: 'muted', textContent: `Last memory check ${when(c.at)}: ${steps.join(', ')}${money(c.costUsd) ? `, ${money(c.costUsd)}` : ''}. ${c.changes.length ? `${c.changes.length} line(s) changed:` : 'Nothing changed.'}` }))
    for (const ch of c.changes) kids.push(el('pre', { className: 'muted', textContent: `${ch.step}, ${ch.op}${ch.from ? `: ${ch.from}` : ''}${ch.to ? `\n  now: ${ch.to}` : ''}\n  why: ${ch.why || ''}${(ch.cites || []).map(x => `\n  from: ${x}`).join('')}` }))
    if ((c.dropped || []).length) kids.push(el('details', {}, el('summary', { textContent: `${c.dropped.length} answer(s) failed a check and were not applied` }), el('pre', { className: 'muted', textContent: c.dropped.join('\n') })))
  }
  return el('div', { className: 'card' }, ...kids)
}

function render(s) {
  const sub = document.getElementById('sub')
  if (!s.available) { sub.textContent = 'The reviewer folder was not found next to the app, so the loop cannot be shown.'; return }
  sub.textContent = `The bots keep a journal, plan each dawn from a small memory file, and a check compares that memory with the journal every two hours. What memory cannot fix becomes a work order, ranked by lost minutes. Everything on this page stays on this computer (${s.loopDir}).`
  const rt = s.reviewTask || {}, rtask = rt.task || {}
  document.getElementById('jobs').replaceChildren(
    el('div', { className: 'card' }, el('div', {}, el('b', { textContent: rt.title || 'Review and dawn briefs' })),
      el('div', { className: 'muted', textContent: (rtask.installed ? `Task "${rt.taskName}": ${rtask.status || 'installed'}, last run ${rtask.lastRun || 'never'}.` : rtask.unsupported ? 'Task Scheduler is Windows-only.' : 'Not installed.') + ' The dawn brief is answered by this job. Install and remove it on the Claude reviews tab.' })),
    ...s.jobs.map(jobCard))
  const open = s.orders.filter(o => o.status === 'open' || o.status === 'parked'), done = s.orders.filter(o => !(o.status === 'open' || o.status === 'parked')).slice(0, 8)
  document.getElementById('orders').replaceChildren(...(open.length || done.length ? [...open, ...done].map(orderCard)
    : [el('div', { className: 'muted', textContent: 'No work orders yet. The dream job opens one when the journal shows the same fault again and again.' })]))
  document.getElementById('bots').replaceChildren(...s.bots.map(botCard))
  const rows = s.runs.map(r => el('tr', {}, el('td', { textContent: when(r.at) }), el('td', { textContent: r.job }), el('td', { className: r.ok === false ? 'err' : '', textContent: r.ok === false ? 'failed' : 'ok' }),
    el('td', { textContent: r.summary || '' }), el('td', { className: 'muted', textContent: [r.durationMs ? `${Math.round(r.durationMs / 1000)} s` : '', money(r.costUsd)].filter(Boolean).join(' · ') })))
  document.getElementById('runs').replaceChildren(rows.length
    ? el('div', { className: 'card' }, el('table', {}, el('tr', {}, ...['When', 'Job', 'Result', 'What it did', 'Time and cost'].map(h => el('th', { textContent: h }))), ...rows))
    : el('div', { className: 'muted', textContent: 'No runs recorded yet.' }))
}

window.botApp.onLoop(render)
window.botApp.loopState().then(render)
setInterval(() => window.botApp.loopState().then(render), 60000)
