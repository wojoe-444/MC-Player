// Terrain readers over a world SAVE (region files), for the bench: where is the best 128x128 window, where is a dry spawn cell, and what did a run
// build (block counts of the window before and after). Offline: reads the files Minecraft wrote, never the live server's memory.
'use strict'
const fs = require('fs')
const path = require('path')
const { readChunk } = require('../../../dashboard/worldcast')

const MIN_Y = -64
function openRegions(worldDir) {
  const fds = new Map()
  const fd = (rx, rz) => {
    const k = rx + ',' + rz
    if (!fds.has(k)) { let f = null; try { f = fs.openSync(path.join(worldDir, 'region', `r.${rx}.${rz}.mca`), 'r') } catch {} fds.set(k, f) }
    return fds.get(k)
  }
  const chunk = (cx, cz) => { const f = fd(cx >> 5, cz >> 5); if (f == null) return null; try { return readChunk(f, cx, cz) } catch { return null } }
  return { chunk, close() { for (const f of fds.values()) if (f != null) fs.closeSync(f) } }
}

// packed heightmap (9 bits per column, 7 per long) -> Int16Array(256) of "first free y"
function heights(longs) {
  const out = new Int16Array(256)
  if (!longs) return out
  const per = 7, mask = 0x1ffn
  for (let i = 0; i < 256; i++) out[i] = Number((BigInt.asUintN(64, longs[Math.floor(i / per)]) >> BigInt((i % per) * 9)) & mask) + MIN_Y
  return out
}

// column grid for x0..x1, z0..z1 (inclusive): ground (top of land or sea floor), water depth, tree flag. null where a chunk is missing.
function columns(worldDir, x0, z0, x1, z1) {
  const R = openRegions(worldDir), W = x1 - x0 + 1, D = z1 - z0 + 1
  const g = { x0, z0, W, D, ground: new Int16Array(W * D), water: new Int16Array(W * D), tree: new Uint8Array(W * D), missing: 0 }
  for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
    const c = R.chunk(cx, cz), hm = c && c.Heightmaps
    if (!hm || !hm.MOTION_BLOCKING_NO_LEAVES || !hm.OCEAN_FLOOR) { g.missing++; continue }
    const nl = heights(hm.MOTION_BLOCKING_NO_LEAVES), of = heights(hm.OCEAN_FLOOR), mb = heights(hm.MOTION_BLOCKING)
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const x = cx * 16 + lx, z = cz * 16 + lz
      if (x < x0 || x > x1 || z < z0 || z > z1) continue
      const i = lz * 16 + lx, o = (z - z0) * W + (x - x0)
      g.ground[o] = of[i] - 1; g.water[o] = nl[i] - of[i]; g.tree[o] = mb[i] > nl[i] ? 1 : 0
    }
  }
  R.close()
  return g
}

function windowStats(g, wx0, wz0, size) {
  const hs = []; let land = 0, trees = 0, n = 0
  for (let z = wz0; z < wz0 + size; z++) for (let x = wx0; x < wx0 + size; x++) {
    const o = (z - g.z0) * g.W + (x - g.x0); n++
    if (g.water[o] <= 0) { land++; hs.push(g.ground[o]) }
    if (g.tree[o]) trees++
  }
  hs.sort((a, b) => a - b)
  const q = (p) => hs.length ? hs[Math.min(hs.length - 1, Math.floor(p * hs.length))] : 0
  return { land: land / n, trees: trees / n, relief: q(0.95) - q(0.05), minY: q(0), maxY: q(1), medianY: q(0.5) }
}

// best size x size window inside the generated grid. want: { minLand, minTrees, maxTrees, maxRelief }; ranked by land, then flatness, then closeness to the tree target
function scout(g, size, want = {}) {
  const w = { minLand: 0.9, minTrees: 0, maxTrees: 1, maxRelief: 40, ...want }
  const out = []
  for (let z = g.z0; z + size <= g.z0 + g.D; z += 16) for (let x = g.x0; x + size <= g.x0 + g.W; x += 16) {
    const s = windowStats(g, x, z, size)
    const ok = s.land >= w.minLand && s.trees >= w.minTrees && s.trees <= w.maxTrees && s.relief <= w.maxRelief
    const target = (w.minTrees + Math.min(w.maxTrees, w.minTrees + 0.2)) / 2
    out.push({ x0: x, z0: z, center: [x + size / 2, z + size / 2], ok, ...s, rank: s.land * 100 - s.relief * 0.8 - Math.abs(s.trees - target) * 40 - Math.hypot(x + size / 2, z + size / 2) * 0.02 })
  }
  out.sort((a, b) => (b.ok - a.ok) || (b.rank - a.rank))
  return out
}

// a dry, flat, treeless 5x5 near (cx, cz): the spawn. -> [x, y(feet), z] or null
function spawnNear(g, cx, cz, radius = 40) {
  let best = null
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
    const x = cx + dx, z = cz + dz
    if (x - 2 < g.x0 || x + 2 >= g.x0 + g.W || z - 2 < g.z0 || z + 2 >= g.z0 + g.D) continue
    let lo = 1e9, hi = -1e9, bad = false
    for (let k = -2; k <= 2 && !bad; k++) for (let j = -2; j <= 2; j++) {
      const o = (z + k - g.z0) * g.W + (x + j - g.x0)
      if (g.water[o] > 0 || g.tree[o]) { bad = true; break }
      lo = Math.min(lo, g.ground[o]); hi = Math.max(hi, g.ground[o])
    }
    if (bad || hi - lo > 1) continue
    const d = Math.hypot(dx, dz), sc = d + (hi - lo) * 3
    if (!best || sc < best.sc) best = { sc, p: [x, g.ground[(z - g.z0) * g.W + (x - g.x0)] + 1, z] }
  }
  return best && best.p
}

// counts of every block name in the box (x0..x1, z0..z1, all heights): from each chunk section's palette, so it is quick. -> { 'minecraft:oak_log': 12, ... }
function blockCounts(worldDir, x0, z0, x1, z1) {
  const R = openRegions(worldDir), counts = {}
  for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
    const c = R.chunk(cx, cz); if (!c || !Array.isArray(c.sections)) continue
    const inside = (cx * 16 >= x0 && cx * 16 + 15 <= x1 && cz * 16 >= z0 && cz * 16 + 15 <= z1)
    for (const s of c.sections) {
      const bs = s.block_states; if (!bs || !bs.palette) continue
      const pal = bs.palette
      if (pal.length === 1 || !bs.data) { if (inside) counts[pal[0].Name] = (counts[pal[0].Name] || 0) + 4096; continue }
      const bits = Math.max(4, Math.ceil(Math.log2(pal.length))), per = Math.floor(64 / bits), mask = (1n << BigInt(bits)) - 1n
      const n = new Uint32Array(pal.length)
      for (let i = 0; i < 4096; i++) {
        if (!inside) { const lx = i & 15, lz = (i >> 4) & 15, x = cx * 16 + lx, z = cz * 16 + lz; if (x < x0 || x > x1 || z < z0 || z > z1) continue }
        n[Number((BigInt.asUintN(64, bs.data[Math.floor(i / per)]) >> BigInt((i % per) * bits)) & mask)]++
      }
      for (let k = 0; k < pal.length; k++) if (n[k]) counts[pal[k].Name] = (counts[pal[k].Name] || 0) + n[k]
    }
  }
  R.close()
  return counts
}

module.exports = { columns, windowStats, scout, spawnNear, blockCounts, openRegions }
