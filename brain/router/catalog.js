// What the decision model may choose from: a closed list built from the registered commands (api.commands.list()), the chat
// module's intent table (legacy handleCommand strings) and the saved waypoints. The model never writes a command; it picks a
// label, and the label maps back to a canonical string that is already known to the bot.
let INTENTS = []
try { INTENTS = require('../chat/intents').INTENTS } catch { /* chat module missing: only registered commands are offered */ }

const NONE = 'none'
const GOTO = 'goto-waypoint'
const NONE_DESC = 'Not an order for the bot: conversation, a statement, feedback, planning talk, a question for the AI assistant, a request for something not listed, or unclear.'
const MAX_WAYPOINTS = 60
// commands that must never be offered to the model (the router's own switches; "again" needs chat memory)
const HIDDEN = (name, canon) => /^router-/.test(name || '') || canon === '@again' || /[<\[]/.test(canon) || /^router\b/.test(canon)

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const legacyName = (n) => /^[a-z0-9][a-z0-9 -]*$/.test(n) && !/^the /.test(n)

// -> { options: [{label, canonical, risk, instant, info, desc}], byLabel: Map, waypoints: [{name, canonical}] }
function build({ commands = [], waypoints = [] } = {}) {
  const byLabel = new Map()
  const have = new Set()
  for (const c of commands) for (const k of (c.canonical || [])) have.add(String(k).toLowerCase())
  const add = (o) => { if (!byLabel.has(o.label.toLowerCase())) byLabel.set(o.label.toLowerCase(), o) }

  for (const it of INTENTS) {
    if (HIDDEN('', it.canonical)) continue
    if (it.brain && !have.has(it.canonical.toLowerCase())) continue   // brain-native intents only when registered
    const phrases = it.phrases.filter(p => !p.startsWith('*')).slice(0, 4)
    add({ label: it.canonical, canonical: it.canonical, risk: it.risk === 'high' ? 'high' : 'low', instant: !!it.instant, info: !!it.info, desc: clean(`${it.id}: ${phrases.join('; ')}`) })
  }
  for (const c of commands) {
    const canon = (c.canonical && c.canonical[0]) || ''
    if (!canon || HIDDEN(c.name, canon)) continue
    if (byLabel.has(canon.toLowerCase())) {   // registered commands win on risk: the integrator knows better than the intent table
      const o = byLabel.get(canon.toLowerCase()); if (c.risk === 'high') o.risk = 'high'
      continue
    }
    add({ label: canon, canonical: canon, risk: c.risk === 'high' ? 'high' : 'low', instant: false, info: false, desc: clean(`${c.name}: ${(c.canonical || []).join('; ')}`) })
  }

  const wps = []
  for (const w of waypoints) {
    if (!w || !w.name) continue
    const lower = String(w.name).toLowerCase()
    let canonical = `go to ${lower}`
    if (!legacyName(lower) && w.x != null && w.z != null) canonical = w.y != null ? `go to ${Math.round(w.x)} ${Math.round(w.y)} ${Math.round(w.z)}` : `go to ${Math.round(w.x)} ${Math.round(w.z)}`
    wps.push({ name: String(w.name), canonical, x: w.x, z: w.z })
  }
  if (wps.length) add({ label: GOTO, canonical: null, risk: 'low', instant: false, info: false, desc: 'go to a saved place by name ("go to the farm", "head to the house"); the place is chosen separately' })
  return { options: [...byLabel.values()], byLabel, waypoints: wps.slice(0, MAX_WAYPOINTS) }
}

module.exports = { build, NONE, GOTO, NONE_DESC, MAX_WAYPOINTS }
