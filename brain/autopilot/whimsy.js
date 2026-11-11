// brain/autopilot/whimsy.js: the bot's own time (CLAUDE.md: "Part of its time is its own ... do not remove or schedule over that slot").
// Until now `whimsy` was a name in a skip list and nothing else: every "free time" decision was a rule-picked chore. This is the real step.
//
// What it does is the bot's choice, made in its dawn brief (brain/memory): one of
//   vantage   walk to the highest ground it can reach near home, look around, and save the spot (brain/state/vantage.json)
//   wander    one short walk somewhere new inside the home leash
//   home      stay at home and look around
// Once per in-game day, in full daylight, when it is healthy and fed, for at most two and a half minutes. It digs nothing and places nothing.
// No brief, or a brief that chose "none": the step never asks to run, and the list plays as before. A brief cannot put this step on hold.
module.exports = function whimsy(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v, st = G.state
  const fs = require('fs')
  const { active } = require('../memory/brief')
  const note = (m) => { try { G.note(m) } catch { log('WHIMSY', m) } }
  const file = () => api.statePath('vantage.json')
  const choice = () => { const b = active(G.brief, { now: Date.now(), day: bot.time && bot.time.day }); return b && b.freeTime.choice !== 'none' ? b.freeTime : null }
  const tod = () => (bot.time && bot.time.timeOfDay) || 0
  const R = 32

  // the highest walkable ground within R of home: the top solid block of each column on a 4-block grid, with two clear blocks above it
  function highGround(h) {
    let best = null
    for (let dx = -R; dx <= R; dx += 4) for (let dz = -R; dz <= R; dz += 4) {
      if (dx * dx + dz * dz > R * R) continue
      const x = Math.floor(h.x) + dx, z = Math.floor(h.z) + dz
      for (let y = Math.floor(h.y) + 40; y >= Math.floor(h.y) - 6; y--) {
        const b = S.block(v(x, y, z)); if (!b) break                                   // not loaded
        if (b.boundingBox !== 'block') continue
        if (/leaves|water|lava|fire|cactus|magma|berry/.test(b.name)) break            // a treetop or a pond is not a place to stand
        const a1 = S.block(v(x, y + 1, z)), a2 = S.block(v(x, y + 2, z))
        if (a1 && a2 && a1.boundingBox === 'empty' && a2.boundingBox === 'empty' && !/water|lava/.test(a1.name) && (!best || y > best.y)) best = { x, y: y + 1, z }
        break
      }
    }
    return best
  }
  async function lookAround(ms) {
    const until = Date.now() + ms
    for (let i = 0; Date.now() < until; i++) { S.check(); try { await bot.look(bot.entity.yaw + Math.PI / 2, i % 2 ? -0.15 : 0.1, false) } catch { /* turning is a nicety */ } await S.wait(2500) }
  }
  const saved = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')) } catch { return [] } }

  return {
    id: 'whimsy', budget: 150000, cool: 60000,
    need: () => !!choice() && !!st.home && st.whimsyDay !== (bot.time && bot.time.day) && !S.isNight() && tod() >= 2000 && tod() <= 9000 &&
      bot.health >= 16 && bot.food >= 14 && (S.skyVisible() || bot.entity.position.y >= st.home[1] - 8),
    run: async () => {
      const c = choice(); if (!c) return true
      const h = v(st.home[0], st.home[1], st.home[2])
      st.whimsyDay = bot.time && bot.time.day; G.save()                                 // the slot is used once it starts, whatever comes of it
      note(`free time: ${c.choice}${c.note ? ` (${c.note})` : ''}`)
      let what = c.choice, where = null
      if (c.choice === 'vantage') {
        const p = highGround(h)
        if (!p) { note('free time: no high ground in sight, staying home instead'); what = 'home' }
        else {
          const r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, escalate: false, ms: 70000 })
          const me = bot.entity.position.floored()
          if (r.ok || (Math.abs(me.y - p.y) <= 3 && Math.hypot(me.x - p.x, me.z - p.z) <= 6)) {
            await lookAround(12000)
            where = [me.x, me.y, me.z]
            const list = saved().filter(q => Math.hypot(q.x - me.x, q.z - me.z) > 8).concat([{ x: me.x, y: me.y, z: me.z, day: bot.time && bot.time.day, at: new Date().toISOString(), note: c.note || '' }]).slice(-30)
            try { fs.writeFileSync(file(), JSON.stringify(list, null, 1)) } catch { /* the walk still happened */ }
            note(`free time: vantage point saved at ${me.x},${me.y},${me.z}`)
          } else note('free time: could not reach the high ground (' + (r.err || r.why || 'stopped') + ')')
        }
      }
      if (what === 'wander') { await G.explore(24); const me = bot.entity.position.floored(); where = [me.x, me.y, me.z] }
      if (what === 'home') {
        if (S.dist(h) > 6) await S.goto(new goals.GoalNear(h.x, h.y, h.z, 3), { dig: false, ms: 60000 })
        await lookAround(20000)
      }
      try { if (bot._journal) bot._journal.add('whimsy', { choice: c.choice, did: what, note: c.note || '', pos: where }) } catch { /* the journal is a nicety */ }
      return true
    }
  }
}
