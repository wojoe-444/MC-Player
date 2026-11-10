// brain/motor/hands.js: two call sites swapping the held item against each other within 2 s are recorded as a pair; one site, slow hand-overs and no-change calls are not.
const test = require('node:test')
const assert = require('node:assert')
const { install } = require('../brain/motor/hands')

function rig() {
  let t = 1000
  const bot = { heldItem: { name: 'dirt' }, equip(item) { bot.heldItem = { name: item }; return Promise.resolve() }, unequip() { bot.heldItem = null; return Promise.resolve() }, setQuickBarSlot() {} }
  const hands = install(bot, { logFile: null, now: () => t, log: () => {} })
  return { bot, hands, adv: (ms) => { t += ms } }
}
const sorter = (b, n) => b.equip(n)
const eater = (b, n) => b.equip(n)

test('a different site changing the hand within 2 s is a swap pair; the call still goes through and returns its promise', async () => {
  const r = rig()
  await sorter(r.bot, 'iron_sword'); r.adv(500); await eater(r.bot, 'bread'); r.adv(500); await sorter(r.bot, 'dirt')
  assert.strictEqual(r.bot.heldItem.name, 'dirt')
  const s = Object.values(r.hands.swaps())
  assert.strictEqual(s.length, 1); assert.strictEqual(s[0].count, 2)
  assert.ok(s[0].a.startsWith('test/hands.test.js:') && s[0].b.startsWith('test/hands.test.js:') && s[0].a !== s[0].b)
  assert.ok(s[0].items['iron_sword -> bread'] === 1 || s[0].items['bread -> dirt'] === 1, JSON.stringify(s[0].items))
  assert.strictEqual(r.hands.calls(), 3)
})

test('one site alone, slow hand-overs, and calls that change nothing are not swaps', async () => {
  const r = rig()
  await sorter(r.bot, 'a'); r.adv(100); await sorter(r.bot, 'b'); r.adv(100); await sorter(r.bot, 'c')
  r.adv(5000); await eater(r.bot, 'bread'); r.adv(5000); await sorter(r.bot, 'x'); r.adv(10); await eater(r.bot, 'x')       // x -> x: nothing changed
  assert.deepStrictEqual(r.hands.swaps(), {})
})

test('uninstall restores the originals; a rejected equip still rejects', async () => {
  const r = rig(); const w = r.bot.equip
  r.bot.heldItem = { name: 'dirt' }
  r.hands.uninstall(); assert.notStrictEqual(r.bot.equip, w)
  const bad = { heldItem: null, equip: () => Promise.reject(new Error('nope')) }
  install(bad, { logFile: null })
  await assert.rejects(bad.equip('x'), /nope/)
})
