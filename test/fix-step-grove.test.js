// Work order step-grove: the grove step idles for about two minutes (watchdog: autopilot-stalled:grove). This test covers that stall only; the
// thrash with shelter and iron belongs to the other work orders named in the order.
// The grove step (brain/autopilot/plan.js, 'grove') calls the tree farm build (brain/treefarm/farm.js). Its walks to a farm spot (the torch cell
// of a light, the sapling spot of a planting, the farm centre) go through the treefarm engine's go-to, and that go-to passes no `escalate` option.
// nav's go-to escalates by default (brain/nav/reach.js): when the plain walk to a cell fails it runs its digging, bridging and pillar rounds until
// a cap, and a pillar or a sidestep that gets nowhere is the bot jumping or oscillating in place. The tidy step had the same fault
// (test/fix-step-tidy.test.js), and torch-spacing and the view walk already pass escalate: false. The fix: the farm's walks to a spot, and the
// walk to the farm, pass escalate: false down to nav (brain/nav/navigator.js approachBlock and gotoNear carry the flag now).
// The test drives the real farm build on a made-up flat world with a virtual clock. The walk stub is nav's go-to as far as this needs it: a walk
// to a cell no plain path reaches fails at once when it is plain, and runs for a long time when it escalates.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const { extendTrees, flatWorld, fakeCtx } = require('./treefarm.helpers')
const createEngine = require('../brain/treefarm/engine')
const L = require('../brain/treefarm/layout')
const safehand = require('../brain/safehand')
const los = require('../brain/los')
const stateStore = require('../brain/treefarm/state')
const baseConfig = require('../brain/treefarm/config.json')
const { Navigator } = require('../brain/nav/navigator')

const ESCALATING = 120000       // an escalating walk to a cell it cannot reach runs nav's rounds for a long time (modelled at two minutes, as the tidy test does)
const PLAIN_FAIL = 2000         // a plain walk to such a cell is given up at once
const HOME = { x: 0, y: 64, z: 0 }

// A farm rig: the real engine and farm on a flat grass world. `stuck(goal)` says which walks no plain path reaches. Every walk is recorded with
// whether it was allowed to escalate (nav's default is yes).
function rig({ stuck = () => false } = {}) {
  const bot = extendTrees(mockBot({ pos: [HOME.x, HOME.y, HOME.z] }))
  flatWorld(bot)
  bot.give('torch', 64); bot.give('birch_sapling', 4); bot.give('dirt', 10)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-step-grove-'))
  const file = path.join(dir, 'treefarm-state.json')
  const state = stateStore.load({ file })
  const save = () => stateStore.save(file, state)
  const walks = []
  let elapsed = 0                                              // virtual seconds the walks cost, in ms
  const walk = (goal, label, escalate) => {
    walks.push({ x: goal.x, y: goal.y, z: goal.z, r: goal.r, label, escalate })
    if (!stuck(goal)) { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); elapsed += 1000; return { ok: true, secs: 1 } }
    elapsed += escalate ? ESCALATING : PLAIN_FAIL
    return { ok: false, secs: 0, err: escalate ? 'timeout' : 'no path' }
  }
  const allowEscalation = (opts) => !(opts && opts.escalate === false)
  const tryGoto = async (goal, label = '', ms, opts) => walk(goal, label, allowEscalation(opts))
  const gotoNear = async (o) => !!walk(new bot.goals.GoalNear(o.pos.x, o.pos.y, o.pos.z, o.radius), o.label, allowEscalation(o)).ok
  const engine = createEngine({
    bot, say: () => {}, goals: bot.goals, tryGoto, safehand: safehand({ bot }), stopNav: () => {},
    gotoNear, canSee: (t) => los.canSee(bot, t),
    ensureLineOfSight: (o) => los.ensureLineOfSight({ bot, goals: bot.goals, tryGoto: (g, l, ms) => tryGoto(g, l, ms, { escalate: false }), stop: () => {}, ...o }),
    depositSmeltables: null, requestChest: null,
    config: { ...baseConfig, keepLogs: 32, storage: [], dropWaitMs: 0, plantWaitMs: 0, logWaitMs: 0, descendMaxMs: 6000 },
    state, save, sitesFn: () => [...state.sites], now: Date.now
  })
  return { bot, engine, state, walks, elapsed: () => elapsed, dispose: () => bot.stopPhysics() }
}

// the walks that were allowed to escalate and go to the cell (x, z) with the given goal radius
const escalatingTo = (walks, x, z, r) => walks.filter(w => w.escalate && w.x === x && w.z === z && w.r === r).map(w => `${w.x},${w.z} r${w.r} (${w.label})`)

test('a torch spot that no plain walk reaches is given up at once: the walk to it does not escalate', async () => {
  let spot = null
  const r = rig({ stuck: (g) => !!spot && g.r === 2 && g.x === spot.x && g.z === spot.z })   // the light's walk: GoalNear(torch cell, 2)
  try {
    await r.engine.farm.create(fakeCtx(), { home: HOME })
    const f = r.state.farms[0]
    spot = L.torchCells(f)[6]
    const out = await r.engine.farm.build(fakeCtx(), { quiet: true })
    const bad = escalatingTo(r.walks, spot.x, spot.z, 2)
    assert.deepEqual(bad, [], `the walk to the torch spot ${spot.x},${spot.z} was allowed to escalate (digging and bridging for up to two minutes): the grove stalls there`)
    assert.ok(out.lit > 0, 'the other torch spots are still lit: ' + JSON.stringify(out))
  } finally { r.dispose() }
})

test('a sapling spot that no plain walk reaches is given up at once: the walk to stand next to it does not escalate', async () => {
  let spot = null
  const r = rig({ stuck: (g) => !!spot && g.r === 3 && g.x === spot.x && g.z === spot.z })   // the planting's walk: GoalNear(soil under the spot, 3)
  try {
    await r.engine.farm.create(fakeCtx(), { home: HOME })
    const f = r.state.farms[0]
    spot = L.spots(f)[0]
    const out = await r.engine.farm.build(fakeCtx(), { quiet: true })
    const bad = escalatingTo(r.walks, spot.x, spot.z, 3)
    assert.deepEqual(bad, [], `the walk to stand by the sapling spot ${spot.x},${spot.z} was allowed to escalate (digging and bridging for up to two minutes): the grove stalls there`)
    assert.ok(out.planted > 0, 'the other spots are still planted: ' + JSON.stringify(out))
  } finally { r.dispose() }
})

test('the walk from far away to the farm does not escalate: when no plain path reaches the farm the visit ends with a reason, not a stall', async () => {
  const r = rig({ stuck: (g) => g.r === 6 })                  // the walk to the farm centre: GoalNear(centre, 6)
  try {
    await r.engine.farm.create(fakeCtx(), { home: HOME })
    r.bot.entity.position = new Vec3(60.5, 64, 60.5)          // far from the farm: the visit walks there first
    const out = await r.engine.farm.build(fakeCtx(), { quiet: true })
    const bad = r.walks.filter(w => w.escalate && w.r === 6).map(w => `${w.x},${w.z} (${w.label})`)
    assert.deepEqual(bad, [], `the walk to the farm was allowed to escalate: ${bad.join(' ')}`)
    assert.ok(/cannot reach the farm/.test(out.why || ''), JSON.stringify(out))
  } finally { r.dispose() }
})

test('control: with every spot reachable the farm is planted and lit in one visit', async () => {
  const r = rig()
  try {
    const out = await r.engine.farm.build(fakeCtx(), { home: HOME, quiet: true })
    assert.strictEqual(out.planted, 4, JSON.stringify(out))
    assert.ok(out.lit > 0, JSON.stringify(out))
  } finally { r.dispose() }
})

test('nav: the approach to a block and gotoNear pass escalate: false on to the go-to; without it nav still escalates as before', async () => {
  const seen = []
  const fake = Object.create(Navigator.prototype)
  Object.assign(fake, {
    attached: true, bot: { entity: { position: new Vec3(0, 64, 0) } },
    goals: { GoalCompositeAny: class { constructor(g) { this.g = g } }, GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z }) } } },
    eyeTo: () => 99, visibleFrom: () => false, standCells: () => [{ x: 1, y: 64, z: 1 }],
    goto: async (g, o) => { seen.push(o); return { ok: false, err: 'no path' } }
  })
  const pos = new Vec3(5, 64, 5)
  await fake.approachBlock(pos, { label: 'a sapling spot', ms: 60000, escalate: false })
  await fake.approachBlock(pos, { label: 'the block', ms: 60000 })
  await fake.gotoNear({ pos, label: 'a leaf', ms: 1000, escalate: false })
  assert.deepEqual(seen.map(o => o.escalate), [false, undefined, false], JSON.stringify(seen))
})
