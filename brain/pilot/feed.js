// brain/pilot/feed: the line-per-event file the driver (Claude) watches instead of chat.log.
// One line per chat line the bot did NOT handle on its own, written when we know what the fast tiers did (or after capMs):
//   2026-10-26T01:51:47.267Z OGWO: <text> || QUICK "<what the fast voice already said>" | OWES real answer (topic: ...)
//   ... || QUICK "<...>" | COMPLETE (nothing more owed unless you have something to add)
//   ... || RAN "furnace status"           (router ran a command; its own reply is in game)
//   ... || ASKED "Did you mean ...?"      (router is waiting for yes/no)
//   ... || ACK ONLY "Got it, one moment." | OWES real answer
//   ... || NOTHING SAID YET (handed on silently) | OWES real answer   (router acks are off: you speak first)
//   ... || NO FAST TIER (pending) | OWES real answer
// A later change for the same line is appended as "   ^ update ... ||" (rare). Pilot notes ("[pilot] ...") are separate lines.
const fs = require('fs')
const path = require('path')

const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n)
const MAX_BYTES = 512 * 1024

function createFeed({ file, now = Date.now, capMs = 2200, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const open = new Map()                       // id -> { user, text, t, timer, written }
  let seq = 0
  function append(line) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line + '\n')
      if (fs.statSync(file).size > MAX_BYTES) { const l = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(file, l.slice(Math.floor(l.length / 2)).join('\n') + '\n') }
    } catch { /* the feed must never break chat */ }
  }
  const stamp = () => new Date(now()).toISOString()
  function write(e, outcome, update) {
    append(`${update ? '   ^ update ' : stamp() + ' ' + e.user + ': ' + one(e.text, 300) + ' '}|| ${outcome}`)
  }
  // a line reached the fast tiers; outcome follows via settle(). Returns an id.
  function begin(user, text) {
    const id = ++seq
    const e = { user, text, t: now(), written: false, timer: null }
    e.timer = setTimer(() => { if (!e.written) { e.written = true; write(e, 'NO FAST TIER YET (pending) | OWES real answer') } }, capMs)
    if (e.timer && e.timer.unref) e.timer.unref()
    open.set(id, e)
    if (open.size > 30) open.delete(open.keys().next().value)
    return id
  }
  // outcome: { kind:'quick'|'ran'|'asked'|'ack'|'none', text?, owes?:boolean, topic? }
  function settle(id, o) {
    const e = open.get(id); if (!e) return false
    let s
    if (o.kind === 'quick') s = `QUICK "${one(o.text, 220)}" | ${o.owes ? 'OWES real answer' : 'COMPLETE (nothing more owed unless you have something to add)'}${o.topic ? ` (topic: ${one(o.topic, 60)})` : ''}`
    else if (o.kind === 'ran') s = `RAN "${one(o.text, 120)}" (its own reply is in game)`
    else if (o.kind === 'asked') s = `ASKED "${one(o.text, 160)}" (waiting for yes/no)`
    else if (o.kind === 'silent') s = 'NOTHING SAID YET (handed on silently) | OWES real answer'
    else if (o.kind === 'ack') s = `ACK ONLY "${one(o.text, 120)}" | OWES real answer`
    else s = 'NO FAST TIER | OWES real answer'
    if (e.written) write(e, s, true)
    else { e.written = true; write(e, s, false) }
    if (e.timer) { clearTimer(e.timer); e.timer = null }
    open.delete(id)
    return true
  }
  const note = (text) => append(`${stamp()} [pilot] ${one(text, 300)}`)
  function stop() { for (const e of open.values()) if (e.timer) clearTimer(e.timer); open.clear() }
  return { begin, settle, note, stop, openCount: () => open.size }
}

module.exports = { createFeed }
