// brain/difficulty: watch the world's difficulty (Walter 2026-11-11: the Chicago mob farm passed every inspection and made nothing, because the Earth24k world was
// on Peaceful, where no hostile mob spawns; "we may need to make sure the difficulty is always set to hard ... it may revert to Peaceful every time I reopen it").
// The bot cannot change the difficulty (no slash commands). It can read it: the server sends it at login and again whenever it changes
// (bot.game.difficulty: 'peaceful' | 'easy' | 'normal' | 'hard'). This module only observes and tells.
//
//   brain/state/difficulty.json   { difficulty, peaceful, at, since, history: [{ at, from, to }] }  (the last 10 changes, "login" for the first reading of a session)
//   bot._difficulty = { value, peaceful, since }
//   log lines   "DIFFICULTY HARD at login" / "DIFFICULTY changed hard -> peaceful" / (every 15 min while Peaceful) "DIFFICULTY PEACEFUL: no hostile mob can spawn ..."
//   journal     bot._journal.add('difficulty', { sal: 1, ... }) on login and on every change, so the day's record has it
//
// brain/outcome already reads the same field: a mob-farm outcome check does not count a Peaceful world as a failure of the farm (verdict "blocked", who: human).
'use strict'
const fs = require('fs')

module.exports = function register(api) {
  const bot = api.bot
  const log = (m) => { try { api.log('difficulty', m) } catch { /* ignore */ } }
  const file = api.statePath('difficulty.json')
  const KNOWN = ['peaceful', 'easy', 'normal', 'hard']
  const REMIND_MS = 15 * 60000
  let last = null, since = Date.now(), lastRemind = 0, timers = [], hist = []
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); hist = Array.isArray(j.history) ? j.history.slice(-10) : [] } catch { /* first run */ }

  // mineflayer's bot.game.difficulty (set on the 'difficulty' packet) was undefined on the live 1.21.6 bots, so join.js also keeps the raw packet in bot._rawDifficulty
  const read = () => {
    const d = bot.game && bot.game.difficulty
    if (typeof d === 'string' && KNOWN.includes(d)) return d
    if (typeof d === 'number' && KNOWN[d]) return KNOWN[d]
    const raw = bot._rawDifficulty && bot._rawDifficulty.value
    if (typeof raw === 'number' && KNOWN[raw]) return KNOWN[raw]
    if (typeof raw === 'string' && KNOWN.includes(raw)) return raw
    return null
  }
  const save = (d) => {
    try { fs.writeFileSync(file, JSON.stringify({ difficulty: d, peaceful: d === 'peaceful', at: new Date().toISOString(), since: new Date(since).toISOString(), history: hist.slice(-10) }, null, 1)) } catch (e) { log('could not write difficulty.json: ' + e.message) }
  }
  const journal = (fields) => { try { if (bot._journal && bot._journal.add) bot._journal.add('difficulty', { sal: 1, ...fields }) } catch { /* ignore */ } }

  function check(why) {
    const d = read()
    if (!d) return
    bot._difficulty = { value: d, peaceful: d === 'peaceful', since }
    if (d !== last) {
      const from = last
      last = d; since = Date.now()
      hist.push({ at: new Date().toISOString(), from: from || (why === 'login' ? 'login' : null), to: d }); hist = hist.slice(-10)
      bot._difficulty.since = since
      if (!from) log(`DIFFICULTY ${d.toUpperCase()} at login`)
      else log(`DIFFICULTY changed ${from} -> ${d}`)
      if (d === 'peaceful') { log('DIFFICULTY PEACEFUL: no hostile mob can spawn anywhere, so a mob farm cannot produce; only the player can change it (the bots have no slash commands)'); lastRemind = Date.now() }
      journal({ difficulty: d, from: from || null, why })
      save(d)
    } else if (d === 'peaceful' && Date.now() - lastRemind > REMIND_MS) {
      lastRemind = Date.now()
      log(`DIFFICULTY PEACEFUL: still Peaceful after ${Math.round((Date.now() - since) / 60000)} min; no hostile mob can spawn, the mob farm cannot produce`)
      save(d)
    }
  }

  return {
    name: 'difficulty',
    start() {
      const onSpawn = () => { last = null; setTimeout(() => check('login'), 1500) }
      bot.on('spawn', onSpawn)
      try { bot._client.on('difficulty', () => setTimeout(() => check('packet'), 50)) } catch { /* no raw client */ }
      timers.push(setInterval(() => check('poll'), 60000))
      if (bot.entity) check('start')
    },
    stop() { for (const t of timers) clearInterval(t); timers = [] },
    status: () => ({ value: last, peaceful: last === 'peaceful', since: new Date(since).toISOString() }),
    check,
  }
}
