// Smeo444 chunk explorer (Walter 2026-11-08): in spectator mode, fly a square spiral out from a centre at a pace the server can keep up
// with, so every chunk along the way is generated and saved. Movement: physics off, the position set a little each tick (mineflayer
// sends it); the bot only moves on while the chunk a few chunks ahead has arrived, so it never outruns generation.
// Progress is kept in brain/state/explore.json and resumes after a restart.
const fs = require('fs')

module.exports = function explore(bot, api, opts = {}) {
  const Vec3 = bot.entity.position.constructor
  const file = api.statePath('explore.json')
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
  const save = (s) => { try { fs.writeFileSync(file, JSON.stringify(s, null, 1)) } catch {} }
  let s = load()
  if (!s || opts.reset) {
    const c = opts.center || [Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.z)]
    s = { center: c, y: opts.y || 160, ring: 0, leg: 0, legPos: 0, spacing: opts.spacing || null, speed: opts.speed || 5, lookahead: opts.lookahead || 3, maxRing: opts.maxRing || 40, done: false, startedAt: Date.now(), blocks: 0 }
  }
  if (opts.speed) s.speed = opts.speed
  if (opts.maxRing) s.maxRing = opts.maxRing
  const st = { running: true, waiting: 0, last: '' }
  const loaded = (x, z) => !!bot.world.getColumnAt ? !!bot.world.getColumnAt(new Vec3(x, 0, z)) : !!bot.blockAt(new Vec3(x, 64, z))
  // how far the server sends chunks (its view distance, capped by ours): measured once along +x
  function viewChunks() {
    const p = bot.entity.position; let r = 0
    for (let k = 1; k <= 40; k++) { if (loaded(p.x + k * 16, p.z)) r = k; else break }
    return Math.max(2, r)
  }
  // square spiral: ring r is the square of half-size r*spacing; leg 0..3 walk its sides; ring 0 is the centre point
  function corner(r, i) { const h = r * s.spacing, [cx, cz] = s.center; return [[cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h], [cx - h, cz - h]][i % 4] }
  function legStart(r, leg) { return leg === 0 ? [s.center[0] - r * s.spacing, s.center[1] - r * s.spacing] : corner(r, leg - 1) }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  async function moveTo(x, z) {
    const step = s.speed / 20
    for (;;) {
      if (!st.running) return false
      const p = bot.entity.position, dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz)
      const dy = s.y - p.y
      if (d < 0.5 && Math.abs(dy) < 0.5) return true
      // pace: the chunk lookahead chunks ahead along the way must be here already
      const ux = d > 0 ? dx / d : 0, uz = d > 0 ? dz / d : 0
      if (!loaded(p.x + ux * s.lookahead * 16, p.z + uz * s.lookahead * 16) && d > s.lookahead * 16) { st.waiting++; await sleep(250); continue }
      const k = Math.min(step, d)
      const ny = p.y + Math.max(-step, Math.min(step, dy))
      bot.entity.position = new Vec3(p.x + ux * k, ny, p.z + uz * k)
      bot.entity.velocity = new Vec3(0, 0, 0)
      s.blocks += k
      await sleep(50)
    }
  }
  async function run() {
    bot.physicsEnabled = false
    // (the server's own view distance decides; asking for 32 flooded the client and it timed out, 03:20)
    await sleep(3000)
    if (!s.spacing) { const vc = viewChunks(); s.spacing = Math.max(32, (2 * vc - 2) * 16); s.viewChunks = vc }
    save(s)
    // up to the flight height first
    await moveTo(bot.entity.position.x, bot.entity.position.z)
    while (st.running && s.ring <= s.maxRing) {
      if (s.ring === 0) { await moveTo(s.center[0], s.center[1]); s.ring = 1; s.leg = 0; save(s); continue }
      if (s.leg === 0) { const a = legStart(s.ring, 0); if (!(await moveTo(a[0], a[1]))) break }
      const b = corner(s.ring, s.leg)
      st.last = `ring ${s.ring} leg ${s.leg} -> ${b.join(',')}`
      if (!(await moveTo(b[0], b[1]))) break
      s.leg++
      if (s.leg >= 4) { s.leg = 0; s.ring++; api.log('explore', `ring ${s.ring - 1} done: ${(s.ring - 1) * s.spacing} blocks out from ${s.center.join(',')}`) }
      save(s)
    }
    if (s.ring > s.maxRing) { s.done = true; save(s); api.log('explore', 'spiral done') }
  }
  st.promise = run().catch(e => { api.log('explore', 'stopped: ' + e.message) })
  st.stop = () => { st.running = false; bot.physicsEnabled = true }
  st.status = () => ({ ...s, pos: bot.entity.position.floored(), waiting: st.waiting, last: st.last, covered: s.ring > 1 ? `${(s.ring - 1) * s.spacing + (s.viewChunks || 0) * 16} blocks radius` : 'starting' })
  return st
}
