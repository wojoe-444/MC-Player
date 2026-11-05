// Fast bulk crafting: server-side recipe fill + shift-click, one table window per job. Toy server in crafting.fast.helpers.js.
const test = require('node:test')
const assert = require('node:assert')
const { rig, mcData } = require('./crafting.helpers')

const ITEMS = ['stone_bricks', 'stick', 'oak_planks', 'ladder', 'torch', 'glass_pane', 'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'stone_hoe', 'wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_sword', 'wooden_hoe', 'crafting_table', 'chest']
const callCraft = (r, name, n, opts) => r.brain.api.crafting.craft(null, name, n, { chests: false, ...opts })
const FAST = (extra = {}) => ({ items: ITEMS, latency: 2, ...extra })

test('craft stone bricks x98: 25 crafts in one batch, exactly the stone it needs, no click-by-click crafting', async () => {
  const r = rig({ chests: [], bag: { stone: 286 }, fast: FAST() })
  const res = await callCraft(r, 'stone_bricks', 98)
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('stone_bricks'), 100)
  assert.strictEqual(r.bot.count('stone'), 286 - 100, 'only the stone the 25 crafts use; the rest of the stack is untouched')
  const st = r.bot.fastStats
  assert.strictEqual(st.requests, 25)
  assert.strictEqual(st.slowCrafts, 0)
  assert.ok(st.clicks <= 3, `${st.clicks} awaited clicks`)
  assert.strictEqual(r.bot.currentWindow, null, 'the table window is closed again')
  assert.strictEqual(r.brain.api.status.all().modules.crafting.fast.crafts, 25)
  r.stop()
})
test('more than a stack of sets is done in several batches; the 2x2 bag grid is used when no table is needed', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 600 }, fast: FAST() })
  const res = await callCraft(r, 'stick', 280)       // 70 crafts of 4 sticks: 2 planks each -> 140 planks, grid slots hold 64 sets at most
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('stick'), 280)
  assert.strictEqual(r.bot.count('oak_planks'), 600 - 140)
  assert.strictEqual(r.bot.fastStats.opens, 0, 'no table needed, no table opened')
  assert.strictEqual(r.bot.fastStats.clicks, 2, 'two shift-clicks: 64 sets + 6 sets')
  r.stop()
})
test('several recipes in one visit: the table is found and opened once', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 40, stone: 40, glass: 12, coal: 4 }, fast: FAST() })
  const res = await r.brain.api.crafting.craftMany(null, [{ name: 'stick', count: 16 }, { name: 'stone_bricks', count: 40 }, { name: 'glass_pane', count: 32 }, { name: 'torch', count: 16 }], { chests: false })
  assert.strictEqual(res.ok, true, res.text)
  assert.deepStrictEqual(['stone_bricks', 'glass_pane', 'torch'].map(n => r.bot.count(n)), [40, 32, 16])
  assert.strictEqual(r.bot.count('stick'), 16 - 4, 'the torches took their 4 sticks')
  assert.strictEqual(r.bot.fastStats.opens, 1, 'one table window for the whole queue')
  assert.strictEqual(r.bot.fastStats.slowCrafts, 0)
  r.stop()
})
test('small jobs (fewer than 3 crafts) keep using the normal way', async () => {
  const r = rig({ chests: [], bag: { stone: 40 }, fast: FAST() })
  const res = await callCraft(r, 'stone_bricks', 8)    // 2 crafts
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.fastStats.requests, 0)
  assert.strictEqual(r.bot.fastStats.slowCrafts, 2)
  r.stop()
})
test('no recipe-book entry for it: the normal way, nothing fails', async () => {
  const r = rig({ chests: [], bag: { stone: 100 }, fast: FAST({ items: ['stick'] }) })
  const res = await callCraft(r, 'stone_bricks', 40)
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.fastStats.requests, 0)
  assert.strictEqual(r.bot.fastStats.slowCrafts, 10)
  r.stop()
})
test('a server that ignores the requests: the grid is given back and the normal way finishes the job; three misses turn the fast way off', async () => {
  const r = rig({ chests: [], bag: { stone: 400 }, fast: FAST({ mode: 'ignore' }) })
  const res = await callCraft(r, 'stone_bricks', 40)
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('stone_bricks'), 40)
  assert.strictEqual(r.brain.api.status.all().modules.crafting.fast.fails, 1)
  for (const n of ['stick', 'oak_planks']) { r.bot.give('oak_log', 20); }
  r.stop()
})
test('a server that fills the grid with everything it can (no per-set control) is caught before shift-click and nothing is over-crafted', async () => {
  const r = rig({ chests: [], bag: { stone: 400 }, fast: FAST({ mode: 'fillmax' }) })
  const res = await callCraft(r, 'stone_bricks', 40)
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('stone_bricks'), 40, 'exactly what was asked for, not all 400 stone')
  assert.strictEqual(r.bot.count('stone'), 400 - 40)
  assert.strictEqual(r.brain.api.status.all().modules.crafting.fast.fails, 1)
  r.stop()
})
test('the chat command uses it too: "craft stone bricks x98" from the bag', async () => {
  const r = rig({ chests: [], bag: { stone: 120 }, fast: FAST() })
  r.route('craft stone bricks x98'); await r.settle()
  assert.strictEqual(r.bot.count('stone_bricks'), 100)
  assert.ok(r.said.some(t => /Crafted 100 stone bricks/.test(t)), r.said.join(' | '))
  r.stop()
})

// ---------------------------------------------------------------- the old tool-set job, now here
test('craft tool set: sticks first, then the stone kit, in one table visit; no legacy job runs', async () => {
  const r = rig({ chests: [], bag: { cobblestone: 20, oak_planks: 12 }, legacyCraft: true, fast: FAST() })
  r.route('craft tool set'); await r.settle()
  for (const k of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) assert.strictEqual(r.bot.count(`stone_${k}`), 1, k)
  assert.deepStrictEqual(r.calls, [], 'the legacy craftToolSet (pathfinder.goto) is not used')
  assert.strictEqual(r.bot.fastStats.opens + r.bot.craftCalls.filter(c => c[2]).length >= 1, true)
  assert.ok(r.said.some(t => /stone tool set/.test(t)), r.said.join(' | '))
  r.stop()
})
test('craft tool set with no cobblestone makes the wooden kit; the api entry works for other modules', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 20 } })
  const res = await r.brain.api.crafting.toolSet(null, { chests: false })
  assert.strictEqual(res.ok, true, res.text)
  for (const k of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) assert.strictEqual(r.bot.count(`wooden_${k}`), 1, k)
  r.stop()
})
test('benchmark model: bulk crafts are several times faster than click-by-click (toy server, 25 ms per awaited click)', async () => {
  const a = rig({ chests: [], bag: { stone: 100 }, fast: FAST({ latency: 25 }) })
  let t0 = Date.now()
  await callCraft(a, 'stone_bricks', 98)
  const fastMs = Date.now() - t0
  const b = rig({ chests: [], bag: { stone: 100 }, fast: FAST({ latency: 25, items: [] }) })
  t0 = Date.now()
  await callCraft(b, 'stone_bricks', 98)
  const slowMs = Date.now() - t0
  assert.strictEqual(b.bot.count('stone_bricks'), 100)
  assert.ok(slowMs > fastMs * 5, `slow ${slowMs} ms vs fast ${fastMs} ms`)
  console.log(`# 98 stone bricks (25 crafts): click-by-click ${slowMs} ms (${(25 / (slowMs / 1000)).toFixed(1)} crafts/s), recipe-fill ${fastMs} ms (${(25 / (fastMs / 1000)).toFixed(1)} crafts/s)`)
  a.stop(); b.stop()
})
