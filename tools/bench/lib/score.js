// Scoring for the bench: what counts as progress in the first hour (ROADMAP phase 1 to early phase 3), and the per-player-hour numbers.
// Everything is read from the SERVER (RCON samples, the stats file, the saved world), never from the bot's own report.
'use strict'

// phase 1 = subsistence (wood, stone tools, food, light, bed); phase 2 = first iron and the kit; phase 3 = early structured mining (diamond, a chest base)
// `inv` matches an inventory item name; `placed` matches a block the run added to the world (the item may never be seen in the bag: a table is placed at once)
const MILESTONES = [
  { k: 'log', phase: 1, pts: 1, inv: /_log$/ },
  { k: 'crafting_table', phase: 1, pts: 1, inv: /^crafting_table$/, placed: /^minecraft:crafting_table$/, crafted: 'minecraft:crafting_table' },
  { k: 'wooden_pickaxe', phase: 1, pts: 1, inv: /^wooden_pickaxe$/, crafted: 'minecraft:wooden_pickaxe' },
  { k: 'cobblestone', phase: 1, pts: 1, inv: /^cobblestone$/ },
  { k: 'stone_pickaxe', phase: 1, pts: 2, inv: /^stone_pickaxe$/, crafted: 'minecraft:stone_pickaxe' },
  { k: 'stone_sword', phase: 1, pts: 1, inv: /^stone_sword$/, crafted: 'minecraft:stone_sword' },
  { k: 'furnace', phase: 1, pts: 2, inv: /^furnace$/, placed: /^minecraft:furnace$/, crafted: 'minecraft:furnace' },
  { k: 'coal', phase: 1, pts: 1, inv: /^(coal|charcoal)$/ },
  { k: 'torch', phase: 1, pts: 1, inv: /^torch$/, crafted: 'minecraft:torch' },
  { k: 'food', phase: 1, pts: 2, inv: /^(cooked_[a-z_]+|bread|apple|baked_potato|carrot|melon_slice|sweet_berries)$/ },
  { k: 'bed', phase: 1, pts: 3, inv: /_bed$/, placed: /_bed$/, crafted: 'minecraft:white_bed' },
  { k: 'raw_iron', phase: 2, pts: 2, inv: /^raw_iron$/ },
  { k: 'iron_ingot', phase: 2, pts: 3, inv: /^iron_ingot$/ },
  { k: 'bucket', phase: 2, pts: 2, inv: /^(bucket|water_bucket)$/, crafted: 'minecraft:bucket' },
  { k: 'iron_pickaxe', phase: 2, pts: 5, inv: /^iron_pickaxe$/, crafted: 'minecraft:iron_pickaxe' },
  { k: 'shield', phase: 2, pts: 3, inv: /^shield$/, crafted: 'minecraft:shield' },
  { k: 'chest', phase: 3, pts: 1, inv: /^chest$/, placed: /^minecraft:chest$/, crafted: 'minecraft:chest' },
  { k: 'diamond', phase: 3, pts: 6, inv: /^diamond$/ }
]
const KEY_PLACED = ['crafting_table', 'furnace', 'chest', 'barrel', 'torch', 'wall_torch', 'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'ladder', 'farmland',
  'white_bed', 'red_bed', 'blue_bed', 'black_bed', 'brown_bed', 'cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks', 'dirt', 'stone', 'cobbled_deepslate']

const NAME = (id) => String(id).replace(/^minecraft:/, '')

// "[{Slot: 0b, id: "minecraft:oak_log", count: 3}, ...]" -> { oak_log: 3 }. Tolerates any key order.
function parseInventory(snbt) {
  const inv = {}
  const body = String(snbt).replace(/^[^\[]*\[/, '[')
  // top-level objects by brace depth (an item with components has braces inside)
  let depth = 0, start = -1
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const item = body.slice(start, i + 1)
        const id = /\bid: "([^"]+)"/.exec(item), cnt = /\b[cC]ount: (\d+)/.exec(item)
        if (id) { const n = NAME(id[1]); inv[n] = (inv[n] || 0) + (cnt ? +cnt[1] : 1) }
        start = -1
      }
    }
  }
  return inv
}
const parseNums = (s) => (String(s).match(/-?\d+(\.\d+)?(?=[df]?[,\]])/g) || []).map(Number)

// samples: [{ t (s since bot joined), pos, hp, food, inv, deaths, day, dim }]
function analyze({ samples, seconds, stats, placedDelta, deathLog, reconnects = 0 }) {
  const first = {}, firstInv = {}
  for (const s of samples) for (const m of MILESTONES) if (first[m.k] == null) for (const n of Object.keys(s.inv || {})) if (m.inv.test(n)) { first[m.k] = s.t; break }
  const crafted = (stats && stats['minecraft:crafted']) || {}
  const got = {}
  for (const m of MILESTONES) {
    const byPlace = m.placed && Object.keys(placedDelta || {}).some(n => m.placed.test(n) && placedDelta[n] > 0)
    const byCraft = m.crafted && crafted[m.crafted] > 0
    got[m.k] = { t: first[m.k] != null ? first[m.k] : null, done: first[m.k] != null || !!byPlace || !!byCraft }
  }
  const pts = MILESTONES.reduce((a, m) => a + (got[m.k].done ? m.pts : 0), 0)
  const maxPts = MILESTONES.reduce((a, m) => a + m.pts, 0)
  const ptsAt = {}
  for (const mark of [10, 20, 30, 45, 60]) if (seconds >= mark * 60 - 30) ptsAt[mark] = MILESTONES.reduce((a, m) => a + (got[m.k].t != null && got[m.k].t <= mark * 60 ? m.pts : 0), 0)

  // stall: a 30 s stretch with the bot within 1.5 blocks of where it was and nothing in the bag changing. Night stretches (13000..23000) reported apart: sheltering is not a stall.
  let stall = 0, stallDay = 0, win = [], dist = 0, bagChanges = 0
  const bagKey = (inv) => Object.entries(inv || {}).sort().join(',')
  let prev = null
  for (const s of samples) {
    if (prev) { if (s.pos && prev.pos) dist += Math.hypot(s.pos[0] - prev.pos[0], s.pos[2] - prev.pos[2]); if (bagKey(s.inv) !== bagKey(prev.inv)) bagChanges++ }
    win.push(s)
    while (win.length > 1 && s.t - win[0].t > 30) win.shift()
    if (prev && win.length > 1 && s.t - win[0].t >= 29) {
      const still = win.every(w => w.pos && s.pos && Math.hypot(w.pos[0] - s.pos[0], w.pos[1] - s.pos[1], w.pos[2] - s.pos[2]) < 1.5) && win.every(w => bagKey(w.inv) === bagKey(s.inv))
      if (still) { const dt = s.t - prev.t; stall += dt; const tod = s.day != null ? s.day % 24000 : 0; if (tod < 13000 || tod > 23000) stallDay += dt }
    }
    prev = s
  }
  const hours = Math.max(seconds, 1) / 3600
  const deaths = Math.max(deathLog.length, samples.length ? Math.max(...samples.map(s => s.deaths || 0)) : 0)
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0)
  const picked = sum(stats && stats['minecraft:picked_up']), mined = sum(stats && stats['minecraft:mined']), craftedN = sum(crafted), usedBlocks = sum(stats && stats['minecraft:used'])
  const kills = sum(stats && stats['minecraft:killed'])
  const key = {}; for (const k of KEY_PLACED) if (placedDelta && placedDelta['minecraft:' + k] > 0) key[k] = placedDelta['minecraft:' + k]
  return {
    seconds: Math.round(seconds), points: pts, maxPoints: maxPts, pointsAt: ptsAt, milestones: got,
    perHour: { points: +(pts / hours).toFixed(1), deaths: +(deaths / hours).toFixed(2), stallSeconds: Math.round(stall / hours), stallDaySeconds: Math.round(stallDay / hours), itemsPickedUp: Math.round(picked / hours), blocksMined: Math.round(mined / hours), itemsCrafted: Math.round(craftedN / hours), distanceBlocks: Math.round(dist / hours) },
    totals: { deaths, deathCauses: deathLog, stallSeconds: Math.round(stall), stallDaySeconds: Math.round(stallDay), stallPct: +(100 * stall / Math.max(seconds, 1)).toFixed(1), picked, mined, crafted: craftedN, blocksPlaced: usedBlocks, kills, distanceBlocks: Math.round(dist), bagChanges, reconnects },
    structures: key,
    phase: { p1: MILESTONES.filter(m => m.phase === 1).filter(m => got[m.k].done).length + '/' + MILESTONES.filter(m => m.phase === 1).length, p2: MILESTONES.filter(m => m.phase === 2).filter(m => got[m.k].done).length + '/' + MILESTONES.filter(m => m.phase === 2).length, p3: MILESTONES.filter(m => m.phase === 3).filter(m => got[m.k].done).length + '/' + MILESTONES.filter(m => m.phase === 3).length }
  }
}

module.exports = { MILESTONES, KEY_PLACED, parseInventory, parseNums, analyze, NAME }
