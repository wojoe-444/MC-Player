// brain/nav and farmland (Walter 2026-11-11: "a bot lands on farmland and turns it back into regular dirt"): the planner prices drops onto farmland, and
// the jump guard drops a hop that would land on it. The simulation uses the real planner and the real physics; the server rule is emulated by `Trampler`
// (vanilla FarmBlock.fallOn: a landing after a fall of more than half a block can turn farmland to dirt, chance fall - 0.5).
const test = require('node:test')
const assert = require('node:assert')
const { rig, goals, Vec3 } = require('./nav.helpers')
const B = require('../brain/nav/blocks')
const { FarmlandGuard } = require('../brain/nav/farmland')

const G = (x, y, z) => new goals.GoalBlock(x, y, z)

// Counts landings on farmland whose fall was long enough to risk the block (> 0.5), the way the server would.
class Trampler {
  constructor(sim) {
    this.sim = sim; this.fall = 0; this.lastY = sim.at().y; this.wasGround = true; this.risky = []; this.landed = 0
    sim.bot.on('physicsTick', () => this.tick())
  }
  tick() {
    const p = this.sim.at(), g = !!this.sim.bot.entity.onGround
    if (!g && p.y < this.lastY) this.fall += this.lastY - p.y
    if (g && !this.wasGround) {
      const under = this.sim.blockName(Math.floor(p.x), Math.floor(p.y - 0.01), Math.floor(p.z))
      if (under === 'farmland') { this.landed++; if (this.fall > 0.5) this.risky.push({ at: [p.x.toFixed(1), p.y.toFixed(2), p.z.toFixed(1)], fall: +this.fall.toFixed(2) }) }
    }
    if (g) this.fall = 0
    this.wasGround = g; this.lastY = p.y
  }
}

// ground at y 63; a 2 high stone ledge (x 0..4) the bot stands on; a farmland plot at ground level (x 5..9) right below the ledge's east edge
function ledgeAndPlot(s) {
  s.floor(-5, -6, 30, 6, 62)
  s.floor(-5, -6, 30, 6, 63)
  s.fill(0, 64, -6, 4, 64, 6, 'stone')
  s.fill(5, 63, -2, 9, 63, 2, 'farmland', { moisture: 7 })
}

test('the planner would drop onto the plot from the ledge (control: without the landing cost the shortest route is a drop onto farmland)', async () => {
  const r = await rig({ pos: [3.5, 65, 0.5] }, ledgeAndPlot)
  r.nav.mvHandle.restore()                                  // plain planner: the cost is part of nav's configuration
  const tr = new Trampler(r.sim)
  const res = await r.go(G(7, 64, 0), { maxTicks: 500 })
  assert.ok(res.ok, JSON.stringify(res))
  assert.ok(tr.risky.length >= 1, 'the old planner takes the drop onto the plot, as expected: ' + JSON.stringify(tr.risky))
  r.close()
})

test('with the landing cost it walks down the ledge elsewhere and steps onto the plot at ground level: no landing on farmland with a fall', async () => {
  const r = await rig({ pos: [3.5, 65, 0.5] }, ledgeAndPlot)
  const tr = new Trampler(r.sim)
  const res = await r.go(G(7, 64, 0), { maxTicks: 700 })
  assert.ok(res.ok, JSON.stringify(res))
  assert.deepStrictEqual(tr.risky, [], 'landed on farmland after a fall')
  assert.ok(r.nav.status().farmland.dropsPriced > 0, 'the planner saw drops onto farmland and priced them')
  r.close()
})

test('a plot only reachable by a drop is still entered (the cost is a price, not a wall), and the bot says nothing odd about it', async () => {
  const r = await rig({ pos: [3.5, 65, 0.5] }, s => { ledgeAndPlot(s); s.fill(4, 63, -6, 10, 66, -3, 'stone_bricks'); s.fill(4, 64, 3, 10, 66, 6, 'stone_bricks'); s.fill(10, 64, -2, 10, 66, 2, 'stone_bricks') })
  const res = await r.go(G(7, 64, 0), { maxTicks: 700 })
  assert.ok(res.ok, 'a farm with one way in must still be enterable: ' + JSON.stringify(res))
  r.close()
})

test('walking across a plot from level ground costs nothing extra and does not trigger the guard', async () => {
  const r = await rig({ pos: [0.5, 64, 0.5] }, s => { s.floor(-5, -6, 30, 6, 63); s.fill(5, 63, -2, 9, 63, 2, 'farmland', { moisture: 7 }) })
  const tr = new Trampler(r.sim)
  const res = await r.go(G(12, 64, 0), { maxTicks: 500 })
  assert.ok(res.ok, JSON.stringify(res))
  assert.deepStrictEqual(tr.risky, [])
  assert.strictEqual(r.nav.status().farmland.jumpsHeld, 0)
  r.close()
})

test('jump guard: a hop on the spot over farmland is held, the same hop on stone still jumps', async () => {
  const stone = await rig({ pos: [0.5, 64, 0.5] }, s => s.floor(-5, -6, 30, 6, 63))
  stone.bot.setControlState('jump', true)
  const y0 = stone.sim.at().y
  await stone.sim.run(() => stone.sim.at().y > y0 + 0.5, 20)
  assert.ok(stone.sim.at().y > y0 + 0.5, 'control: jumps on stone')
  stone.close()

  const r = await rig({ pos: [6.5, 63.9375, 0.5] }, s => { s.floor(-5, -6, 30, 6, 62); s.fill(5, 63, -2, 9, 63, 2, 'farmland', { moisture: 7 }) })
  const tr = new Trampler(r.sim)
  r.bot.setControlState('jump', true)                                     // asked once, like a stuck-recovery hop
  await r.sim.run(null, 40)
  assert.ok(r.sim.at().y < 64.2, 'bot hopped on the plot: y ' + r.sim.at().y)
  assert.deepStrictEqual(tr.risky, [])
  assert.ok(r.nav.status().farmland.jumpsHeld >= 1)
  // a jump key held down from before the bot reached the plot is released on the next tick, before it can hop
  r.bot.controlState.jump = true
  r.sim.bot.emit('physicsTick')
  assert.strictEqual(r.bot.controlState.jump, false)
  r.close()
})

test('jump guard: a step up out of the plot (a block in the way) is never held', async () => {
  const r = await rig({ pos: [8.5, 63.9375, 0.5], yaw: -Math.PI / 2 }, s => {
    s.floor(-5, -6, 30, 6, 62); s.fill(5, 63, -2, 9, 63, 2, 'farmland', { moisture: 7 }); s.fill(10, 63, -2, 12, 64, 2, 'stone')     // yaw -90 deg faces east, into a 1 high rim
  })
  r.bot.setControlState('forward', true)
  r.bot.on('physicsTick', () => r.bot.setControlState('jump', true))      // like the pathfinder: asks for the jump on every tick it needs one
  await r.sim.run(() => r.sim.at().x > 10.2 && r.sim.at().y > 64.5, 60)
  assert.ok(r.sim.at().x > 10.2 && r.sim.at().y > 64.5, 'climbed out over the rim, at ' + r.sim.at())
  r.close()
})

test('jump guard: pillaring on farmland (looking down) is not held; swimming and ladders are not either', async () => {
  const r = await rig({ pos: [6.5, 63.9375, 0.5] }, s => { s.floor(-5, -6, 30, 6, 62); s.fill(5, 63, -2, 9, 63, 2, 'farmland', { moisture: 7 }) })
  r.bot.entity.pitch = 1.4
  r.bot.setControlState('jump', true)
  await r.sim.run(() => r.sim.at().y > 64.5, 20)
  assert.ok(r.sim.at().y > 64.5, 'a pillar jump goes up')
  r.close()
  const g = new FarmlandGuard({ bot: { entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, isInWater: true }, blockAt: () => null, controlState: {} } })
  assert.strictEqual(g.holdsJump(), false)
})

test('the guard puts bot.setControlState back on detach and tolerates a bot without one', () => {
  const calls = []
  const bot = { setControlState: (k, v) => calls.push([k, v]), on() {}, removeListener() {}, entity: null, controlState: {} }
  const orig = bot.setControlState
  const g = new FarmlandGuard({ bot }).attach()
  assert.notStrictEqual(bot.setControlState, orig)
  bot.setControlState('jump', true)                     // no entity yet: passes through
  assert.deepStrictEqual(calls, [['jump', true]])
  g.detach()
  assert.strictEqual(bot.setControlState, orig)
  assert.ok(B.FARMLAND_LANDING_COST > 0)
})
