// brain/storage-model.js: the storage room as a tracked entity, and the lean kit (pure; no bot, no world, no timers).
//
// A storage room is a registry record (brain/autopilot/ladder.js: Downloads/bot-shared/registry.json, rooms[]) that both bots read and write:
//   { id, type:'storage', shaft, box, y, chests:[[x,y,z]...], junk:[x,y,z], reset:[x,y,z], chestInfo:{ "x,y,z": { role, items:{name:n}, at } }, ... }
// What this file adds on top of the plain record:
//   * roles: every chest the room knows has a role. 'storage' (the double chests in the rows: overflow from every task), 'reset' (the reset-gear
//     chest: the lean kit, taken only when the bag is short of it) and 'junk' (the discard closet: never taken from). A storage chest's *theme*
//     (ore, wood, stone, food, tools, misc) is derived from what it holds; nothing forces items into a themed chest yet (that is the item sorter,
//     Phase 3).
//   * contents: what each chest held when it was last opened (chestInfo[key].items, .at), so the planner can answer "where is the iron?" without a walk.
//   * the lean kit (ROADMAP Phase 2, item 2 and 5): the few things a bot needs in its bag to get back to work after a death. It is the content of
//     the reset chest, and the bot's own check for "I am short of it, go and fetch it".
// Rules this encodes (Walter's, 2026-11-10): minimum tool tier (stone), no crafted armor until diamond gear with Mending, a stack of food in the bag.
'use strict'
const fs = require('fs')

const key = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]).join(',')
const toArr = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z])

// ---------------------------------------------------------------------------------------------------- the lean kit
// id; re = which item names count toward it; prefer = in a chest, take names in this order (lowest tier first: the tool rule);
// want = what the bag should hold to count as kitted; keep = what the bag holds back when it stocks the chest from its surplus;
// stock = what the chest should hold; essential = a bag without it is "short" (triggers a fetch).
const LEAN_KIT = [
  { id: 'pickaxe', re: /^(wooden|stone|iron|diamond)_pickaxe$/, prefer: ['stone_pickaxe', 'wooden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'], want: 1, keep: 2, stock: 2, essential: true, craft: 'stone_pickaxe' },
  { id: 'sword', re: /^(wooden|stone|iron|diamond)_sword$/, prefer: ['stone_sword', 'wooden_sword', 'iron_sword', 'diamond_sword'], want: 1, keep: 1, stock: 1, essential: true, craft: 'stone_sword' },
  { id: 'food', re: /^(bread|cooked_[a-z_]+|baked_potato|dried_kelp|apple|carrot|sweet_berries|golden_carrot)$/, prefer: ['bread', 'baked_potato', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'carrot', 'apple', 'dried_kelp', 'sweet_berries'], want: 16, keep: 32, stock: 32, essential: true },
  { id: 'torch', re: /^torch$/, prefer: ['torch'], want: 16, keep: 32, stock: 32, essential: true },
  { id: 'filler', re: /^(cobblestone|cobbled_deepslate)$/, prefer: ['cobblestone', 'cobbled_deepslate'], want: 32, keep: 64, stock: 64, essential: false }
]
const kitEntry = (id) => LEAN_KIT.find(e => e.id === id)

// The kit never lists armor (the armor rule) and crafts only stone tools.
// Counts of the kit entries in a list of { name, count } (a bag or a chest).
function kitCounts(items) {
  const out = {}
  for (const e of LEAN_KIT) out[e.id] = 0
  for (const it of items || []) { const e = LEAN_KIT.find(k => k.re.test(it.name)); if (e) out[e.id] += it.count || 0 }
  return out
}
// What the bag is short of: [{ id, need }] against `want`. essentialOnly: only the entries without which work stops.
function kitGap(counts, { essentialOnly = false } = {}) {
  const out = []
  for (const e of LEAN_KIT) { if (essentialOnly && !e.essential) continue; const have = counts[e.id] || 0; if (have < e.want) out.push({ id: e.id, need: e.want - have }) }
  return out
}
// The bag is short of an essential entry when it has less than half of `want` (one torch short is not a trip to the storage room); the tools are all-or-nothing.
function kitShort(counts) {
  return LEAN_KIT.filter(e => e.essential && (e.want === 1 ? (counts[e.id] || 0) < 1 : (counts[e.id] || 0) < Math.ceil(e.want / 2))).map(e => e.id)
}
const rank = (e, name) => { const i = e.prefer.indexOf(name); return i < 0 ? 99 : i }
// What to withdraw from the reset chest for a bag: [{ name, n }]. Fills the gap of every entry (all of them, not only the essential ones) from the chest.
function restockTake(chestItems, bagCounts) {
  const out = []
  for (const g of kitGap(bagCounts)) {
    const e = kitEntry(g.id); let need = g.need
    const here = (chestItems || []).filter(i => e.re.test(i.name)).sort((a, b) => rank(e, a.name) - rank(e, b.name))
    for (const it of here) { if (need <= 0) break; const n = Math.min(need, it.count); if (n > 0) { out.push({ name: it.name, n }); need -= n } }
  }
  return out
}
// What the bag may put into the reset chest from its surplus: [{ name, n }]. A bag keeps `keep` of every entry for itself; the chest wants `stock`.
function stockGive(bagItems, chestCounts) {
  const out = [], bag = kitCounts(bagItems)
  for (const e of LEAN_KIT) {
    let give = Math.min((bag[e.id] || 0) - e.keep, e.stock - (chestCounts[e.id] || 0))
    if (give <= 0) continue
    // the lowest tier of a kind goes into the chest first (the tool rule: the best of a kind stays in the bag)
    const mine = (bagItems || []).filter(i => e.re.test(i.name)).sort((a, b) => rank(e, a.name) - rank(e, b.name))
    for (const it of mine) { if (give <= 0) break; const n = Math.min(give, it.count); out.push({ name: it.name, n }); give -= n }
  }
  return out
}
// What the chest lacks that the bag could make (tools only): ids of crafted entries whose chest count is under `stock`.
const craftable = (chestCounts) => LEAN_KIT.filter(e => e.craft && (chestCounts[e.id] || 0) < e.stock).map(e => ({ id: e.id, item: e.craft, missing: e.stock - (chestCounts[e.id] || 0) }))

// ---------------------------------------------------------------------------------------------------- items and themes
const tally = (items) => { const m = {}; for (const it of items || []) m[it.name] = (m[it.name] || 0) + (it.count || 0); return m }
const THEMES = [
  ['ore', /^(raw_|iron_ingot|gold_ingot|copper_ingot|diamond|emerald|lapis|redstone|coal|charcoal|netherite|amethyst)/],
  ['tools', /_(pickaxe|axe|sword|shovel|hoe)$|^(bow|crossbow|shield|fishing_rod|shears|arrow)$/],
  ['food', /^(bread|cooked_|baked_potato|dried_kelp|apple|carrot|potato|beetroot|sweet_berries|melon_slice|wheat|golden_|pumpkin_pie|cookie|mushroom_stew)/],
  ['wood', /_(log|wood|planks|sapling|leaves)$|^(stick|ladder|chest|barrel|crafting_table)$/],
  ['stone', /^(cobblestone|cobbled_deepslate|stone|deepslate|dirt|gravel|sand|andesite|diorite|granite|tuff|netherrack|stone_bricks|smooth_stone)/]
]
const themeOfItem = (name) => { const t = THEMES.find(([, re]) => re.test(name)); return t ? t[0] : 'misc' }
// A storage chest's theme: the theme holding most of its items, 'misc' when mixed (no theme holds half) and 'empty' with nothing in it.
function themeOfChest(items) {
  const by = {}, total = Object.values(items || {}).reduce((a, n) => a + n, 0)
  if (!total) return 'empty'
  for (const [name, n] of Object.entries(items)) { const t = themeOfItem(name); by[t] = (by[t] || 0) + n }
  const [t, n] = Object.entries(by).sort((a, b) => b[1] - a[1])[0]
  return n * 2 >= total ? t : 'misc'
}

// ---------------------------------------------------------------------------------------------------- the room record
function info(room) { return room.chestInfo = room.chestInfo || {} }
// The role of the chest at pos in this room: 'reset' | 'junk' | 'storage' | null (not the room's).
function roleOf(room, pos) {
  const k = key(pos)
  if (room.reset && key(room.reset) === k) return 'reset'
  if (room.junk && key(room.junk) === k) return 'junk'
  if ((room.chests || []).some(c => key(c) === k)) return 'storage'
  return null
}
// Remember what a chest held when it was opened (items = [{ name, count }] or { name: n }). Marks the chest's role.
function observe(room, pos, items, now = Date.now()) {
  const m = Array.isArray(items) ? tally(items) : { ...items }
  const role = roleOf(room, pos)
  info(room)[key(pos)] = { role: role || 'storage', items: m, at: now }
  return m
}
const chestItems = (room, pos) => ((room.chestInfo || {})[key(pos)] || {}).items || null
// Register the reset chest in the room (one per room).
function setReset(room, pos, now = Date.now()) { room.reset = toArr(pos); if (!info(room)[key(pos)]) info(room)[key(pos)] = { role: 'reset', items: {}, at: 0 }; info(room)[key(pos)].role = 'reset'; room.at = now; return room }
function setJunk(room, pos) { room.junk = toArr(pos); info(room)[key(pos)] = { ...(info(room)[key(pos)] || { items: {}, at: 0 }), role: 'junk' }; return room }
// Forget a chest that is gone (broken, or a ghost): its role and contents go.
function forget(room, pos) {
  const k = key(pos)
  if (room.reset && key(room.reset) === k) room.reset = null
  if (room.junk && key(room.junk) === k) room.junk = null
  room.chests = (room.chests || []).filter(c => key(c) !== k)
  if (room.chestInfo) delete room.chestInfo[k]
  return room
}
// One summary of a room for the planner and the dashboard: totals over the storage chests (not the reset or junk chests), per-chest themes, the reset chest's kit.
function summary(room, now = Date.now()) {
  if (!room) return null
  const totals = {}, chests = []
  for (const c of room.chests || []) {
    const rec = (room.chestInfo || {})[key(c)]
    chests.push({ at: toArr(c), theme: rec ? themeOfChest(rec.items) : 'unknown', age_min: rec && rec.at ? Math.round((now - rec.at) / 60000) : null })
    if (rec) for (const [n, k] of Object.entries(rec.items)) totals[n] = (totals[n] || 0) + k
  }
  const rr = room.reset ? (room.chestInfo || {})[key(room.reset)] : null
  const kit = rr ? kitCounts(Object.entries(rr.items).map(([name, count]) => ({ name, count }))) : null
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 14).reduce((o, [n, k]) => (o[n] = k, o), {})
  return { id: room.id, y: room.y, chests: chests.length, by_theme: chests, top_items: top, reset_chest: room.reset ? { at: room.reset, kit, age_min: rr && rr.at ? Math.round((now - rr.at) / 60000) : null } : null, junk_chest: room.junk || null }
}
// Where is it? Storage chests whose last-seen contents hold something matching re, most first (never the reset or junk chest).
function whereIs(room, re) {
  const out = []
  for (const c of room.chests || []) {
    const rec = (room.chestInfo || {})[key(c)]; if (!rec) continue
    const n = Object.entries(rec.items).filter(([name]) => re.test(name)).reduce((a, [, k]) => a + k, 0)
    if (n) out.push({ at: toArr(c), n })
  }
  return out.sort((a, b) => b.n - a.n)
}

// ---------------------------------------------------------------------------------------------------- reserved chests
// Chests that no general take may touch: the reset chest (its kit belongs to whoever comes back from a death, not to a craft recipe or a
// "fetch some torches") and the junk chest. keys are "x,y,z".
function reservedKeys(rooms) {
  const s = new Set()
  for (const r of rooms || []) { if (r && r.reset) s.add(key(r.reset)); if (r && r.junk) s.add(key(r.junk)) }
  return s
}
// From the registry file (all worlds: coordinates of two worlds never meet in practice). Cached for `ttl` ms by the caller's closure.
function reservedFromFile(file) {
  try {
    const reg = JSON.parse(fs.readFileSync(file, 'utf8')), rooms = []
    for (const w of Object.values(reg.worlds || {})) for (const r of w.rooms || []) rooms.push(r)
    return reservedKeys(rooms)
  } catch { return new Set() }
}
function makeReserved(file, ttl = 15000, now = Date.now) {
  let at = -Infinity, set = new Set()
  return () => { if (now() - at > ttl) { set = reservedFromFile(file); at = now() } return set }
}

// ---------------------------------------------------------------------------------------------------- spots for a single chest
// A single chest (reset, junk) goes on a room cell that is open above (a covered chest does not open) on a solid floor, is not a chest-row spot or a
// torch spot, and is not next to another chest (it would join it into a double), nearest the entrance first. `P` is storage.js's plan();
// block(c) gives { name, boundingBox } or null; skip = keys of spots that failed before.
function singleSpot(P, block, skip = []) {
  const bad = new Set((skip || []).map(key)), rows = new Set(P.chestSpots.flat().map(q => q.toString())), tor = new Set(P.torches.map(q => q.toString()))
  const open = (c) => { const b = block(c); return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
  for (let k = 3; k < 10; k++) for (const j of [2, -2, 1, -1]) {
    const c = P.at(k, j); if (bad.has(key(c)) || rows.has(c.toString()) || tor.has(c.toString())) continue
    const g = block(c.offset(0, -1, 0)); if (!g || g.boundingBox !== 'block' || !open(c) || !open(c.offset(0, 1, 0))) continue
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = block(c.offset(dx, 0, dz)); return n && /chest|barrel/.test(n.name) })) continue
    return c
  }
  return null
}

module.exports = { LEAN_KIT, kitEntry, kitCounts, kitGap, kitShort, restockTake, stockGive, craftable, tally, themeOfItem, themeOfChest, roleOf, observe, chestItems, setReset, setJunk, forget, summary, whereIs, reservedKeys, reservedFromFile, makeReserved, singleSpot, key }
