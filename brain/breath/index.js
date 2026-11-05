// brain/breath: drowning reflex (automatic layer). Drowning is the bot's second most common death; every one happened while another
// layer (safety "recover", a walk, a tunnel) kept it under water. A player who runs out of air swims to the nearest place where the head is in air.
// Trigger: head under water for 5 s, or the air reading low (the server's air value is unreliable here: it jumps between ticks and bubbles).
// Then: jump, and every second steer toward the nearest breathable cell within 12 blocks (under a ceiling, up is not always out).
module.exports = function register(api) {
  const { bot } = api
  const Vec3 = require('vec3').Vec3
  // the movement controls belong to this reflex while it works: it leases `body` (brain/reflexes.js) so combat and the autopilot's goto stand aside.
  // The old flags on the bot are still written for code that has not moved to the registry.
  const reflex = api.reflexes ? api.reflexes.register({ name: 'breath', priority: 90, claims: ['body'], desc: 'drowning and suffocation: swim to air, break out of a buried head, get ashore' }) : null
  const holdBody = (ms, why) => { if (reflex) reflex.claim('body', ms, why) }
  let active = false, since = 0, wetSince = 0, saves = 0, target = null, lastScan = 0, lastAir = null, lastAirAt = 0
  const blk = (p) => { try { return bot.blockAt(p) } catch { return null } }
  const isWater = (b) => !!b && (b.name === 'water' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'kelp_plant' || b.name === 'seagrass' || b.name === 'tall_seagrass')
  const headWet = () => isWater(blk(bot.entity.position.offset(0, 1.62, 0)))
  const passable = (b) => !!b && (b.boundingBox === 'empty') && b.name !== 'lava'
  function breathable() {
    const me = bot.entity.position.floored()
    let best = null, bd = Infinity
    for (let dy = 6; dy >= -2; dy--) for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
      const d = Math.abs(dx) + Math.abs(dz) + Math.max(0, -dy) * 3 + Math.max(0, dy) * 0.5
      if (d >= bd) continue
      const p = me.offset(dx, dy, dz), feet = blk(p), head = blk(p.offset(0, 1, 0))
      if (!feet || !head || !passable(feet) || isWater(head) || !passable(head)) continue
      best = p; bd = d
    }
    return best
  }
  function release() { try { bot.setControlState('jump', false); bot.setControlState('forward', false); bot.setControlState('sprint', false) } catch {} }
  // suffocation: falling gravel/sand (or a bad step) puts the head inside a block; a player breaks it at once
  let digging = false, unburied = 0, lastErrAt = 0
  function headClear() {
    if (digging) return
    const b = blk(bot.entity.position.offset(0, 1.62, 0))
    // only natural blocks that really bury a head (falling gravel/sand, a bad step into stone); never ladders, doors, glass or anything built:
    // climbing Walter's ladder shaft, this broke five of his ladders (00:10, Smeo444)
    if (!b || b.boundingBox !== 'block' || !/^(gravel|sand|red_sand|suspicious_(sand|gravel)|dirt|coarse_dirt|grass_block|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|clay|netherrack|.*concrete_powder)$/.test(b.name)) return
    try { const z = bot._ap && bot._ap.S && bot._ap.S.noDigAt && bot._ap.S.noDigAt(b.position, b.name); if (z && !/gravel|sand/.test(b.name)) return } catch {}
    digging = true
    api.log('breath', `head inside ${b.name} at ${b.position}: breaking out`)
    const tools = bot.inventory.items().filter(i => /_(shovel|pickaxe|axe)$/.test(i.name))
    const tool = tools.find(i => (/gravel|sand|dirt|grass|clay|snow|soul/.test(b.name) ? /_shovel$/ : /_pickaxe$/).test(i.name)) || tools[0]
    // the pathfinder (and whatever task drives it) aborts digs it did not start ('Digging aborted' while gravel kept the head buried): stop it first
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
    try { bot.stopDigging() } catch {}
    bot._breathBusyUntil = Date.now() + 3000; holdBody(3000, 'breaking out of a block')
    Promise.resolve(tool ? bot.equip(tool, 'hand').catch(() => {}) : null).then(() => bot.dig(b, 'ignore')).then(() => { unburied++ }).catch((e) => { if (Date.now() - (lastErrAt || 0) > 3000) { lastErrAt = Date.now(); api.log('breath', 'break-out dig failed: ' + e.message) } try { bot.setControlState('back', true); setTimeout(() => { try { bot.setControlState('back', false) } catch {} }, 400) } catch {} }).finally(() => { digging = false })
  }
  // ashore: in the water with mobs close or health low, the way out is land, not a fight (drowned pulled it down at night: 18:37 death).
  // The pathfinder walks to the nearest dry standing cell; the combat reflex and S.goto stand aside meanwhile.
  let wetFeetSince = 0, ashoreAt = 0, ashoreTarget = null, ashores = 0
  const HOSTILE_RE = /^(drowned|zombie|husk|skeleton|stray|spider|cave_spider|creeper|witch|guardian|pillager|vindicator|phantom)$/
  function landCell() {
    const me = bot.entity.position.floored(); let best = null, bd = Infinity
    for (let dy = 3; dy >= -2; dy--) for (let dx = -16; dx <= 16; dx++) for (let dz = -16; dz <= 16; dz++) {
      const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy); if (d >= bd) continue
      const p = me.offset(dx, dy, dz), g = blk(p.offset(0, -1, 0)), f = blk(p), h = blk(p.offset(0, 1, 0))
      if (!g || !f || !h || g.boundingBox !== 'block' || isWater(g) || isWater(f) || isWater(h) || !passable(f) || !passable(h)) continue
      best = p; bd = d }
    return best
  }
  function ashore(now) {
    const inWater = !!bot.entity.isInWater || isWater(blk(bot.entity.position))
    if (!inWater) { wetFeetSince = 0; if (ashoreTarget) { ashoreTarget = null; bot._ashoreUntil = 0; if (reflex) reflex.release('body'); api.log('breath', 'ashore: on land') } return }
    if (!wetFeetSince) wetFeetSince = now
    const me = bot.entity.position
    const threat = Object.values(bot.entities).some(e => e && e !== bot.entity && HOSTILE_RE.test(e.name || '') && e.position.distanceTo(me) < 10)
    if (now - wetFeetSince < 4000 || !(threat || bot.health < 12)) return
    bot._ashoreUntil = now + 2000; bot._breathBusyUntil = Math.max(bot._breathBusyUntil || 0, now + 2000); holdBody(2000, 'getting ashore')
    if (now - ashoreAt < 2500) return
    ashoreAt = now
    const t = landCell(); if (!t) return
    if (!ashoreTarget || !ashoreTarget.equals(t)) { ashores++; api.log('breath', `ashore: in the water with ${threat ? 'mobs close' : 'low health'} (hp ${Math.round(bot.health)}): heading for land at ${t}`) }
    ashoreTarget = t
    try { const { goals } = require('mineflayer-pathfinder'); bot.pathfinder.setGoal(new goals.GoalBlock(t.x, t.y, t.z)) } catch {}
  }
  // thorns: standing in a berry bush hurts and slows (Walter 2026-11-05: Smeo444 stopped to eat on top of one). Whatever put it there (a
  // reflex's steering, a fight, a path end), step out to the nearest free cell at once
  let thornAt = 0, thornOuts = 0
  function thorns(now) {
    const me = bot.entity.position, feet = blk(me.floored())
    if (!feet || feet.name !== 'sweet_berry_bush' || now - thornAt < 600) return
    thornAt = now
    let best = null, bd = 9
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
      const p = me.floored().offset(dx, dy, dz), f = blk(p), h = blk(p.offset(0, 1, 0)), g = blk(p.offset(0, -1, 0))
      if (!f || !h || !g || f.boundingBox !== 'empty' || h.boundingBox !== 'empty' || g.boundingBox !== 'block' || /sweet_berry_bush|water|lava|fire/.test(f.name + h.name)) continue
      const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy); if (d < bd) { bd = d; best = p }
    }
    if (!best) return
    thornOuts++
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
    bot.lookAt(best.offset(0.5, 1.6, 0.5), true).catch(() => {}); bot.setControlState('forward', true); if (best.y > me.y) bot.setControlState('jump', true)
    setTimeout(() => { try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {} }, 350)
  }
  function tick() {
    if (!bot.entity) return
    try { headClear() } catch {}
    try { thorns(Date.now()) } catch {}
    try { if (!active) ashore(Date.now()) } catch {}
    const raw = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 300
    const air = raw > 20 ? Math.round(raw / 15) : raw
    const wet = headWet(), now = Date.now()
    if (wet) { if (!wetSince) wetSince = now } else { wetSince = 0; if (now - lastAirAt > 500) { lastAir = bot.entity.position.floored(); lastAirAt = now } }
    if (wet && (now - wetSince > 5000 || air <= 10)) {
      if (!active) { active = true; since = now; target = null; api.log('breath', `head under water ${Math.round((now - wetSince) / 1000)}s (air ${air}) at ${bot.entity.position.floored()}: heading for air`) }
      // the way back is the most reliable way out of an underwater cave (the nearest air pocket is often behind a wall): head for where the head was last in air
      // the pathfinder rewrites the movement keys every tick and kept digging stone under water (drowned 14:50): stop it while out of air
      bot._breathBusyUntil = now + 1500; holdBody(1500, 'out of air')
      // first seconds: swim by hand toward air; still under after 8 s (219 s stuck in the farm's water at 00:18): let the pathfinder route there
      const handSwim = now - since < 8000
      if (now - lastScan > 1000 && handSwim) { try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} try { bot.stopDigging() } catch {} }
      if (now - lastScan > 1000) {
        lastScan = now; target = (lastAir && bot.entity.position.distanceTo(lastAir) < 24 && now - since < 15000) ? lastAir : (breathable() || lastAir)
        if (!handSwim && target) { try { const { goals } = require('mineflayer-pathfinder'); bot.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z)) } catch {} }
      }
      if (!handSwim) { try { bot.setControlState('jump', true) } catch {} return }
      try {
        bot.setControlState('jump', true); bot.setControlState('sneak', false)
        if (target) { bot.lookAt(target.offset(0.5, 1.5, 0.5), true).catch(() => {}); const flat = Math.hypot(target.x + 0.5 - bot.entity.position.x, target.z + 0.5 - bot.entity.position.z); bot.setControlState('forward', flat > 0.6); bot.setControlState('sprint', flat > 2) }
        else if (now - since > 3000) bot.setControlState('forward', true)
      } catch {}
    } else if (active && !wet) {
      active = false; saves++; release(); if (reflex) reflex.release('body')
      api.log('breath', `head in air again after ${Math.round((now - since) / 1000)}s`)
    }
  }
  return {
    name: 'breath',
    start() { bot.on('physicsTick', tick) },
    stop() { bot.removeListener('physicsTick', tick); if (active) release(); if (reflex) reflex.release('body') },
    status: () => ({ active, saves, unburied, ashores, thornOuts, target: target && target.toString() })
  }
}
module.exports.meta = require('./meta.json')
