// brain/bases: the base record (a waypoint with a radius) and the dug-block log inside it.
const test = require('node:test')
const assert = require('node:assert')
const os = require('os'), fs = require('fs'), path = require('path')
const EE = require('events')
const V = require('vec3')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bases-'))
process.env.BOT_BASES_DIR = DIR
const lib = require('../brain/bases/lib')
const register = require('../brain/bases')
const config = require('../brain/bases/config.json')

const fakeBot = () => {
  const bot = new EE(); bot.username = 'OzoGo444'; bot.spawnPoint = { x: 714.4, z: -2657.2 }
  return bot
}
const blk = (name, x, y, z) => ({ name, position: V(x, y, z) })

test('base ids are stable, readable, and differ per world', () => {
  assert.strictEqual(lib.slug('Chicago'), 'chicago')
  assert.strictEqual(lib.slug('  Sáhara Station! '), 'sahara-station')
  assert.strictEqual(lib.baseId('Chicago', 'spawn 1,2'), lib.baseId('Chicago', 'spawn 1,2'))
  assert.notStrictEqual(lib.baseId('Chicago', 'spawn 1,2'), lib.baseId('Chicago', 'spawn 3,4'))
  assert.match(lib.baseId('Chicago', 'spawn 1,2'), /^chicago-[0-9a-f]{4}$/)
})

test('baseAt: inside the circle at any height, nearest wins, outside is null', () => {
  const a = { id: 'a', x: 0, z: 0, radius: 50 }, b = { id: 'b', x: 60, z: 0, radius: 50 }
  assert.strictEqual(lib.baseAt([a, b], { x: 10, y: -40, z: 0 }).id, 'a')
  assert.strictEqual(lib.baseAt([a, b], { x: 35, y: 10, z: 0 }).id, 'b')       // overlap: closer to b
  assert.strictEqual(lib.baseAt([a, b], { x: 200, y: 10, z: 0 }), null)
  assert.strictEqual(lib.baseAt([], { x: 0, y: 0, z: 0 }), null)
})

test('digLine: plants, trunks and things the bot placed are not "space"; stone is', () => {
  const re = new RegExp(config.ignore)
  assert.deepStrictEqual(JSON.parse(lib.digLine(blk('stone', 1, 2, 3), 'OzoGo444', 99, re, null)), [1, 2, 3, 'stone', 'OzoGo444', 99])
  for (const n of ['oak_log', 'birch_leaves', 'short_grass', 'wheat', 'torch', 'ladder', 'chest', 'oak_fence', 'water', 'dandelion', 'oak_sapling']) {
    assert.strictEqual(lib.digLine(blk(n, 1, 2, 3), 'x', 1, re, null), null, n)
  }
  for (const n of ['cobblestone', 'dirt', 'deepslate', 'gravel', 'iron_ore', 'sand', 'tuff']) assert.ok(lib.digLine(blk(n, 1, 2, 3), 'x', 1, re, null), n)
  // a block the bot placed itself (a plug it takes out again) does not hollow anything
  assert.strictEqual(lib.digLine(blk('cobblestone', 1, 2, 3), 'x', 1, re, () => true), null)
  assert.strictEqual(lib.digLine(null, 'x', 1, re, null), null)
})

test('mergeBase adds, keeps other bases, and reports a change only when something moved', () => {
  const base = { id: 'chicago-1', name: 'Chicago', x: 1, y: 2, z: 3, radius: 110, at: 5 }
  let r = lib.mergeBase({ worlds: { w: { bases: [{ id: 'other', name: 'Other', x: 9, z: 9, radius: 10 }] } } }, 'w', base)
  assert.strictEqual(r.changed, true); assert.strictEqual(r.file.worlds.w.bases.length, 2)
  r = lib.mergeBase(r.file, 'w', { ...base, at: 99 })
  assert.strictEqual(r.changed, false)                                           // same place: no rewrite
  r = lib.mergeBase(r.file, 'w', { ...base, x: 50, at: 99 })
  assert.strictEqual(r.changed, true); assert.strictEqual(r.file.worlds.w.bases.find(b => b.id === 'chicago-1').x, 50)
  assert.strictEqual(r.file.worlds.w.bases.find(b => b.id === 'chicago-1').at, 5)     // keeps when it was first recorded
  assert.strictEqual(lib.mergeBase(null, 'w', base).file.worlds.w.bases.length, 1)
})

test('module: writes the base from the waypoint book and logs digs inside it only', () => {
  const bot = fakeBot()
  const placed = new Set(['5,6,7'])
  bot._placed = { at: (p) => (placed.has(`${p.x},${p.y},${p.z}`) ? { by: 'x' } : null) }
  const book = { load() {}, all: () => [{ name: 'Mumbai', x: 5000, y: 80, z: -600, dim: 0 }, { name: 'Chicago', x: -6023, y: 67, z: -2355, dim: 0 }] }
  const api = { bot, nav: { book }, now: () => 1000, log() {} }
  const h = register(api)
  h._tick.sync()
  const f = JSON.parse(fs.readFileSync(path.join(DIR, 'bases.json'), 'utf8'))
  const bases = f.worlds['spawn 714,-2658'].bases
  assert.strictEqual(bases.length, 1)
  assert.strictEqual(bases[0].name, 'Chicago'); assert.strictEqual(bases[0].radius, config.radius); assert.strictEqual(bases[0].source, 'waypoint')
  assert.strictEqual(bot._bases.at({ x: -6030, y: 12, z: -2350 }).name, 'Chicago')
  assert.strictEqual(bot._bases.at({ x: 0, y: 12, z: 0 }), null)

  h.start()                                           // listens for diggingCompleted
  bot.emit('diggingCompleted', blk('stone', -6018, 30, -2355))
  bot.emit('diggingCompleted', blk('deepslate', -6018, -5, -2356))
  bot.emit('diggingCompleted', blk('stone', 100, 30, 100))             // not in any base
  bot.emit('diggingCompleted', blk('oak_log', -6020, 66, -2350))       // a tree
  bot.emit('diggingCompleted', blk('cobblestone', -6025, 66, -2355))
  h._tick.flush()
  h.stop()
  const id = bases[0].id
  const lines = fs.readFileSync(path.join(DIR, 'base-dug', id + '.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepStrictEqual(lines.map(l => l.slice(0, 4)), [[-6018, 30, -2355, 'stone'], [-6018, -5, -2356, 'deepslate'], [-6025, 66, -2355, 'cobblestone']])
  assert.strictEqual(lines[0][4], 'OzoGo444'); assert.strictEqual(lines[0][5], 1000)
  assert.deepStrictEqual(h.status().dugThisRun, { [id]: 3 })
})

test('module: a placed block the bot digs again is not logged, and a missing waypoint writes nothing', () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true })
  const bot = fakeBot()
  bot._placed = { at: () => ({ by: 'OzoGo444' }) }
  const h = register({ bot, nav: { book: { load() {}, all: () => [{ name: 'Mumbai', x: 1, z: 1, dim: 0 }] } }, now: () => 1, log() {} })
  h._tick.sync()
  assert.ok(!fs.existsSync(path.join(DIR, 'bases.json')))
  assert.deepStrictEqual(bot._bases.list(), [])
  bot.emit('diggingCompleted', blk('stone', 1, 1, 1))                  // no bases: nothing happens
  h._tick.flush()
  assert.ok(!fs.existsSync(path.join(DIR, 'base-dug')))
})

test('the module meta is valid and the module is in the brain list', () => {
  const meta = require('../brain/meta')
  assert.deepStrictEqual(meta.validate(register.meta, null), [])
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'brain', 'index.js'), 'utf8'), /const MODULES = \[[^\]]*'bases'/)
})
