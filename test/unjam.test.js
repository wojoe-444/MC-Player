const test = require('node:test')
const assert = require('node:assert')
const { mockBot } = require('./mock-bot')
const safehand = require('../brain/safehand')
const furnaceMod = require('../brain/furnace')
const smelt = require('../brain/smeltables')
const config = require('../brain/furnace-config.json')

function world({ furnaceInputs = {} } = {}) {
  const bot = mockBot({ pos: [-1045, 128, 2276] })
  bot.give('stone_sword')
  for (const u of config.stations.flatMap(s => s.units)) bot.setBlock(...u.furnace, 'furnace')
  const ch = [[-1043, 131, 2274], [-1043, 132, 2273], [-1043, 128, 2273], [-1051, 154, 2323], [-1051, 155, 2324], [-1051, 151, 2324], [-1051, 154, 2326], [-1051, 155, 2325], [-1051, 151, 2325]]
  for (const [x, y, z] of ch) bot.addChest(x, y, z, 54, {})
  bot.world.raycast = () => null
  // furnace windows: input slot contents per furnace key
  const slots = { ...furnaceInputs }
  bot.openFurnace = async (block) => {
    const k = `${block.position.x},${block.position.y},${block.position.z}`
    return { inputItem: () => slots[k] || null, fuelItem: () => null, outputItem: () => null, async takeInput() { const it = slots[k]; delete slots[k]; bot.give(it.name, it.count) }, close() {} }
  }
  const said = []
  const f = furnaceMod({ bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: safehand({ bot }), config, stateFile: null })
  return { bot, f, said, slots }
}

test('isSmeltable knows the common cases and not saplings', () => {
  for (const n of ['cobblestone', 'raw_iron', 'sand', 'iron_ore', 'beef', 'oak_log', 'clay_ball']) assert.ok(smelt.isSmeltable(n), n)
  for (const n of ['birch_sapling', 'dirt', 'stick', 'diamond']) assert.ok(!smelt.isSmeltable(n), n)
})

test('unjam takes a sapling out of a furnace input slot and leaves cobblestone alone', async () => {
  const { bot, f, slots } = world({ furnaceInputs: { '-1051,153,2324': { name: 'birch_sapling', count: 1 }, '-1051,153,2325': { name: 'cobblestone', count: 12 } } })
  const r = await f.unjam(null)
  assert.ok(r.some(l => /took 1 birch_sapling/.test(l)), r.join('|'))
  assert.strictEqual(bot.count('birch_sapling'), 1)
  assert.strictEqual(slots['-1051,153,2324'], undefined)
  assert.strictEqual(slots['-1051,153,2325'].count, 12)
})

test('unknown item in an input slot is reported, not taken', async () => {
  const { bot, f, slots } = world({ furnaceInputs: { '-1043,130,2273': { name: 'diamond', count: 3 } } })
  const r = await f.unjam(null)
  assert.ok(r.some(l => /do not recognise/.test(l)))
  assert.strictEqual(slots['-1043,130,2273'].count, 3)
  assert.strictEqual(bot.count('diamond'), 0)
})

test('deposits are spread over the reachable input chests instead of piling into one', async () => {
  const { bot, f } = world()
  bot.give('cobblestone', 48 + 300)
  await f.depositSmeltables(null, { force: true })
  const a = (bot.chestItems(-1043, 132, 2273).cobblestone || 0), b = (bot.chestItems(-1051, 155, 2324).cobblestone || 0), c = (bot.chestItems(-1051, 155, 2325).cobblestone || 0)
  assert.strictEqual(a + b + c, 300)
  assert.ok(a >= 90 && b >= 90 && c >= 90, `spread ${a}/${b}/${c}`)
})

test('balance moves half of the cobblestone surplus from the fullest input chest to the emptiest', async () => {
  const { bot, f } = world()
  bot.addChest(-1051, 155, 2324, 54, { cobblestone: 640 })
  const msg = await f.balanceInputs(null)
  assert.match(msg, /moved \d+ cobblestone/)
  const after = [bot.chestItems(-1043, 132, 2273).cobblestone || 0, bot.chestItems(-1051, 155, 2324).cobblestone || 0, bot.chestItems(-1051, 155, 2325).cobblestone || 0]
  assert.strictEqual(after.reduce((a, b) => a + b, 0) + bot.count('cobblestone'), 640)
  assert.ok(Math.max(...after) < 640)
})

test('input chest holding something the furnace cannot smelt is reported once, not touched', async () => {
  const { bot, f, said } = world()
  bot.addChest(-1051, 155, 2324, 54, { cobblestone: 64, birch_sapling: 2 })
  await f.plan(null); await f.plan(null)
  assert.strictEqual(said.filter(t => /jam it/.test(t)).length, 1)
  assert.deepStrictEqual(f.snapshot().units.find(u => u.name === 'S2.1').junkInInput, ['birch_sapling'])
  assert.strictEqual(bot.chestItems(-1051, 155, 2324).birch_sapling, 2)
})
