// brain/storage-model.js: the storage room as a tracked entity, the lean kit, reserved chests, single-chest spots
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { Vec3 } = require('vec3')
const SM = require('../brain/storage-model')

const items = (o) => Object.entries(o).map(([name, count]) => ({ name, count }))

test('lean kit: counts by entry, the gap, and "short" means an essential is missing (tools all-or-nothing, others under half)', () => {
  const c = SM.kitCounts(items({ stone_pickaxe: 1, iron_pickaxe: 1, bread: 5, cooked_beef: 6, torch: 3, cobblestone: 40, dirt: 99, leather_helmet: 1 }))
  assert.deepStrictEqual(c, { pickaxe: 2, sword: 0, food: 11, torch: 3, filler: 40 })
  assert.deepStrictEqual(SM.kitGap(c).map(g => g.id + ':' + g.need), ['sword:1', 'food:5', 'torch:13'])
  assert.deepStrictEqual(SM.kitShort(c), ['sword', 'torch'])   // torch 3 < 8
  assert.deepStrictEqual(SM.kitShort({ pickaxe: 1, sword: 1, food: 8, torch: 8, filler: 0 }), [])
  assert.ok(!SM.LEAN_KIT.some(e => e.re.test('iron_helmet')), 'no armor in the kit')
})

test('restockTake fills only the gap, lowest tool tier first, best food first, never more than the chest has', () => {
  const chest = items({ stone_pickaxe: 2, iron_pickaxe: 1, stone_sword: 1, bread: 10, cooked_beef: 30, torch: 8, cobblestone: 64, diamond: 3 })
  const take = SM.restockTake(chest, { pickaxe: 0, sword: 0, food: 4, torch: 0, filler: 32 })
  const by = Object.fromEntries(take.map(t => [t.name, t.n]))
  assert.deepStrictEqual(by, { stone_pickaxe: 1, stone_sword: 1, bread: 10, cooked_beef: 2, torch: 8 })   // food gap 12: bread first; torch gap 16 but the chest has 8; filler is full; diamond never
  assert.deepStrictEqual(SM.restockTake(chest, { pickaxe: 1, sword: 1, food: 16, torch: 16, filler: 32 }), [], 'a bag with the kit takes nothing')
})

test('stockGive puts only surplus above what the bag keeps into the chest, up to its stock; the lowest tier goes first', () => {
  const bag = items({ stone_pickaxe: 3, iron_pickaxe: 1, stone_sword: 1, bread: 50, torch: 40, cobblestone: 200 })
  const give = Object.fromEntries(SM.stockGive(bag, { pickaxe: 0, sword: 0, food: 20, torch: 0, filler: 0 }).map(g => [g.name, g.n]))
  // pickaxes: 4 held, keep 2 -> 2 spare, chest wants 2: both stone ones; sword: 1 held, keep 1 -> none; food: 50-32=18 spare, chest wants 12 more; torch 40-32=8; cobble 200-64=136 but stock 64
  assert.deepStrictEqual(give, { stone_pickaxe: 2, bread: 12, torch: 8, cobblestone: 64 })
  assert.deepStrictEqual(SM.stockGive(items({ stone_pickaxe: 1, bread: 5 }), {}), [], 'a bag at or under its own keep gives nothing')
  assert.deepStrictEqual(SM.craftable({ pickaxe: 2, sword: 0 }).map(c => c.item), ['stone_sword'])
})

test('room record: roles, contents observed, forget, summary and where-is (the reset and junk chests stay out of the totals)', () => {
  const room = { id: 'storage-s1', type: 'storage', y: 40, chests: [[1, 40, 1], [1, 40, 2], [5, 40, 1], [5, 40, 2]] }
  SM.setReset(room, new Vec3(3, 40, 4)); SM.setJunk(room, [4, 40, 4])
  assert.strictEqual(SM.roleOf(room, [3, 40, 4]), 'reset'); assert.strictEqual(SM.roleOf(room, new Vec3(4, 40, 4)), 'junk'); assert.strictEqual(SM.roleOf(room, [1, 40, 2]), 'storage'); assert.strictEqual(SM.roleOf(room, [9, 9, 9]), null)
  SM.observe(room, [1, 40, 1], items({ raw_iron: 30, coal: 10, dirt: 2 }), 1000)
  SM.observe(room, [5, 40, 1], items({ oak_log: 40, oak_planks: 20, cobblestone: 10 }), 1000)
  SM.observe(room, [3, 40, 4], items({ stone_pickaxe: 1, torch: 4, bread: 2 }), 1000)
  const s = SM.summary(room, 1000 + 5 * 60000)
  assert.strictEqual(s.chests, 4)
  assert.deepStrictEqual(s.by_theme.map(c => c.theme), ['ore', 'unknown', 'wood', 'unknown'])
  assert.strictEqual(s.top_items.raw_iron, 30); assert.ok(!('torch' in s.top_items), 'the reset chest is not storage')
  assert.deepStrictEqual(s.reset_chest.kit, { pickaxe: 1, sword: 0, food: 2, torch: 4, filler: 0 }); assert.strictEqual(s.reset_chest.age_min, 5)
  assert.deepStrictEqual(SM.whereIs(room, /^raw_iron$/), [{ at: [1, 40, 1], n: 30 }]); assert.deepStrictEqual(SM.whereIs(room, /torch/), [])
  SM.forget(room, [3, 40, 4]); assert.strictEqual(room.reset, null); assert.ok(!('3,40,4' in room.chestInfo))
  assert.strictEqual(JSON.parse(JSON.stringify(room)).chests.length, 4, 'the record survives the JSON registry')
})

test('themes: by what a chest holds', () => {
  assert.strictEqual(SM.themeOfChest({}), 'empty')
  assert.strictEqual(SM.themeOfChest({ raw_iron: 10, coal: 5, dirt: 1 }), 'ore')
  assert.strictEqual(SM.themeOfChest({ oak_log: 10, spruce_planks: 10 }), 'wood')
  assert.strictEqual(SM.themeOfChest({ bread: 4, cooked_beef: 4, stone_pickaxe: 5, oak_log: 5, dirt: 5 }), 'misc')
  assert.strictEqual(SM.themeOfItem('stone_pickaxe'), 'tools'); assert.strictEqual(SM.themeOfItem('cobblestone'), 'stone')
})

test('reserved chests: reset and junk keys from the registry file, cached, empty when the file is missing', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'registry.json')
  assert.strictEqual(SM.reservedFromFile(f).size, 0)
  fs.writeFileSync(f, JSON.stringify({ worlds: { a: { rooms: [{ reset: [1, 2, 3], junk: [4, 5, 6] }, { reset: null }] }, b: { rooms: [{ reset: [7, 8, 9] }] } } }))
  assert.deepStrictEqual([...SM.reservedFromFile(f)].sort(), ['1,2,3', '4,5,6', '7,8,9'])
  let t = 0; const get = SM.makeReserved(f, 1000, () => t)
  assert.strictEqual(get().size, 3)
  fs.writeFileSync(f, JSON.stringify({ worlds: {} })); assert.strictEqual(get().size, 3, 'cached'); t = 2000; assert.strictEqual(get().size, 0)
})

test('crafting chests refuse a reserved chest: no recipe takes from the reset chest', () => {
  const makeChests = require('../brain/crafting/chests').create
  const reserved = new Set(['1,2,3'])
  const c = makeChests({ dir: os.tmpdir(), overlayFile: null, rules: { reserved: () => reserved }, furnaceConfig: {} })
  assert.strictEqual(c.allowed(new Vec3(1, 2, 3), 'stone_pickaxe'), false)
  assert.strictEqual(c.allowed(new Vec3(1, 2, 4), 'stone_pickaxe'), true)
})

test('base memory never offers a reserved chest as a source to fetch from', () => {
  const { createMemory } = (() => { const m = require('../brain/autopilot/memory'); return { createMemory: m.createMemory || m } })()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'))
  const mem = createMemory({ file: path.join(dir, 'm.json'), dir, reserved: () => new Set(['3,40,4']) })
  mem.setChest({ x: 3, y: 40, z: 4 }, { torch: 20, stone_pickaxe: 2 }); mem.setChest({ x: 1, y: 40, z: 1 }, { torch: 5 })
  assert.deepStrictEqual(mem.chestsWith(/torch/).map(c => c.k), ['1,40,1'])
})

test('singleSpot: first open cell with a floor, not a row/torch spot, never beside another chest, skipping failed spots', () => {
  // a straight room along +x from s=(0,40,0); at(k,j,h) = s + (k, h, j)
  const s = new Vec3(0, 40, 0), at = (k, j, h = 0) => s.offset(k, h, j)
  const P = { at, chestSpots: [[at(4, 2), at(5, 2)], [at(4, -2), at(5, -2)]], torches: [at(3, 0)] }
  const world = new Map(); const put = (c, name, bb) => world.set(c.toString(), { name, boundingBox: bb })
  for (let k = 3; k < 10; k++) for (let j = -2; j <= 2; j++) { put(at(k, j, -1), 'stone', 'block'); put(at(k, j, 0), 'air', 'empty'); put(at(k, j, 1), 'air', 'empty') }
  const block = (c) => world.get(c.toString()) || null
  assert.strictEqual(SM.singleSpot(P, block).toString(), at(3, 2).toString())
  assert.strictEqual(SM.singleSpot(P, block, [[3, 40, 2]]).toString(), at(3, -2).toString(), 'a failed spot is skipped')
  put(at(3, 2), 'chest', 'block')   // a chest there: the neighbours that would join it are out
  assert.notStrictEqual(SM.singleSpot(P, block).toString(), at(4, 2).toString())
  assert.notStrictEqual(SM.singleSpot(P, block).toString(), at(3, 1).toString())
})
