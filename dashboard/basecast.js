// Data for the dashboard's Bases page (/api/bases, /api/bases/<id>): the "ant-farm cast" of a base. Read-only, no dependencies.
//
// Walter (2026-11-11): looking at the base in spectator mode it looked like metal poured into an ant colony. The page shows the space the bots dug and
// built under (and around) a base waypoint, with the solid world left out, as a cast.
//
// Everything comes from what the bots recorded themselves, never from reading the world:
//   recorded digs   bot-shared/base-dug/<base id>.jsonl   every block a bot dug inside a base (brain/bases), from the day that module first ran
//   shafts, rooms   the shared registry (bot-shared/registry.json): the shaft column, the storage room with its corridor, the mob farm (its design,
//                   rebuilt from the registry record with brain/mobfarm/geometry.js when the code folder is available)
//   farms           the bots' own state files: tree farm spots, animal pens, the crop plot
//   placed blocks   bot-shared/placed-blocks.json: chests, crafting tables, furnaces, hoppers inside the base, shown as markers
// Digs from before the dug log existed are not recoverable from records, so the open space itself comes from the world save (dashboard/worldcast.js):
// the underground air connected to the shaft and rooms, inside the base circle. That is a view for Walter, read the way a map viewer reads the save;
// nothing here reaches the bots. Where the save cannot be found the cast falls back to the registry's shafts, rooms and farms ("derived" cells).
// Every cell says whether it is a recorded dig, so the page can show the live record on top of the world.
//
// The base list is bot-shared/bases.json (brain/bases writes it from the waypoints named in brain/bases/config.json). Until the bot has run that module,
// the same waypoints are looked up here through the code folder's waypoint book, so the page works before the bot restarts.
'use strict'
const fs = require('fs')
const path = require('path')

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const arr = (a) => (Array.isArray(a) ? a : [])
const isPos = (p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(Number.isFinite)
const key = (x, y, z) => x + ',' + y + ',' + z
const MAX_CELLS = 400000

// Cell kinds, in the order that decides who wins when two parts claim one cell. The client keeps the same list.
const KINDS = ['shaft', 'room', 'mobfarm', 'farm', 'tunnel', 'cave']

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'base'

// ---------------------------------------------------------------- the base list
function basesFromFile(sharedDir) {
  const f = readJson(path.join(sharedDir, 'bases.json'))
  const out = []
  for (const [world, w] of Object.entries((f && f.worlds) || {})) {
    for (const b of arr(w && w.bases)) if (b && Number.isFinite(b.x) && Number.isFinite(b.z) && b.radius > 0) out.push({ id: String(b.id), name: String(b.name || b.id), x: b.x, y: Number.isFinite(b.y) ? b.y : 64, z: b.z, radius: b.radius, world, save: b.save || null, source: b.source || 'waypoint' })
  }
  return out
}

// Before the bot has written bases.json: the waypoints named in brain/bases/config.json, found in the code folder's waypoint book (Xaero + waypoints.json).
function basesFromWaypoints({ codeDir, registry }) {
  if (!codeDir) return []
  try {
    const cfg = readJson(path.join(codeDir, 'brain', 'bases', 'config.json'))
    if (!cfg || !arr(cfg.bases).length) return []
    const { WaypointBook } = require(path.join(codeDir, 'brain', 'nav', 'waypoints.js'))
    let xaero = null
    try { xaero = require(path.join(codeDir, 'xaero.js')) } catch { /* local waypoints only */ }
    const book = new WaypointBook({ dir: codeDir, xaero, world: null })
    const world = Object.keys((registry && registry.worlds) || {})[0] || 'unknown'
    const out = []
    for (const name of cfg.bases) {
      const w = book.all(0).find(x => slug(x.name) === slug(name))
      if (w) out.push({ id: slug(w.name) + '-live', name: w.name, x: w.x, y: typeof w.y === 'number' ? w.y : 64, z: w.z, radius: cfg.radius || 110, world, save: book.xaeroWorld() || null, source: 'waypoint (looked up here)' })
    }
    return out
  } catch { return [] }
}

function listBases({ sharedDir, codeDir, registry }) {
  const fromFile = basesFromFile(sharedDir)
  return fromFile.length ? fromFile : basesFromWaypoints({ codeDir, registry })
}

// ---------------------------------------------------------------- the cast
const inCircle = (b, x, z) => Math.hypot(x - b.x, z - b.z) <= b.radius

// Cells between the shaft and a room box: the corridor the builder digs (two cells, two high) along the axis that points at the box.
function corridorToBox(shaft, box, y) {
  if (!shaft || !isPos(shaft.entry) || !box) return []
  const sx = shaft.entry[0], sz = shaft.entry[2], out = []
  const dx = sx < box.x0 ? 1 : sx > box.x1 ? -1 : 0, dz = sz < box.z0 ? 1 : sz > box.z1 ? -1 : 0
  if ((dx !== 0) === (dz !== 0)) return out                 // diagonal or inside: nothing to say
  let x = sx, z = sz
  for (let i = 0; i < 12; i++) {
    x += dx; z += dz
    if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1) break
    for (let h = 0; h < 2; h++) out.push([x, y + h, z])
  }
  return out
}

function mobfarmCells(room, shaft, codeDir) {
  if (codeDir && shaft) {
    try {
      const L = require(path.join(codeDir, 'brain', 'inspect', 'mobfarm.js')).layoutOfRoom(room, shaft)
      if (L) {
        const cells = L.dig.slice()
        // the water source cells at the trench tips are part of the cast too (the sources are placed, not dug, so they are not in `dig`)
        for (const s of L.platform.sources) cells.push(s)
        return { cells, design: true }
      }
    } catch { /* fall back to the box */ }
  }
  const b = room.box, cells = []
  if (b) for (let x = b.x0; x <= b.x1; x++) for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) cells.push([x, y, z])
  return { cells, design: false }
}

function boxCells(b) {
  const out = []
  for (let x = b.x0; x <= b.x1; x++) for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) out.push([x, y, z])
  return out
}

function stateFiles(botDirs) {
  const out = []
  for (const b of botDirs) out.push({ id: b.id, dir: path.join(b.dir, 'brain', 'state') })
  return out
}

// The recorded digs of one base, newest record wins per cell. Returns Map key -> [x,y,z,name,by,t].
function readDug(sharedDir, id) {
  const file = path.join(sharedDir, 'base-dug', id + '.jsonl'), out = new Map()
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    if (!line) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    if (!Array.isArray(r) || r.length < 3 || !r.slice(0, 3).every(Number.isInteger)) continue
    out.set(key(r[0], r[1], r[2]), r)
  }
  return out
}


// ---------------------------------------------------------------- the provenance ledger (brain/ledger)
// bot-shared/ledger/<world hash>/<bot>.jsonl, lines [t, op, x, y, z, block, by, space, via]; the newest line of a cell wins (a tie goes to the one that names a space).
// op: p placed, d dug, r a placed block taken out again (hollows nothing), f appeared with no bot of ours placing it, x one of ours changed from outside,
// S space metadata (block = kind, space = id, via = label), B a writer's coverage marker. This reader is the file-shape contract with brain/ledger/lib.js.
function readLedger(sharedDir, base) {
  const root = path.join(sharedDir, 'ledger'), cellsOut = new Map(), spaces = new Map(), writers = {}
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name)) } catch { return null }
  let lines = 0
  for (const dir of dirs) {
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      let text = ''; try { text = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line) continue
        let r; try { r = JSON.parse(line) } catch { continue }
        if (!Array.isArray(r) || r.length < 7 || !Number.isFinite(r[0])) continue
        lines++
        const [t, op] = r
        if (op === 'B') { if (writers[r[6]] == null || t < writers[r[6]]) writers[r[6]] = t; continue }
        if (op === 'S') { const o = spaces.get(r[7]); if (!o || o.t <= t) spaces.set(r[7], { id: r[7], kind: r[5] || null, label: r[8] || null, t }); continue }
        if (!['p', 'd', 'r', 'f', 'x'].includes(op) || !r.slice(2, 5).every(Number.isInteger) || !inCircle(base, r[2], r[4])) continue
        const k = key(r[2], r[3], r[4]), o = cellsOut.get(k)
        if (o && (o[0] > t || (o[0] === t && o[7] && !r[7]))) continue
        cellsOut.set(k, [t, op, r[2], r[3], r[4], r[5], r[6], r[7] || (o && o[7]) || '', r[8] || ''])
      }
    }
  }
  if (!lines) return null
  const from = Object.values(writers).length ? Math.min(...Object.values(writers)) : null
  return { cells: cellsOut, spaces, from, writers: Object.keys(writers) }
}
// what the dug log ignored: not "space" (trunks, leaves, plants, light, workbenches)
const DUG_IGNORE = /(_log|_wood|_stem|_hyphae|_leaves|_sapling|_roots|_planks)$|^(grass|short_grass|tall_grass|fern|large_fern|dead_bush|vine|snow|snow_block|sugar_cane|cactus|bamboo|kelp|kelp_plant|seagrass|tall_seagrass|wheat|carrots|potatoes|beetroots|melon|pumpkin|torch|wall_torch|ladder|chest|crafting_table|furnace|hopper|barrel|oak_fence|oak_fence_gate|lily_pad|moss_carpet|glow_lichen|sweet_berry_bush|brown_mushroom|red_mushroom|dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|leaf_litter|water|lava)$|(_flower|_tulip|_orchid|_bush|_carpet)$/
const PART_KIND = { shaft: 'shaft', room: 'room', storage: 'room', mobfarm: 'mobfarm', farm: 'farm' }

// ---------------------------------------------------------------- the world save
const SAVE_CACHE = new Map()
function defaultSavesDir() {
  if (process.env.BOT_WORLD_SAVES) return process.env.BOT_WORLD_SAVES
  return process.env.APPDATA ? path.join(process.env.APPDATA, '.minecraft', 'saves') : null
}
// The save folder holding the base: base.save when the record names one, else the most recently written save whose region files cover the base.
function findSave(base, savesDir) {
  const root = savesDir || defaultSavesDir()
  if (!root) return null
  const rx = Math.floor(base.x / 512), rz = Math.floor(base.z / 512)
  const file = (name) => path.join(root, name, 'region', `r.${rx}.${rz}.mca`)
  const m = (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } }
  if (base.save && m(file(base.save)) != null) return { name: base.save, regionDir: path.join(root, base.save, 'region'), mtime: m(file(base.save)) }
  let best = null
  try { for (const d of fs.readdirSync(root)) { const t = m(file(d)); if (t != null && (!best || t > best.mtime)) best = { name: d, regionDir: path.join(root, d, 'region'), mtime: t } } } catch { return null }
  return best
}

// Underground open space connected to the base's own cells. Returns { list, open (Set of keys), work (Set of keys of bot-worked cells), save, savedAt, chunks } or null.
function worldCells({ base, savesDir, cells, placed, worldKeys }) {
  let wc
  try { wc = require('./worldcast') } catch { return null }
  const sv = findSave(base, savesDir)
  if (!sv) return null
  // cells the bots worked: what they dug (the recorded cells), and what they placed underground
  const work = new Set(), seeds = []
  for (const c of cells.values()) {
    if (c.kind === 'shaft' || c.kind === 'room' || c.kind === 'mobfarm' || c.src === 'recorded') seeds.push([c.x, c.y, c.z])
    if (c.src === 'recorded') work.add(key(c.x, c.y, c.z))
  }
  const BOT_THING = /^(torch|wall_torch|ladder|chest|crafting_table|furnace|hopper|barrel|[a-z_]*_bed|oak_door|oak_fence_gate|oak_sign|lantern)$/
  for (const [wn, w] of Object.entries((placed && placed.worlds) || {})) {
    if (worldKeys.size && !worldKeys.has(wn) && wn !== 'unknown') continue
    for (const [k, r] of Object.entries(w)) {
      if (!BOT_THING.test(String(r[0]))) continue
      const [x, y, z] = k.split(',').map(Number)
      if (!inCircle(base, x, z)) continue
      work.add(k); seeds.push([x, y, z])
    }
  }
  const ck = base.id + '|' + sv.regionDir + '|' + sv.mtime + '|' + base.radius
  let hit = SAVE_CACHE.get(ck)
  if (!hit) {
    SAVE_CACHE.clear()
    let scan
    try { scan = wc.scanBase({ regionDir: sv.regionDir, x: base.x, z: base.z, radius: base.radius }) } catch { return null }
    hit = { scan, at: Date.now() }
    SAVE_CACHE.set(ck, hit)
  }
  if (!hit.scan.chunks) return null
  const cav = wc.cavityFrom(hit.scan, seeds, { x: base.x, z: base.z, radius: base.radius })
  if (!cav.count) return null
  const b = hit.scan.box, list = [], open = new Set()
  for (let gy = 0; gy < b.H; gy++) for (let gz = 0; gz < b.D; gz++) for (let gx = 0; gx < b.W; gx++) {
    if (!cav.cells[gx + b.W * (gz + b.D * gy)]) continue
    const x = gx + b.x0, y = gy + b.y0, z = gz + b.z0
    list.push([x, y, z]); open.add(key(x, y, z))
  }
  return { list, open, work, save: sv.name, savedAt: sv.mtime, chunks: hit.scan.chunks }
}

function buildCast({ base, sharedDir, registryFile, botDirs = [], codeDir = null, savesDir = null, now = Date.now() }) {
  const registry = registryFile ? readJson(registryFile) : null
  const placed = readJson(path.join(sharedDir, 'placed-blocks.json'))
  const cells = new Map()                 // key -> { x, y, z, kind, part, src }
  const parts = []
  const markers = []
  const notes = []
  const rank = (k) => KINDS.indexOf(k)
  const claim = (list, kind, part, src) => {
    let n = 0
    for (const [x, y, z] of list) {
      const k = key(x, y, z), c = cells.get(k)
      if (c && rank(c.kind) <= rank(kind)) continue
      cells.set(k, { x, y, z, kind, part, src }); n++
    }
    return n
  }
  const addPart = (p, list) => { const n = claim(list, p.kind, p.id, p.src); parts.push({ ...p, cells: n }); return n }

  // ---- shafts and rooms from the shared registry (the base's world; a base looked up before bases.json existed takes every world with a shaft inside its circle)
  const worlds = registry && registry.worlds ? Object.entries(registry.worlds).filter(([name, w]) => name === base.world || (arr(w.shafts).some(s => isPos(s.entry) && inCircle(base, s.entry[0], s.entry[2])))) : []
  for (const [, w] of worlds) {
    for (const s of arr(w.shafts)) {
      if (!isPos(s.entry) || !inCircle(base, s.entry[0], s.entry[2])) continue
      const x = s.entry[0], z = s.entry[2], bottom = isPos(s.bottom) ? s.bottom[1] : null
      const list = []
      if (bottom != null) for (let y = bottom; y <= s.entry[1]; y++) list.push([x, y, z])
      else notes.push(`Shaft ${s.id} has no recorded bottom yet`)
      addPart({ id: s.id, kind: 'shaft', label: 'Shaft', by: s.by || null, at: Number.isFinite(s.at) ? s.at : null, src: 'registry', detail: bottom != null ? `${s.entry[1] - bottom} blocks deep` : 'no bottom recorded' }, list)
      for (const r of arr(w.rooms)) {
        if (r.shaft !== s.id || !r.box) continue
        if (r.type === 'mobfarm') {
          const m = mobfarmCells(r, s, codeDir)
          addPart({ id: r.id, kind: 'mobfarm', label: 'Mob farm', by: r.by || null, at: Number.isFinite(r.at) ? r.at : null, src: 'registry', detail: m.design ? 'from its design' : 'the recorded box' }, m.cells)
          if (!m.design) notes.push('The mob farm is drawn as its whole recorded box: the code folder was not available to rebuild its design')
          for (const c of arr(r.chests)) if (isPos(c)) markers.push({ type: 'chest', x: c[0], y: c[1], z: c[2], label: 'Mob farm chest' })
        } else {
          const y = Number.isFinite(r.y) ? r.y : r.box.y0
          addPart({ id: r.id, kind: 'room', label: r.type === 'storage' ? 'Storage room' : `Room (${r.type || 'room'})`, by: r.by || null, at: Number.isFinite(r.at) ? r.at : null, src: 'registry', detail: `${r.box.x1 - r.box.x0 + 1} x ${r.box.z1 - r.box.z0 + 1} x ${r.box.y1 - r.box.y0 + 1}` }, boxCells(r.box).concat(corridorToBox(s, r.box, y)))
          for (const c of arr(r.chests)) if (isPos(c)) markers.push({ type: 'chest', x: c[0], y: c[1], z: c[2], label: r.type === 'storage' ? 'Storage chest' : 'Chest' })
        }
      }
    }
  }

  // ---- farms from the bots' own state files
  const seenFarm = new Set()
  for (const sf of stateFiles(botDirs)) {
    const tf = readJson(path.join(sf.dir, 'treefarm-state.json'))
    for (const f of arr(tf && tf.farms)) {
      const id = 'tree-' + f.id
      if (seenFarm.has(id) || !Number.isFinite(f.x) || !inCircle(base, f.x, f.z)) continue
      seenFarm.add(id)
      const list = []
      for (const [xz, y] of Object.entries(f.spotY || {})) { const [x, z] = xz.split(',').map(Number); if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(y)) list.push([x, y, z], [x, y + 1, z]) }
      addPart({ id, kind: 'farm', label: `Tree farm ${f.id}`, by: null, at: Number.isFinite(f.at) ? f.at : null, src: 'state', detail: `${f.cols || '?'} x ${f.rows || '?'} ${f.species || ''}`.trim() }, list)
    }
    const hu = readJson(path.join(sf.dir, 'husbandry-state.json'))
    for (const p of arr(hu && hu.pens)) {
      const id = 'pen-' + p.id
      if (seenFarm.has(id) || !p.built || !Number.isFinite(p.ox) || !inCircle(base, p.ox, p.oz)) continue
      seenFarm.add(id)
      const list = []
      for (let x = p.ox; x < p.ox + p.w; x++) for (let z = p.oz; z < p.oz + p.d; z++) list.push([x, p.oy, z], [x, p.oy + 1, z])
      addPart({ id, kind: 'farm', label: `Animal pen ${p.id}`, by: null, at: Number.isFinite(p.createdAt) ? p.createdAt : null, src: 'state', detail: `${p.w} x ${p.d}` }, list)
    }
    const ap = readJson(path.join(sf.dir, 'autopilot-state.json'))
    if (ap && arr(ap.farm).length && !seenFarm.has('crops')) {
      const plot = arr(ap.farm).filter(c => isPos(c) && inCircle(base, c[0], c[2]))
      if (plot.length) {
        seenFarm.add('crops')
        const list = []
        for (const [x, y, z] of plot) list.push([x, y + 1, z], [x, y + 2, z])
        if (isPos(ap.farmWater)) list.push([ap.farmWater[0], ap.farmWater[1], ap.farmWater[2]])
        addPart({ id: 'crops', kind: 'farm', label: 'Crop plot', by: null, at: null, src: 'state', detail: `${plot.length} soil blocks` }, list)
      }
    }
  }

  // ---- recorded digs (tunnels and anything else a bot dug in the base): the provenance ledger first, the older per-base dug log under it
  const dug = readDug(sharedDir, base.id)
  const ledger = readLedger(sharedDir, base)
  const ledgerStats = ledger ? { cells: ledger.cells.size, dug: 0, placed: 0, removed: 0, foreign: 0, changed: 0, spaces: 0, coverageFrom: ledger.from, writers: ledger.writers } : null
  if (ledger) {
    const bySpace = new Map()                                    // space id -> [[x,y,z]...] of dug cells the ledger filed under it
    for (const r of ledger.cells.values()) {
      const [t, op, x, y, z, block, by, space] = r
      if (op === 'd') ledgerStats.dug++; else if (op === 'p') ledgerStats.placed++; else if (op === 'r') ledgerStats.removed++; else if (op === 'f') ledgerStats.foreign++; else ledgerStats.changed++
      if (op !== 'd' || DUG_IGNORE.test(block)) continue
      const k = key(x, y, z), old = dug.get(k)
      if (!old || old[5] < t) dug.set(k, [x, y, z, block, by, t])
      if (space) { let a = bySpace.get(space); if (!a) bySpace.set(space, a = []); a.push([x, y, z]) }
    }
    // a space the registry and the state files do not know (a job declared it) becomes its own part; a known one just marks its cells as recorded
    for (const [id, list] of bySpace) {
      const known = parts.find(p => p.id === id)
      if (known) { for (const [x, y, z] of list) { const c = cells.get(key(x, y, z)); if (c) c.src = 'recorded' } continue }
      const meta = ledger.spaces.get(id) || {}
      const kind = PART_KIND[meta.kind] || 'tunnel'
      const lastT = Math.max(...list.map(([x, y, z]) => (ledger.cells.get(key(x, y, z)) || [0])[0]))
      addPart({ id, kind, label: meta.label || id, by: null, at: lastT || null, src: 'recorded', detail: `${list.length} blocks dug, filed under "${id}" by the ledger` }, list)
      ledgerStats.spaces++
    }
    if (ledger.from) notes.push(`The ledger has recorded every dig and placement since ${new Date(ledger.from).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${ledgerStats.placed} blocks placed, ${ledgerStats.dug} dug, ${ledgerStats.removed} placed blocks taken out again in this base. A block with no record from then on is not ours.`)
    if (ledgerStats.foreign) notes.push(`${ledgerStats.foreign} block(s) appeared in this base that no bot of ours placed (an enderman, a player, a flow); ${ledgerStats.changed} of our own were changed by someone else.`)
  }
  if (dug.size) {
    const list = [], by = {}
    let first = Infinity, last = 0
    for (const r of dug.values()) { list.push([r[0], r[1], r[2]]); by[r[4]] = (by[r[4]] || 0) + 1; if (r[5] < first) first = r[5]; if (r[5] > last) last = r[5] }
    const owners = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ')
    const own = new Set(cells.keys())
    const fresh = list.filter(c => !own.has(key(c[0], c[1], c[2]))).length
    const n = claim(list, 'tunnel', 'dug', 'recorded')
    parts.push({ id: 'dug', kind: 'tunnel', label: 'Dug tunnels', by: null, at: last || null, src: 'recorded', detail: `${dug.size} blocks dug (${owners}); ${fresh} outside the shafts, rooms and farms`, cells: n })
  } else notes.push('No digs recorded yet: the dug-block log starts when the bots next restart with the bases module. Until then the cast is the shafts, rooms and farms the registry knows.')

  // ---- placed things inside the base, as markers (the cast itself is only the space)
  const MARK = { chest: 'chest', crafting_table: 'table', furnace: 'furnace', hopper: 'hopper', barrel: 'chest', bed: 'bed' }
  const worldKeys = new Set(worlds.map(([n]) => n)); if (base.world) worldKeys.add(base.world)
  let placedCount = 0
  const seenM = new Set(markers.map(m => key(m.x, m.y, m.z)))
  for (const [wn, w] of Object.entries((placed && placed.worlds) || {})) {
    if (worldKeys.size && !worldKeys.has(wn) && !(wn === 'unknown')) continue
    for (const [k, r] of Object.entries(w)) {
      const [x, y, z] = k.split(',').map(Number)
      if (!inCircle(base, x, z)) continue
      placedCount++
      const nm = String(r[0]), type = /_bed$/.test(nm) ? 'bed' : MARK[nm]
      if (!type || seenM.has(k)) continue
      seenM.add(k)
      markers.push({ type, x, y, z, label: String(r[0]).replace(/_/g, ' ') })
    }
  }

  // ---- the open space itself, from the world save
  const worldInfo = worldCells({ base, savesDir, cells, placed, worldKeys })
  if (worldInfo) {
    const open = worldInfo.open                                   // Set of keys of the underground cavity reachable from the base
    let dropped = 0
    for (const [k, c] of cells) if ((c.kind === 'shaft' || c.kind === 'room' || c.kind === 'mobfarm') && !open.has(k)) { cells.delete(k); dropped++ }
    const work = worldInfo.work
    const near = (x, y, z) => { for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) if (work.has(key(x + dx, y + dy, z + dz))) return true; return false }
    const tun = [], cav = []
    for (const [x, y, z] of worldInfo.list) { if (cells.has(key(x, y, z))) continue; (near(x, y, z) ? tun : cav).push([x, y, z]) }
    parts.push({ id: 'world-tunnels', kind: 'tunnel', label: 'Tunnels and lit caves', by: null, at: null, src: 'world', detail: 'open space within 2 blocks of a dig, torch, ladder or chest a bot placed', cells: 0 })
    parts.push({ id: 'world-caves', kind: 'cave', label: 'Natural caves joined to the base', by: null, at: null, src: 'world', detail: 'untouched cave connected to the shaft or a room', cells: 0 })
    claim(tun, 'tunnel', 'world-tunnels', 'world'); claim(cav, 'cave', 'world-caves', 'world')
    if (dropped) notes.push(`${dropped} cells of the registry's shaft, rooms and mob farm design are not open in the saved world (not built yet, or the save is older than the build) and are left out.`)
    notes.push(`The open space is read from the world save "${worldInfo.save}" as Minecraft last wrote it (${new Date(worldInfo.savedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC).`)
  }
  // part sizes follow what is left in the cast
  const sizes = new Map()
  for (const c of cells.values()) sizes.set(c.part, (sizes.get(c.part) || 0) + 1)
  for (const p of parts) p.cells = sizes.get(p.id) || 0

  // ---- put together
  const all = [...cells.values()]
  let truncated = false
  if (all.length > MAX_CELLS) { all.length = MAX_CELLS; truncated = true }
  // flat: x, y, z, index into parts, 1 when the cell is a recorded dig (0 when it comes from the registry or a state file)
  const partIndex = new Map(parts.map((p, n) => [p.id, n]))
  const flat = new Array(all.length * 5)
  let i = 0, minY = Infinity, maxY = -Infinity
  for (const c of all) {
    flat[i++] = c.x; flat[i++] = c.y; flat[i++] = c.z
    flat[i++] = partIndex.get(c.part); flat[i++] = c.src === 'recorded' ? 1 : 0
    if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y
  }
  const bySrc = { recorded: 0, derived: 0 }
  for (const c of all) bySrc[c.src === 'recorded' ? 'recorded' : 'derived']++
  return {
    base: { id: base.id, name: base.name, x: base.x, y: base.y, z: base.z, radius: base.radius },
    generatedAt: new Date(now).toISOString(),
    kinds: KINDS,
    cells: flat, cellStride: 5,
    parts, markers, notes,
    stats: { cells: all.length, recorded: bySrc.recorded, derived: bySrc.derived, digsRecorded: dug.size, placedInBase: placedCount, minY: all.length ? minY : null, maxY: all.length ? maxY : null, truncated },
    sources: { registry: !!registry, placed: !!placed, dugLog: dug.size > 0, ledger: ledgerStats, world: worldInfo ? { save: worldInfo.save, savedAt: worldInfo.savedAt, chunks: worldInfo.chunks, openCells: worldInfo.list.length } : null },
  }
}

// ---------------------------------------------------------------- entry points used by dashboard/server.js
function basesIndex(opts) {
  const registry = opts.registryFile ? readJson(opts.registryFile) : null
  const list = listBases({ sharedDir: opts.sharedDir, codeDir: opts.codeDir, registry })
  return { generatedAt: new Date(opts.now || Date.now()).toISOString(), bases: list.map(b => ({ id: b.id, name: b.name, x: b.x, y: b.y, z: b.z, radius: b.radius, source: b.source })) }
}

function baseCast(opts, id) {
  const registry = opts.registryFile ? readJson(opts.registryFile) : null
  const base = listBases({ sharedDir: opts.sharedDir, codeDir: opts.codeDir, registry }).find(b => b.id === id)
  if (!base) return null
  return buildCast({ base, ...opts })
}

module.exports = { basesIndex, baseCast, buildCast, listBases, KINDS, corridorToBox, readDug }
