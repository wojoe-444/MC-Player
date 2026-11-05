const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const los = require('../brain/los')
const safehand = require('../brain/safehand')
const furnaceMod = require('../brain/furnace')
const config = require('../brain/furnace-config.json')

// a corridor floor at y=63 from x=0..10, bot standing at (1,64,0), chest at (6,64,0)
function corridor() {
  const bot = mockBot({ pos: [1, 64, 0] })
  for (let x = -2; x <= 12; x++) for (let z = -3; z <= 3; z++) bot.setBlock(x, 63, z, 'stone')
  return bot
}

test('clear ray: a chest down the corridor is visible, a stone wall in front hides it, a glass-free gap lets it through', () => {
  const bot = corridor()
  bot.addChest(6, 64, 0, 27, {})
  assert.strictEqual(los.canSee(bot, bot.blockAt(new Vec3(6, 64, 0))), true)
  bot.setBlock(3, 64, 0, 'stone'); bot.setBlock(3, 65, 0, 'stone')
  assert.strictEqual(los.canSee(bot, bot.blockAt(new Vec3(6, 64, 0))), false, 'wall between the eye and the chest')
})

test('a mob behind a 1-block wall is not visible; in the open it is (acceptance test)', () => {
  const bot = corridor()
  const mob = { id: 5, name: 'zombie', type: 'hostile', position: new Vec3(5.5, 64, 0.5), height: 1.95 }
  assert.strictEqual(los.canSee(bot, mob), true)
  bot.setBlock(3, 64, 0, 'stone'); bot.setBlock(3, 65, 0, 'stone')
  assert.strictEqual(los.canSee(bot, mob), false)
  // taller wall not needed: a single block at head height is enough to hide the head, feet are still seen only if not blocked
  bot.setBlock(3, 66, 0, 'stone')
  assert.strictEqual(los.canSee(bot, mob), false)
})

test('ensureLineOfSight walks to a viewpoint when the first spot is blocked', async () => {
  const bot = corridor()
  bot.addChest(6, 64, 0, 27, {})
  for (const z of [-1, 0, 1]) { bot.setBlock(3, 64, z, 'stone'); bot.setBlock(3, 65, z, 'stone') }   // wall across the corridor
  // the chest is also open from the other side of the wall
  const ok = await los.ensureLineOfSight({ bot, goals: bot.goals, tryGoto: bot.tryGoto, target: bot.blockAt(new Vec3(6, 64, 0)) })
  assert.strictEqual(ok, true)
  assert.ok(los.canSee(bot, bot.blockAt(new Vec3(6, 64, 0))), 'can see the chest after repositioning')
  assert.ok(bot.entity.position.x !== 1.5 || bot.entity.position.z !== 0.5, 'actually moved')
})

test('furnace work refuses a chest it cannot get a clear view of (no open, no take)', async () => {
  const bot = mockBot({ pos: [-1045, 128, 2276] })
  bot.give('stone_sword')
  for (const u of config.stations.flatMap(s => s.units)) bot.setBlock(...u.furnace, 'furnace')
  const chests = [[-1043, 131, 2274, { lava_bucket: 1 }], [-1043, 132, 2273, {}], [-1043, 128, 2273, { bucket: 4 }], [-1051, 154, 2323, {}], [-1051, 155, 2324, {}], [-1051, 151, 2324, {}], [-1051, 154, 2326, {}], [-1051, 155, 2325, {}], [-1051, 151, 2325, { bucket: 2 }]]
  for (const [x, y, z, items] of chests) bot.addChest(x, y, z, 27, items)
  // seal the station 1 fuel chest inside solid stone on every side
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const p = [-1043 + dx, 131 + dy, 2274 + dz]; if (!bot.blockAt(new Vec3(...p)).name.includes('chest')) bot.setBlock(...p, 'stone') }
  const sh = safehand({ bot })
  const ensure = (o) => los.ensureLineOfSight({ bot, goals: bot.goals, tryGoto: bot.tryGoto, ...o })
  const f = furnaceMod({ bot, say: () => {}, goals: bot.goals, tryGoto: bot.tryGoto, safehand: sh, config, stateFile: null, ensureLos: ensure })
  await f.plan(null)
  const s1 = f.snapshot().units.find(u => u.name === 'S1')
  assert.ok(s1.errors.some(e => /line of sight/.test(e)), JSON.stringify(s1.errors))
  assert.ok(!bot.actions.some(a => a[0] === 'open' && a[1] === '-1043,131,2274'), 'must not open a chest it cannot see')
})
