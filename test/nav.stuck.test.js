// brain/nav: stuck detection/recovery and the runtime hazard guard.
const test = require('node:test')
const assert = require('node:assert')
const { rig, goals, Vec3 } = require('./nav.helpers')
const { Penalties, StuckMonitor } = require('../brain/nav/stuck')

const flat = (s) => s.floor(-5, -5, 40, 20, 63)
const G = (x, y, z) => new goals.GoalBlock(x, y, z)
const inLava = (r) => r.track(() => r.sim.bot.entity.isInLava || /lava/.test(r.sim.blockName(Math.floor(r.sim.at().x), Math.floor(r.sim.at().y - 0.1), Math.floor(r.sim.at().z))))

test('an invisible pillar (planner and world disagree): stuck is noticed, the bot sidesteps/re-plans and gets there', async () => {
  const r = await rig({}, s => { flat(s); s.hide(5, 64, 0); s.hide(5, 65, 0) })
  const res = await r.go(G(10, 64, 0), { maxTicks: 900 })
  assert.ok(res.ok, JSON.stringify(res) + '\n' + r.logs.join('\n'))
  assert.ok(r.nav.status().stuck.episodes >= 1)
  r.close()
})

test('an invisible wall across the whole area: recovery escalates, then gives up with "stuck" and leaves the bot idle', async () => {
  const r = await rig({}, s => { flat(s); for (let z = -5; z <= 20; z++) { s.hide(5, 64, z); s.hide(5, 65, z) } })
  const res = await r.go(G(10, 64, 0), { maxTicks: 1500 })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.err, 'stuck')
  assert.ok(res.secs < 40, `took ${res.secs}s to give up`)
  assert.strictEqual(r.nav.status().stuck.maxLevel, 5)
  assert.strictEqual(r.bot.pathfinder.goal, null, 'no goal left set')
  assert.ok(!Object.values(r.bot.controlState).some(Boolean), 'no control state left pressed')
  r.close()
})

test('recovery moves are checked first: stuck next to lava never walks, strafes or backs into it', async () => {
  // floor ends at x=6 (lava beyond); an invisible wall at x=5 holds the bot at the edge area while it "tries"
  const r = await rig({ pos: [3.5, 64, 0.5] }, s => {
    s.floor(-5, -5, 5, 20, 63); s.fill(6, 63, -5, 40, 63, 20, 'lava'); s.floor(-5, -5, 5, 20, 63)
    for (let z = -5; z <= 20; z++) { s.hide(4, 64, z); s.hide(4, 65, z) }
  })
  const bad = inLava(r)
  const res = await r.go(G(5, 64, 0), { maxTicks: 1500 })
  assert.strictEqual(res.ok, false)
  assert.ok(!bad.some(Boolean), 'touched lava while recovering')
  r.close()
})

test('StuckMonitor.safe(): hazards, holes and drops ahead are refused, solid ground is fine', async () => {
  const r = await rig({ pos: [5.5, 64, 5.5] }, s => { flat(s); s.fill(8, 63, 0, 12, 63, 10, 'lava'); s.fill(2, 63, 0, 3, 63, 10, 'air'); s.floor(2, 0, 3, 10, 58) })
  r.bot.entity.yaw = Math.PI * 1.5                                  // facing +x? check each direction explicitly instead
  const yawFor = (dx, dz) => Math.atan2(-dx, -dz)
  r.bot.entity.yaw = yawFor(1, 0)                                   // facing east: lava at x>=8 is 2.5 blocks ahead
  assert.strictEqual(r.nav.stuck.safe(0, 3.2), false, 'lava ahead')
  assert.strictEqual(r.nav.stuck.safe(0, 1.6), true, 'still safe 1.6 blocks ahead')
  assert.strictEqual(r.nav.stuck.safe(Math.PI, 0.8), true, 'west is fine for the first 0.8 blocks')
  assert.strictEqual(r.nav.stuck.safe(Math.PI, 2.4), false, 'west: a 5 block drop at x<=3')
  r.close()
})

test('not stuck while simply waiting: no forward key pressed or no path -> no episodes', async () => {
  const r = await rig({}, flat)
  const a = await r.go(G(3, 64, 0), { after: 400 })                 // arrived, then idle for 20 s
  assert.ok(a.ok)
  assert.strictEqual(r.nav.status().stuck.episodes, 0)
  r.close()
})

test('Penalties: weights apply to the planner, areas expire', () => {
  const p = new Penalties()
  p.add(3, 64, 3, 45, 100)
  const blk = (x, y, z) => ({ position: { x, y, z } })
  assert.strictEqual(p.weight(blk(3, 64, 3)), 45)
  assert.strictEqual(p.weight(blk(4, 64, 3)), 0)
  p.addArea(10, 64, 10, 1, 100, 50)
  assert.strictEqual(p.weight(blk(11, 64, 9)), 100)
  for (let i = 0; i < 200; i++) p.tick()
  assert.strictEqual(p.weight(blk(3, 64, 3)), 0)
  assert.strictEqual(p.size, 0)
})

// ---------------------------------------------------------------- hazard guard
test('standing in lava: climbs out the shortest way, then carries on to the goal', async () => {
  const r = await rig({ pos: [0.5, 64.5, 0.5] }, s => { flat(s); s.fill(-1, 63, -1, 1, 63, 1, 'lava'); s.set(0, 64, 0, 'lava') })
  const res = await r.go(G(8, 64, 0), { maxTicks: 400 })
  assert.ok(res.ok, JSON.stringify(res) + r.logs.join('\n'))
  assert.ok(r.nav.status().hazards.escapes >= 1)
  assert.ok(r.logs.some(l => /in lava/.test(l)))
  r.close()
})

test('a hazard reported while a goto runs ends it with "hazard" (and says nothing by itself)', async () => {
  const r = await rig({}, flat)
  let res = null
  r.nav.goto(G(30, 64, 0), { ms: 30000 }).then(x => { res = x })
  await r.sim.run(null, 20)
  r.sim.set(Math.floor(r.sim.at().x), 64, 0, 'lava')                // lava appears at the bot's feet
  await r.sim.run(() => res, 200)
  assert.ok(res && !res.ok && res.err === 'hazard', JSON.stringify(res))
  r.close()
})

test('goals inside lava/fire/cactus are refused up front', async () => {
  const r = await rig({}, s => { flat(s); s.set(10, 64, 0, 'fire'); s.set(12, 63, 0, 'lava'); s.set(12, 64, 0, 'lava') })
  for (const x of [10, 12]) {
    const res = await r.go(G(x, 64, 0), { maxTicks: 50 })
    assert.strictEqual(res.ok, false)
    assert.match(res.err, /goal is in/)
  }
  r.close()
})

test('MotionMonitor flags a teleport-like jump but not a fall or a death/portal respawn', async () => {
  const r = await rig({}, flat)
  await r.sim.run(null, 80)
  const before = r.nav.motion.anomalies.length
  r.bot.entity.position.x += 20                                     // someone else moved us 20 blocks (a /tp, a bug)
  await r.sim.run(null, 3)
  assert.strictEqual(r.nav.motion.anomalies.length, before + 1)
  r.bot.emit('forcedMove'); r.bot.entity.position.x += 30           // the server moved us (portal, respawn): expected
  await r.sim.run(null, 3)
  assert.strictEqual(r.nav.motion.anomalies.length, before + 1)
  r.close()
})
