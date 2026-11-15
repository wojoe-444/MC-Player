// Work order flag-torch-spacing: torches went down two blocks from another torch on the same line, which torch-air-air-torch forbids.
// Two places let that through:
//  (1) S.torchCrowded (brain/autopilot/skills.js), the check S.placeAgainst makes before every torch (light-home, shelter, mining hallways,
//      storage, light-up), reads only the first `count` matches that findBlocks returns. findBlocks gives matches in its own search order, not
//      nearest first (test/mock-bot.js works the same way), so a torch two blocks away can be left out when twelve others come first.
//  (2) The tree farm's light step (brain/treefarm/farm.js, light) skips a lattice cell only when a torch is adjacent (torchNear radius 1), so it
//      puts a torch two blocks from one already standing.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const makeSkills = require('../brain/autopilot/skills')
const { rig, blockName, fakeCtx } = require('./treefarm.helpers')
const L = require('../brain/treefarm/layout')
const ctx = () => fakeCtx()

// a fake bot whose only blocks are torches at `cells` ([x, y, z] each); findBlocks returns the first `count` torches within maxDistance in the
// order they were given, the way the mock does
function torchBot(cells) {
  const bot = new EventEmitter()
  bot.version = '1.21.6'; bot.entity = { position: new Vec3(0, 64, 0) }; bot.inventory = { items: () => [], slots: [] }
  bot.pathfinder = { setMovements() {}, setGoal() {} }; bot.clickWindow = async () => {}; bot.equip = async () => {}; bot.unequip = async () => {}
  bot.registry = require('minecraft-data')('1.21.6')
  const order = cells.map(([x, y, z]) => new Vec3(x, y, z))
  const has = new Set(order.map(p => `${p.x},${p.y},${p.z}`))
  bot.blockAt = (p) => { const name = has.has(`${p.x},${p.y},${p.z}`) ? 'torch' : 'air'; return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: new Vec3(p.x, p.y, p.z) } }
  bot.findBlocks = ({ matching, point, maxDistance = 16, count = 1 }) => order.filter(p => p.distanceTo(point) <= maxDistance && matching({ name: 'torch' })).slice(0, count)
  return bot
}

test('S.torchCrowded: a torch two blocks away on the same line is crowded, even when twelve other torches come first in the search', () => {
  // twelve torches at least three blocks from the spot (none crowds it), then one two blocks away, last in the order
  const twelve = [[3, 64, 0], [-3, 64, 0], [0, 64, 3], [0, 64, -3], [3, 65, 0], [3, 63, 0], [-3, 65, 0], [-3, 63, 0], [0, 67, 0], [0, 61, 0], [0, 65, -3], [0, 63, -3]]
  const bot = torchBot([...twelve, [2, 64, 0]])
  const S = makeSkills({ bot, api: { statePath: (f) => '/tmp/' + f, log() {}, say() {} }, log() {} })
  clearInterval(bot._resyncTimer); clearInterval(bot._hotbarTimer)
  assert.equal(S.torchCrowded(new Vec3(0, 64, 0)), true, 'the torch at 2,64,0 two blocks away was not seen: the spot looked free')
})

test('S.torchCrowded: a torch three blocks away on the line is not crowded (the torch-air-air-torch gap is allowed)', () => {
  const bot = torchBot([[3, 64, 0]])
  const S = makeSkills({ bot, api: { statePath: (f) => '/tmp/' + f, log() {}, say() {} }, log() {} })
  clearInterval(bot._resyncTimer); clearInterval(bot._hotbarTimer)
  assert.equal(S.torchCrowded(new Vec3(0, 64, 0)), false)
})

test('tree farm light: a lattice torch is not put two blocks from a torch already standing, and that cell stays unlit', async () => {
  const r = rig({ inv: { torch: 64, dirt: 20, iron_axe: 1, birch_sapling: 6 } })
  const { bot, engine, state } = r
  try {
    const out0 = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
    assert.ok(out0.ok, JSON.stringify(out0))
    const f = state.farms[0]
    const t = L.torchCells(f).find(c => c.i === -1 && c.j === -1)          // the corner torch of the ring
    bot.setBlock(t.x, 64, t.z, 'air')                                       // that torch is missing
    bot.setBlock(t.x - 2, 64, t.z, 'torch')                                 // another torch two blocks off it on the same line
    const out = await engine.farm.light(ctx(), f)
    assert.equal(blockName(bot, t.x, 64, t.z), 'air', `a torch went down at ${t.x},64,${t.z}, two blocks from another (placed ${out.placed})`)
  } finally { r.stop() }
})
