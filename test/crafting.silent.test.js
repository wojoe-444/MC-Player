// Crafts the server silently ignores (live failure: "the stick did not show up in my bag" for torches and ladders).
const test = require('node:test')
const assert = require('node:assert')
const { rig, mcData } = require('./crafting.helpers')

const callCraft = (r, name, n, opts) => r.brain.api.crafting.craft(null, name, n, opts)
const isStick = (recipe) => mcData.items[recipe.result.id].name === 'stick'

test('a multi-craft that the server ignores is retried one craft at a time', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 14, coal: 6, stick: 1 } })
  r.bot.craftFail = (recipe, count) => isStick(recipe) && count > 1
  const res = await callCraft(r, 'torch', 24, { chests: false })
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('torch'), 24)
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'craft-ignored').length, 1, 'one ignored batch, then singles')
  assert.ok(r.bot.craftCalls.filter(c => c[0] === 'stick').every(c => c[1] === 1))
  r.stop()
})
test('a grid the server ignores is swapped for the other one when the recipe fits both', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 8, cobblestone: 3 } })
  r.bot.craftFail = (recipe, count, table) => isStick(recipe) && !!table
  const res = await callCraft(r, 'stone_pickaxe', 1, { chests: false })
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('stone_pickaxe'), 1)
  assert.ok(r.bot.craftCalls.some(c => c[0] === 'stick' && c[2] === false), 'sticks came out of the bag grid')
  const r2 = rig({ chests: [], bag: { oak_planks: 8, coal: 1 }, table: [5, 64, 5], pos: [5, 64, 3] })
  r2.bot.craftFail = (recipe, count, table) => isStick(recipe) && !table
  const res2 = await callCraft(r2, 'torch', 4, { chests: false })
  assert.strictEqual(res2.ok, true, res2.text)
  assert.ok(r2.bot.craftCalls.some(c => c[0] === 'stick' && c[2] === true), 'bag grid ignored, the table worked')
  r.stop(); r2.stop()
})
test('when every way is ignored the failure says so, logs the window state, and loses nothing', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 4, coal: 1 } })
  r.bot.craftFail = (recipe) => isStick(recipe)
  const logs = []
  const orig = r.brain.api.log
  r.brain.api.log = (t, m) => { logs.push(`${t} ${m}`); return orig(t, m) }
  const res = await callCraft(r, 'torch', 4, { chests: false })
  assert.strictEqual(res.ok, false)
  assert.match(res.text, /the stick did not show up in my bag \(tried \d ways, details in idle.log\)/)
  assert.ok(logs.some(l => /DIAG/.test(l)), 'a diagnostic line with the window state is logged')
  assert.strictEqual(r.bot.count('oak_planks'), 4)
  r.stop()
})
test('a product that arrives late (within 3 s) still counts', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 2 } })
  const real = r.bot.craft
  r.bot.craft = async (rec, n, t) => { if (isStick(rec)) { setTimeout(() => r.bot.give('stick', 4), 1700); return } return real(rec, n, t) }
  const res = await callCraft(r, 'stick', 4, { chests: false })
  assert.strictEqual(res.ok, true, res.text)
  r.stop()
})
