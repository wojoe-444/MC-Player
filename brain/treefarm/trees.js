// Pure tree knowledge: which blocks are trees, how to find a whole tree, and what to deposit. No side effects.
const SPECIES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'pale_oak']   // mangrove (stilt roots) and azalea are left alone
const LOG_NAMES = SPECIES.map(s => `${s}_log`)
const SAPLING = Object.fromEntries(SPECIES.map(s => [s, `${s}_sapling`]))
const SAPLING_NAMES = new Set(Object.values(SAPLING))
const BIG = new Set(['dark_oak', 'pale_oak'])       // only grow from a 2x2 of saplings
const SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mycelium', 'moss_block', 'mud', 'muddy_mangrove_roots', 'farmland'])

const logSpecies = (name) => { const m = /^([a-z_]+)_log$/.exec(name || ''); return m && SPECIES.includes(m[1]) ? m[1] : null }
const saplingSpecies = (name) => { const m = /^([a-z_]+)_sapling$/.exec(name || ''); return m && SPECIES.includes(m[1]) ? m[1] : null }
const isSoil = (b) => !!b && SOIL.has(b.name)
const isLeaves = (b) => !!b && /_leaves$/.test(b.name)
const isAir = (b) => !!b && b.boundingBox === 'empty' && !/^(water|lava)$/.test(b.name)
// a leaf block the game generated (player-placed leaves are persistent)
const naturalLeaves = (b) => {
  if (!isLeaves(b)) return false
  const p = typeof b.getProperties === 'function' ? b.getProperties() : {}
  return p.persistent === false || p.persistent === 'false' || p.persistent === undefined
}

const key = (p) => `${p.x},${p.y},${p.z}`
const NEIGHBOURS = []
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) NEIGHBOURS.push([dx, dy, dz])

// Flood-fill the logs of one tree from a log block. Returns
// { species, logName, logs:[Vec3 sorted by y], bases:[Vec3], trunk:Vec3|null, leaves, ok, why }
// ok = a natural tree: standing on soil, tall enough, with natural leaves (houses, log cabins and stripped logs never qualify).
function scanTree(bot, start, cfg) {
  const first = bot.blockAt(start)
  const species = first && logSpecies(first.name)
  const out = { species, logName: first && first.name, logs: [], bases: [], trunk: null, leaves: 0, ok: false, why: '' }
  if (!species) { out.why = 'not a log'; return out }
  const seen = new Set([key(start)]), queue = [start], logs = []
  while (queue.length && logs.length < cfg.maxTreeLogs) {
    const p = queue.shift(); logs.push(p)
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const q = p.offset(dx, dy, dz)
      if (Math.abs(q.x - start.x) > cfg.treeBox || Math.abs(q.z - start.z) > cfg.treeBox || Math.abs(q.y - start.y) > 64) continue
      const k = key(q); if (seen.has(k)) continue
      seen.add(k)
      const b = bot.blockAt(q)
      if (b && b.name === first.name) queue.push(q)
    }
  }
  logs.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
  out.logs = logs
  out.bases = logs.filter(p => isSoil(bot.blockAt(p.offset(0, -1, 0))))
  out.trunk = out.bases[0] || null
  const leafSeen = new Set()
  for (const p of logs) {
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const q = p.offset(dx, dy, dz), k = key(q)
      if (leafSeen.has(k)) continue
      if (naturalLeaves(bot.blockAt(q))) { leafSeen.add(k); if (leafSeen.size >= cfg.minLeaves) break }
    }
    if (leafSeen.size >= cfg.minLeaves) break
  }
  out.leaves = leafSeen.size
  if (!out.bases.length) out.why = 'not standing on soil'
  else if (logs.length < cfg.minLogs) out.why = 'too small'
  else if (out.leaves < cfg.minLeaves) out.why = 'no natural leaves (a build?)'
  else out.ok = true
  return out
}

// What to put away: saplings above `keepSaplings` per species, sticks above `keepSticks`, logs above `keepLogs` in total
// (biggest stacks go first). Only wood items: nothing else is ever deposited by this module.
function planUnload(inv, cfg) {
  const saplings = {}, logs = {}
  for (const [n, c] of Object.entries(inv)) {
    const keep = cfg.preferSpecies && n === SAPLING[cfg.preferSpecies] ? cfg.keepSaplings * 2 : cfg.keepSaplings        // the preferred species is what gets replanted
    if (SAPLING_NAMES.has(n) && c > keep) saplings[n] = c - keep
  }
  let budget = cfg.keepLogs
  const have = Object.entries(inv).filter(([n]) => logSpecies(n)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  for (const [n, c] of have) { const keep = Math.min(c, budget); budget -= keep; if (c - keep > 0) logs[n] = c - keep }
  const sticks = Math.max(0, (inv.stick || 0) - cfg.keepSticks)
  const leaves = {}                                                       // only shears give leaf blocks; they are not kept
  for (const [n, c] of Object.entries(inv)) if (/_leaves$/.test(n) && c > 0) leaves[n] = c
  return { saplings, logs, sticks, leaves, logCount: Object.values(logs).reduce((s, n) => s + n, 0) }
}

// Item entity -> item name (mineflayer exposes getDroppedItem; the test mock sets itemName).
function droppedName(e) {
  try { const it = e.getDroppedItem && e.getDroppedItem(); if (it && it.name) return it.name } catch { /* fall through */ }
  return e.itemName || null
}
const WANTED_DROP = (name) => !!name && (!!logSpecies(name) || SAPLING_NAMES.has(name) || name === 'stick' || name === 'apple' || name === 'chest' || /_leaves$/.test(name))

module.exports = { SPECIES, LOG_NAMES, SAPLING, SAPLING_NAMES, BIG, SOIL, logSpecies, saplingSpecies, isSoil, isLeaves, isAir, naturalLeaves, scanTree, planUnload, droppedName, WANTED_DROP, key }
