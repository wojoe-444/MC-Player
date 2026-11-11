// dashboard/worldcast.js: the open space around a base, read from a (synthetic) Anvil region file, and how basecast.js turns it into the cast.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'worldcast-'))
process.env.BOT_WORLD_SAVES = path.join(ROOT, 'saves')
const wc = require('../dashboard/worldcast')
const bc = require('../dashboard/basecast')

// ---- a tiny NBT writer (the reader is what is under test, so the writer is independent of it)
const tag = { byte: 1, int: 3, long: 4, string: 8, list: 9, compound: 10, longs: 12 }
function w(t, v) {
  switch (t) {
    case 'byte': return Buffer.from([v & 255])
    case 'int': { const b = Buffer.alloc(4); b.writeInt32BE(v); return b }
    case 'string': { const s = Buffer.from(v, 'utf8'), b = Buffer.alloc(2); b.writeUInt16BE(s.length); return Buffer.concat([b, s]) }
    case 'longs': { const b = Buffer.alloc(4 + v.length * 8); b.writeInt32BE(v.length); v.forEach((x, i) => b.writeBigUInt64BE(BigInt.asUintN(64, x), 4 + i * 8)); return b }
    case 'list': { const [it, items] = v; const head = Buffer.alloc(5); head[0] = tag[it]; head.writeInt32BE(items.length, 1); return Buffer.concat([head, ...items.map(x => w(it, x))]) }
    case 'compound': return Buffer.concat([...Object.entries(v).map(([k, [tt, vv]]) => Buffer.concat([Buffer.from([tag[tt]]), w('string', k), w(tt, vv)])), Buffer.from([0])])
  }
}
// a section whose blocks come from fn(x, y, z) -> block name (x, y, z local 0..15)
function section(Y, fn) {
  const names = [], ids = new Uint16Array(4096)
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const n = fn(x, y + Y * 16, z); let i = names.indexOf(n); if (i < 0) { names.push(n); i = names.length - 1 }
    ids[x + 16 * (z + 16 * y)] = i
  }
  const bits = Math.max(4, Math.ceil(Math.log2(names.length))), per = Math.floor(64 / bits), longs = []
  for (let i = 0; i < 4096; i += per) { let v = 0n; for (let k = 0; k < per && i + k < 4096; k++) v |= BigInt(ids[i + k]) << BigInt(k * bits); longs.push(v) }
  const bs = { palette: ['list', ['compound', names.map(n => ({ Name: ['string', n] }))]] }
  if (names.length > 1) bs.data = ['longs', longs]
  return { Y: ['byte', Y], block_states: ['compound', bs] }
}
function regionFile(chunks) {                                            // chunks: Map "cx,cz" -> sections[]
  const header = Buffer.alloc(8192), bodies = []
  let sector = 2
  for (const [k, secs] of chunks) {
    const [cx, cz] = k.split(',').map(Number)
    const nbt = Buffer.concat([Buffer.from([10]), w('string', ''), w('compound', { sections: ['list', ['compound', secs]], Status: ['string', 'minecraft:full'] })])
    const z = zlib.deflateSync(nbt), len = Buffer.alloc(5); len.writeInt32BE(z.length + 1); len[4] = 2
    let body = Buffer.concat([len, z]); const n = Math.ceil(body.length / 4096); body = Buffer.concat([body, Buffer.alloc(n * 4096 - body.length)])
    header.writeUIntBE(sector, ((cx & 31) + (cz & 31) * 32) * 4, 3); header[((cx & 31) + (cz & 31) * 32) * 4 + 3] = n
    bodies.push(body); sector += n
  }
  return Buffer.concat([header, ...bodies])
}

// stone from y -64..47, a one-wide shaft at (8, 20..47, 8), a 1 x 2 tunnel along +x from (8,20,8) to (14,20,8), and a pocket at (3,30,3) that joins nothing
const open = new Set()
for (let y = 20; y <= 47; y++) open.add(`8,${y},8`)
for (let x = 8; x <= 14; x++) { open.add(`${x},20,8`); open.add(`${x},21,8`) }
open.add('3,30,3'); open.add('3,31,3')
const world = (x, y, z) => (y > 47 ? 'minecraft:air' : open.has(`${x},${y},${z}`) ? (x === 10 && y === 20 ? 'minecraft:torch' : 'minecraft:air') : 'minecraft:stone')
function makeSave(name) {
  const secs = []; for (let Y = -4; Y <= 3; Y++) secs.push(section(Y, (x, y, z) => world(x, y, z)))
  const dir = path.join(ROOT, 'saves', name, 'region'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'r.0.0.mca'), regionFile(new Map([['0,0', secs]])))
  return dir
}

test('parseNbt and the region reader read sections back; scanBase marks open and solid cells and the ground height', () => {
  const dir = makeSave('Test World')
  const scan = wc.scanBase({ regionDir: dir, x: 8, z: 8, radius: 7 })
  assert.strictEqual(scan.chunks, 1)
  const b = scan.box, at = (x, y, z) => scan.grid[(x - b.x0) + b.W * ((z - b.z0) + b.D * (y - b.y0))]
  assert.strictEqual(at(8, 25, 8), 1); assert.strictEqual(at(9, 25, 8), 0); assert.strictEqual(at(12, 20, 8), 1); assert.strictEqual(at(12, 22, 8), 0)
  assert.strictEqual(at(10, 20, 8), 1)                                     // a torch is open space
  assert.strictEqual(at(8, 60, 8), 1)                                      // the sky
  assert.strictEqual(scan.top[(9 - b.x0) + b.W * (8 - b.z0)], 47)         // stone to y 47 beside the shaft
  assert.strictEqual(scan.top[(8 - b.x0) + b.W * (8 - b.z0)], 19)         // the shaft column's own highest stone is below the shaft
})

test('cavityFrom: reaches the tunnel and the shaft up to the ground, not the sky, not the pocket, nothing outside the circle', () => {
  const dir = makeSave('Test World 2')
  const scan = wc.scanBase({ regionDir: dir, x: 8, z: 8, radius: 7 })
  const cav = wc.cavityFrom(scan, [[8, 25, 8]], { x: 8, z: 8, radius: 7 })
  const b = scan.box, at = (x, y, z) => cav.cells[(x - b.x0) + b.W * ((z - b.z0) + b.D * (y - b.y0))]
  assert.strictEqual(at(14, 20, 8), 1)
  assert.strictEqual(at(8, 46, 8), 1)                                      // the shaft up to the ground
  assert.strictEqual(at(8, 49, 8), 0)                                      // above the ground: sky
  assert.strictEqual(at(3, 30, 3), 0)                                      // the pocket is not connected
  assert.strictEqual(cav.count, 27 + 12)                                   // shaft y20..46 plus the 12 tunnel cells beyond it
  const small = wc.cavityFrom(scan, [[8, 25, 8]], { x: 8, z: 8, radius: 4 })
  assert.ok(small.count < cav.count)                                       // x 13 and 14 are outside radius 4
  assert.strictEqual(wc.cavityFrom(scan, [[9, 25, 8]], { x: 8, z: 8, radius: 7 }).count, 0)   // a seed in rock starts nothing
})

test('buildCast with a save: the open space becomes parts (shaft kept, bot-worked tunnel, natural cave), registry cells that are not open are dropped', () => {
  makeSave('Chicago Test')
  const reg = path.join(ROOT, 'shared', 'registry.json'); fs.mkdirSync(path.dirname(reg), { recursive: true })
  fs.writeFileSync(reg, JSON.stringify({ worlds: { w: { shafts: [{ id: 'sh', by: 'OzoGo444', entry: [8, 47, 8], bottom: [8, 20, 8] }],
    rooms: [{ id: 'storage-sh', type: 'storage', shaft: 'sh', box: { x0: 30, x1: 32, y0: 40, y1: 41, z0: 8, z1: 8 }, y: 40, chests: [] }] } } }))
  fs.writeFileSync(path.join(ROOT, 'shared', 'placed-blocks.json'), JSON.stringify({ worlds: { w: { '10,20,8': ['torch', 'OzoGo444', 1] } } }))
  const base = { id: 'b', name: 'Test', x: 8, y: 48, z: 8, radius: 20, world: 'w', save: 'Chicago Test' }
  const c = bc.buildCast({ base, sharedDir: path.join(ROOT, 'shared'), registryFile: reg, botDirs: [], codeDir: null })
  const byId = Object.fromEntries(c.parts.map(p => [p.id, p]))
  assert.strictEqual(byId.sh.cells, 27)                                   // the shaft as built in the save, up to the ground
  assert.strictEqual(byId['storage-sh'].cells, 0)                         // designed but not in the save: dropped
  assert.strictEqual(byId['world-tunnels'].kind, 'tunnel'); assert.strictEqual(byId['world-tunnels'].cells, 8)     // x 9..12 at two heights: within 2 blocks of the torch
  assert.strictEqual(byId['world-caves'].kind, 'cave'); assert.strictEqual(byId['world-caves'].cells, 4)          // x 13 and 14: open, joined, but nobody worked there
  assert.strictEqual(c.sources.world.save, 'Chicago Test'); assert.strictEqual(c.sources.world.chunks, 1)
  assert.match(c.notes.join(' '), /not open in the saved world/)
  assert.match(c.notes.join(' '), /read from the world save/)
  // no save at all: back to the registry's own design
  const none = bc.buildCast({ base: { ...base, save: 'nope', x: 99999 }, sharedDir: path.join(ROOT, 'shared'), registryFile: reg, botDirs: [], codeDir: null })
  assert.strictEqual(none.sources.world, null)
})
