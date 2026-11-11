// Reads the open space around a base straight from the world save (Anvil region files), for the dashboard's Bases page. No dependencies.
//
// This is a view for Walter, not something a bot sees: the dashboard reads the same save folder Minecraft wrote, the way a map viewer or a spectator
// would, and nothing here reaches the bots (rule 1 of the shared world is about the bot's own senses). The bots' recorded data stays on top of it.
//
//   scanBase({ regionDir, x, z, radius })  ->  { grid, box, top }
//     grid  Uint8Array over box (x0..x1, y0..y1, z0..z1): 0 solid, 1 open (air, light, ladders, chests ... anything a player can stand in or pass), 255 not loaded
//     top   Int16Array per column: the y of the highest natural-terrain block, to tell underground from sky
//   cavityFrom(scan, seeds, opt) -> Uint8Array: the underground open cells reachable from the seeds, within the circle
//
// A save is only as fresh as Minecraft's last write (it flushes chunks when they unload and on autosave), so a block changed a minute ago may be missing.
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---------------------------------------------------------------- NBT
// Just enough: reads the whole tree into plain JS (compound -> object, list -> array, long arrays -> BigInt64Array, other arrays -> typed arrays).
function parseNbt(buf, off = 0) {
  let p = off
  const rd = {
    i8() { const v = buf.readInt8(p); p += 1; return v },
    i16() { const v = buf.readInt16BE(p); p += 2; return v },
    i32() { const v = buf.readInt32BE(p); p += 4; return v },
    i64() { const v = buf.readBigInt64BE(p); p += 8; return v },
    f32() { const v = buf.readFloatBE(p); p += 4; return v },
    f64() { const v = buf.readDoubleBE(p); p += 8; return v },
    str() { const n = buf.readUInt16BE(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s },
  }
  const payload = (t) => {
    switch (t) {
      case 1: return rd.i8()
      case 2: return rd.i16()
      case 3: return rd.i32()
      case 4: return rd.i64()
      case 5: return rd.f32()
      case 6: return rd.f64()
      case 7: { const n = rd.i32(); const a = new Int8Array(buf.buffer.slice(buf.byteOffset + p, buf.byteOffset + p + n)); p += n; return a }
      case 8: return rd.str()
      case 9: { const it = rd.i8(), n = rd.i32(), a = new Array(n); for (let i = 0; i < n; i++) a[i] = payload(it); return a }
      case 10: { const o = {}; for (;;) { const tt = rd.i8(); if (tt === 0) break; const name = rd.str(); o[name] = payload(tt) } return o }
      case 11: { const n = rd.i32(), a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = rd.i32(); return a }
      case 12: { const n = rd.i32(), a = new BigInt64Array(n); for (let i = 0; i < n; i++) a[i] = rd.i64(); return a }
      default: throw new Error('bad NBT tag ' + t)
    }
  }
  const t = rd.i8()
  if (t !== 10) throw new Error('NBT root is not a compound')
  rd.str()
  return payload(10)
}

// ---------------------------------------------------------------- region files
function readChunk(fd, cx, cz) {
  const idx = ((cx & 31) + (cz & 31) * 32) * 4
  const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, idx)
  const off = head.readUIntBE(0, 3) * 4096, secs = head[3]
  if (!off || !secs) return null
  const buf = Buffer.alloc(secs * 4096); fs.readSync(fd, buf, 0, buf.length, off)
  const len = buf.readInt32BE(0), type = buf[4]
  if (len < 2 || len > buf.length - 4) return null
  const data = buf.subarray(5, 4 + len)
  let raw
  if (type === 2) raw = zlib.inflateSync(data)
  else if (type === 1) raw = zlib.gunzipSync(data)
  else if (type === 3) raw = data
  else return null                                  // LZ4 (4) and external (128+) chunks are not used by a default world
  return parseNbt(raw)
}

// ---------------------------------------------------------------- blocks
// Terrain a player digs through. Everything else (air, light, ladders, chests, water, plants ...) counts as open space for the cast.
const SOLID = /^minecraft:(stone|deepslate|tuff|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|gravel|sand|red_sand|sandstone|red_sandstone|smooth_sandstone|snow_block|ice|packed_ice|blue_ice|netherrack|bedrock|obsidian|crying_obsidian|calcite|dripstone_block|granite|diorite|andesite|basalt|smooth_basalt|blackstone|moss_block|amethyst_block|budding_amethyst|terracotta|magma_block|cobblestone|mossy_cobblestone|cobbled_deepslate|infested_[a-z_]+|[a-z_]*_ore|[a-z_]*_terracotta|[a-z_]*_concrete|[a-z_]*_wool|[a-z_]*_planks|[a-z_]*_bricks|stone_bricks|polished_[a-z_]+|chiseled_[a-z_]+|cracked_[a-z_]+|[a-z_]*_block|raw_[a-z_]+_block|spawner|bookshelf|crafting_table|furnace|blast_furnace|smoker|glass|tinted_glass|[a-z_]*_log|[a-z_]*_wood|[a-z_]*_stem|[a-z_]*_hyphae|[a-z_]*_leaves|[a-z_]*_nylium|[a-z_]*_shroomlight|shroomlight|glowstone|sea_lantern|tnt|hay_block|bone_block|melon|pumpkin|carved_pumpkin|jack_o_lantern|sculk|sculk_catalyst|sculk_shrieker|sculk_sensor|reinforced_deepslate|farmland|dirt_path|soul_sand|soul_soil|honeycomb_block|slime_block|honey_block|target|lodestone|note_block|jukebox|dispenser|dropper|observer|piston|sticky_piston|command_block|barrel|chest_placeholder)$/
// Not natural terrain for "where is the sky": wood and leaves stop a column from counting as ground, so a tree is not mistaken for a hill.
const NOT_GROUND = /_log$|_wood$|_leaves$|_stem$|_hyphae$|^minecraft:(snow|ice|glass|tinted_glass|crafting_table|furnace|barrel|bookshelf)$/
const isSolidName = (n) => SOLID.test(n)
const isGroundName = (n) => SOLID.test(n) && !NOT_GROUND.test(n)

// Decode one chunk's sections into per-section arrays of palette indices; returns { y: { palette:[name], idx(i) } } lazily.
function sectionReader(sec) {
  const bs = sec.block_states
  if (!bs || !Array.isArray(bs.palette) || !bs.palette.length) return null
  const names = bs.palette.map(p => p.Name)
  if (names.length === 1 || !bs.data) return { names, uniform: 0 }
  const bits = Math.max(4, Math.ceil(Math.log2(names.length))), per = Math.floor(64 / bits), mask = (1n << BigInt(bits)) - 1n
  const data = bs.data, out = new Uint16Array(4096)
  for (let i = 0; i < 4096; i++) {
    const w = data[Math.floor(i / per)], sh = BigInt((i % per) * bits)
    out[i] = Number((BigInt.asUintN(64, w) >> sh) & mask)
  }
  return { names, ids: out }
}

// Scan the box around (x, z) of the given radius. Returns the grid described at the top of the file.
function scanBase({ regionDir, x, z, radius, yMin = -64, yMax = 320 }) {
  const x0 = Math.floor(x - radius), x1 = Math.floor(x + radius), z0 = Math.floor(z - radius), z1 = Math.floor(z + radius)
  const W = x1 - x0 + 1, D = z1 - z0 + 1, H = yMax - yMin + 1
  const grid = new Uint8Array(W * D * H).fill(255)
  const top = new Int16Array(W * D).fill(yMin - 1)
  const at = (gx, gy, gz) => gx + W * (gz + D * gy)
  const fds = new Map()
  const fd = (rx, rz) => {
    const k = rx + ',' + rz
    if (!fds.has(k)) { let f = null; try { f = fs.openSync(path.join(regionDir, `r.${rx}.${rz}.mca`), 'r') } catch { /* region not generated */ } fds.set(k, f) }
    return fds.get(k)
  }
  let chunks = 0
  try {
    for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
      const f = fd(cx >> 5, cz >> 5)
      if (f == null) continue
      let ch = null
      try { ch = readChunk(f, cx, cz) } catch { ch = null }
      if (!ch || !Array.isArray(ch.sections)) continue
      chunks++
      for (const sec of ch.sections) {
        const sy = sec.Y
        if (sy * 16 > yMax || sy * 16 + 15 < yMin) continue
        const r = sectionReader(sec)
        const solidOf = r ? r.names.map(isSolidName) : null
        const groundOf = r ? r.names.map(isGroundName) : null
        for (let ly = 0; ly < 16; ly++) {
          const y = sy * 16 + ly
          if (y < yMin || y > yMax) continue
          for (let lz = 0; lz < 16; lz++) {
            const wz = cz * 16 + lz
            if (wz < z0 || wz > z1) continue
            for (let lx = 0; lx < 16; lx++) {
              const wx = cx * 16 + lx
              if (wx < x0 || wx > x1) continue
              let solid, ground
              if (!r) { solid = false; ground = false } else {
                const id = r.uniform != null ? 0 : r.ids[lx + 16 * (lz + 16 * ly)]
                solid = solidOf[id]; ground = groundOf[id]
              }
              const gx = wx - x0, gz = wz - z0
              grid[at(gx, y - yMin, gz)] = solid ? 0 : 1
              if (ground && y > top[gx + W * gz]) top[gx + W * gz] = y
            }
          }
        }
      }
    }
  } finally { for (const f of fds.values()) if (f != null) fs.closeSync(f) }
  return { grid, top, box: { x0, x1, y0: yMin, y1: yMax, z0, z1, W, D, H }, chunks }
}

// Open cells that are underground (below the highest ground of the cell's column or its neighbours: a one-wide shaft is open all the way up and
// would otherwise count as sky), reachable from the seeds over faces, inside the circle. Returns { cells: Uint8Array over box (1 = in the cavity), count }.
function cavityFrom(scan, seeds, { x, z, radius, cover = 1 }) {
  const { grid, top, box } = scan, { W, D, H } = box
  const at = (gx, gy, gz) => gx + W * (gz + D * gy)
  // ground height per column, taking the highest of the 3x3 around it
  const ground = new Int16Array(W * D)
  for (let gz = 0; gz < D; gz++) for (let gx = 0; gx < W; gx++) {
    let m = -9999
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = gx + dx, b = gz + dz
      if (a < 0 || b < 0 || a >= W || b >= D) continue
      if (top[a + W * b] > m) m = top[a + W * b]
    }
    ground[gx + W * gz] = m
  }
  const r2 = radius * radius
  const cells = new Uint8Array(grid.length)
  const stack = []
  const ok = (gx, gy, gz) => {
    if (gx < 0 || gz < 0 || gy < 0 || gx >= W || gz >= D || gy >= H) return false
    const k = at(gx, gy, gz)
    if (grid[k] !== 1 || cells[k]) return false
    if (gy + box.y0 > ground[gx + W * gz] - cover) return false                     // sky side
    const dx = gx + box.x0 + 0.5 - x, dz = gz + box.z0 + 0.5 - z
    return dx * dx + dz * dz <= r2
  }
  const push = (gx, gy, gz) => { cells[at(gx, gy, gz)] = 1; stack.push(gx, gy, gz) }
  for (const [sx, sy, sz] of seeds) { const gx = sx - box.x0, gy = sy - box.y0, gz = sz - box.z0; if (ok(gx, gy, gz)) push(gx, gy, gz) }
  let count = stack.length / 3
  while (stack.length) {
    const gz = stack.pop(), gy = stack.pop(), gx = stack.pop()
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const a = gx + dx, b = gy + dy, c = gz + dz
      if (ok(a, b, c)) { push(a, b, c); count++ }
    }
  }
  return { cells, count }
}

module.exports = { parseNbt, readChunk, scanBase, cavityFrom, isSolidName }
