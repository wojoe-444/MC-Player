// tools/spawn-census.js: read a world save (Anvil region files, the saved light) and say where hostile mobs can spawn around a point, and how
// much of that the bot's mob farm gets. A view for the person running the bots (and for Claude agents debugging a farm), not a sense of the bot.
//
//   node tools/spawn-census.js --save <saves/World> --x -6030 --y 59 --z -2355 [--radius 128] [--player x,y,z]... [--pads] [--json]
//
// Vanilla 1.21 natural spawning, as used here (NaturalSpawner / ChunkMap):
//   * a chunk is eligible while a player is within 128 blocks (horizontal) of it;
//   * every tick an eligible chunk gets ONE attempt: a random column (x,z) in the chunk and a y uniform in [minY .. surfaceHeight + 1];
//   * the cell must have a solid floor and two free cells, block light 0 (monster_spawn_block_light_limit) and sky light <= a roll of 0..7,
//     and must be farther than 24 blocks from EVERY player (3D) and from the world spawn;
//   * a hit pulls a pack of the mob up through a short random walk (ignored here), and the mob cap (70 per 289 eligible chunks) stops it.
// So the chance that one attempt starts in cell c is  1 / (256 * (surface(c.col) + 1 - minY + 1))  times the sky roll, and the share of a
// farm is its cells' summed chance over everybody's. The farm's pads all sit at one y and its columns' range is the whole depth to the surface.
'use strict'
const fs = require('fs')
const path = require('path')
const { readChunk, isSolidName } = require('../dashboard/worldcast')

const MIN_Y = -64
// cells a mob can stand in and breathe at: no collision, no liquid (plants and decorations count: they do not block a spawn)
const FREE = /^minecraft:(air|cave_air|void_air|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|ladder|vine|glow_lichen|cave_vines|cave_vines_plant|[a-z_]*button|redstone_wire|tripwire|string|lever|short_grass|tall_grass|fern|large_fern|dead_bush|[a-z_]*_sapling|[a-z_]*_mushroom|moss_carpet|[a-z_]*_carpet|sculk_vein|rail|powered_rail|detector_rail|activator_rail|snow|leaf_litter|dandelion|poppy|[a-z_]*_flower|small_dripleaf|hanging_roots|spore_blossom|sign|[a-z_]*_wall_sign|[a-z_]*_sign)$/
const isFree = (n) => FREE.test(n)
const isFloor = (n) => isSolidName(n) && !/^minecraft:(bedrock|barrier|leaves|[a-z_]*_leaves|ice|packed_ice|blue_ice|glass|tinted_glass|slime_block|honey_block|spawner)$/.test(n)

// ---- section decode: palette ids, nibbles
function unpackIds(sec) {
  const bs = sec.block_states
  if (!bs || !Array.isArray(bs.palette) || !bs.palette.length) return null
  const names = bs.palette.map(p => p.Name)
  if (names.length === 1 || !bs.data) return { names, ids: null }
  const bits = Math.max(4, Math.ceil(Math.log2(names.length))), per = Math.floor(64 / bits), mask = (1n << BigInt(bits)) - 1n
  const ids = new Uint16Array(4096)
  for (let i = 0; i < 4096; i++) ids[i] = Number((BigInt.asUintN(64, bs.data[Math.floor(i / per)]) >> BigInt((i % per) * bits)) & mask)
  return { names, ids }
}
const nib = (arr, i) => arr ? ((arr[i >> 1] >> ((i & 1) * 4)) & 15) : 0
// the heightmap long array holds 256 values, 9 bits each, 7 per long (no spanning since 1.16)
function heightmap(ch, name) {
  const hm = ch.Heightmaps && ch.Heightmaps[name]; if (!hm) return null
  const out = new Int16Array(256)
  for (let i = 0; i < 256; i++) out[i] = Number((BigInt.asUintN(64, hm[Math.floor(i / 7)]) >> BigInt((i % 7) * 9)) & 511n)
  return out
}

// ---- the world
function openRegions(saveDir) {
  const fds = new Map()
  const fd = (kind, rx, rz) => {
    const k = kind + rx + ',' + rz
    if (!fds.has(k)) { let f = null; try { f = fs.openSync(path.join(saveDir, kind, `r.${rx}.${rz}.mca`), 'r') } catch { /* not generated */ } fds.set(k, f) }
    return fds.get(k)
  }
  const chunk = (kind, cx, cz) => { const f = fd(kind, cx >> 5, cz >> 5); if (f == null) return null; try { return readChunk(f, cx, cz) } catch { return null } }
  return { chunk, close: () => { for (const f of fds.values()) if (f != null) fs.closeSync(f) } }
}

// Per chunk: the cells where something may spawn, each with its chance per attempt of the chunk. Returns [{x,y,z,w,block,sky}] (w = chance, before the pack walk).
function spawnCells(ch) {
  const out = []
  const cx = ch.xPos, cz = ch.zPos
  const surf = heightmap(ch, 'WORLD_SURFACE')
  const secs = new Map()
  for (const s of ch.sections || []) { const u = unpackIds(s); secs.set(s.Y, { u, bl: s.BlockLight, sl: s.SkyLight }) }
  const at = (x, y, z) => {          // block name and lights at chunk-local x,z and world y
    const sy = y >> 4, s = secs.get(sy); if (!s || !s.u) return { n: 'minecraft:air', bl: 0, sl: 0 }
    const li = (x) + 16 * (z) + 256 * (y & 15), id = s.u.ids ? s.u.ids[(x) + 16 * (z) + 256 * (y & 15)] : 0
    return { n: s.u.names[id], bl: nib(s.bl, li), sl: nib(s.sl, li) }
  }
  for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
    const top = surf ? surf[lx + 16 * lz] + MIN_Y : 64          // getHeight: the first free y above the highest block
    const range = (top + 1) - MIN_Y + 1
    for (let y = MIN_Y + 1; y <= top + 1; y++) {
      const here = at(lx, y, lz)
      if (!isFree(here.n)) continue
      const above = at(lx, y + 1, lz); if (!isFree(above.n)) continue
      const below = at(lx, y - 1, lz); if (!isFloor(below.n)) continue
      if (here.bl > 0 || above.bl > 0) continue
      if (here.sl > 7) continue
      out.push({ x: cx * 16 + lx, y, z: cz * 16 + lz, w: ((8 - here.sl) / 8) / (256 * range), floor: below.n, sky: here.sl })
    }
  }
  return out
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// census({ saveDir, center:[x,y,z], radius, pads:[[x,y,z]...] (feet cells of the farm), players:[[x,y,z]...] })
//   Reads every chunk within `radius` of the center (the farm may be eligible through any player within 128 of it, so use radius 128 + the farm's size),
//   keeps only the cells that spawn can pick given where the players stand, and returns the farm's share.
function census({ saveDir, center, radius = 144, pads = [], players = [], regions }) {
  const R = regions || openRegions(saveDir)
  const padSet = new Set(pads.map(p => p[0] + ',' + p[1] + ',' + p[2]))
  const cells = []
  let chunks = 0, missing = 0
  try {
    for (let cz = Math.floor((center[2] - radius) / 16); cz <= Math.floor((center[2] + radius) / 16); cz++) for (let cx = Math.floor((center[0] - radius) / 16); cx <= Math.floor((center[0] + radius) / 16); cx++) {
      const ch = R.chunk('region', cx, cz)
      if (!ch || !Array.isArray(ch.sections)) { missing++; continue }
      chunks++
      for (const c of spawnCells(ch)) { c.pad = padSet.has(c.x + ',' + c.y + ',' + c.z); cells.push(c) }
    }
  } finally { if (!regions) R.close() }
  return { cells, chunks, missing, padSet }
}

// What a given set of player positions allows: the chance mass of the farm vs everything else, with the 24 block ring and the 128 block chunk range applied.
function share(cs, players) {
  let farm = 0, rest = 0, farmCells = 0, restCells = 0
  const eligibleChunk = (x, z) => { const cxm = (x >> 4) * 16 + 8, czm = (z >> 4) * 16 + 8; return players.length === 0 || players.some(p => Math.hypot(cxm - p[0], czm - p[2]) < 128) }
  for (const c of cs.cells) {
    if (!eligibleChunk(c.x, c.z)) continue
    const pos = [c.x + 0.5, c.y, c.z + 0.5]
    if (players.some(p => dist3(pos, p) <= 24)) continue
    if (c.pad) { farm += c.w; farmCells++ } else { rest += c.w; restCells++ }
  }
  return { farm, rest, farmCells, restCells, farmShare: farm + rest ? farm / (farm + rest) : 0, farmPerHour: farm * 20 * 3600 }
}

module.exports = { census, share, spawnCells, openRegions, isFree, isFloor, heightmap, unpackIds, MIN_Y }

if (require.main === module) {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d }
  const all = (k) => a.flatMap((v, i) => v === '--' + k ? [a[i + 1]] : [])
  const saveDir = get('save'); if (!saveDir) { console.error('usage: node tools/spawn-census.js --save <World folder> --x X --y Y --z Z [--player x,y,z]...'); process.exit(1) }
  const center = [+get('x'), +get('y', 59), +get('z')]
  const MF = require('../brain/mobfarm/geometry')
  const L = MF.layout({ ox: +get('ox', -6018), oz: +get('oz', -2355), d: [+get('dx', -1), +get('dz', 0)], yPlatform: +get('yp', 59) })
  const pads = L.platform.pads.map(c => [c[0], c[1] + 1, c[2]])
  const cs = census({ saveDir, center, pads })
  const players = all('player').map(s => s.split(',').map(Number))
  const r = share(cs, players)
  console.log(JSON.stringify({ chunks: cs.chunks, missing: cs.missing, cells: cs.cells.length, pads: pads.length, ...r }, null, 1))
}
