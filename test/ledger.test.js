// brain/ledger: the provenance ledger. Pure store and journal first, then the module against a fake bot (wire packets, server block updates, mineflayer events).
const test = require('node:test')
const assert = require('node:assert')
const os = require('os'), fs = require('fs'), path = require('path')
const EE = require('events')
const { Vec3 } = require('vec3')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
process.env.BOT_LEDGER_DIR = path.join(DIR, 'ledger')
process.env.BOT_REGISTRY = path.join(DIR, 'registry.json')
const lib = require('../brain/ledger/lib')
const scope = require('../brain/ledger/scope')
const register = require('../brain/ledger')

const rec = (o) => ({ t: 1000, op: 'p', x: 1, y: 2, z: 3, block: 'cobblestone', by: 'OzoGo444', space: null, via: null, ...o })
const storeWith = (...recs) => { const s = new lib.Store(); s.bots.add('OzoGo444'); s.bots.add('Smeo444'); s.apply({ t: 1, op: 'B', by: 'OzoGo444' }); for (const r of recs) s.apply(r); return s }

test('store: newest record wins in any order, a tie goes to the one that names a space, a cell keeps its space', () => {
  const s = storeWith()
  assert.ok(s.apply(rec({ t: 5, op: 'p', space: 'room-1' })))
  assert.ok(!s.apply(rec({ t: 4, op: 'd' })), 'older loses')
  assert.ok(s.apply(rec({ t: 9, op: 'd', block: 'cobblestone' })))
  assert.strictEqual(s.get(1, 2, 3).op, 'd')
  assert.strictEqual(s.get(1, 2, 3).space, 'room-1', 'taking a plug out of a room is still the room\'s work')
  assert.strictEqual(s.inSpace('room-1').length, 1)
  assert.ok(s.apply(rec({ t: 9, op: 'd', space: 'room-2' })) && s.get(1, 2, 3).space === 'room-2', 'tie: the one naming a space wins')
  assert.strictEqual(s.inSpace('room-1').length, 0)
  assert.ok(!s.apply({ op: 'p', x: 'a', y: 1, z: 1, t: 1 }) && !s.apply(null) && !s.apply({ t: 1, op: 'zz', x: 1, y: 1, z: 1 }))
})

test('whoMade: ours, dug by us, unrecorded, replaced by someone else, appeared from nowhere', () => {
  const s = storeWith(rec({ x: 0, y: 0, z: 0, space: 'farm-1' }), rec({ x: 1, y: 0, z: 0, op: 'd', block: 'stone' }), rec({ x: 3, y: 0, z: 0, op: 'f', block: 'dirt', by: 'other' }), rec({ x: 4, y: 0, z: 0, by: 'Smeo444' }))
  let v = s.whoMade(0, 0, 0, 'cobblestone', 'OzoGo444')
  assert.deepStrictEqual([v.verdict, v.ours, v.mine, v.space], ['placed-by-us', true, true, 'farm-1'])
  v = s.whoMade(4, 0, 0, 'cobblestone', 'OzoGo444'); assert.deepStrictEqual([v.verdict, v.ours, v.mine], ['placed-by-us', true, false], 'the other bot of ours')
  v = s.whoMade(1, 0, 0, 'air', 'OzoGo444'); assert.deepStrictEqual([v.verdict, v.ours], ['dug-by-us', true])
  v = s.whoMade(1, 0, 0, 'dirt', 'OzoGo444'); assert.deepStrictEqual([v.verdict, v.ours, v.wasOurs], ['changed-since', false, true], 'we dug it, then something filled it')
  v = s.whoMade(0, 0, 0, 'dirt', 'OzoGo444'); assert.deepStrictEqual([v.verdict, v.ours], ['changed-since', false], 'we placed cobblestone, dirt stands there')
  v = s.whoMade(9, 9, 9, 'stone', 'OzoGo444'); assert.deepStrictEqual([v.verdict, v.ours], ['unrecorded', false])
  assert.match(v.why, /since 1970/)
  v = s.whoMade(3, 0, 0, 'dirt', 'OzoGo444'); assert.deepStrictEqual([v.verdict, v.ours, v.by], ['placed-by-other', false, 'other'])
  v = s.whoMade(0, 0, 0, null, 'OzoGo444'); assert.strictEqual(v.verdict, 'placed-by-us', 'an unloaded chunk cannot contradict the record')
})

test('spatial queries: near, box and space across chunk borders', () => {
  const s = storeWith(rec({ x: 15, z: 15, space: 'a' }), rec({ x: 16, z: 16, space: 'a' }), rec({ x: -1, z: -1, y: 70, space: 'b' }), rec({ x: 500, z: 500 }))
  assert.strictEqual(s.near({ x: 15, y: 2, z: 15 }, 2).length, 2)
  assert.strictEqual(s.near({ x: 0, y: 2, z: 0 }, 1).length, 0)
  assert.strictEqual(s.inBox({ x0: -2, x1: 2, y0: 60, y1: 80, z0: -2, z1: 2 }).length, 1)
  const sum = s.summary().find(r => r.id === 'a')
  assert.deepStrictEqual([sum.placed, sum.dug, sum.byBot.OzoGo444, sum.box.x0, sum.box.x1], [2, 0, 2, 15, 16])
})

test('audit: made blocks nobody recorded are foreign; our records that changed are reported', () => {
  const s = storeWith(rec({ x: 0, y: 0, z: 0, block: 'stone_bricks' }), rec({ x: 1, y: 0, z: 0, block: 'hopper' }), rec({ x: 2, y: 0, z: 0, op: 'd', block: 'stone' }))
  const world = { '0,0,0': 'stone_bricks', '1,0,0': 'dirt', '2,0,0': 'air', '3,0,0': 'oak_planks', '4,0,0': 'stone' }
  const a = s.audit({ x0: 0, x1: 4, y0: 0, y1: 0, z0: 0, z1: 0 }, (x, y, z) => world[`${x},${y},${z}`] || null)
  assert.deepStrictEqual(a.foreign.map(f => f.block), ['oak_planks'])
  assert.deepStrictEqual(a.changed.map(c => [c.expected, c.found]), [['hopper', 'dirt']])
  assert.deepStrictEqual(a.ours, { placed: 1, dug: 1 })
})

test('registry geometry: a room beats the shaft it hangs off; outside is null', () => {
  const defs = lib.defsFromRegistry({ shafts: [{ id: 'sh1', entry: [10, 70, 10], bottom: [10, 40, 10] }], rooms: [{ id: 'rm1', type: 'storage', box: { x0: 8, x1: 14, y0: 40, y1: 43, z0: 8, z1: 14 } }, { id: 'mf1', type: 'mobfarm', box: { x0: 20, x1: 30, y0: 30, y1: 40, z0: 20, z1: 30 } }] })
  assert.strictEqual(lib.spaceAt(defs, 10, 60, 10).id, 'sh1')
  assert.strictEqual(lib.spaceAt(defs, 10, 41, 10).id, 'rm1')
  assert.strictEqual(lib.spaceAt(defs, 25, 35, 25).kind, 'mobfarm')
  assert.strictEqual(lib.spaceAt(defs, 100, 60, 100), null)
})

test('journal: two writers see each other, a restart reloads, compaction keeps only the newest word on each cell', () => {
  const dir = path.join(DIR, 'j1')
  const a = new lib.Journal({ dir, writer: 'OzoGo444' }), b = new lib.Journal({ dir, writer: 'Smeo444' })
  const sa = storeWith(), sb = storeWith()
  const wa = (r) => { sa.apply(r, 'OzoGo444'); a.append(r) }
  wa(rec({ t: 10, x: 1 })); wa(rec({ t: 11, x: 1, op: 'd' })); wa(rec({ t: 12, x: 2, space: 's' }))
  a.flush()
  b.load(sb)
  assert.strictEqual(sb.size, 2, 'b learns a\'s two cells')
  assert.strictEqual(sb.get(1, 2, 3).op, 'd'); assert.strictEqual(sb.get(2, 2, 3).space, 's')
  b.load(sb); assert.strictEqual(b.load(sb), 0, 'a second read finds nothing new')
  // a restart: a fresh store reads the file back
  const sc = new lib.Store(), c = new lib.Journal({ dir, writer: 'OzoGo444' })
  c.load(sc)
  assert.strictEqual(sc.size, 2); assert.strictEqual(sc.get(1, 2, 3).op, 'd')
  // b overwrites a cell of a's later; a compacts and the stale line is gone
  const r = rec({ t: 50, x: 2, op: 'f', block: 'dirt', by: 'other' }); sb.apply(r, 'Smeo444'); b.append(r); b.flush()
  a.load(sa)
  assert.strictEqual(sa.get(2, 2, 3).op, 'f')
  const lines = fs.readFileSync(path.join(dir, 'OzoGo444.jsonl'), 'utf8').trim().split('\n').length
  const kept = a.compact(sa)
  assert.ok(kept < lines, `${kept} < ${lines}`)
  const sd = new lib.Store(); new lib.Journal({ dir, writer: 'Zed' }).load(sd)
  assert.strictEqual(sd.get(1, 2, 3).op, 'd'); assert.strictEqual(sd.get(2, 2, 3).op, 'f')
})

// ---------- the module ----------
const fakeBot = () => {
  const bot = new EE(); bot.username = 'OzoGo444'; bot.spawnPoint = { x: 714.4, z: -2657.2 }
  bot.entity = { position: new Vec3(0, 60, 0) }
  bot.sent = []; bot._client = { write(name, params) { bot.sent.push([name, params]) } }
  bot.world = new Map(); bot.blockAt = (p) => ({ name: bot.world.get(`${p.x},${p.y},${p.z}`) || 'air', position: p })
  bot.players = {}
  return bot
}
const mk = (opt = {}) => {
  const bot = fakeBot(); let t = 100000
  const mod = register({ bot, now: () => t, log() {}, statePath: (f) => path.join(DIR, 'state-' + (opt.id || 'x'), f), scheduler: { running: { name: 'mining' } } })
  mod.start()
  return { bot, mod, tick: (ms) => { t += ms }, L: bot._ledger, stop: () => mod.stop() }
}
const block = (name, x, y, z, extra = {}) => ({ name, position: new Vec3(x, y, z), ...extra })
const set = (bot, x, y, z, name) => { bot.world.set(`${x},${y},${z}`, name) }
const update = (bot, x, y, z, from, to, extra) => { set(bot, x, y, z, to); bot.emit('blockUpdate', from ? block(from, x, y, z) : null, block(to, x, y, z, extra)) }

test('module: a raw block_dig packet (no mineflayer event) is recorded from the server\'s block update', () => {
  const { bot, L, stop } = mk({ id: 'raw' })
  bot._client.write('block_dig', { status: 0, location: new Vec3(5, 50, 5), face: 1 })
  update(bot, 5, 50, 5, 'stone', 'air')
  const r = L.at(new Vec3(5, 50, 5))
  assert.deepStrictEqual([r.op, r.block, r.by, r.via], ['d', 'stone', 'OzoGo444', 'mining'])
  assert.strictEqual(bot.sent.length, 1, 'the packet still went out')
  assert.strictEqual(L.whoMade(new Vec3(5, 50, 5)).verdict, 'dug-by-us')
  // the start+cancel "punch" of the tunnel resync is not a dig
  bot._client.write('block_dig', { status: 0, location: new Vec3(6, 50, 5), face: 1 }); bot._client.write('block_dig', { status: 1, location: new Vec3(6, 50, 5), face: 1 })
  update(bot, 6, 50, 5, 'stone', 'air')
  assert.strictEqual(L.at(new Vec3(6, 50, 5)), null, 'a cell that opened with no dig of ours is not ours')
  stop()
})

test('module: diggingCompleted and blockUpdate for one dig make one record; placing records a place with the face offset', () => {
  const { bot, L, stop } = mk({ id: 'dedupe' })
  bot._client.write('block_dig', { status: 0, location: new Vec3(1, 50, 1), face: 1 }); bot._client.write('block_dig', { status: 2, location: new Vec3(1, 50, 1), face: 1 })
  bot.emit('diggingCompleted', block('iron_ore', 1, 50, 1)); update(bot, 1, 50, 1, 'iron_ore', 'air')
  const before = bot._ledger._tick.flush(); assert.strictEqual(before, 1, 'one line, not two')
  // place a torch on the top face of (2,49,2): the cell is (2,50,2)
  bot._client.write('block_place', { hand: 0, location: new Vec3(2, 49, 2), direction: 1 })
  update(bot, 2, 50, 2, 'air', 'torch')
  const r = L.at(new Vec3(2, 50, 2)); assert.deepStrictEqual([r.op, r.block, r.by], ['p', 'torch', 'OzoGo444'])
  stop()
})

test('module: the enderman case. A block that appears with no placement of ours is not ours; one of ours swapped by someone else is flagged', () => {
  const { bot, L, stop } = mk({ id: 'ender' })
  bot._client.write('block_place', { hand: 0, location: new Vec3(0, 49, 0), direction: 1 })
  update(bot, 0, 50, 0, 'air', 'cobblestone')
  assert.strictEqual(L.isOurs(new Vec3(0, 50, 0)), true)
  update(bot, 9, 50, 9, 'air', 'grass_block')                                   // an enderman puts a block down
  let v = L.whoMade(new Vec3(9, 50, 9)); assert.deepStrictEqual([v.ours, v.verdict, v.by], [false, 'placed-by-other', 'other'])
  update(bot, 0, 50, 0, 'cobblestone', 'dirt')                                   // and swaps one of ours
  v = L.whoMade(new Vec3(0, 50, 0)); assert.deepStrictEqual([v.ours, v.verdict, v.wasOurs], [false, 'changed-since', true])
  update(bot, 11, 50, 11, 'air', 'oak_leaves'); update(bot, 12, 50, 11, 'water', 'ice'); update(bot, 13, 50, 11, 'air', 'sand')
  for (const x of [11, 12, 13]) assert.strictEqual(L.at(new Vec3(x, 50, 11)), null, 'leaves, ice and falling sand are nobody\'s placement')
  update(bot, 20, 50, 20, 'air', 'water', { metadata: 3 })                      // a flow
  assert.strictEqual(L.at(new Vec3(20, 50, 20)), null)
  stop()
})

test('module: a player who swung an arm nearby is named on the block they placed', () => {
  const { bot, L, stop } = mk({ id: 'walter' })
  bot.emit('entitySwingArm', { type: 'player', username: 'OGWO', position: new Vec3(30, 50, 30) })
  update(bot, 31, 50, 30, 'air', 'oak_planks')
  assert.strictEqual(L.at(new Vec3(31, 50, 30)).by, 'OGWO'); assert.strictEqual(L.isOurs(new Vec3(31, 50, 30)), false)
  stop()
})

test('module: bucket water sources are placed by us, flows are not; picking it up is a dig', () => {
  const { bot, L, stop } = mk({ id: 'bucket' })
  bot.entity.position = new Vec3(40, 50, 40)
  bot._client.write('use_item', { hand: 0 })
  update(bot, 41, 50, 40, 'air', 'water', { metadata: 0 }); update(bot, 42, 50, 40, 'air', 'water', { metadata: 1 })
  assert.deepStrictEqual([L.at(new Vec3(41, 50, 40)).op, L.at(new Vec3(42, 50, 40))], ['p', null])
  stop()
})

test('module: the job\'s declared scope names the space, geometry fills the rest, a later registry record claims what was dug before it existed', () => {
  const { bot, L, tick, stop } = mk({ id: 'space' })
  scope.within({ id: 'tree-3', kind: 'farm', label: 'Tree farm 3' }, () => { bot._client.write('block_place', { hand: 0, location: new Vec3(70, 59, 70), direction: 1 }) })
  update(bot, 70, 60, 70, 'air', 'birch_sapling')
  assert.strictEqual(L.at(new Vec3(70, 60, 70)).space, 'tree-3', 'the scope was read when the packet was sent, not when the server answered')
  assert.deepStrictEqual(L.spaces().find(s => s.id === 'tree-3').kind, 'farm')
  // a room dug before it is in the registry: no space yet
  bot._client.write('block_dig', { status: 0, location: new Vec3(100, 40, 100), face: 1 }); update(bot, 100, 40, 100, 'stone', 'air')
  assert.strictEqual(L.at(new Vec3(100, 40, 100)).space, null)
  fs.writeFileSync(process.env.BOT_REGISTRY, JSON.stringify({ worlds: { 'spawn 714,-2658': { shafts: [{ id: 'sh9', entry: [100, 70, 100], bottom: [100, 40, 100] }], rooms: [{ id: 'rm9', type: 'storage', box: { x0: 98, x1: 102, y0: 40, y1: 43, z0: 98, z1: 102 } }] } } }))
  assert.ok(L.reconcile() >= 1)
  assert.strictEqual(L.at(new Vec3(100, 40, 100)).space, 'rm9', 'the room, not the shaft that passes through it')
  // new digs inside the box are filed by geometry straight away
  bot._client.write('block_dig', { status: 0, location: new Vec3(101, 41, 99), face: 1 }); update(bot, 101, 41, 99, 'stone', 'air')
  assert.strictEqual(L.spaceAt(new Vec3(101, 41, 99)), 'rm9')
  assert.strictEqual(L.spaceAt(new Vec3(100, 60, 100)), 'sh9')
  assert.ok(L.space('rm9').dug >= 2)
  tick(1); stop()
})

test('module: a restart and a second bot see the same ledger; the older placed-block log is imported', () => {
  const first = mk({ id: 'persist' })
  first.bot._client.write('block_place', { hand: 0, location: new Vec3(0, 49, 0), direction: 1 }); update(first.bot, 0, 50, 0, 'air', 'chest')
  first.stop()
  const second = mk({ id: 'persist2' })
  assert.strictEqual(second.L.whoMade(new Vec3(0, 50, 0), 'chest').verdict, 'placed-by-us')
  assert.ok(second.L.coverageFrom() > 0)
  second.stop()
  // the old log
  const lib2 = require('../brain/ledger/lib')
  const f = path.join(DIR, 'placed.json'); fs.writeFileSync(f, JSON.stringify({ worlds: { w: { '1,2,3': ['chest', 'OzoGo444', 5], '4,5,6': ['oak_planks', 'OGWO', 6] } } }))
  const s = new lib2.Store(); s.bots.add('OzoGo444')
  assert.strictEqual(lib2.importPlaced(s, f, 'w'), 2)
  assert.strictEqual(s.whoMade(1, 2, 3, 'chest').ours, true); assert.strictEqual(s.whoMade(4, 5, 6, 'oak_planks').ours, false)
})

test('module: digging out a block that was placed is a removal, not a hollowing', () => {
  const { bot, L, stop } = mk({ id: 'plug' })
  bot._client.write('block_place', { hand: 0, location: new Vec3(0, 49, 0), direction: 1 }); update(bot, 0, 50, 0, 'air', 'cobblestone')
  bot._client.write('block_dig', { status: 0, location: new Vec3(0, 50, 0), face: 1 }); update(bot, 0, 50, 0, 'cobblestone', 'air')
  bot.emit('diggingCompleted', block('cobblestone', 0, 50, 0))
  const r = L.at(new Vec3(0, 50, 0)); assert.strictEqual(r.op, 'r')
  assert.deepStrictEqual([L.whoMade(new Vec3(0, 50, 0)).verdict, L.isOurs(new Vec3(0, 50, 0))], ['removed-by-us', true])
  bot._client.write('block_dig', { status: 0, location: new Vec3(0, 51, 0), face: 1 }); update(bot, 0, 51, 0, 'stone', 'air')
  assert.strictEqual(L.at(new Vec3(0, 51, 0)).op, 'd', 'natural stone is a real dig')
  assert.strictEqual(L.space('x'), null)
  stop()
})

test('module: stop puts the client back, and a failing listener never breaks a packet', () => {
  const { bot, stop } = mk({ id: 'unwrap' })
  assert.ok(bot._client.__ledgerWrapped)
  bot._client.write('block_dig', null); bot._client.write('block_place', { location: null })
  assert.strictEqual(bot.sent.length, 2)
  stop(); assert.strictEqual(bot._client.write.__orig, undefined)
})
