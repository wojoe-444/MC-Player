const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { rig, mcData } = require('./crafting.helpers')
const names = require('../brain/crafting/names')
const { plan, maxFeasible, tally } = require('../brain/crafting/planner')
const chestsMod = require('../brain/crafting/chests')
const Recipe = require('prismarine-recipe')(mcData).Recipe

const id = (n) => mcData.itemsByName[n].id
const nm = (i) => mcData.items[i].name
const M = (o) => new Map(Object.entries(o).map(([k, v]) => [id(k), v]))
const recipesOf = (i) => Recipe.find(i, null)
const P = (target, count, inventory = {}, chests = {}, extra = {}) => plan({ registry: mcData, recipesOf, target: id(target), count, inventory: M(inventory), chests: M(chests), ...extra })
const itemNames = mcData.itemsArray.map(i => i.name)
const allNames = [...new Set([...itemNames, ...mcData.blocksArray.map(b => b.name)])]

// ---------------------------------------------------------------- names
test('names: "glass" is searched as glass, never as "glas"; plurals and families resolve', () => {
  assert.deepStrictEqual(names.resolve(itemNames, 'glass').matches, ['glass'])
  assert.deepStrictEqual(names.resolve(itemNames, 'glass panes').matches, ['glass_pane'])
  assert.deepStrictEqual(names.resolve(itemNames, 'torches').matches, ['torch'])
  assert.deepStrictEqual(names.resolve(itemNames, 'sticks').matches, ['stick'])
  assert.deepStrictEqual(names.resolve(itemNames, 'crafting table').matches, ['crafting_table'])
  assert.deepStrictEqual(names.resolve(itemNames, 'table').matches, ['crafting_table'])
  const planks = names.resolve(itemNames, 'planks')
  assert.strictEqual(planks.rank, 2)
  assert.ok(planks.matches.includes('oak_planks') && planks.matches.includes('spruce_planks') && planks.matches.every(n => n.endsWith('_planks')))
  assert.ok(names.resolve(allNames, 'bed').matches.includes('red_bed'))
  assert.ok(names.resolve(itemNames, 'glass').inside.includes('glass_pane'), 'longer names are kept for widening')
  assert.strictEqual(names.resolve(itemNames, 'glass').inside.includes('glass'), false)
})
test('names: typos resolve only when nothing else matches; nonsense resolves to nothing', () => {
  assert.deepStrictEqual(names.resolve(itemNames, 'galss').matches, ['glass'])
  assert.strictEqual(names.resolve(itemNames, 'galss').rank, 3)
  assert.deepStrictEqual(names.resolve(itemNames, 'crafting tabel').matches, ['crafting_table'])
  assert.deepStrictEqual(names.resolve(itemNames, 'zzzq').matches, [])
  assert.deepStrictEqual(names.resolve(itemNames, 'ab').matches, [])
  assert.deepStrictEqual(names.resolve(itemNames, 'glass', { fuzzy: false }).matches, ['glass'])
})
test('names: counts in every position', () => {
  const c = (s) => { const r = names.parseCount(s); return [r.count, r.what] }
  assert.deepStrictEqual(c('3 torches'), [3, 'torches'])
  assert.deepStrictEqual(c('torches 3'), [3, 'torches'])
  assert.deepStrictEqual(c('x16 glass pane'), [16, 'glass pane'])
  assert.deepStrictEqual(c('glass pane x 16'), [16, 'glass pane'])
  assert.deepStrictEqual(c('a stack of sticks'), [64, 'sticks'])
  assert.deepStrictEqual(c('glass pane'), [1, 'glass pane'])
  assert.deepStrictEqual(c('5000 sticks'), [2304, 'sticks'])
  assert.deepStrictEqual(c('0 sticks'), [1, 'sticks'])
})

// ---------------------------------------------------------------- planner
test('planner: takes only what is needed from chests, bag first', () => {
  let p = P('glass_pane', 10, {}, { glass: 136 })
  assert.ok(p.ok); assert.strictEqual(p.yield, 16); assert.ok(p.needsTable)
  assert.deepStrictEqual(tally(p.take, nm), ['6 glass'])
  p = P('glass_pane', 10, { glass: 4 }, { glass: 136 })
  assert.deepStrictEqual(tally(p.take, nm), ['2 glass']); assert.deepStrictEqual(tally(p.useInv, nm), ['4 glass'])
  p = P('glass_pane', 10, { glass: 6 }, { glass: 136 })
  assert.strictEqual(p.take.size, 0)
})
test('planner: crafts intermediates (logs -> planks -> sticks) and uses the wood the bot actually has', () => {
  const p = P('wooden_pickaxe', 1, {}, { spruce_log: 36 })
  assert.ok(p.ok)
  assert.deepStrictEqual(tally(p.take, nm), ['2 spruce log'])
  assert.deepStrictEqual(p.steps.map(s => nm(s.id)).filter((x, i, a) => a.indexOf(x) === i), ['spruce_planks', 'stick', 'wooden_pickaxe'])
  const q = P('stick', 4, { birch_planks: 2 }, {})
  assert.ok(q.ok); assert.strictEqual(q.steps.length, 1); assert.strictEqual(nm(q.steps[0].recipe.delta[0].id), 'birch_planks')
})
test('planner: surplus from a craft is reused (one stick craft serves two pickaxes)', () => {
  const p = P('stone_pickaxe', 2, { cobblestone: 6, oak_planks: 2 }, {})
  assert.ok(p.ok)
  assert.strictEqual(p.steps.filter(s => nm(s.id) === 'stick').length, 1)
  assert.strictEqual(p.steps.find(s => nm(s.id) === 'stick').times, 1)
})
test('planner: reports what is missing and never uses lava buckets or uncrafts storage blocks for sub-steps', () => {
  const p = P('wooden_pickaxe', 1, {}, {})
  assert.strictEqual(p.ok, false)
  assert.deepStrictEqual(tally(p.missing, nm), ['2 oak log'])
  const f = P('furnace', 1, { cobblestone: 4 }, {})
  assert.strictEqual(f.ok, false); assert.deepStrictEqual(tally(f.missing, nm), ['4 cobblestone'])
  // a gold block in a chest is not broken up to supply the ingots of a golden pickaxe...
  const g = P('golden_pickaxe', 1, { oak_planks: 5 }, { gold_block: 1 })
  assert.strictEqual(g.ok, false)
  // ...but asking for the ingots outright is fine
  assert.ok(P('gold_ingot', 9, {}, { gold_block: 1 }).ok)
  assert.strictEqual(P('stick', 4, { lava_bucket: 1 }, {}).ok, false)
})
test('planner: maxFeasible and the chest filter', () => {
  assert.strictEqual(maxFeasible({ registry: mcData, recipesOf, target: id('glass_pane'), inventory: M({ glass: 13 }), chests: M({ glass: 30 }) }), 112)
  assert.strictEqual(maxFeasible({ registry: mcData, recipesOf, target: id('glass_pane'), inventory: M({}), chests: M({}) }), 0)
  const blocked = P('glass_pane', 1, {}, { glass: 50 }, { chestAllowed: () => false })
  assert.strictEqual(blocked.ok, false)
})

// ---------------------------------------------------------------- chests
const furnaceCfg = require('../brain/furnace-config.json')
function chestLib(index, overlay = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chestlib-'))
  fs.writeFileSync(path.join(dir, 'chest-index.json'), JSON.stringify(index))
  const overlayFile = path.join(dir, 'overlay.json')
  fs.writeFileSync(overlayFile, JSON.stringify(overlay))
  return chestsMod.create({ dir, overlayFile, furnaceConfig: furnaceCfg, rules: require('../brain/crafting/config.json') })
}
test('chests: furnace fuel/input chests and lava buckets are never offered; output chests give everything but buckets', () => {
  const c = chestLib({
    '-1043,131,2274': { items: { lava_bucket: 6, glass: 5 }, at: 1 },     // S1 fuel
    '-1043,132,2273': { items: { cobblestone: 200 }, at: 1 },             // S1 input
    '-1043,128,2273': { items: { glass: 106, bucket: 4, lava_bucket: 1 }, at: 1 },   // S1 output
    '-1000,70,2000': { items: { glass: 3, lava_bucket: 1 }, at: 1 }
  })
  const t = c.totals(c.entries(), mcData)
  assert.strictEqual(t.get(id('glass')), 109)
  assert.strictEqual(t.get(id('cobblestone')), undefined)
  assert.strictEqual(t.get(id('bucket')), undefined)
  assert.strictEqual(t.get(id('lava_bucket')), undefined)
  assert.strictEqual(c.allowed(new Vec3(-1043, 128, 2274), 'bucket'), false, 'the other half of the double chest is protected too')
  assert.strictEqual(c.allowed(new Vec3(-1000, 70, 2000), 'glass'), true)
})
test('chests: double-chest halves with identical contents count once; errors are skipped; a newer overlay wins', () => {
  const c = chestLib({
    '0,64,0': { items: { glass: 10 }, at: 5 }, '1,64,0': { items: { glass: 10 }, at: 5 },
    '9,64,9': { error: 'unreachable', at: 5 }, '20,64,0': { items: { glass: 4 }, at: 5 }
  }, { '20,64,0': { items: { glass: 1 }, at: 9 }, '0,64,0': { items: { glass: 99 }, at: 2 } })
  const e = c.entries()
  assert.strictEqual(e.length, 2)
  assert.strictEqual(c.totals(e, mcData).get(id('glass')), 11, 'older overlay entry ignored, newer one used')
  assert.strictEqual(c.totals(e, mcData, new Set(['20,64,0'])).get(id('glass')), 10)
})
test('chests: assign covers the need with the fewest chests, nearest first', () => {
  const c = chestLib({
    '0,64,10': { items: { glass: 2 }, at: 1 }, '0,64,50': { items: { glass: 100 }, at: 1 }, '0,64,30': { items: { glass: 100, stick: 4 }, at: 1 }
  })
  const route = c.assign(c.entries(), mcData, M({ glass: 60, stick: 2 }), new Vec3(0, 64, 0))
  assert.deepStrictEqual(route.map(r => r.key), ['0,64,30'])
  assert.strictEqual(route[0].take.get('glass'), 60)
  const far = c.assign(c.entries(), mcData, M({ glass: 150 }), new Vec3(0, 64, 0))
  assert.deepStrictEqual(far.map(r => r.key), ['0,64,30', '0,64,50'], 'walk order: nearest first')
})

// ---------------------------------------------------------------- craft command (real brain wiring, mock bot)
const CHESTS = [
  [-1043, 128, 2273, 54, { glass: 106, stone: 286, bucket: 4 }],       // furnace output chest: glass ok, buckets off limits
  [-1051, 160, 2330, 27, { glass: 30, spruce_log: 36, cobblestone: 20 }]
]
test('craft glass pane 10: takes exactly 6 glass, walks to the known table, crafts once', async () => {
  const r = rig({ chests: CHESTS })
  assert.strictEqual(r.route('craft glass pane 10'), true)
  await r.settle()
  assert.strictEqual(r.bot.count('glass_pane'), 16)
  assert.strictEqual(r.bot.count('glass'), 0, 'no more glass taken than the recipe uses')
  const taken = r.bot.actions.filter(a => a[0] === 'withdraw')
  assert.deepStrictEqual(taken.map(a => [a[1], a[2]]), [['glass', 6]])
  assert.strictEqual(r.bot.chestItems(-1051, 160, 2330).glass + r.bot.chestItems(-1043, 128, 2273).glass, 136 - 6)
  assert.deepStrictEqual(r.bot.craftCalls, [['glass_pane', 1, true]])
  assert.ok(r.bot.entity.position.distanceTo(new Vec3(-1051, 151, 2320)) < 6, 'ended next to the crafting table')
  assert.ok(r.said.some(t => /Crafted 16 glass pane/.test(t)), r.said.join(' | '))
  r.stop()
})
test('craft uses the bag first and visits no chest when the bag is enough', async () => {
  const r = rig({ chests: CHESTS, bag: { glass: 6 } })
  r.route('make 16 glass panes'); await r.settle()
  assert.strictEqual(r.bot.count('glass_pane'), 16)
  assert.ok(!r.bot.actions.some(a => a[0] === 'open' || a[0] === 'withdraw'))
  r.stop()
})
test('craft a recipe that fits the 2x2 grid does not walk to a table', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 4 } })
  r.route('craft 4 sticks'); await r.settle()
  assert.strictEqual(r.bot.count('stick'), 4)
  assert.deepStrictEqual(r.bot.craftCalls, [['stick', 1, false]])
  assert.ok(!r.bot.actions.some(a => a[0] === 'goto'))
  r.stop()
})
test('craft chains logs -> planks -> sticks -> pickaxe, taking only the 2 logs it needs', async () => {
  const r = rig({ chests: CHESTS })
  r.route('craft wooden pickaxe'); await r.settle()
  assert.strictEqual(r.bot.count('wooden_pickaxe'), 1)
  assert.deepStrictEqual(r.bot.actions.filter(a => a[0] === 'withdraw').map(a => [a[1], a[2]]), [['spruce_log', 2]])
  assert.strictEqual(r.bot.chestItems(-1051, 160, 2330).spruce_log, 34)
  r.stop()
})
test('craft reports what is missing (and where it looked) without taking or walking anything', async () => {
  const r = rig({ chests: [[-1051, 160, 2330, 27, { glass: 2 }]] })
  r.route('craft glass pane'); await r.settle()
  assert.ok(r.said.some(t => /Can't craft 1 glass pane: missing 4 glass/.test(t) && /1 indexed chest/.test(t)), r.said.join(' | '))
  assert.ok(!r.bot.actions.some(a => ['withdraw', 'goto', 'craft'].includes(a[0])))
  const r2 = rig({ chests: [], bag: {} })
  r2.route('craft furnace'); await r2.settle()
  assert.ok(r2.said.some(t => /missing 8 cobblestone/.test(t) && /index chests/.test(t)), r2.said.join(' | '))
  r.stop(); r2.stop()
})
test('craft makes what it can when the chests hold less than asked, and says so', async () => {
  const r = rig({ chests: [[-1051, 160, 2330, 27, { glass: 14 }]] })
  r.route('craft 48 glass pane'); await r.settle()     // 3 crafts of 16 = 48 panes = 18 glass, only 14 exist -> 2 crafts (12 glass, 32 panes)
  assert.strictEqual(r.bot.count('glass_pane'), 32)
  assert.ok(r.said.some(t => /only make 32 of 48/.test(t)), r.said.join(' | '))
  assert.deepStrictEqual(r.bot.actions.filter(a => a[0] === 'withdraw').map(a => a[2]), [12])
  assert.strictEqual(r.bot.chestItems(-1051, 160, 2330).glass, 2)
  r.stop()
})
test('craft survives a stale chest index: takes what is really there, then reports the shortfall and fixes its overlay', async () => {
  const real = [-1051, 160, 2330, 27, { glass: 4 }]
  const r = rig({ chests: [real], index: [[-1051, 160, 2330, 27, { glass: 10 }]] })
  r.route('craft glass pane'); await r.settle()
  assert.strictEqual(r.bot.count('glass_pane'), 0)
  assert.ok(r.said.some(t => /missing 2 glass/.test(t)), r.said.join(' | '))
  const overlay = JSON.parse(fs.readFileSync(path.join(r.dir, 'state', 'crafting-chests.json'), 'utf8'))
  assert.deepStrictEqual(overlay['-1051,160,2330'].items, {}, 'chest contents as seen after the visit')
  r.said.length = 0
  r.route('craft glass pane'); await r.settle()
  assert.ok(r.said.some(t => /missing/.test(t)))
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'open').length, 1, 'second try knows the chest is empty and does not walk there again')
  r.stop()
})
test('craft never takes furnace-station stock: buckets, lava, fuel and input chests', async () => {
  const r = rig({ chests: [
    [-1043, 131, 2274, 27, { glass: 50, lava_bucket: 6 }],   // S1 fuel chest
    [-1043, 128, 2273, 54, { bucket: 4 }]                    // S1 output
  ] })
  r.route('craft glass pane'); await r.settle()
  assert.ok(!r.bot.actions.some(a => a[0] === 'open'))
  assert.ok(r.said.some(t => /missing/.test(t)))
  r.stop()
})
test('craft refuses to take items into a full bag', async () => {
  const bag = {}
  const fillers = mcData.itemsArray.filter(i => i.stackSize === 64 && !/glass/.test(i.name)).slice(0, 36).map(i => i.name)
  for (const n of fillers) bag[n] = 1
  const r = rig({ chests: CHESTS, bag })
  r.route('craft glass pane'); await r.settle()
  assert.ok(r.said.some(t => /bag is too full/.test(t)), r.said.join(' | '))
  assert.ok(!r.bot.actions.some(a => a[0] === 'withdraw' || a[0] === 'craft'))
  r.stop()
})
test('craft with no crafting table within reach says so', async () => {
  const r = rig({ chests: CHESTS, table: null })
  r.route('craft glass pane'); await r.settle()
  assert.ok(r.said.some(t => /can't reach a crafting table/.test(t)), r.said.join(' | '))
  r.stop()
})
test('craft uses a nearby crafting table when it is closer than the known one', async () => {
  const r = rig({ chests: CHESTS, bag: { glass: 6 }, pos: [0, 64, 0], table: null })
  r.bot.setBlock(5, 64, 5, 'crafting_table')
  r.route('craft glass pane'); await r.settle()
  assert.ok(r.bot.entity.position.distanceTo(new Vec3(5, 64, 5)) < 6)
  assert.strictEqual(r.bot.count('glass_pane'), 16)
  r.stop()
})
test('craft never walks with lava selected; a misspelled item is claimed and answered, not crafted', async () => {
  const r = rig({ chests: CHESTS })
  r.bot.give('lava_bucket', 1); await r.bot.equip('lava_bucket')
  r.route('craft glass pane'); await r.settle()
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
  assert.strictEqual(r.bot.count('glass_pane'), 16)
  r.said.length = 0
  assert.strictEqual(r.route('craft flurbwidget'), true, 'still claimed: the legacy job would craft a stone tool set')
  assert.ok(r.said.some(t => /don't know an item called "flurbwidget"/.test(t)))
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'craft').length, 1)
  r.stop()
})
test('craft explains items that are smelted, and asks which one when several tiers are makeable', async () => {
  const r = rig({ chests: [], bag: { cobblestone: 20, oak_planks: 20, iron_ingot: 10, stick: 10 } })
  r.route('craft glass')
  assert.ok(r.said.some(t => /glass can't be crafted \(it is smelted\)/.test(t)), r.said.join(' | '))
  r.said.length = 0
  r.route('craft pickaxe'); await r.settle()
  assert.ok(r.said.some(t => /Which one\? .*stone pickaxe/.test(t)), r.said.join(' | '))
  assert.strictEqual(r.bot.craftCalls.length, 0)
  r.stop()
})
test('stop cancels a craft job while it walks to the table: nothing is crafted', async () => {
  let release
  const slow = async (goal, label) => { if (/table/.test(label)) await new Promise(res => { release = res }); return r.bot.tryGoto(goal, label) }
  const r = rig({ chests: CHESTS, extra: { tryGoto: slow } })
  r.route('craft glass pane'); await r.wait(60)
  r.brain.userStop(); if (release) release()
  await r.settle()
  assert.strictEqual(r.bot.count('glass_pane'), 0)
  assert.ok(!r.bot.actions.some(a => a[0] === 'craft'))
  assert.strictEqual(r.bot.count('glass'), 6, 'the ingredients it fetched stay in the bag')
  r.stop()
})

// ---------------------------------------------------------------- commands and legacy routing
test('built-in tool-set command is shadowed: "craft <item>" and the tool-set phrases are handled by us, the legacy job never runs', async () => {
  const r = rig({ chests: CHESTS, bag: { glass: 6 }, legacyCraft: true })
  assert.ok(r.brain.commands.list().some(c => c.name === 'craft'), 'built-in craft command present')
  assert.ok(r.brain.commands.list().some(c => c.name === 'craft-item' && /craft <item>/.test(c.help)))
  r.route('hey can you please craft glass pane 3'); await r.settle()
  assert.strictEqual(r.bot.count('glass_pane'), 16)
  assert.deepStrictEqual(r.calls, [])
  for (const phrase of ['craft tool set', 'craft tools', 'make yourself some tools', 'craft a tool set']) { r.said.length = 0; assert.strictEqual(r.route(phrase), true); await r.settle(); assert.ok(r.said.some(t => /tool set/.test(t)), phrase + ': ' + r.said.join(' | ')) }
  assert.deepStrictEqual(r.calls, [], 'the legacy craftToolSet (pathfinder.goto) did not run')
  assert.strictEqual(r.brain.api.status.all().modules.crafting.shadowedByBuiltInCraft, true)
  r.stop()
})
test('without the built-in command the registered craft-item command matches on its own', async () => {
  const r = rig({ chests: CHESTS, bag: { glass: 6 } })
  assert.strictEqual(r.brain.api.status.all().modules.crafting.shadowedByBuiltInCraft, false)
  assert.strictEqual(r.brain.route('OGWO', 'craft glass pane', { handleCommand: () => false, internal: true }), true, 'also reachable through commands.dispatch (the chat module)')
  await r.settle()
  assert.strictEqual(r.bot.count('glass_pane'), 16)
  assert.strictEqual(r.route('make sure you are careful'), false, '"make" is only ours for real item names')
  assert.strictEqual(r.route('make yourself a sandwich'), false)
  assert.strictEqual(r.route('craft yourself a stick'), true, '"yourself" does not turn an item request into the tool-set job')
  await r.settle()
  assert.strictEqual(r.route('craft'), false)
  r.stop()
})

// ---------------------------------------------------------------- find
const FINDW = [
  [-1043, 128, 2273, 54, { glass: 106, stone: 286 }],
  [-1051, 151, 2324, 54, { glass: 30, iron_ingot: 17 }],
  [-900, 70, 2300, 27, { glass_pane: 20, tinted_glass: 3 }]
]
test('find glass: bag, chests and blocks, nearest first, never searches "glas"', async () => {
  const r = rig({ chests: FINDW, bag: { glass: 4 }, pos: [-1045, 128, 2276] })
  r.bot.setBlock(-1040, 128, 2290, 'glass'); r.bot.setBlock(-1040, 129, 2290, 'glass'); r.bot.setBlock(-1100, 128, 2276, 'glass')
  assert.strictEqual(r.route('find glass'), true)
  const line = r.said.at(-1)
  assert.match(line, /^glass: I carry 4; /)
  const dists = [...line.matchAll(/(\d+)m /g)].map(m => +m[1])
  assert.ok(dists.length >= 3 && dists.every((d, i) => i === 0 || d >= dists[i - 1]), 'nearest first: ' + line)
  assert.match(line, /2 glass at -1040,128,2290/)
  assert.match(line, /chest -1043,128,2273 has 106 glass/)
  assert.ok(!/glass pane|tinted/.test(line), 'exact name wins over longer names')
  const full = fs.readFileSync(path.join(r.dir, 'state', 'find-last.txt'), 'utf8')
  assert.match(full, /nearest first:/); assert.match(full, /chest -1051,151,2324: 30 glass/)
  r.stop()
})
test('find: plural, family and typo forms; widening; unknown things fall through to the legacy handler', async () => {
  const r = rig({ chests: FINDW })
  r.route('where are the iron ingots'); assert.match(r.said.at(-1), /^iron ingot: .*chest -1051,151,2324 has 17 iron ingot/, r.said.at(-1))
  r.route('find galss'); assert.match(r.said.at(-1), /glass: .*106 glass/)
  r.route('find glass panes'); assert.match(r.said.at(-1), /glass pane: .*20 glass pane/)
  // the exact name has nothing anywhere -> widen to names that contain it
  const r2 = rig({ chests: [[10, 64, 10, 27, { red_stained_glass: 5 }]] })
  r2.route('find glass'); assert.match(r2.said.at(-1), /^No exact match; closest names\. .*5 red stained glass/, r2.said.at(-1))
  const r3 = rig({ chests: [], index: [] })
  assert.strictEqual(r3.route('find the secret base'), false, 'not an item or block: not ours')
  assert.strictEqual(r3.legacy.at(-1), 'find the secret base')
  r3.route('find diamond'); assert.match(r3.said.at(-1), /^No diamond in my bag or within 128 blocks\. \(say "index chests"/)
  const r4 = rig({ chests: FINDW })
  r4.route('find furnaces'); assert.strictEqual(r4.legacy.at(-1), 'find furnaces', 'furnace survey stays with the legacy handler')
  r.stop(); r2.stop(); r3.stop(); r4.stop()
})
test('find: blocks are grouped, the nearest block of the nearest group is given, and the message stays chat-sized', async () => {
  const r = rig({ chests: [], index: [] })
  for (let i = 0; i < 40; i++) r.bot.setBlock(-1045 + i * 7, 128, 2276, 'oak_planks')
  r.route('find planks')
  const line = r.said.at(-1)
  assert.ok(line.length <= 230, line.length + ' ' + line)
  assert.match(line, /oak planks at -1045,128,2276/)
  r.stop()
})
test('find only reads: nothing is opened, taken or moved', async () => {
  const r = rig({ chests: FINDW })
  const before = JSON.stringify(r.bot.chestItems(-1043, 128, 2273))
  r.route('find glass'); r.route('locate iron ingot')
  assert.ok(!r.bot.actions.some(a => ['open', 'withdraw', 'goto', 'craft'].includes(a[0])))
  assert.strictEqual(JSON.stringify(r.bot.chestItems(-1043, 128, 2273)), before)
  r.stop()
})

// ---------------------------------------------------------------- line of sight (Walter's survival-legit rule)
const { canSee } = require('../brain/los')
// flat stone floor at y=63 for x/z 0..20 and a wall at x=9 (y 64..67, z 6..14) between the bot (west) and the target at (10,64,10)
function wallWorld(r, { enclose = false } = {}) {
  for (let x = 0; x <= 20; x++) for (let z = 0; z <= 20; z++) r.bot.setBlock(x, 63, z, 'stone')
  for (let y = 64; y <= 67; y++) for (let z = 6; z <= 14; z++) r.bot.setBlock(9, y, z, 'stone')
  if (enclose) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) r.bot.setBlock(10 + dx, 64 + dy, 10 + dz, 'stone')
}
test('line of sight: the integrator helper is what the module relies on', () => {
  const r = rig({ chests: [[10, 64, 10, 27, { glass: 1 }]], pos: [8, 64, 10], table: null })
  wallWorld(r)
  assert.strictEqual(typeof r.brain.api.ensureLineOfSight, 'function')
  assert.strictEqual(canSee(r.bot, new Vec3(10, 64, 10)), false, 'one-block-thick wall between eye and chest')
  r.stop()
})
test('craft: a chest behind a wall is not opened from the wrong side; the bot walks to a spot with a clear view first', async () => {
  const r = rig({ chests: [[10, 64, 10, 27, { oak_planks: 4 }]], pos: [8.5, 64, 10.5], table: null })
  wallWorld(r)
  const seenAtOpen = []
  const open = r.bot.openContainer
  r.bot.openContainer = async (b) => { seenAtOpen.push(canSee(r.bot, b.position)); return open(b) }
  r.route('craft 4 sticks'); await r.settle()
  assert.deepStrictEqual(seenAtOpen, [true], 'the chest was only opened with a clear line')
  assert.ok(r.bot.actions.some(a => a[0] === 'goto' && /clear view/.test(a[1])), 'it repositioned first')
  assert.strictEqual(r.bot.count('stick'), 4)
  r.stop()
})
test('craft: a chest with no clear line from anywhere is left alone and the reply says why', async () => {
  const r = rig({ chests: [[10, 64, 10, 27, { oak_planks: 4 }]], pos: [8.5, 64, 10.5], table: null })
  wallWorld(r, { enclose: true })
  r.route('craft 4 sticks'); await r.settle()
  assert.ok(!r.bot.actions.some(a => a[0] === 'open' || a[0] === 'withdraw'))
  assert.strictEqual(r.bot.count('stick'), 0)
  assert.ok(r.said.some(t => /No clear line to the chest at 10,64,10/.test(t)), r.said.join(' | '))
  r.stop()
})
test('craft: the crafting table needs a clear line too (reposition, or refuse)', async () => {
  const r = rig({ chests: [], bag: { glass: 6 }, pos: [8.5, 64, 10.5], table: null })
  wallWorld(r); r.bot.setBlock(10, 64, 10, 'crafting_table')
  const seenAtCraft = []
  const craft = r.bot.craft
  r.bot.craft = async (rec, n, table) => { seenAtCraft.push(canSee(r.bot, table.position)); return craft(rec, n, table) }
  r.route('craft glass pane'); await r.settle()
  assert.deepStrictEqual(seenAtCraft, [true])
  assert.strictEqual(r.bot.count('glass_pane'), 16)
  const r2 = rig({ chests: [], bag: { glass: 6 }, pos: [8.5, 64, 10.5], table: null })
  wallWorld(r2, { enclose: true }); r2.bot.setBlock(10, 64, 10, 'crafting_table')
  r2.route('craft glass pane'); await r2.settle()
  assert.strictEqual(r2.bot.count('glass_pane'), 0)
  assert.ok(r2.said.some(t => /crafting table with a clear line/.test(t)), r2.said.join(' | '))
  r.stop(); r2.stop()
})
test('craft fails closed when the line-of-sight helper is missing: no chest is opened', async () => {
  const r = rig({ chests: CHESTS })
  delete r.brain.api.ensureLineOfSight
  r.route('craft glass pane'); await r.settle()
  assert.ok(!r.bot.actions.some(a => a[0] === 'open' || a[0] === 'withdraw' || a[0] === 'craft'))
  r.stop()
})

// ---------------------------------------------------------------- api.crafting.craft (used by other modules, e.g. the excavation's pickaxes)
const callCraft = (r, name, n, opts) => r.brain.api.crafting.craft(null, name, n, opts)
test('api.crafting.craft: 8 stone pickaxes from planks, sticks and cobblestone at the known table (the excavation restock case)', async () => {
  const r = rig({ chests: [], bag: { spruce_planks: 27, cobblestone: 528, stick: 3, stone_pickaxe: 4 }, pos: [-1065, 136, 2339] })
  const res = await callCraft(r, 'stone_pickaxe', 8, { chests: false })
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(res.made, 8)
  assert.strictEqual(r.bot.count('stone_pickaxe'), 12)
  assert.strictEqual(r.bot.count('cobblestone'), 528 - 24)
  assert.strictEqual(r.bot.count('stick') + 16, 3 + 4 * 4, 'exactly the sticks it needed were made: 4 crafts of 4, 16 used')
  assert.ok(!r.bot.actions.some(a => a[0] === 'open' || a[0] === 'withdraw'), 'no chests with chests:false')
  assert.ok(r.said.length === 0, 'it does not talk in chat')
  r.stop()
})
test('api.crafting.craft: says exactly what is missing instead of "no recipe"', async () => {
  const r = rig({ chests: [], bag: { cobblestone: 20, stick: 1, oak_planks: 1, spruce_planks: 1 } })
  const res = await callCraft(r, 'stone_pickaxe', 2, { chests: false })
  assert.strictEqual(res.ok, false)
  assert.match(res.text, /missing .*oak log/, res.text)
  assert.ok(Array.isArray(res.missing) && res.missing.length)
  assert.strictEqual(r.bot.count('stone_pickaxe'), 0)
  const c = r.brain.api.crafting.canCraft('stone_pickaxe', 1)
  assert.strictEqual(c.ok, false)
  assert.strictEqual(r.brain.api.crafting.canCraft('stick', 1).ok, false)
  r.stop()
})
test('api.crafting.craft: with no table in reach it fails by default, and puts one down only when the caller allows placing', async () => {
  const bag = { oak_planks: 12, cobblestone: 9, stick: 4 }
  const r = rig({ chests: [], bag, table: null, pos: [5, 64, 5] })
  for (let x = 0; x <= 12; x++) for (let z = 0; z <= 12; z++) r.bot.setBlock(x, 63, z, 'stone')
  const no = await callCraft(r, 'stone_pickaxe', 2, { chests: false, tableRadius: 64 })
  assert.strictEqual(no.ok, false); assert.match(no.text, /can't reach a crafting table/)
  assert.ok(!r.bot.actions.some(a => a[0] === 'place'))
  const yes = await callCraft(r, 'stone_pickaxe', 2, { chests: false, placeTable: true, tableRadius: 64 })
  assert.strictEqual(yes.ok, true, yes.text)
  assert.strictEqual(r.bot.count('stone_pickaxe'), 2)
  const placed = r.bot.actions.filter(a => a[0] === 'place')
  assert.strictEqual(placed.length, 1)
  assert.strictEqual(r.bot.blockAt(new Vec3(placed[0][2], placed[0][3], placed[0][4])).name, 'crafting_table')
  assert.strictEqual(r.bot.count('oak_planks'), 12 - 4, 'the table cost 4 planks, nothing else was used (sticks were enough)')
  r.stop()
})
test('api.crafting.craft: unknown items, and placing needs planks or a table in the bag', async () => {
  const r = rig({ chests: [], bag: { cobblestone: 9, stick: 4 }, table: null, pos: [5, 64, 5] })
  assert.strictEqual((await callCraft(r, 'flurbwidget', 1)).ok, false)
  const res = await callCraft(r, 'stone_pickaxe', 1, { chests: false, placeTable: true, tableRadius: 64 })
  assert.strictEqual(res.ok, false)
  assert.ok(!r.bot.actions.some(a => a[0] === 'place'))
  r.stop()
})
