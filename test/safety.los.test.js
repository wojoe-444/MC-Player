const test = require('node:test')
const assert = require('node:assert')
const { lineOfSight, entityVisible, findVisibleSpot } = require('../brain/safety/reach')
const { rig, addMob, until, wait, Vec3 } = require('./safety.combat.helpers')

// floor of stone from -8..8 at y=63 so spots are standable
function floor(bot) { for (let x = -8; x <= 12; x++) for (let z = -8; z <= 8; z++) bot.setBlock(x, 63, z, 'stone') }
const wall = (bot, x, zs) => { for (const z of zs) { bot.setBlock(x, 64, z, 'stone'); bot.setBlock(x, 65, z, 'stone') } }
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const attacks = (bot) => bot.actions.filter(a => a[0] === 'attack').length

test('lineOfSight: through a wall is blocked, over it and around it is clear, diagonal corners are not squeezed', () => {
  const walls = new Set(['5,64,0', '5,65,0'])
  const solid = (x, y, z) => walls.has(`${x},${y},${z}`)
  assert.strictEqual(lineOfSight({ x: 0.5, y: 65.6, z: 0.5 }, { x: 9.5, y: 65.5, z: 0.5 }, solid), false)
  assert.strictEqual(lineOfSight({ x: 0.5, y: 65.6, z: 0.5 }, { x: 9.5, y: 65.5, z: 3.5 }, solid), true)
  assert.strictEqual(lineOfSight({ x: 0.5, y: 67.6, z: 0.5 }, { x: 9.5, y: 67.5, z: 0.5 }, solid), true)
  const diag = new Set(['1,64,0', '0,64,1'])
  assert.strictEqual(lineOfSight({ x: 0.5, y: 64.5, z: 0.5 }, { x: 1.5, y: 64.5, z: 1.5 }, (x, y, z) => diag.has(`${x},${y},${z}`)), false)
})

test('a mob directly behind a 1-block wall is not hit (melee)', async () => {
  const { bot, sched, rt } = rig({ pos: [0.5, 64, 0.5] })
  floor(bot); wall(bot, 2, range(-6, 6))                    // long wall: no way round
  addMob(bot, 7, 'zombie', 3.2, 0.5)                         // 2.7 blocks away, inside reach, other side of the wall
  assert.strictEqual(entityVisible(bot, bot.entities[7]), false)
  rt.scan(); await wait(900)
  for (let i = 0; i < 6; i++) { rt.scan(); await wait(100) }
  assert.strictEqual(attacks(bot), 0, 'no attack through the wall')
  assert.ok(!bot.actions.some(a => a[0] === 'activate'))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})

test('wall with a gap: repositions to a spot with a clear line, then hits', async () => {
  const { bot, sched, rt } = rig({ pos: [1.5, 64, 3.5] })
  floor(bot); wall(bot, 2, range(-6, -1).concat(range(2, 6)))   // gap at z 0..1
  addMob(bot, 7, 'zombie', 3.2, 3.5)                         // 1.7 blocks away, other side of the wall
  rt.scan(); await wait(300)
  assert.strictEqual(attacks(bot), 0)
  const spotGoal = bot.goalLog.find(g => g.g && g.g.constructor && g.g.constructor.name === 'GoalBlock')
  assert.ok(spotGoal, `expected a GoalBlock reposition, got ${bot.goalLog.map(g => g.g.constructor.name)}`)
  const g = spotGoal.g
  const spot = new Vec3(g.x, g.y, g.z)
  assert.ok(spot.distanceTo(new Vec3(3.2, 64, 3.5)) <= 3.2, 'spot is in reach of the mob')
  bot.entity.position = spot.offset(0.5, 0, 0.5)             // "walk" there
  assert.ok(entityVisible(bot, bot.entities[7]))
  for (let i = 0; i < 8; i++) { rt.scan(); await wait(100) }
  assert.ok(attacks(bot) > 0, 'hits once it can see the mob')
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})

test('diagonal corner: no melee through the gap between two diagonal blocks', async () => {
  const { bot, sched, rt } = rig({ pos: [0.5, 64, 0.5] })
  floor(bot)
  bot.setBlock(1, 64, 0, 'stone'); bot.setBlock(0, 64, 1, 'stone'); bot.setBlock(1, 65, 0, 'stone'); bot.setBlock(0, 65, 1, 'stone')
  addMob(bot, 7, 'zombie', 1.5, 1.5)
  assert.strictEqual(entityVisible(bot, bot.entities[7]), false)
  rt.scan(); await wait(300); for (let i = 0; i < 4; i++) { rt.scan(); await wait(100) }
  assert.strictEqual(attacks(bot), 0)
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})

test('open ground: still attacks (the check does not block normal fights)', async () => {
  const { bot, sched, rt } = rig({ pos: [0.5, 64, 0.5] })
  floor(bot); addMob(bot, 7, 'zombie', 2.5, 0.5)
  rt.scan(); await wait(300); for (let i = 0; i < 4; i++) { rt.scan(); await wait(100) }
  assert.ok(attacks(bot) > 0)
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})

test('findVisibleSpot: null when walled in, a standable spot when there is a way', () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5] })
  floor(bot); wall(bot, 2, range(-8, 8)); addMob(bot, 7, 'zombie', 3.5, 0.5)
  const z = bot.entities[7]
  const spot = findVisibleSpot(bot, z)
  assert.ok(spot, 'there is ground on the zombie\'s own side with a clear line')
  assert.ok(entityVisible({ ...bot, entity: { position: spot.offset(0.5, 0, 0.5) }, blockAt: bot.blockAt }, z))
})

test('bow: no draw and no shot when the creeper is behind a wall; a wall that appears mid-draw cancels the shot', async () => {
  const { bot, sched, rt } = rig({ items: ['stone_sword', 'bow', 'arrow'], pos: [0.5, 64, 0.5] })
  floor(bot); wall(bot, 5, range(-6, 6))
  addMob(bot, 9, 'creeper', 14.5, 0.5)
  for (let i = 0; i < 8; i++) { rt.scan(); await wait(80) }
  assert.ok(!bot.actions.some(a => a[0] === 'activateItem'), 'never draws without a clear line')
  // now remove the wall, draw, then put it back before release
  for (const z of range(-6, 6)) { bot.setBlock(5, 64, z, 'air'); bot.setBlock(5, 65, z, 'air') }
  let drew = false
  for (let i = 0; i < 20 && !drew; i++) { rt.scan(); await wait(60); drew = bot.actions.some(a => a[0] === 'activateItem') }
  assert.ok(drew, 'draws with a clear line')
  wall(bot, 5, range(-6, 6))
  for (let i = 0; i < 25; i++) { rt.scan(); await wait(60) }
  assert.ok(!bot.actions.some(a => a[0] === 'deactivateItem'), 'arrow never released into the wall')
  assert.strictEqual(bot.heldItem.name, 'stone_sword', 'draw cancelled by switching back to the sword')
  delete bot.entities[9]; await until(() => { rt.scan(); return !sched.running })
})
