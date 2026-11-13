// Work order step-torch-spacing: the step times out in 6 of 21 runs (one bot) and in 2 of 17 (the other), and fails in between. A pass that the
// step's 360 s budget cuts short keeps no record of the torches it walked to. The crowded torches are sorted the same way on every pass, so the
// unreachable ones are walked to first again and again, the budget runs out before the reachable torches get a turn, and the step is due again
// five minutes later from the same spot. Light-home and tidy already keep such a record (lightStuck, tidyStuck). The test drives the real
// torch-spacing step (brain/autopilot/plan.js, the step's run) on a flat made-up world: a row of torches at x=-14 that cannot be walked to (each
// walk takes a minute and fails), and a pair at x=8 that can (five seconds, the bot moves there and takes one down). Time is a fake clock; the
// budget is enforced the way skills.js S.check enforces it (StepTimeout once S.stepDeadline has passed).
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const key = (x, y, z) => `${x},${y},${z}`
const BUDGET = 360000
const NAME_OF_ID = { 50: 'torch', 51: 'wall_torch', 52: 'red_bed' }

// a made-up flat world: stone up to y63, air above, a red bed at home 0,64,0, torches standing on the ground at y64.
// Torch cells read as solid here: the light flood is off in this world (no block states), and a torch that is lit only by itself would
// otherwise always count as dark and be kept, so nothing would ever be taken down.
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-ts-walk-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  const cells = new Map([[key(0, 64, 0), 'red_bed']])
  // the west row: six torches two apart (the middle ones are crowded, two neighbours each); the east pair: two torches two apart
  for (const z of [0, 2, 4, 6, 8, 10]) cells.set(key(-14, 64, z), 'torch')
  for (const z of [0, 2]) cells.set(key(8, 64, z), 'torch')
  const name = (x, y, z) => cells.get(key(x, y, z)) || (y <= 63 ? 'stone' : 'air')
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z) } }
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(-20.5, 64, 2.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 2000 }
  bot.health = 20; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = {
    blocksArray: [{ name: 'torch', id: 50 }, { name: 'wall_torch', id: 51 }, { name: 'red_bed', id: 52 }],
    blocksByName: { torch: { name: 'torch', id: 50 }, wall_torch: { name: 'wall_torch', id: 51 } }, blocksByStateId: {},
  }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = (p) => block(p.x, p.y, p.z)
  // blocks of the listed ids, nearest first, within maxDistance of point (what mineflayer's findBlocks returns)
  bot.findBlocks = ({ matching, point, maxDistance = 16, count = 1 }) => {
    const want = new Set(matching.map(i => NAME_OF_ID[i]))
    const hits = []
    for (const [k, n] of cells) {
      if (!want.has(n)) continue
      const [x, y, z] = k.split(',').map(Number), p = new Vec3(x, y, z), d = p.distanceTo(point)
      if (d <= maxDistance) hits.push({ p, d })
    }
    return hits.sort((a, b) => a.d - b.d).slice(0, count).map(h => h.p)
  }
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const walks = []                                       // every go-to the step made: where, and whether it arrived
  const west = (p) => p.x <= -10
  const base = {
    bot, goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor (x, y, z) { Object.assign(this, { x, y, z }) } } },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => block(p.x, p.y, p.z), isAir: (b) => !!b && b.name === 'air', isLiquid: () => false, isWaterish: () => false,
    passable: (b) => !!b && b.boundingBox === 'empty', solid: (b) => !!b && b.boundingBox === 'block',
    dist: (p) => bot.entity.position.distanceTo(p),
    items: () => [], toolTier: () => 3, freeSlots: () => 20, isNight: () => false, skyVisible: () => true,
    check() {}, wait: async () => {}, say() {}, aborted: () => false, isAbort: () => false, stepDeadline: 0,
    // one walk: a west go-to takes a minute and fails; an east one takes five seconds and arrives
    goto: async (goal) => {
      if (base.stepDeadline && Date.now() > base.stepDeadline) { base.stepDeadline = 0; const e = new Error('step time budget used up'); e.name = 'StepTimeout'; throw e }
      const at = new Vec3(goal.x, goal.y, goal.z)
      if (west(at)) { clock.now += 60000; walks.push({ at, ok: false }); return { ok: false, err: 'nopath' } }
      clock.now += 5000; bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); walks.push({ at, ok: true }); return { ok: true }
    },
    // what S.mine does for a torch: approach (two go-tos, the second one a looser stand-near), then take it down
    mine: async (b) => {
      const at = b.position
      if (west(at)) { for (let i = 0; i < 2; i++) await base.goto(new base.goals.GoalNear(at.x, at.y, at.z, 2)); return false }
      if (!(await base.goto(new base.goals.GoalNear(at.x, at.y, at.z, 2))).ok) return false
      cells.delete(key(at.x, at.y, at.z)); return true
    },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')     // no shared registry here
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const step = G.steps.find(s => s.id === 'torch-spacing')
  return {
    G, base, step, walks, cells, clock,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

// one pass the way goals.js runs a step: the budget is set first, then the run; returns the run's error if it was cut short
async function pass(r) {
  r.base.stepDeadline = r.clock.now + BUDGET
  try { await r.step.run(); return null } catch (e) { return e } finally { r.base.stepDeadline = 0 }
}

test('a pass cut short by its budget does not start the next pass on the same unreachable torches: the reachable torch gets its turn', async () => {
  const r = rig()
  try {
    assert.ok(r.step, 'the torch-spacing step exists')
    const cut = await pass(r)                              // four west torches at two minutes each, then the budget is gone
    assert.ok(cut && cut.name === 'StepTimeout', 'the first pass should be cut short by the budget')
    r.walks.length = 0
    await pass(r)
    assert.ok(r.walks.length >= 1, 'the second pass made no walk at all')
    const first = r.walks[0].at
    assert.ok(first.x > -10, `the second pass walked first to the unreachable torch ${first.x},${first.y},${first.z}, the same as the first pass`)
    assert.notEqual(r.cells.get(key(8, 64, 0)), 'torch', 'the reachable torch at 8,64,0 was not taken down')
  } finally { r.dispose() }
})

test('a torch whose walk was cut short is left alone for a while: the next pass does not walk to it again', async () => {
  const r = rig()
  try {
    const cut = await pass(r)
    assert.ok(cut && cut.name === 'StepTimeout', 'the first pass should be cut short by the budget')
    r.walks.length = 0
    await pass(r)
    const again = r.walks.filter(w => w.at.x === -14 && w.at.z >= 2 && w.at.z <= 8)
    assert.equal(again.length, 0, `the second pass walked again to the unreachable torches at z ${again.map(w => w.at.z).join(', ')}`)
  } finally { r.dispose() }
})
