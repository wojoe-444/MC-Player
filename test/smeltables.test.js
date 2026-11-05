const test = require('node:test')
const assert = require('node:assert')
const { mockBot } = require('./mock-bot')
const safehand = require('../brain/safehand')
const furnaceMod = require('../brain/furnace')
const smelt = require('../brain/smeltables')
const config = require('../brain/furnace-config.json')

const inv = (o) => Object.entries(o).map(([name, count]) => ({ name, count }))
const asObj = (list) => Object.fromEntries(list.map(t => [t.name, t.count]))

test('rules: ores, raw metals, sand, clay, netherrack, kelp deposit fully; coal and tools stay', () => {
  const r = asObj(smelt.plan(inv({ raw_iron: 30, raw_gold: 5, raw_copper: 12, ancient_debris: 2, sand: 64, red_sand: 3, clay_ball: 20, netherrack: 64, kelp: 9, cactus: 4, wet_sponge: 1, coal: 40, iron_pickaxe: 1, deepslate_iron_ore: 3, nether_gold_ore: 6, cobbled_deepslate: 80 }), { reserved: {} }))
  assert.deepStrictEqual(r, { raw_iron: 30, raw_gold: 5, raw_copper: 12, ancient_debris: 2, sand: 64, red_sand: 3, clay_ball: 20, netherrack: 64, kelp: 9, cactus: 4, wet_sponge: 1, deepslate_iron_ore: 3, nether_gold_ore: 6, cobbled_deepslate: 80 })
})

test('cobblestone keeps the 48 reserve; stone deposits fully', () => {
  assert.deepStrictEqual(asObj(smelt.plan(inv({ cobblestone: 200, stone: 30 }), { reserved: {} })), { cobblestone: 152, stone: 30 })
  assert.deepStrictEqual(smelt.plan(inv({ cobblestone: 40 }), { reserved: {} }), [])
})

test('raw food: the 64 food stack counts cooked food first; potatoes keep 16 as seed', () => {
  assert.deepStrictEqual(asObj(smelt.plan(inv({ cooked_beef: 64, beef: 20, porkchop: 7, potato: 40 }), { reserved: {} })), { beef: 20, porkchop: 7, potato: 24 })
  assert.deepStrictEqual(asObj(smelt.plan(inv({ cooked_beef: 30, beef: 20, porkchop: 40 }), { reserved: {} })), { porkchop: 26 })   // 34 of food room: 20 beef kept, 14 pork kept
})

test('logs: keep 32 for tools, surplus goes in', () => {
  const r = smelt.plan(inv({ oak_log: 50, birch_log: 20 }), { reserved: {} })
  assert.strictEqual(r.reduce((s, t) => s + t.count, 0), 70 - 32)
})

function world({ inputs = 27, full = false } = {}) {
  const bot = mockBot({ pos: [-1045, 128, 2276] })
  bot.give('stone_sword')
  for (const u of config.stations.flatMap(s => s.units)) bot.setBlock(...u.furnace, 'furnace')
  const ch = [[-1043, 131, 2274, 27, {}], [-1043, 132, 2273, inputs, {}], [-1043, 128, 2273, 54, {}], [-1051, 154, 2323, 27, {}], [-1051, 155, 2324, inputs, {}], [-1051, 151, 2324, 54, {}], [-1051, 154, 2326, 27, {}], [-1051, 155, 2325, inputs, {}], [-1051, 151, 2325, 54, {}]]
  for (const [x, y, z, size, items] of ch) bot.addChest(x, y, z, size, items)
  if (full) for (const k of [[-1043, 132, 2273], [-1051, 155, 2324], [-1051, 155, 2325]]) { const c = bot.addChest(...k, 27, {}); c.slots.fill({ name: 'glass', count: 64 }) }
  bot.world.raycast = () => null
  const said = []
  const f = furnaceMod({ bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: safehand({ bot }), config, stateFile: null })
  return { bot, f, said }
}

test('trigger: nothing happens while more than 6 slots are free, unless forced', async () => {
  const { bot, f } = world(); bot.give('raw_iron', 10)
  const r = await f.depositSmeltables(null, {})
  assert.strictEqual(r.skipped, true)
  assert.strictEqual(bot.count('raw_iron'), 10)
  const r2 = await f.depositSmeltables(null, { force: true })
  assert.strictEqual(bot.count('raw_iron'), 0)
  assert.strictEqual(r2.moved.raw_iron, 10)
})

test('with <= 6 free slots everything smeltable goes in, in one trip, and coal stays', async () => {
  const { bot, f, said } = world()
  for (let i = 0; i < 29; i++) bot.give(['sand', 'netherrack', 'clay_ball', 'kelp', 'raw_copper', 'raw_gold'][i % 6], 64)   // fill slots (stack sizes: mock gives stacks)
  bot.give('coal', 30)
  const free = bot.inventory.emptySlotCount()
  assert.ok(free <= 6, `free ${free}`)
  const r = await f.depositSmeltables(null, {})
  assert.strictEqual(r.full, false)
  assert.strictEqual(bot.count('coal'), 30)
  assert.strictEqual(bot.count('sand') + bot.count('netherrack') + bot.count('raw_gold'), 0)
  assert.ok(bot.inventory.emptySlotCount() > free)
  assert.ok(said.some(t => /furnace input chests/.test(t)))
})

test('all input chests full: nothing is thrown away, the caller is told to pause, and Walter is told once', async () => {
  const { bot, f, said } = world({ full: true }); bot.give('raw_iron', 64)
  const toss = []; bot.tossStack = async (i) => toss.push(i.name)
  const r1 = await f.depositSmeltables(null, { force: true })
  const r2 = await f.depositSmeltables(null, { force: true })
  assert.strictEqual(r1.full, true); assert.strictEqual(r2.full, true)
  assert.strictEqual(bot.count('raw_iron'), 64)
  assert.deepStrictEqual(toss, [])
  assert.strictEqual(said.filter(t => /full or out of reach/.test(t)).length, 1)
})

test('no clear line of sight to an input chest: nothing is opened', async () => {
  const { bot, f } = world(); bot.give('raw_iron', 5)
  const los = require('../brain/los')
  const f2 = furnaceMod({ bot, say: () => {}, goals: bot.goals, tryGoto: async () => ({ ok: false, err: 'x' }), safehand: safehand({ bot }), config, stateFile: null, ensureLos: async () => false })
  const r = await f2.depositSmeltables(null, { force: true })
  assert.strictEqual(bot.count('raw_iron'), 5)
  assert.ok(!bot.actions.some(a => a[0] === 'open'))
})

test('worn/carried armor, tools, ingots, torches and coal are never deposited', () => {
  const r = smelt.plan(inv({ iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, iron_sword: 1, shield: 1, iron_ingot: 25, gold_ingot: 3, torch: 40, coal: 30, charcoal: 5, diamond: 2, bread: 12 }), { reserved: {} })
  assert.deepStrictEqual(r, [])
})

test('reserved.json amounts (the driver\'s builds) are never treated as spare', () => {
  const r = asObj(smelt.plan(inv({ stone: 200, cobblestone: 100, spruce_log: 50, raw_iron: 7 }), { reserved: { stone: 150, spruce_log: 40 }, keepLogs: 0 }))
  assert.deepStrictEqual(r, { stone: 50, cobblestone: 52, spruce_log: 10, raw_iron: 7 })
})
