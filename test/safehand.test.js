const test = require('node:test')
const assert = require('node:assert')
const { mockBot } = require('./mock-bot')
const safehand = require('../brain/safehand')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

test('guard swaps lava out of the hand and stops pathing', async () => {
  const bot = mockBot(); bot.give('stone_sword'); bot.give('lava_bucket')
  const sh = safehand({ bot, pollMs: 20 }); sh.start()
  bot.pathfinder.setGoal({ x: 1 }); bot.setControlState('forward', true)
  await bot.equip('lava_bucket')
  await wait(60)
  assert.strictEqual(bot.heldItem.name, 'stone_sword')
  assert.strictEqual(bot.pathfinder._goal, null)
  assert.deepStrictEqual(bot.controlStates, {})
  sh.stop()
})

test('lavaMoment allows lava inside and always stows after, even on error', async () => {
  const bot = mockBot(); bot.give('iron_pickaxe'); bot.give('lava_bucket')
  const sh = safehand({ bot, pollMs: 10 }); sh.start()
  await assert.rejects(sh.lavaMoment(async () => {
    await bot.equip('lava_bucket'); await wait(50)
    assert.strictEqual(bot.heldItem.name, 'lava_bucket', 'guard must not fight an explicit lava moment')
    throw new Error('chest closed')
  }), /chest closed/)
  assert.strictEqual(bot.heldItem.name, 'iron_pickaxe')
  sh.stop()
})

test('falls back to empty hand when only buckets are carried', async () => {
  const bot = mockBot(); bot.give('lava_bucket'); bot.give('bucket', 3)
  const sh = safehand({ bot })
  await bot.equip('lava_bucket')
  await sh.ensureSafeForMove()
  assert.ok(!bot.heldItem)
})

test('ensureSafeForMove refuses if lava cannot be stowed', async () => {
  const bot = mockBot(); bot.give('lava_bucket')
  const sh = safehand({ bot })
  await bot.equip('lava_bucket')
  bot.unequip = async () => {}          // simulate a failed unequip
  await assert.rejects(sh.ensureSafeForMove(), /refusing to move/)
})
