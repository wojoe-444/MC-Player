// brain/senses: standing views for the driver (Walter 2026-11-04: render the views on a cadence so they are always there to look at,
// instead of collecting, rendering and only then viewing them on demand).
// Every minute: a top-down map (top block per column, torches, chests, beds, cells where mobs can spawn) around home, or around the bot
// when it is away, plus a first-person contact sheet (forward/left/back/right). Images go to brain/state/views/ with a timestamp,
// plus *-latest.png copies; views older than 2 hours are deleted. Rendering runs in short-lived child processes so the bot's
// event loop only pays for collecting the map (done in slices that yield).
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

module.exports = function register(api) {
  const { bot } = api
  const Vec3 = require('vec3').Vec3
  const ROOT = path.join(__dirname, '..', '..')
  const DIR = api.statePath('views')
  const EVERY = 60000, KEEP = 2 * 3600000, N = 96
  let timer = null, busy = false, last = null, runs = 0, err = null
  const yieldNow = () => new Promise(r => setImmediate(r))
  const apState = () => { try { return JSON.parse(fs.readFileSync(api.statePath('autopilot-state.json'), 'utf8')) } catch { return {} } }
  const run = (args, ms) => new Promise(res => execFile(process.execPath, args, { cwd: ROOT, timeout: ms, windowsHide: true }, (e, out) => res(e ? null : String(out))))

  async function collect() {
    const st = apState(), me = bot.entity.position.floored()
    const home = st.home ? new Vec3(...st.home) : null
    const c = home && me.distanceTo(home) < 48 ? home : me
    const x0 = c.x - N / 2, z0 = c.z - N / 2, cells = new Array(N * N).fill(null)
    const air = (s) => { const b = bot.registry.blocksByStateId[s]; return !b || b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        for (let y = c.y + 30; y >= c.y - 30; y--) {
          let s; try { s = bot.world.getBlockStateId(new Vec3(x0 + j, y, z0 + i)) } catch { break }
          if (s == null) break
          if (!air(s)) { cells[i * N + j] = [bot.registry.blocksByStateId[s].name, y]; break }
        }
      }
      if (i % 8 === 7) await yieldNow()
    }
    const ids = (re) => bot.registry.blocksArray.filter(b => re.test(b.name)).map(b => b.id)
    const find = (re) => bot.findBlocks({ matching: ids(re), point: c, maxDistance: N / 2 + 4, count: 2000 }).map(p => [p.x, p.z])
    const d = { t: Date.now(), size: N, x0, z0, home: home ? st.home : [c.x, c.y, c.z], me: [me.x, me.y, me.z], cells,
      torches: find(/^(torch|wall_torch)$/), chests: find(/^(chest|barrel)$/), beds: find(/_bed$/), scaffold: [], mine: [] }
    await yieldNow()
    // where mobs can spawn: block light 0 (computed, the server's light data is scrambled) on a solid floor with two free cells
    try {
      delete require.cache[require.resolve('../autopilot/light')]
      const lm = await require('../autopilot/light')(bot, Vec3).compute(c, N / 2, 24)
      d.dark = []; d.lowl = []
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const cell = cells[i * N + j]; if (!cell) continue
        const q = new Vec3(x0 + j, cell[1] + 1, z0 + i)
        if (lm.spawnable(q)) d.dark.push([q.x, q.z]); else { const l = lm.level(q); if (l > 0 && l < 6) d.lowl.push([q.x, q.z]) } }
    } catch (e) { err = 'light: ' + e.message }
    return d
  }

  function prune() {
    try { for (const f of fs.readdirSync(DIR)) { const p = path.join(DIR, f); if (!/latest/.test(f) && Date.now() - fs.statSync(p).mtimeMs > KEEP) fs.unlinkSync(p) } } catch {}
  }

  async function tick() {
    if (busy || !bot.entity) return
    busy = true
    try {
      fs.mkdirSync(DIR, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const d = await collect()
      const json = path.join(DIR, 'topmap-latest.json')
      fs.writeFileSync(json, JSON.stringify(d))
      fs.writeFileSync(api.statePath('topmap.json'), JSON.stringify(d))
      const top = path.join(DIR, `top-${ts}.png`), pov = path.join(DIR, `pov-${ts}.png`)
      const [a, b] = await Promise.all([run(['tools/topmap.js', '6', json, top], 40000), run(['pov.js', pov, '--around', '--w', '480', '--h', '270', '--port', String(Number(process.env.VIEWER_PORT) || 3007)], 50000)])
      if (a && fs.existsSync(top)) fs.copyFileSync(top, path.join(DIR, 'top-latest.png'))
      if (b && fs.existsSync(pov)) fs.copyFileSync(pov, path.join(DIR, 'pov-latest.png'))
      let info = null; try { info = JSON.parse(String(b).trim().split('\n').pop()) } catch {}
      const ap = bot._ap, G = ap && ap.G
      const bag = {}; for (const it of bot.inventory.items()) bag[it.name] = (bag[it.name] || 0) + it.count
      last = { at: new Date().toISOString(), bot: bot.username, role: (G && G.role) || 'hillclimber', step: G && G.lastStep, hp: Math.round(bot.health), food: bot.food,
        time: bot.time && bot.time.timeOfDay, sleeping: !!bot.isSleeping, home: G && G.state && G.state.home, bag,
        armor: bot.inventory.slots.slice(5, 9).filter(Boolean).map(i => i.name),
        me: d.me, spawnable: (d.dark || []).length, torches: d.torches.length, top: !!a, pov: !!b,
        lookingAt: info && info.lookingAt, inView: info && info.entitiesInView }
      fs.writeFileSync(path.join(DIR, 'latest.json'), JSON.stringify(last, null, 1))
      runs++; prune()
    } catch (e) { err = e.message } finally { busy = false }
  }

  return {
    name: 'senses',
    start() { timer = setInterval(tick, EVERY); setTimeout(tick, 5000) },
    stop() { clearInterval(timer) },
    status() { return { runs, last, err } }
  }
}
module.exports.meta = require('./meta.json')
