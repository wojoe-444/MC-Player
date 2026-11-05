// brain/autopilot/memory.js: the bot's persistent world memory. What a player who lives at the base simply knows:
// where the structures are, what is in each chest (refreshed whenever a chest is really opened), where it has walked underground,
// where it died, and where it must never dig (the property). Saved to brain/state/base-memory.json, survives restarts and hot reloads.
const fs = require('fs')
const path = require('path')

// Walter's property. The surface layer (y >= minY) inside the box (plus pad) is never dug, nor is the ladder shaft column or anything next to a ladder.
const SEED = { anchor: { x: 0, y: 64, z: 0 }, boxes: [], allow: [], keep: [], places: {}, deaths: [] }

const num = (x) => typeof x === 'number' && Number.isFinite(x)

function createMemory({ file, dir, log = () => {} }) {
  let M = null
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
  M = load() || {}
  const merge = (k, def) => { if (M[k] == null) M[k] = JSON.parse(JSON.stringify(def)); }
  merge('anchor', SEED.anchor); merge('boxes', SEED.boxes); M.keep = []; M.allow = JSON.parse(JSON.stringify(SEED.allow)); merge('deaths', SEED.deaths)
  M.places = Object.assign({}, SEED.places, M.places || {})
  for (const [k, p] of Object.entries(SEED.places)) if (!(M.places[k] && M.places[k].learned)) M.places[k] = p       // seeds are canonical unless the bot corrected them
  M.chests = M.chests || {}
  M.trail = M.trail || {}
  M.lessons = M.lessons || []
  let dirty = true, saveTimer = null
  const save = () => { dirty = false; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(M)); fs.renameSync(file + '.tmp', file) } catch (e) { log('MEM_SAVE_ERR', e.message) } }
  const touch = () => { dirty = true; if (!saveTimer) { saveTimer = setTimeout(() => { saveTimer = null; if (dirty) save() }, 4000); if (saveTimer.unref) saveTimer.unref() } }

  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const parse = (k) => k.split(',').map(Number)

  // ---------- no-dig zone ----------
  function noDig(p, blockName) {
    if (!p) return false
    const x = p.x, y = p.y, z = p.z
    if (blockName) for (const b of M.allow || []) if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2] && new RegExp(b.only).test(blockName)) return false
    for (const b of M.keep || []) if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]) return true
    for (const b of M.boxes || []) {
      const pad = b.pad || 0
      if (x >= b.min[0] - pad && x <= b.max[0] + pad && z >= b.min[2] - pad && z <= b.max[2] + pad && y >= (b.minY != null ? b.minY : b.min[1]) && y <= b.max[1]) return true
    }
    // anything within 2 blocks of a remembered chest / furnace / bed / table is part of the base
    for (const k of Object.keys(M.chests)) { const c = parse(k); if (Math.abs(c[0] - x) <= 2 && Math.abs(c[1] - y) <= 2 && Math.abs(c[2] - z) <= 2) return true }
    return false
  }
  const inBase = (p) => { const b = (M.boxes || [])[0]; if (!b || !p) return false; return p.x >= b.min[0] - 12 && p.x <= b.max[0] + 12 && p.z >= b.min[2] - 12 && p.z <= b.max[2] + 12 && p.y >= b.min[1] && p.y <= b.max[1] }

  // ---------- chests ----------
  function setChest(pos, items, slots) {
    M.chests[key(pos)] = { items: items || {}, slots: slots || null, at: Date.now() }
    touch()
  }
  function forgetChest(pos) { delete M.chests[key(pos)]; touch() }
  // pick up what the other modules (furnace, crafting, mining) learned about chests: chest-index.json, crafting-chests.json, stations.json
  let lastMerge = 0
  function mergeIndex() {
    if (Date.now() - lastMerge < 20000) return
    lastMerge = Date.now()
    const take = (k, c) => {
      if (!c || typeof c !== 'object' || !c.items || c.error) return
      const cur = M.chests[k]
      const at = c.at || 0
      if (!cur || (at > (cur.at || 0))) { M.chests[k] = { items: c.items, slots: c.slots || (cur && cur.slots) || null, at: at || Date.now() - 6 * 3600000 }; dirty = true }
    }
    const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
    const ci = rd('chest-index.json'); if (ci) for (const [k, c] of Object.entries(ci)) take(k, c)
    const cc = rd(path.join('brain', 'state', 'crafting-chests.json')); if (cc) for (const [k, c] of Object.entries(cc)) take(k, c)
    const st = rd('stations.json'); if (Array.isArray(st)) for (const s of st) for (const c of s.chests || []) { if (c.at && c.items && !c.error) take(c.at, { items: c.items, slots: c.slots, at: 0 }) }
    if (dirty) touch()
  }
  // chests grouped so that the two halves of a double chest count once
  function chestList(from) {
    const out = [], seen = new Set()
    for (const [k, c] of Object.entries(M.chests)) {
      if (seen.has(k)) continue
      const p = parse(k); seen.add(k)
      const sig = JSON.stringify(c.items || {})
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nk = `${p[0] + dx},${p[1]},${p[2] + dz}`; const n = M.chests[nk]; if (n && !seen.has(nk) && JSON.stringify(n.items || {}) === sig) seen.add(nk) }
      out.push({ k, p, items: c.items || {}, at: c.at || 0, slots: c.slots })
    }
    if (from) out.sort((a, b) => Math.hypot(a.p[0] - from.x, a.p[1] - from.y, a.p[2] - from.z) - Math.hypot(b.p[0] - from.x, b.p[1] - from.y, b.p[2] - from.z))
    return out
  }
  const chestsWith = (re, from) => chestList(from).filter(c => Object.keys(c.items).some(n => re.test(n)))
  const INTEREST = /(pickaxe|_axe|sword|shovel|hoe|helmet|chestplate|leggings|boots|shield|^bow$|^arrow|crossbow|iron_ingot|raw_iron|diamond|^coal$|charcoal|cobblestone|cobbled_deepslate|^stone$|torch|bread|baked_potato|^cooked_|^apple|^carrot|golden_apple|_log$|_planks$|^stick$|bucket|_bed$|crafting_table|^furnace|^chest$|ender_pearl|gold_ingot|^redstone$|^sand$|^glass$)/
  function stock(from) {
    const agg = {}
    for (const c of chestList(from)) for (const [n, cnt] of Object.entries(c.items)) {
      if (!INTEREST.test(n)) continue
      const a = agg[n] || (agg[n] = { total: 0, where: [] })
      a.total += cnt
      a.where.push({ at: c.k, n: cnt, age_min: c.at ? Math.round((Date.now() - c.at) / 60000) : null })
    }
    for (const a of Object.values(agg)) a.where = a.where.slice(0, 2)
    return agg
  }
  function chestFreshness() {
    const l = chestList(); let stale = 0, unknown = 0
    for (const c of l) { if (!c.at) unknown++; else if (Date.now() - c.at > 20 * 60000) stale++ }
    return { chests: l.length, stale_over_20min: stale, never_opened: unknown }
  }

  // ---------- trail (where the bot has actually walked) ----------
  function breadcrumb(p) {
    if (!p) return
    const k = `${Math.floor(p.x) >> 3}|${Math.floor(p.y) >> 3}|${Math.floor(p.z) >> 3}`
    const t = M.trail[k]
    if (t) { t.n++; t.t = Date.now() } else { if (Object.keys(M.trail).length > 4000) return; M.trail[k] = { n: 1, t: Date.now() } }
    touch()
  }
  // underground levels the bot has walked: y band -> bounding box of visited cells
  function trailSummary() {
    const bands = {}
    for (const k of Object.keys(M.trail)) {
      const [cx, cy, cz] = k.split('|').map(Number)
      const y = cy * 8
      if (y >= 120) continue
      const b = bands[cy] || (bands[cy] = { y: `${y}..${y + 7}`, minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9, cells: 0 })
      b.minX = Math.min(b.minX, cx * 8); b.maxX = Math.max(b.maxX, cx * 8 + 7); b.minZ = Math.min(b.minZ, cz * 8); b.maxZ = Math.max(b.maxZ, cz * 8 + 7); b.cells++
    }
    return Object.values(bands).sort((a, b) => parseInt(b.y) - parseInt(a.y)).slice(0, 6)
  }

  // ---------- deaths ----------
  function addDeath(p, cause) { M.deaths.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), t: Date.now(), cause: cause || null }); if (M.deaths.length > 20) M.deaths.shift(); touch() }
  function dangerZones() {
    const zones = []
    for (const d of M.deaths) {
      const z = zones.find(q => Math.hypot(q.x - d.x, q.z - d.z) < 40 && Math.abs(q.y - d.y) < 30)
      if (z) { z.deaths++; z.cause = d.cause || z.cause } else zones.push({ x: d.x, y: d.y, z: d.z, deaths: 1, cause: d.cause })
    }
    return zones.sort((a, b) => b.deaths - a.deaths).slice(0, 5)
  }
  const lastDeath = () => M.deaths.length ? M.deaths[M.deaths.length - 1] : null

  // ---------- places ----------
  function loadWaypoints() {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, 'waypoints.json'), 'utf8'))
      for (const [name, c] of Object.entries(w)) {
        if (!c || !num(c.x) || !num(c.z)) continue
        if (Math.hypot(c.x - M.anchor.x, c.z - M.anchor.z) > 200) continue
        const k = name.toLowerCase()
        if (!M.places[k]) M.places[k] = { x: c.x, y: num(c.y) ? c.y : M.anchor.y, z: c.z, kind: 'waypoint', note: c.source || '' }
      }
    } catch { /* optional */ }
  }
  loadWaypoints()
  function place(name) {
    const n = String(name || '').toLowerCase().trim()
    if (!n) return null
    if (M.places[n]) return { name: n, ...M.places[n] }
    const hit = Object.keys(M.places).find(k => k.includes(n) || n.includes(k))
    return hit ? { name: hit, ...M.places[hit] } : null
  }
  function addPlace(name, p, kind, note) { M.places[String(name).toLowerCase()] = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), kind: kind || 'custom', note: note || '', learned: true }; touch() }
  function nearestPlaces(from, n = 6) {
    return Object.entries(M.places).map(([name, p]) => ({ name, d: Math.round(Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z)), at: [p.x, p.y, p.z], kind: p.kind })).sort((a, b) => a.d - b.d).slice(0, n)
  }

  // nearest open ground outside the no-dig zone: where to go for trees, stone outcrops, animals
  function exits(p) {
    const b = (M.boxes || [])[0]; if (!b || !p) return null
    const pad = (b.pad || 0) + 10
    const opts = [['west', b.min[0] - pad, Math.round(p.z)], ['east', b.max[0] + pad, Math.round(p.z)], ['north', Math.round(p.x), b.min[2] - pad], ['south', Math.round(p.x), b.max[2] + pad]]
    return opts.map(([dir, x, z]) => ({ dir, x, z, d: Math.round(Math.hypot(x - p.x, z - p.z)) })).sort((a, c) => a.d - c.d).slice(0, 3)
  }

  return { M, exits, save, touch, noDig, inBase, setChest, forgetChest, mergeIndex, chestList, chestsWith, stock, chestFreshness, breadcrumb, trailSummary, addDeath, dangerZones, lastDeath, place, addPlace, nearestPlaces, key, parse, dispose() { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; if (dirty) save() }, SEED }
}

module.exports = { createMemory, SEED }
