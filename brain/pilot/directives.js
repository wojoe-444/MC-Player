// brain/pilot/directives: priority directives read from how Walter framed a request ("drop everything and finish the tower", "when you get a chance",
// "just this once", "forget the farm for an hour"). The quick voice fills a small enumerated record; this keeps it WITH his original wording so later
// decisions (the director, the prompt, Claude, the scheduler) can consult it. Persisted in brain/state/pilot-directives.jsonl (append-only log) and
// kept in memory while active. Expiry: minutes -> that long; until_done -> until a task named like the focus finishes (or 3 h); once -> until one such
// task finishes (or 45 min); until_told -> until cleared (max 12 h).
const fs = require('fs')
const path = require('path')

const HOUR = 3600000
const words = (s) => String(s || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3)

function createDirectives({ file, now = Date.now, onAdd, onEnd } = {}) {
  let list = []
  let seq = 0
  const log = (o) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(o) + '\n') } catch { /* logging only */ } }
  function expiryOf(d, at) {
    if (d.persist === 'minutes') return at + (d.minutes || 30) * 60000
    if (d.persist === 'once') return at + 45 * 60000
    if (d.persist === 'until_told') return at + 12 * HOUR
    return at + 3 * HOUR
  }
  function sweep() {
    const t = now()
    const gone = list.filter(d => d.expiresAt <= t)
    if (gone.length) { list = list.filter(d => d.expiresAt > t); for (const d of gone) { log({ t: new Date(t).toISOString(), event: 'expired', id: d.id }); onEnd && onEnd(d, 'expired') } }
  }
  // d: sanitized directive from talker.sanitizeDirective; wording: Walter's own words
  function add(d, wording) {
    sweep()
    const at = now()
    // a newer directive about the same focus replaces the older one
    for (const o of list.filter(x => words(x.focus).some(w => words(d.focus).includes(w)))) end(o.id, 'replaced')
    const e = { id: ++seq, at, ...d, wording: String(wording || '').slice(0, 300), expiresAt: expiryOf(d, at) }
    list.push(e)
    log({ t: new Date(at).toISOString(), event: 'added', ...e })
    onAdd && onAdd(e)
    return e
  }
  function end(id, why) {
    const i = list.findIndex(d => d.id === id); if (i < 0) return false
    const [d] = list.splice(i, 1)
    log({ t: new Date(now()).toISOString(), event: why || 'cleared', id })
    onEnd && onEnd(d, why || 'cleared')
    return true
  }
  // a task finished: directives about it (once / until_done) are satisfied
  function taskDone(name) {
    const tw = words(name)
    for (const d of [...list]) if ((d.persist === 'once' || d.persist === 'until_done') && ((d.task && d.task === name) || words(d.focus).some(w => tw.includes(w)))) end(d.id, 'done')
  }
  const active = () => { sweep(); return list.map(d => ({ ...d })) }
  // compact form for prompts: his wording stays attached
  function summary() {
    return active().map(d => ({ focus: d.focus, urgency: d.urgency, persist: d.persist, minutes_left: Math.max(0, Math.round((d.expiresAt - now()) / 60000)), then: d.then, avoid: d.avoid.length ? d.avoid : undefined, then_next: d.after && d.after.length ? d.after.map(a => a.focus) : undefined, walter_said: d.wording.slice(0, 140) }))
  }
  const clear = () => { for (const d of [...list]) end(d.id, 'cleared') }
  return { add, end, taskDone, active, summary, clear, hold: () => active().some(d => d.urgency !== 'background') }
}

module.exports = { createDirectives }
