// brain/treefarm/farm.js on the mock bench (same rig as treefarm.test.js): site pick, saplings from leaves, planting, lighting, upkeep,
// harvesting only the lattice trees, and the keep-natural-trees policy.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { rig, growTree, blockName, fakeCtx } = require('./treefarm.helpers')
const L = require('../brain/treefarm/layout')

const INV = { torch: 64, dirt: 20, iron_axe: 1, birch_sapling: 6 }
const mk = (o = {}) => rig({ inv: INV, ...o, config: { ...(o.config || {}) } })
const ctx = () => fakeCtx()
const spotsOf = (f) => L.spots(f)
const count = (r, name) => { let n = 0; for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) for (let y = 60; y <= 80; y++) if (r.bot.blockAt(new Vec3(x, y, z)).name === name) n++; return n }

test('build: picks level ground near home, plants startSaplings birch on the lattice, lights it, registers the site, saves state', async () => {
  const r = mk(); const { bot, engine, state } = r
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.ok(out.ok, JSON.stringify(out))
  assert.strictEqual(out.created, true)
  assert.strictEqual(out.planted, 4, 'startSaplings = 4')
  const f = state.farms[0]
  assert.strictEqual(f.species, 'birch'); assert.strictEqual(f.spacing, 4)
  const saplings = spotsOf(f).filter(s => blockName(bot, s.x, s.y, s.z) === 'birch_sapling')
  assert.strictEqual(saplings.length, 4)
  assert.ok(saplings.every(s => (s.x - f.x) % 4 === 0 && (s.z - f.z) % 4 === 0))
  assert.strictEqual(count(r, 'torch'), 20, 'a torch in the middle of every square, ring included')
  for (const t of L.torchCells(f)) assert.strictEqual(blockName(bot, t.x, 64, t.z), 'torch', `torch at ${t.x},${t.z}`)
  assert.strictEqual(state.sites.filter(s => s.farm === f.id).length, 1)
  assert.strictEqual(state.sites[0].species, 'birch')
  assert.strictEqual(bot.losViolations.length, 0, 'every placement had a clear ray')
  assert.ok(out.status.torches === 20 && out.status.saplings === 4)
  r.stop()
})

test('build again: nothing new is created, the next 0 saplings are not planted over a full start, torches are not doubled', async () => {
  const r = mk(); const { engine, state } = r
  await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  const torches1 = count(r, 'torch')
  const out = await engine.farm.build(ctx(), { quiet: true })
  assert.strictEqual(state.farms.length, 1)
  assert.strictEqual(out.created, false)
  assert.strictEqual(count(r, 'torch'), torches1)
  r.stop()
})

test('the farm keeps off the base, natural trees and water', async () => {
  const r = mk(); const { bot, engine, state } = r
  for (const [x, z] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) growTree(bot, { x, z, h: 5, species: 'oak' })
  for (let x = 6; x <= 16; x++) for (let z = 6; z <= 16; z++) bot.setBlock(x, 63, z, 'water')
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.ok(out.ok, JSON.stringify(out))
  const f = state.farms[0], b = L.bounds(f)
  for (const [x, z] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) assert.ok(!(x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1), `tree at ${x},${z} outside the farm`)
  assert.ok(!(b.x1 >= 6 && b.x0 <= 16 && b.z1 >= 6 && b.z0 <= 16), 'not on the pond')
  assert.strictEqual(count(r, 'oak_log'), 20, 'no tree was touched')
  r.stop()
})

test('no site: honest refusal with a hint, nothing placed', async () => {
  const r = mk(); const { bot, engine } = r
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) bot.setBlock(x, 63, z, 'stone')
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.strictEqual(out.ok, false); assert.ok(/no level clear ground/.test(out.why)); assert.ok(out.hint)
  assert.strictEqual(count(r, 'torch'), 0)
  r.stop()
})

test('saplings come from the LEAVES of a natural birch (the trunk stays), a few leaves per tree, then the farm is planted', async () => {
  const r = mk({ inv: { torch: 64, dirt: 10 } }); const { bot, engine, state } = r
  const trunk = growTree(bot, { x: 30, z: 30, h: 6, species: 'birch' })
  // a sapling drops from every 4th broken leaf (the real chance is about 5 percent)
  const baseDig = bot.dig; let leaves = 0
  bot.dig = async (b, f) => { const leaf = /_leaves$/.test(b.name); await baseDig(b, f); if (leaf && ++leaves % 4 === 0) bot.addItemEntity(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5, 'birch_sapling', 1) }
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.ok(out.planted >= 1, JSON.stringify(out))
  assert.strictEqual(trunk.filter(p => blockName(bot, p.x, p.y, p.z) === 'birch_log').length, trunk.length, 'the tree itself is untouched')
  assert.ok(leaves > 0 && leaves <= 12 + 4, `a few leaves only (${leaves})`)
  assert.strictEqual(state.stats.leavesBroken, leaves)
  assert.strictEqual(Object.values(bot.entities).filter(e => e.name === 'item').length, 0, 'drops are picked up')
  assert.strictEqual(bot.losViolations.length, 0)
  r.stop()
})

test('no birch within reach but an oak wood: the farm becomes an oak farm, saplings come from oak leaves, planting stays strict', async () => {
  const r = mk({ inv: { torch: 64, dirt: 10 } }); const { bot, engine, state } = r
  const trunk = growTree(bot, { x: 30, z: 30, h: 6, species: 'oak' })
  const baseDig = bot.dig; let leaves = 0
  bot.dig = async (b, f) => { const leaf = /_leaves$/.test(b.name); await baseDig(b, f); if (leaf && ++leaves % 4 === 0) bot.addItemEntity(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5, 'oak_sapling', 1) }
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.ok(out.ok && out.planted >= 1, JSON.stringify(out))
  const f = state.farms[0]
  assert.strictEqual(f.species, 'oak'); assert.strictEqual(state.sites[0].species, 'oak')
  assert.ok(spotsOf(f).some(s => blockName(bot, s.x, s.y, s.z) === 'oak_sapling'))
  assert.ok(spotsOf(f).every(s => !/birch/.test(blockName(bot, s.x, s.y, s.z))))
  assert.strictEqual(trunk.filter(p => blockName(bot, p.x, p.y, p.z) === 'oak_log').length, trunk.length, 'the oak itself is untouched')
  r.stop()
})

test('species choice: the configured one wins when it has a source, saplings in the bag count, an explicit species is honoured, big ones are never used', async () => {
  const pick = async (inv, trees, opt) => {
    const r = mk({ inv }); for (const t of trees) growTree(r.bot, { x: t.x, z: 30, h: 6, species: t.sp })
    const p = (await r.engine.farm.create(ctx(), { home: { x: 0, y: 64, z: 0 }, ...opt })).species; r.stop(); return p
  }
  assert.strictEqual((await pick({}, [{ x: 30, sp: 'oak' }, { x: -30, sp: 'birch' }])).species, 'birch', 'birch leaves in range: birch, whatever else grows around')
  assert.strictEqual((await pick({ oak_sapling: 3 }, [])).species, 'oak', 'no birch source, oak saplings in the bag')
  assert.strictEqual((await pick({ birch_sapling: 1 }, [{ x: 30, sp: 'oak' }])).species, 'birch', 'a birch sapling in the bag beats oak leaves')
  assert.strictEqual((await pick({}, [{ x: 30, sp: 'spruce' }])).species, 'spruce', 'falls back past oak (none) to spruce')
  assert.strictEqual((await pick({}, [{ x: 30, sp: 'dark_oak' }])).species, 'birch', 'dark oak is never chosen: with no source it stays on the configured species')
  assert.strictEqual((await pick({}, [{ x: -30, sp: 'birch' }, { x: 30, sp: 'oak' }], { species: 'oak' })).species, 'oak', 'an explicit species with a source is used')
  assert.strictEqual((await pick({}, [{ x: -30, sp: 'birch' }], { species: 'oak' })).species, 'birch', 'an explicit species with no source falls back')
})

test('no saplings and no leaves of any usable species: stays on birch and says what to do instead of idling', async () => {
  const r = mk({ inv: { torch: 64 } }); const { engine, state } = r
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.strictEqual(out.planted, 0)
  assert.strictEqual(state.farms[0].species, 'birch')
  assert.ok(out.needs.some(n => /birch leaves|birch saplings|birch trees/.test(n)), JSON.stringify(out.needs))
  assert.strictEqual(count(r, 'torch'), 20, 'it still lights the farm so saplings planted later grow')
  r.stop()
})

test('no torches: the farm is planted, the missing light is reported', async () => {
  const r = mk({ inv: { birch_sapling: 6, dirt: 4 } }); const { engine } = r
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.strictEqual(out.planted, 4); assert.strictEqual(out.lit, 0)
  assert.ok(out.needs.some(n => /craft torches/.test(n)), JSON.stringify(out.needs))
  r.stop()
})

test('tend: replants an emptied spot, relights a missing torch, picks up the sapling that fell from the leaves', async () => {
  const r = mk({ inv: { ...INV, birch_sapling: 8 } }); const { bot, engine, state } = r
  await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  const f = state.farms[0], sp = spotsOf(f)
  bot.setBlock(sp[0].x, 64, sp[0].z, 'air')                                        // a sapling that got eaten / destroyed
  const t = L.torchCells(f)[3]; bot.setBlock(t.x, 64, t.z, 'air')                  // a broken torch
  bot.addItemEntity(f.x + 1, 64.5, f.z + 1, 'birch_sapling', 2)                    // a drop lying in the farm
  const out = await engine.farm.tend(ctx(), { quiet: true })
  assert.ok(out[0].ok)
  assert.strictEqual(blockName(bot, sp[0].x, 64, sp[0].z), 'birch_sapling')
  assert.strictEqual(blockName(bot, t.x, 64, t.z), 'torch')
  assert.strictEqual(Object.values(bot.entities).filter(e => e.name === 'item').length, 0)
  r.stop()
})

test('a grass cell is cleared before its torch goes in (and nothing else is broken)', async () => {
  const r = mk({ inv: { torch: 40, dirt: 4 } }); const { bot, engine } = r
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) bot.setBlock(x, 64, z, 'short_grass')
  const out = await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.strictEqual(out.lit, 20, JSON.stringify(out))
  assert.deepStrictEqual([...new Set(bot.actions.filter(a => a[0] === 'dig').map(a => a[1]))], ['short_grass'])
  r.stop()
})

test('harvest: only grown LATTICE trees are felled (natural trees beside the farm stay), each is replanted with birch, the torches survive', async () => {
  const r = mk({ inv: { ...INV, birch_sapling: 8 } }); const { bot, engine, state } = r
  await engine.farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  const f = state.farms[0], sp = spotsOf(f)
  // two lattice saplings have "grown": a birch of 6 logs stands where the sapling was
  const grown = sp.slice(0, 2).map(s => growTree(bot, { x: s.x, z: s.z, h: 6, species: 'birch' }))
  // a natural oak right outside the rectangle: it must be left alone
  const b = L.bounds(f)
  const oak = growTree(bot, { x: b.x1 + 3, z: b.z0 + 3, h: 6, species: 'oak' })
  bot.give('dirt', 20)
  const before = count(r, 'torch')
  const res = await engine.farm.harvest(ctx(), { logs: 12 })
  assert.ok(res.ok)
  for (const t of grown) assert.strictEqual(t.filter(p => /_log$/.test(blockName(bot, p.x, p.y, p.z))).length, 0, 'lattice tree felled')
  assert.strictEqual(oak.filter(p => blockName(bot, p.x, p.y, p.z) === 'oak_log').length, oak.length, 'the natural oak is kept')
  for (const s of sp.slice(0, 2)) assert.strictEqual(blockName(bot, s.x, 64, s.z), 'birch_sapling', 'replanted with birch')
  assert.strictEqual(bot.count('birch_log'), 12)
  assert.strictEqual(count(r, 'torch'), before)
  assert.strictEqual(bot.losViolations.length, 0)
  r.stop()
})

test('naturalPolicy: natural trees may only be felled as bootstrap, never once the farm has grown trees', async () => {
  const r = mk({ inv: { ...INV, birch_sapling: 8 } }); const { bot, engine, state } = r
  const farm = engine.farm
  assert.strictEqual(farm.naturalPolicy({ logs: 0 }).natural, true, 'no farm yet: the old behaviour')
  await farm.build(ctx(), { home: { x: 0, y: 64, z: 0 }, quiet: true })
  assert.strictEqual(farm.naturalPolicy({ logs: 3 }).natural, true, 'farm planted, nothing grown, short of wood: bootstrap')
  assert.strictEqual(farm.naturalPolicy({ logs: 40 }).natural, false, 'enough wood in the bag')
  const spots = spotsOf(state.farms[0])
  growTree(bot, { x: spots[0].x, z: spots[0].z, h: 6, species: 'birch' })
  assert.strictEqual(farm.naturalPolicy({ logs: 0 }).natural, true, 'one grown tree gives a few logs only: still short of wood, natural trees allowed')
  for (const s of spots.slice(1, 4)) growTree(bot, { x: s.x, z: s.z, h: 6, species: 'birch' })
  const p = farm.naturalPolicy({ logs: 0 })
  assert.strictEqual(p.natural, false); assert.ok(/harvest/.test(p.why))
  r.stop()
})

test('chat: "build a tree farm" starts the lit farm; "tree farm here" still marks a site', () => {
  const reg = require('../brain/treefarm')
  const P = reg.phrases
  assert.ok(P.FARM.test('build a tree farm') && P.FARM.test('start a lit birch tree farm') && P.FARM.test('tend the tree farm'))
  assert.ok(!P.FARM.test('tree farm here') && !P.FARM.test('chop trees') && !P.FARM.test('how is the tree farm'))
})
