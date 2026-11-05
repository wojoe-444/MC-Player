const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { dropExposure } = require('../brain/safety/shelter')
const { makeEntomb } = require('../brain/safety/entomb')
const { rig, addMob, until, wait } = require('./safety.combat.helpers')

// 1-wide bridge along z at x=0, y=63, over nothing (a cave)
function bridge(bot) { for (let z = -10; z <= 10; z++) bot.setBlock(0, 63, z, 'cobblestone') }
function blockOps(bot) {
  bot.placed = []; bot.dug = []
  bot.placeBlock = async (ref, face) => {
    const t = ref.position.plus(face), held = bot.heldItem
    if (!held || !/cobblestone/.test(held.name)) throw new Error('not holding a block')
    if (bot.blockAt(t).name !== 'air') throw new Error('target not empty')
    bot.setBlock(t.x, t.y, t.z, held.name); bot.take(held.name, 1); bot.placed.push(t)
  }
  bot.dig = async (b) => { bot.setBlock(b.position.x, b.position.y, b.position.z, 'air'); bot.dug.push(b.position) }
}

test('dropExposure: flat ground is fine, a 1-wide bridge is narrow, a wall beside the path is not a drop, a cliff corner is not narrow', () => {
  const flat = rig({ pos: [0.5, 64, 0.5] })
  assert.strictEqual(dropExposure(flat.bot).narrow, false)
  const b = rig({ pos: [0.5, 64, 0.5], floor: false }); bridge(b.bot)
  const e = dropExposure(b.bot); assert.strictEqual(e.narrow, true); assert.ok(e.drops >= 6)
  for (let z = -3; z <= 3; z++) { b.bot.setBlock(1, 64, z, 'stone'); b.bot.setBlock(1, 65, z, 'stone'); b.bot.setBlock(-1, 64, z, 'stone'); b.bot.setBlock(-1, 65, z, 'stone') }
  assert.strictEqual(dropExposure(b.bot).narrow, false, 'walls on both sides = a tunnel, not a bridge')
  const c = rig({ pos: [0.5, 64, 0.5], floor: false })
  for (let x = -10; x <= 0; x++) for (let z = -10; z <= 10; z++) c.bot.setBlock(x, 63, z, 'stone')       // floor on the -x half only
  assert.strictEqual(dropExposure(c.bot).narrow, false, 'edge of a ledge')
  assert.strictEqual(dropExposure(c.bot, new Vec3(0.5, 64, 0.5)).drops, 3)
})

test('on a bridge with a creeper coming and wall-in OFF: stands still, never sets a flee goal, says why', async () => {
  const { bot, sched, said, rt } = rig({ pos: [0.5, 64, 0.5], floor: false, mode: 'warn' }); bridge(bot)
  addMob(bot, 7, 'creeper', 0.5, 6.5)
  for (let i = 0; i < 10; i++) { rt.scan(); await wait(60) }
  assert.strictEqual(bot.goalLog.length, 0, `goals: ${bot.goalLog.map(g => g.kind)}`)
  assert.ok(said.some(t => /Narrow ground/.test(t)))
  assert.ok(!bot.actions.some(a => a[0] === 'attack'))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 3000)
})

test('on a bridge in fight mode: a zombie that reaches us is hit, but the bot never chases it along the bridge', async () => {
  const { bot, sched, rt } = rig({ pos: [0.5, 64, 0.5], floor: false }); bridge(bot)
  addMob(bot, 7, 'zombie', 0.5, 4.5)
  for (let i = 0; i < 6; i++) { rt.scan(); await wait(60) }
  assert.strictEqual(bot.goalLog.length, 0, 'no follow goal on narrow ground'); assert.ok(!bot.actions.some(a => a[0] === 'attack'), 'out of reach: no attack yet')
  bot.entities[7].position = new Vec3(0.5, 64, 2.2)                  // it came to us
  for (let i = 0; i < 8; i++) { rt.scan(); await wait(80) }
  assert.ok(bot.actions.some(a => a[0] === 'attack'))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 3000)
})

test('on a bridge with wall-in ON: seals both ends of the bridge (the voids beside it need nothing), not a step taken', async () => {
  const { bot, sched, said, rt } = rig({ pos: [0.5, 64, 0.5], floor: false, items: ['stone_sword', 'bread'] }); bridge(bot); blockOps(bot); bot.give('cobblestone', 30)
  rt.setEmergencyEntomb(true)
  addMob(bot, 7, 'creeper', 0.5, 5.5)                              // inside the 7 block flee range
  for (let i = 0; i < 14; i++) { rt.scan(); await wait(80) }
  assert.ok(bot.placed.length >= 4, `placed ${bot.placed.length}`)
  assert.strictEqual(bot.goalLog.length, 0, 'never set a movement goal')
  for (const [x, y, z] of [[0, 64, 1], [0, 64, -1], [0, 65, 1], [0, 65, -1]]) assert.strictEqual(bot.blockAt(new Vec3(x, y, z)).name, 'cobblestone', `${x},${y},${z}`)
  assert.ok(said.some(t => /Sealed in/.test(t)))
  assert.strictEqual(bot.entity.position.x, 0.5)
  delete bot.entities[7]; bot.health = 20; await until(() => { rt.scan(); return bot.dug.length >= 2 }, 9000)
  assert.ok(bot.dug.length >= 2)
  await until(() => { rt.scan(); return !sched.running }, 4000)
})

test('seal() on a bridge: the two ends are sealed, nothing is wasted on the void beside it', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], floor: false, items: ['stone_sword'] }); bridge(bot); blockOps(bot); bot.give('cobblestone', 30)
  const r = await makeEntomb({ bot, sleep: () => Promise.resolve() }).seal()
  assert.ok(r.ok, JSON.stringify(r))
  assert.ok(bot.placed.every(p => p.x === 0), `placed beside the bridge: ${bot.placed.map(p => p.x + ',' + p.y + ',' + p.z)}`)
  assert.strictEqual(bot.placed.length, 4)
})

test('while the safety task runs no step may drop more than 3 blocks; the shared Movements value is restored afterwards', async () => {
  const { bot, sched, rt } = rig({ pos: [0.5, 64, 0.5], mode: 'warn' })
  bot.pathfinder.movements = { maxDropDown: 9 }
  addMob(bot, 7, 'zombie', 4.5, 0.5)
  rt.scan(); await wait(150)
  assert.ok(sched.running && sched.running.name === 'safety')
  assert.ok(bot.pathfinder.movements.maxDropDown <= 4, `maxDropDown ${bot.pathfinder.movements.maxDropDown}`)
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 3000)
  assert.strictEqual(bot.pathfinder.movements.maxDropDown, 9)
  bot.pathfinder.movements = { maxDropDown: 3 }
  addMob(bot, 8, 'zombie', 4.5, 0.5); rt.scan(); await wait(150)
  assert.strictEqual(bot.pathfinder.movements.maxDropDown, 3, 'a stricter value is left alone')
  delete bot.entities[8]; await until(() => { rt.scan(); return !sched.running }, 3000)
})
