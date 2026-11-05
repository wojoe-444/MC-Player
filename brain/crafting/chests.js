// Chest knowledge for crafting and find: reads chest-index.json (written by the legacy "index chests"; this module never writes it),
// keeps its own overlay of what it saw when it last opened a chest (brain/state/crafting-chests.json), and decides which chests
// to visit so that only the needed items are taken.
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }
const parseKey = (k) => { const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(k); return m ? new Vec3(+m[1], +m[2], +m[3]) : null }
const sameItems = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => a[k] === b[k]) }

function create({ dir, overlayFile, indexFile = 'chest-index.json', furnaceConfig = {}, rules = {}, now = Date.now, log = () => {} }) {
  const never = new Set(rules.neverTakeItems || ['lava_bucket'])
  const roleRules = rules.furnaceChestRules || {}

  // key -> role of the furnace-station chests (fuel / input / output). A double chest has two halves, so a chest next to a
  // configured one on the same level counts as the same chest.
  const stationChests = []
  for (const st of furnaceConfig.stations || []) for (const u of st.units || []) for (const role of ['fuel', 'input', 'output']) if (u[role]) stationChests.push({ role, pos: new Vec3(u[role][0], u[role][1], u[role][2]) })
  function roleOf(pos) {
    for (const s of stationChests) {
      if (s.pos.y === pos.y && Math.abs(s.pos.x - pos.x) + Math.abs(s.pos.z - pos.z) <= 1) return s.role
    }
    return null
  }
  // may `item` be taken out of the chest at pos?
  function allowed(pos, item) {
    if (never.has(item)) return false
    const role = roleOf(pos)
    if (!role) return true
    const r = roleRules[role]
    if (r === 'all') return false
    return !(Array.isArray(r) && r.includes(item))
  }

  let overlay = overlayFile ? readJson(overlayFile, {}) : {}
  const saveOverlay = () => { if (!overlayFile) return; try { const tmp = overlayFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(overlay)); fs.renameSync(tmp, overlayFile) } catch (e) { log('overlay save failed: ' + e.message) } }

  // [{ key, pos, items:{name:n}, at }], overlay entries win when they are newer than the index entry; double-chest halves with
  // identical contents are counted once.
  function entries() {
    const idx = readJson(path.join(dir, indexFile), {})
    const out = new Map()
    for (const [key, v] of Object.entries(idx)) {
      const pos = parseKey(key)
      if (!pos || !v || v.error || !v.items) continue
      out.set(key, { key, pos, items: { ...v.items }, at: v.at || 0 })
    }
    for (const [key, v] of Object.entries(overlay)) {
      const pos = parseKey(key)
      if (!pos) continue
      const cur = out.get(key)
      if (v.gone) { out.delete(key); continue }
      if (!cur || (v.at || 0) >= cur.at) out.set(key, { key, pos, items: { ...v.items }, at: v.at || 0 })
    }
    const list = [...out.values()]
    const keep = []
    for (const e of list) {
      const twin = keep.find(k => k.pos.y === e.pos.y && Math.abs(k.pos.x - e.pos.x) + Math.abs(k.pos.z - e.pos.z) === 1 && sameItems(k.items, e.items) && Object.keys(e.items).length)
      if (!twin) keep.push(e)
    }
    return keep
  }

  // what the bot saw when it opened the chest just now
  function observe(key, items) { overlay[key] = { items, at: now() }; saveOverlay() }
  function gone(key) { overlay[key] = { gone: true, at: now() }; saveOverlay() }

  // item id -> count that may be taken, over all chests (minus `skip` keys)
  function totals(list, registry, skip = new Set()) {
    const m = new Map()
    for (const e of list) {
      if (skip.has(e.key)) continue
      for (const [name, n] of Object.entries(e.items)) {
        const it = registry.itemsByName[name]
        if (!it || !allowed(e.pos, name)) continue
        m.set(it.id, (m.get(it.id) || 0) + n)
      }
    }
    return m
  }

  // Which chests to open for `take` (Map itemId -> n)? Greedy: the chest that covers most of what is still needed, nearest first
  // on ties; then ordered as a walk from `from`. Returns [{ key, pos, take: Map(name -> n) }].
  function assign(list, registry, take, from, skip = new Set()) {
    const left = new Map([...take].filter(([, n]) => n > 0).map(([id, n]) => [registry.items[id].name, n]))
    const pool = list.filter(e => !skip.has(e.key)).map(e => ({ e, items: new Map(Object.entries(e.items).filter(([n]) => allowed(e.pos, n)).map(([n, c]) => [n, c])) }))
    const picked = []
    while ([...left.values()].some(n => n > 0)) {
      let best = null
      for (const c of pool) {
        if (picked.some(p => p.e === c.e)) continue
        let cover = 0
        for (const [n, want] of left) if (want > 0) cover += Math.min(want, c.items.get(n) || 0)
        if (!cover) continue
        const d = from.distanceTo(c.e.pos)
        if (!best || cover > best.cover || (cover === best.cover && d < best.d)) best = { c, cover, d }
      }
      if (!best) break
      const t = new Map()
      for (const [n, want] of left) { const got = Math.min(want, best.c.items.get(n) || 0); if (got > 0) { t.set(n, got); left.set(n, want - got) } }
      picked.push({ e: best.c.e, take: t })
    }
    // walk order: nearest next
    const route = []
    let at = from
    const rest = picked.slice()
    while (rest.length) {
      rest.sort((a, b) => at.distanceTo(a.e.pos) - at.distanceTo(b.e.pos))
      const n = rest.shift(); route.push({ key: n.e.key, pos: n.e.pos, take: n.take }); at = n.e.pos
    }
    return route
  }

  return { entries, observe, gone, totals, assign, allowed, roleOf, CHEST_NAMES }
}

module.exports = { create, CHEST_NAMES, parseKey }
