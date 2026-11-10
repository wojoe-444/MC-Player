// brain/autopilot/resetgear.js: the reset-gear chest steps against a small fake world (bag, blocks, one container)
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const makeResetgear = require('../brain/autopilot/resetgear')
const SM = require('../brain/storage-model')

function world({ bag = {}, room = {}, night = false, chestAt = null, chestItems = {} } = {}) {
  const typeOf = (n) => n.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100000
  const inv = Object.entries(bag).map(([name, count]) => ({ name, count, type: typeOf(name) }))
  const blocks = new Map(), s = new Vec3(0, 40, 0), at = (k, j, h = 0) => s.offset(k, h, j)
  const put = (c, name, bb) => blocks.set(c.toString(), { name, boundingBox: bb, position: c })
  for (let k = 3; k < 10; k++) for (let j = -2; j <= 2; j++) { put(at(k, j, -1), 'stone', 'block'); put(at(k, j, 0), 'air', 'empty'); put(at(k, j, 1), 'air', 'empty') }
  const P = { at, chestSpots: [[at(4, 2), at(5, 2)], [at(4, -2), at(5, -2)]], torches: [at(3, 0)] }
  const store = new Map()   // chest pos string -> [{ name, count, type }]
  const setChest = (c, items) => { put(c, 'chest', 'block'); store.set(c.toString(), Object.entries(items).map(([name, count]) => ({ name, count, type: typeOf(name) }))) }
  if (chestAt) setChest(chestAt, chestItems)
  const notes = [], saved = []
  const add = (name, n) => { const e = inv.find(i => i.name === name); if (e) e.count += n; else inv.push({ name, count: n, type: typeOf(name) }) }
  const take = (name, n) => { const e = inv.find(i => i.name === name); e.count -= n; if (e.count <= 0) inv.splice(inv.indexOf(e), 1) }
  const countOf = (re) => inv.filter(i => (typeof re === 'string' ? i.name === re : re.test(i.name))).reduce((a, i) => a + i.count, 0)
  const S = {
    bot: { openContainer: async (b) => {
      const list = store.get(b.position.toString()); if (!list) throw new Error('no container')
      return { containerItems: () => list.map(i => ({ ...i })), close() {},
        deposit: async (type, _m, n) => { const it = inv.find(i => i.type === type); take(it.name, n); const e = list.find(i => i.name === it.name); if (e) e.count += n; else list.push({ name: it.name, count: n, type }) },
        withdraw: async (type, _m, n) => { const e = list.find(i => i.type === type); e.count -= n; if (e.count <= 0) list.splice(list.indexOf(e), 1); add(e.name, n) } }
    } },
    goals: {}, v: (x, y, z) => new Vec3(x, y, z), items: () => inv.map(i => ({ ...i })), count: countOf, has: (n) => countOf(n) > 0,
    planks: () => countOf(/_planks$/), logs: () => countOf(/_log$/), isNight: () => night, closeWindows() {}, block: (c) => blocks.get(new Vec3(c.x, c.y, c.z).toString()) || null,
    craft: async (item, n) => {
      if (item === 'chest') { take('oak_planks', 8); add('chest', Math.max(1, n)); return true }
      if (/^stone_(pickaxe|sword)$/.test(item)) { take('cobblestone', item === 'stone_sword' ? 2 : 3); take('oak_planks', 2); add(item, n - countOf(item)); return true }
      return false
    },
    placeAgainst: async (g, dir, name) => { const c = g.position.plus(dir); take(name, 1); setChest(c, {}); return true }
  }
  const rec = { id: 'storage-1', type: 'storage', shaft: 's1', chests: [[4, 40, 2], [5, 40, 2]], ...room }
  const G = { state: {}, note: (m) => notes.push(m), save() {}, storageRoom: () => rec, storagePlan: () => P, storageGo: async () => true, storageClearAbove: async () => true }
  const M = { LD: { putRoom: (r) => saved.push(JSON.parse(JSON.stringify(r))) } }
  const { resetChestStep, restockStep } = makeResetgear(G, S, M, {}, () => {})
  return { G, S, M, room: rec, notes, saved, inv, store, setChest, step: { chest: resetChestStep, restock: restockStep }, at, items: () => Object.fromEntries(inv.map(i => [i.name, i.count])) }
}

test('reset chest: set up on a free single spot, recorded in the room, stocked from the surplus only', async () => {
  const w = world({ bag: { chest: 1, stone_pickaxe: 3, stone_sword: 1, bread: 40, torch: 40, cobblestone: 100 } })
  assert.strictEqual(w.step.chest.need(), true)
  assert.strictEqual(await w.step.chest.run(), true)
  assert.deepStrictEqual(w.room.reset, [3, 40, 2], 'nearest single spot on the +2 wall (the room is walked in at slice 3)')
  assert.strictEqual(SM.roleOf(w.room, w.room.reset), 'reset')
  const inChest = Object.fromEntries(w.store.get(new Vec3(...w.room.reset).toString()).map(i => [i.name, i.count]))
  // bag keeps pickaxe 2 / sword 1 / food 32 / torch 32 / cobble 64: 1 pickaxe, 8 bread, 8 torches, 36 cobblestone are surplus
  assert.deepStrictEqual(inChest, { stone_pickaxe: 1, bread: 8, torch: 8, cobblestone: 36 })
  assert.strictEqual(w.items().stone_pickaxe, 2); assert.strictEqual(w.items().bread, 32); assert.strictEqual(w.items().stone_sword, 1, 'the bag keeps its own sword')
  assert.ok(w.saved.length >= 1 && w.saved.at(-1).reset, 'the registry record carries the chest')
  assert.deepStrictEqual(SM.chestItems(w.room, w.room.reset), inChest, 'contents are tracked')
  assert.strictEqual(w.step.chest.need(), false, 'nothing more to give')
})

test('reset chest: missing stone tools are crafted from spare cobblestone and wood, not from the bag\'s own', async () => {
  const w = world({ bag: { chest: 1, stone_pickaxe: 2, stone_sword: 1, cobblestone: 120, oak_planks: 40 } })
  await w.step.chest.run()
  const inChest = Object.fromEntries(w.store.get(new Vec3(...w.room.reset).toString()).map(i => [i.name, i.count]))
  assert.ok(inChest.stone_sword >= 1 && inChest.stone_pickaxe >= 1, JSON.stringify(inChest))
  assert.ok(w.items().stone_sword >= 1 && w.items().stone_pickaxe >= 2 && w.items().cobblestone >= 64, 'the bag still has its own kit: ' + JSON.stringify(w.items()))
  const poor = world({ bag: { chest: 1, stone_pickaxe: 2, stone_sword: 1, cobblestone: 30, oak_planks: 40 } })
  await poor.step.chest.run()
  assert.strictEqual(poor.items().cobblestone, 30, 'under its own filler: no tools crafted from it')
})

test('reset restock: a bag short of the kit takes the gap, nothing else; a bag with the kit never goes', async () => {
  const chestAt = new Vec3(3, 40, 2)
  const w = world({ bag: { oak_log: 3, dirt: 5 }, room: { reset: [3, 40, 2] }, chestAt, chestItems: { stone_pickaxe: 2, stone_sword: 1, bread: 20, torch: 32, cobblestone: 64, diamond: 4, iron_chestplate: 1 } })
  assert.strictEqual(w.step.restock.need(), true)
  assert.strictEqual(await w.step.restock.run(), true)
  assert.deepStrictEqual(w.items(), { oak_log: 3, dirt: 5, stone_pickaxe: 1, stone_sword: 1, bread: 16, torch: 16, cobblestone: 32 })
  assert.deepStrictEqual(SM.chestItems(w.room, w.room.reset), { stone_pickaxe: 1, bread: 4, torch: 16, cobblestone: 32, diamond: 4, iron_chestplate: 1 })
  w.G.state.resetTakeAt = 0
  assert.strictEqual(w.step.restock.need(), false, 'kitted: no trip')
})

test('reset restock: not at night, not while the chest is known to hold nothing the bag lacks, and no chest means no step', async () => {
  const none = world({ bag: {} })
  assert.strictEqual(none.step.restock.need(), false, 'no reset chest recorded')
  const bare = world({ bag: { bread: 20 }, room: { reset: [3, 40, 2] }, chestAt: new Vec3(3, 40, 2), chestItems: { cobblestone: 64 } })
  SM.observe(bare.room, bare.room.reset, [{ name: 'cobblestone', count: 64 }], 1)
  assert.strictEqual(bare.step.restock.need(), false, 'short of a pickaxe, but the last look found none')
  // the chest was broken: the record is dropped and the step reports false instead of looping
  const gone = world({ bag: {}, room: { reset: [3, 40, 2] } })
  assert.strictEqual(await gone.step.restock.run(), false); assert.strictEqual(gone.room.reset, null)
})

test('the stash records what it saw in a storage chest, and the planner summary lists it', () => {
  const w = world({ bag: {} })
  w.G.storageObserve([4, 40, 2], [{ name: 'raw_iron', count: 12 }, { name: 'coal', count: 3 }])
  const s = w.G.storageSummary()
  assert.strictEqual(s.top_items.raw_iron, 12); assert.strictEqual(s.by_theme[0].theme, 'ore'); assert.strictEqual(s.reset_chest, null)
})
