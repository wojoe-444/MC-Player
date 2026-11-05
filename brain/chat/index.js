// brain/chat: fuzzy command matching for Walter's in-game chat (see README.md and brain/INTERFACE.md).
// Runs at the `fallback` step: only lines that no brain command and no legacy handleCommand rule understood get here.
const fs = require('fs')
const path = require('path')
const { create } = require('./matcher')

const NEAR_MISS_FILE = 'chat-nearmiss.jsonl'
const MAX_LOG_BYTES = 256 * 1024

// Append one JSON line; when the file grows past the cap keep only its newer half. Never throws.
function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file,JSON.stringify(obj) + '\n')
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n')
    }
  } catch { /* logging must never break chat */ }
}

module.exports = function register(api) {
  const { bot } = api
  const owner = api.ownerName || null

  // waypoints.json -> [{name,x,y,z}], re-read when the file changes (Xaero import and "save waypoint" both write it)
  const wpFile = path.join(api.dir || process.cwd(), 'waypoints.json')
  let wpCache = { mtime: 0, list: [] }
  function waypoints() {
    try {
      const m = fs.statSync(wpFile).mtimeMs
      if (m !== wpCache.mtime) {
        const raw = JSON.parse(fs.readFileSync(wpFile, 'utf8').replace(/^﻿/, ''))
        wpCache = { mtime: m, list: Object.entries(raw).map(([name, v]) => ({ name, x: v.x, y: v.y, z: v.z })) }
      }
    } catch { /* no file yet: no waypoints */ }
    return wpCache.list
  }
  let blockNames = null, itemNames = null
  const blocks = () => blockNames || (blockNames = bot.registry && bot.registry.blocksArray ? bot.registry.blocksArray.map(b => b.name) : [])
  const items = () => itemNames || (itemNames = bot.registry && bot.registry.itemsArray ? bot.registry.itemsArray.map(i => i.name) : [])

  const matcher = create({
    getWaypoints: waypoints,
    getBlockNames: blocks,
    getItemNames: items,
    getCommands: () => api.commands.list(),
    getPosition: () => (bot.entity ? bot.entity.position : null),
    now: () => api.now()
  })

  const recent = []   // ring buffer for status()
  const note = (e) => { recent.push({ at: api.now(), ...e }); if (recent.length > 12) recent.shift() }
  const nearMissPath = () => api.statePath(NEAR_MISS_FILE)
  const mine = (user) => !owner || user === owner

  let busy = false
  function run(user, d) {
    if (busy) return false
    busy = true
    try {
      const ok = api.commands.dispatch(user, d.canonical) === true
      note({ type: 'run', user, canonical: d.canonical, intent: d.result && d.result.intent, ok })
      api.log('chat', `${ok ? 'ran' : 'NOT handled'} "${d.canonical}"${d.confirmed ? ' (confirmed)' : ''}`)
      if (ok) matcher.remember(user, d.canonical, d.result && d.result.risk)
      return ok
    } catch (e) {
      api.log('chat', `dispatch error for "${d.canonical}": ${e.message}`)
      return false
    } finally { busy = false }
  }

  return {
    name: 'chat',
    status() { return { ...matcher.stats, pending: [...matcher.pending.keys()], recent: recent.slice(-5) } },

    // Step 2: only consumes answers to our own "Did you mean ...?" / "which one?" questions, and keeps "do that again" fed.
    onChat(user, text) {
      try {
        if (!mine(user)) return false
        if (matcher.hasPending(user)) {
          const d = matcher.resolvePending(user, text)
          if (d) {
            if (d.type === 'run') run(user, d)
            else if (d.type === 'say') api.say(d.text)
            return true
          }
        }
        const r = matcher.parse(user, text)
        if (r && r.level === 'high' && !r.info && r.intent !== 'again') matcher.remember(user, r.canonical, r.risk)
      } catch (e) { api.log('chat', `onChat error: ${e.message}`) }
      return false
    },

    // Step 5: fuzzy match. Replies only when it understood something (a confirmation question or a "which one"); never to noise.
    fallback(user, text) {
      try {
        if (!mine(user)) return false
        const d = matcher.decide(user, text)
        if (d.type === 'run') return run(user, d)
        if (d.type === 'ask' || d.type === 'say') {
          note({ type: d.type, user, text: d.question || d.text })
          api.say(d.question || d.text)
          return true
        }
        if (d.best && d.best.score >= 0.35) appendJsonl(nearMissPath(), { t: new Date(api.now()).toISOString(), user, text: String(text).slice(0, 200), guess: d.best.intent, score: d.best.score })
        return false
      } catch (e) {
        api.log('chat', `fallback error: ${e.message}`)
        return false
      }
    }
  }
}
module.exports.meta = { name: 'chat', version: 1 }
module.exports.appendJsonl = appendJsonl
module.exports.quickAck = (text) => create({}).quickAck(text)
