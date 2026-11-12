// Work order step-shelter: a finished shelter is logged as a failure ('0 placed, 0 wall/roof blocks still missing, door open, torch in' and then
// 'shelter failed'). The step's run ends with `return placed > 0`, so a pass that had nothing left to place failed. The failure cools the step
// down for five minutes and the bot goes off to light-home and iron (the shelter>light-home and shelter>iron thrashes). The test drives the real
// shelter step (brain/autopilot/plan.js: its need() and run()) on a made-up stone world: a red bed at 0,64,0 inside a stone ring and roof, the
// doorways open, a torch inside, and nothing else missing. The only thing left is a door that cannot go in: a door in the bag that the doorway
// refuses, or six planks with no crafting table in reach to make the door from. Both keep the step due, so the stuck rule must still bound it.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const key = (x, y, z) => `${x},${y},${z}`

// opts.bag: what the bot carries; opts.hole: a wall cell that is missing. Stone up to y63, air above.
function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-shelter-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  // the planner picks both sides of the bed as doorways: east (2,64,0) and south (0,64,2), both open
  const DOORWAYS = [[2, 0], [0, 2]]
  const cells = new Map([[key(0, 64, 0), 'red_bed'], [key(-1, 65, -1), 'torch']])
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    cells.set(key(x, 66, z), 'stone')                                   // roof
    const onRing = Math.max(Math.abs(x), Math.abs(z)) === 2, doorway = DOORWAYS.some(([dx, dz]) => dx === x && dz === z)
    if (onRing && !doorway) { cells.set(key(x, 64, z), 'stone'); cells.set(key(x, 65, z), 'stone') }   // two-high walls
  }
  if (opts.hole) cells.set(key(...opts.hole), 'air')
  const name = (x, y, z) => cells.get(key(x, y, z)) || (y <= 63 ? 'stone' : 'air')
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: n === 'air' || n === 'torch' ? 'empty' : 'block', position: new Vec3(x, y, z) } }
  const bag = (opts.bag || []).map(i => ({ ...i }))
  const count = (w) => bag.filter(i => (w instanceof RegExp ? w.test(i.name) : i.name === w)).reduce((n, i) => n + i.count, 0)
  const tries = { door: 0, craft: 0 }
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(-5.5, 64, 2.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 2000 }
  bot.health = 20; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = { blocksArray: [{ name: 'torch', id: 50 }, { name: 'wall_torch', id: 51 }, { name: 'red_bed', id: 52 }], blocksByName: {}, blocksByStateId: {} }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = (p) => block(p.x, p.y, p.z)
  bot.findBlocks = () => [...cells].filter(([, n]) => /torch/.test(n)).map(([k]) => new Vec3(...k.split(',').map(Number)))
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const base = {
    bot, goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor (x, y, z) { Object.assign(this, { x, y, z }) } } },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => block(p.x, p.y, p.z), isAir: (b) => !!b && b.name === 'air', isLiquid: () => false, isWaterish: () => false,
    passable: (b) => !!b && b.boundingBox === 'empty', solid: (b) => !!b && b.boundingBox === 'block',
    dist: (p) => bot.entity.position.distanceTo(p), eye: () => bot.entity.position.offset(0, 1.6, 0),
    count, planks: () => count(/_planks$/), logs: () => count(/_log$/), items: () => bag,
    toolTier: () => 3, freeSlots: () => 20, isNight: () => false, skyVisible: () => true,
    check() {}, wait: async () => {}, say() {}, aborted: () => false, isAbort: () => false, stepDeadline: 0,
    resyncInventory: async () => {}, closeWindows() {}, reclaim: async () => {},
    craft: async () => { tries.craft++; return false },                 // no crafting table in reach: no door can be made
    placeAgainst: async (ref, face, item) => { if (item && /_door$/.test(item)) tries.door++; return false },   // the doorway refuses the door
    goto: async () => ({ ok: true }),
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')            // no shared registry here
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const step = G.steps.find(s => s.id === 'shelter')
  return {
    G, step, tries,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('a finished shelter with a door in the bag that will not go in is a success, not a failure', async () => {
  const r = rig({ bag: [{ name: 'oak_door', count: 1 }] })
  try {
    assert.equal(r.step.need(), true, 'the step is due: a door is carried and the doorways are open')
    const ok = await r.step.run()
    assert.ok(r.G.log.some(l => /0 placed, 0 wall\/roof blocks still missing, door open, torch in/.test(l)), 'the pass should end with the shelter finished: ' + r.G.log.slice(-2).join(' | '))
    assert.equal(ok, true, 'a finished shelter was logged as a failure: the step cools down and the bot goes to light-home and iron')
  } finally { r.dispose() }
})

test('six planks and no table: the shelter is still finished, and after three such passes the step is paused, not due again at once', async () => {
  const r = rig({ bag: [{ name: 'oak_planks', count: 6 }] })
  try {
    assert.equal(r.step.need(), true, 'the step is due: six planks could make a door')
    assert.equal(await r.step.run(), true, 'a finished shelter whose door cannot be made is a success')
    assert.equal(await r.step.run(), true, 'the second pass finds the same and is a success too')
    assert.equal(await r.step.run(), true, 'the third pass finds the same and is a success too')
    assert.ok(r.tries.craft >= 1, 'the pass should have tried to craft the door')
    assert.equal(r.step.need(), false, 'three passes found the same thing: the stuck rule must pause the step, or it is picked again every second')
  } finally { r.dispose() }
})

test('a shelter still missing a wall is not a success when nothing in the bag can put it back', async () => {
  const r = rig({ bag: [{ name: 'oak_door', count: 1 }], hole: [2, 64, 2] })
  try {
    assert.equal(r.step.need(), true, 'the step is due: a wall is missing')
    assert.equal(await r.step.run(), false, 'a wall block is still missing and nothing can be placed: the pass must still fail')
  } finally { r.dispose() }
})
