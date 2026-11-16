// Work order finding-smeo-light-walk-nopath: torch, whimsy and schematic walks time out and shuttle a shaft. The bot climbs from y 64 down to
// y -9 and back about every 45 s, with no digs and no places. Those walks all go through S.goto (brain/autopilot/skills.js). When the plain walk
// to a goal returns "no path", S.goto first walks "closer": a GoalNearXZ hop 4 blocks short of the goal, met at ANY height. The hop is met at the
// foot of a shaft (the xz position is close enough), so the bot rides the ladders down to a tunnel under the goal and counts that as closer. Then
// the exact goal is tried again from there: its partial path climbs back up the shaft, and the walk times out.
// Expected: a goal the bot cannot reach fails quickly with "no path", and the bot does not leave its level.
// The test drives the real S.goto over the real pathfinder and physics (test/nav.helpers.js) in a made-up world: a plateau at y 63, a one-wide
// shaft down to y -9, a tunnel that ends under an enclosed pit, and the goal in that pit.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const { rig, goals } = require('./nav.helpers.js')
const makeSkills = require('../brain/autopilot/skills')

function build(sim) {
  sim.fill(-25, -10, -10, 25, 62, 10, 'stone')          // solid ground
  sim.fill(-25, 63, -10, 12, 63, 10, 'stone')           // the plateau the bot stands on (feet at 64)
  sim.clear(-1, 63, 0)                                  // the shaft's hole in the plateau
  sim.ladder(-1, -9, 62, 0, 'east')                     // the shaft: ladders from y 62 down to y -9
  for (let y = -9; y <= -8; y++) for (let x = 0; x <= 16; x++) sim.clear(x, y, 0)   // the tunnel at the bottom, ending under the pit
  sim.fill(13, 58, -10, 25, 62, 10, 'air')              // the pit: the goal (20,58,0) is in it, reachable only by digging
}

test('a walk to a goal it cannot reach (under a shaft) fails with "no path" and does not ride the shaft down and back', async () => {
  const r = await rig({ pos: [-10.5, 64, 0.5], bounds: { x0: -40, x1: 60, y0: -20, y1: 100, z0: -20, z1: 20 } }, build, {})
  const bot = r.bot, sim = r.sim
  try {
    const handle = { nav: r.nav, reach: r.nav.reach, goto: (g, o) => r.nav.goto(g, o) }
    bot.clickWindow = async () => {}
    const S = makeSkills({ bot, api: { nav: handle, statePath: (f) => path.join(os.tmpdir(), f), log() {}, say() {} }, log: () => {} })
    clearInterval(bot._resyncTimer); clearInterval(bot._hotbarTimer)      // makeSkills starts two timers that would keep the test process alive
    let minY = Infinity, done = null
    bot.on('physicsTick', () => { minY = Math.min(minY, bot.entity.position.y) })
    S.goto(new goals.GoalNear(20, 58, 0, 2), { dig: false, ms: 30000, escalate: false }).then(x => { done = x })
    await sim.run(() => done, 3000)
    assert.ok(done, 'the walk did not end within 150 s of virtual time')
    assert.ok(minY >= 50, `the bot rode the shaft down to y ${minY.toFixed(1)} (the tunnel under the goal) and climbed back: the walk to an unreachable goal must stay on its level`)
    assert.ok(sim.ticks <= 800, `the walk took ${sim.ticks} ticks (${(sim.ticks / 20).toFixed(0)} s) to end: it should fail quickly with "no path"`)
    assert.equal(done.ok, false)
    assert.equal(done.err, 'no path', `the walk ended with "${done.err}" instead of "no path"`)
  } finally { r.close() }
})
