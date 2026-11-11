// brain/ledger/lib.js: the pure core of the provenance ledger (no bot, no timers). One record per cell, kept in memory with a spatial index, saved as
// append-only lines that every bot writes to its own file and every bot reads.
//
//   bot-shared/ledger/<world hash>/<writer>.jsonl     one JSON array per line:  [t, op, x, y, z, block, by, space, via]
//
//   op   'p' placed by `by` (a bot we run)         block = what was placed
//        'd' dug by `by`                           block = what was dug out (the cell is open now)
//        'r' a block that was placed (by us or anyone) taken out again by `by`: the cell is as open as before it was placed, nothing was hollowed
//        'f' appeared and nobody we run made it    by = a player name that swung an arm nearby, else 'other' (an enderman, Walter, a flow...)
//        'x' one of our records was changed by someone else (our block is gone or replaced); block = what is there now
//        'S' a space's metadata:  x,y,z unused, block = kind, by = who declared it, space = id, via = label
//        'B' a writer started recording (coverage marker): by = the writer; the ledger only knows what happened after the first one
//   space  the named space or structure the cell belongs to (shaft id, room id, `tree-<id>`, `pen-<id>`, `crops`), or null
//   via    the job that did it (scheduler task name: mining, build, treefarm...), or null
//
// The newest record of a cell wins (`t`; on a tie the one that names a space wins). That is the whole model: "who made this block?" is a Map lookup, and the
// answer to "did I place it?" for a block with no record is "no", with the date the recording began so the caller knows how far back "no" can be trusted.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const OPS = new Set(['p', 'd', 'f', 'x', 'r'])
const key = (x, y, z) => `${x},${y},${z}`
const colKey = (x, z) => `${x >> 4},${z >> 4}`
const worldHash = (world) => crypto.createHash('sha1').update(String(world)).digest('hex').slice(0, 4)

// What a bot has to be told is made, not grown: block kinds the world does not generate near a base. Used to audit a box for blocks nobody recorded.
const MADE = /_planks$|_door$|_bed$|^(chest|barrel|trapped_chest|crafting_table|furnace|smoker|blast_furnace|torch|wall_torch|lantern|ladder|farmland|glass|glass_pane|hopper|dropper|dispenser|observer|piston|sticky_piston|lever|stone_button|oak_button|stone_pressure_plate|oak_pressure_plate|redstone_torch|redstone_wire|repeater|comparator|iron_bars|cobblestone|stone_bricks|smooth_stone|bricks)$|_slab$|_stairs$|_fence|_wall$|_carpet$|_wool$|_sign$|^polished_|^smooth_|_trapdoor$|_fence_gate$/

class Store {
  constructor() {
    this.cells = new Map()          // key -> { x, y, z, op, block, by, t, space, via, w }
    this.cols = new Map()           // "cx,cz" -> Set(key): the spatial index (16 x 16 columns, every height)
    this.spaces = new Map()         // id -> { id, kind, label, by, t }
    this.bySpace = new Map()        // id -> Set(key)
    this.writers = new Map()        // writer -> first coverage marker time
    this.bots = new Set()           // names whose work counts as "ours"
  }

  // Applies one record. Returns true when the store changed. Safe to apply the same record twice and in any order.
  apply(rec, writer = null) {
    if (!rec || !Number.isFinite(rec.t)) return false
    if (rec.op === 'B') {
      const prev = this.writers.get(rec.by)
      if (prev == null || rec.t < prev) this.writers.set(rec.by, rec.t)
      if (rec.by) this.bots.add(rec.by)
      return prev == null || rec.t < prev
    }
    if (rec.op === 'S') {
      if (!rec.space) return false
      const old = this.spaces.get(rec.space)
      if (old && old.t > rec.t) return false
      this.spaces.set(rec.space, { id: rec.space, kind: rec.block || (old && old.kind) || null, label: rec.via || (old && old.label) || null, by: rec.by || (old && old.by) || null, t: rec.t })
      return true
    }
    if (!OPS.has(rec.op) || !Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return false
    const k = key(rec.x, rec.y, rec.z), old = this.cells.get(k)
    if (old && (old.t > rec.t || (old.t === rec.t && old.space && !rec.space))) return false
    // a cell inside a structure stays in it: taking a plug out of a farm's wall is still the farm's work
    const space = rec.space || (old && old.space) || null
    if (old && old.space && old.space !== space) this._unspace(old.space, k)
    const cell = { x: rec.x, y: rec.y, z: rec.z, op: rec.op, block: rec.block || null, by: rec.by || null, t: rec.t, space, via: rec.via || null, w: writer }
    this.cells.set(k, cell)
    if (!old) { const ck = colKey(rec.x, rec.z); let s = this.cols.get(ck); if (!s) this.cols.set(ck, s = new Set()); s.add(k) }
    if (space) { let s = this.bySpace.get(space); if (!s) this.bySpace.set(space, s = new Set()); s.add(k) }
    return true
  }
  _unspace(id, k) { const s = this.bySpace.get(id); if (s) { s.delete(k); if (!s.size) this.bySpace.delete(id) } }

  get(x, y, z) { return this.cells.get(key(x, y, z)) || null }
  get size() { return this.cells.size }
  isOurs(name) { return !!name && this.bots.has(name) }

  // every record within r blocks (a cube) of a point
  near(p, r = 8) {
    return this.inBox({ x0: Math.floor(p.x - r), x1: Math.floor(p.x + r), y0: Math.floor(p.y - r), y1: Math.floor(p.y + r), z0: Math.floor(p.z - r), z1: Math.floor(p.z + r) })
  }
  inBox(b) {
    const out = []
    for (let cx = b.x0 >> 4; cx <= b.x1 >> 4; cx++) for (let cz = b.z0 >> 4; cz <= b.z1 >> 4; cz++) {
      const s = this.cols.get(`${cx},${cz}`); if (!s) continue
      for (const k of s) { const c = this.cells.get(k); if (c && c.x >= b.x0 && c.x <= b.x1 && c.y >= b.y0 && c.y <= b.y1 && c.z >= b.z0 && c.z <= b.z1) out.push(c) }
    }
    return out
  }
  inSpace(id) { const s = this.bySpace.get(id), out = []; if (s) for (const k of s) { const c = this.cells.get(k); if (c) out.push(c) } return out }

  // One row per space: how much of it was dug and placed, by whom, when, and where it sits.
  summary(id = null) {
    const ids = id ? [id] : [...new Set([...this.bySpace.keys(), ...this.spaces.keys()])]
    const out = []
    for (const sid of ids) {
      const row = { id: sid, kind: null, label: null, dug: 0, placed: 0, removed: 0, foreign: 0, byBot: {}, first: null, last: null, box: null }
      const meta = this.spaces.get(sid); if (meta) { row.kind = meta.kind; row.label = meta.label }
      for (const c of this.inSpace(sid)) {
        if (c.op === 'd') row.dug++; else if (c.op === 'p') row.placed++; else if (c.op === 'r') row.removed++; else row.foreign++
        if (c.by) row.byBot[c.by] = (row.byBot[c.by] || 0) + 1
        if (row.first == null || c.t < row.first) row.first = c.t
        if (row.last == null || c.t > row.last) row.last = c.t
        const b = row.box || (row.box = { x0: c.x, x1: c.x, y0: c.y, y1: c.y, z0: c.z, z1: c.z })
        if (c.x < b.x0) b.x0 = c.x; if (c.x > b.x1) b.x1 = c.x; if (c.y < b.y0) b.y0 = c.y; if (c.y > b.y1) b.y1 = c.y; if (c.z < b.z0) b.z0 = c.z; if (c.z > b.z1) b.z1 = c.z
      }
      if (row.dug + row.placed + row.removed + row.foreign || meta) out.push(row)
    }
    return out
  }

  // When the earliest writer started: "unrecorded" can only be trusted from here on.
  coverageFrom() { let t = null; for (const v of this.writers.values()) if (t == null || v < t) t = v; return t }

  // The question this whole thing exists for. `current` is the name of the block that stands there now (null/undefined when the chunk is not loaded).
  //   verdict  placed-by-us | dug-by-us | placed-by-other | changed-since | unrecorded
  //   ours     true only for placed-by-us and dug-by-us
  whoMade(x, y, z, current, me = null) {
    const c = this.get(x, y, z), from = this.coverageFrom()
    const base = { x, y, z, current: current == null ? null : current, coverageFrom: from }
    if (!c) return { ...base, ours: false, mine: false, verdict: 'unrecorded', by: null, op: null, block: null, t: null, space: null, via: null,
      why: from == null ? 'nothing has been recorded yet' : 'no bot recorded placing or digging here since ' + new Date(from).toISOString() + ': natural, or made by something else' }
    const rec = { ...base, by: c.by, op: c.op, block: c.block, t: c.t, space: c.space, via: c.via }
    const ours = this.isOurs(c.by)
    const gone = (c.op === 'p' || c.op === 'f') && current != null && current !== c.block
    const filled = (c.op === 'd' || c.op === 'r') && current != null && !/^(air|cave_air|void_air)$/.test(current)
    if (c.op === 'x') return { ...rec, ours: false, mine: false, verdict: 'changed-since', wasOurs: true, why: `one of ours was changed by someone else (now ${c.block || 'something'})` }
    if (c.op === 'f') return { ...rec, ours: false, mine: false, verdict: 'placed-by-other', why: `${c.block} appeared here and no bot of ours placed it (${c.by || 'other'})` }
    if (gone || filled) return { ...rec, ours: false, mine: false, verdict: 'changed-since', wasOurs: ours, why: `${c.by} ${c.op === 'p' ? 'placed ' + c.block : 'dug ' + c.block} here, but ${current} stands there now` }
    return { ...rec, ours, mine: !!me && c.by === me, verdict: c.op === 'p' ? 'placed-by-us' : c.op === 'r' ? 'removed-by-us' : 'dug-by-us', why: `${c.by} ${c.op === 'p' ? 'placed' : c.op === 'r' ? 'placed and later removed' : 'dug'} ${c.block} here${c.space ? ' (' + c.space + ')' : ''}` }
  }

  // Compare a box of the loaded world with the ledger. `read(x, y, z)` returns a block name or null. Reports blocks of a made kind that no bot recorded
  // (someone else built or placed them), and records of ours whose block is no longer what we placed.
  audit(box, read, opt = {}) {
    const made = opt.made || MADE, foreign = [], changed = [], ours = { placed: 0, dug: 0 }
    for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) {
      const name = read(x, y, z); if (name == null) continue
      const c = this.get(x, y, z)
      if (!c) { if (made.test(name)) foreign.push({ x, y, z, block: name }); continue }
      if (c.op === 'p' && this.isOurs(c.by)) { if (name === c.block) ours.placed++; else changed.push({ x, y, z, expected: c.block, found: name, by: c.by }) }
      else if ((c.op === 'd' || c.op === 'r') && this.isOurs(c.by)) ours.dug++
      else if ((c.op === 'f' || c.op === 'x') && made.test(name)) foreign.push({ x, y, z, block: name, by: c.by })
    }
    return { foreign, changed, ours }
  }
}

// ---- spaces from geometry: the registry knows the shafts and rooms (brain/autopilot/ladder.js), so a dig there is filed under them even when no job declared it ----

// defs from one registry world: { shafts: [...], rooms: [...] } -> [{ id, kind, box }]
function defsFromRegistry(w) {
  const out = []
  for (const s of (w && w.shafts) || []) {
    if (!s || !s.id || !Array.isArray(s.entry) || s.entry.length < 3) continue
    const bottom = Array.isArray(s.bottom) ? s.bottom[1] : s.entry[1] - 1
    out.push({ id: s.id, kind: 'shaft', label: 'Shaft', box: { x0: s.entry[0], x1: s.entry[0], z0: s.entry[2], z1: s.entry[2], y0: Math.min(bottom, s.entry[1]), y1: s.entry[1] + 1 } })
  }
  for (const r of (w && w.rooms) || []) {
    if (!r || !r.id || !r.box) continue
    out.push({ id: r.id, kind: r.type === 'mobfarm' ? 'mobfarm' : r.type === 'storage' ? 'storage' : 'room', label: r.type === 'storage' ? 'Storage room' : r.type === 'mobfarm' ? 'Mob farm' : `Room (${r.type || 'room'})`, box: r.box })
  }
  return out
}

// farms, pens and the crop plot live in the bots' own state files, not in the registry: treefarm-state.json { farms: [{ id, spotY: { "x,z": y } }] },
// husbandry-state.json { pens: [{ id, ox, oy, oz, w, d }] }, autopilot-state.json { farm: [[x,y,z]...] }. Ids match the dashboard's (dashboard/basecast.js).
function defsFromState({ treefarm, husbandry, autopilot } = {}) {
  const out = [], fin = Number.isFinite
  for (const f of (treefarm && treefarm.farms) || []) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [xz, y] of Object.entries(f.spotY || {})) { const [x, z] = xz.split(',').map(Number); if (!fin(x) || !fin(z) || !fin(y)) continue; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    if (x0 <= x1) out.push({ id: 'tree-' + f.id, kind: 'farm', label: `Tree farm ${f.id}`, box: { x0: x0 - 2, x1: x1 + 2, z0: z0 - 2, z1: z1 + 2, y0: y0 - 2, y1: y1 + 10 } })
  }
  for (const p of (husbandry && husbandry.pens) || []) {
    if (!p || !fin(p.ox) || !fin(p.oy) || !fin(p.oz) || !fin(p.w) || !fin(p.d)) continue
    out.push({ id: 'pen-' + p.id, kind: 'farm', label: `Animal pen ${p.id}`, box: { x0: p.ox - 1, x1: p.ox + p.w, z0: p.oz - 1, z1: p.oz + p.d, y0: p.oy - 1, y1: p.oy + 3 } })
  }
  const soil = ((autopilot && autopilot.farm) || []).filter(c => Array.isArray(c) && c.length >= 3 && c.every(fin))
  if (soil.length) {
    const xs = soil.map(c => c[0]), ys = soil.map(c => c[1]), zs = soil.map(c => c[2])
    out.push({ id: 'crops', kind: 'farm', label: 'Crop plot', box: { x0: Math.min(...xs) - 1, x1: Math.max(...xs) + 1, z0: Math.min(...zs) - 1, z1: Math.max(...zs) + 1, y0: Math.min(...ys) - 1, y1: Math.max(...ys) + 2 } })
  }
  return out
}
const vol = (b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1)
// the smallest declared box that holds the cell (any room or farm beats the shaft that runs through it), or null
function spaceAt(defs, x, y, z) {
  let best = null, bv = Infinity
  for (const d of defs || []) {
    const b = d.box
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || z < b.z0 || z > b.z1) continue
    const v = vol(b) + (d.kind === 'shaft' ? 1e9 : 0); if (v < bv) { best = d; bv = v }      // a room beats the thin shaft that runs through it
  }
  return best
}

// ---- persistence ----

const safeRename = (tmp, dst) => { try { fs.renameSync(tmp, dst) } catch (e) { if (!/EPERM|EBUSY|EACCES/.test(String(e.code || e.message))) throw e; fs.writeFileSync(dst, fs.readFileSync(tmp)); fs.unlinkSync(tmp) } }
const toLine = (r) => JSON.stringify([r.t, r.op, r.x || 0, r.y || 0, r.z || 0, r.block || '', r.by || '', r.space || '', r.via || ''])
function fromLine(line) {
  let a; try { a = JSON.parse(line) } catch { return null }
  if (!Array.isArray(a) || a.length < 7) return null
  return { t: a[0], op: a[1], x: a[2], y: a[3], z: a[4], block: a[5] || null, by: a[6] || null, space: a[7] || null, via: a[8] || null }
}

// One folder per world; one file per writer (so nobody ever rewrites a file somebody else appends to, and compaction is safe).
class Journal {
  constructor({ dir, writer, now = Date.now, log = () => {} }) {
    this.dir = dir; this.writer = writer; this.now = now; this.log = log
    this.file = path.join(dir, writer + '.jsonl')
    this.buf = []; this.offsets = new Map(); this.lines = 0; this.owned = 0
  }
  append(rec) { this.buf.push(toLine(rec)); this.lines++ }
  flush() {
    if (!this.buf.length) return 0
    const n = this.buf.length
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.file, this.buf.join('\n') + '\n'); this.buf = [] } catch (e) { this.log('ledger write failed: ' + e.message); return 0 }
    return n
  }
  // read what is new in every writer's file (our own too, the first time). Returns the number of records applied.
  load(store) {
    let n = 0, files = []
    try { files = fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl')) } catch { return 0 }
    for (const f of files) {
      const full = path.join(this.dir, f), w = f.slice(0, -6)
      let st; try { st = fs.statSync(full) } catch { continue }
      let off = this.offsets.get(f) || 0
      if (st.size < off) off = 0                                            // rewritten (compacted) since we looked
      if (st.size === off) continue
      if (w === this.writer && off > 0) { this.offsets.set(f, st.size); continue }   // our own appends are already applied
      let text = ''
      try { const fd = fs.openSync(full, 'r'); try { const b = Buffer.alloc(st.size - off); fs.readSync(fd, b, 0, b.length, off); text = b.toString('utf8') } finally { fs.closeSync(fd) } } catch { continue }
      const cut = text.lastIndexOf('\n')
      if (cut < 0) continue                                                  // a line still being written
      this.offsets.set(f, off + Buffer.byteLength(text.slice(0, cut + 1)))
      let own = 0
      for (const line of text.slice(0, cut).split('\n')) { if (!line) continue; const r = fromLine(line); if (!r) continue; if (store.apply(r, w)) n++; if (w === this.writer) own++ }
      if (w === this.writer) this.lines = (off ? this.lines : 0) + own
    }
    return n
  }
  // Rewrite our own file with only the lines that are still the newest word on their cell (plus space metadata and the first coverage marker).
  compact(store) {
    this.flush()
    const keep = []
    let coverage = store.writers.get(this.writer)
    if (coverage != null) keep.push(toLine({ t: coverage, op: 'B', by: this.writer }))
    for (const s of store.spaces.values()) keep.push(toLine({ t: s.t, op: 'S', block: s.kind, by: s.by, space: s.id, via: s.label }))
    for (const c of store.cells.values()) if (c.w === this.writer) keep.push(toLine(c))
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, keep.join('\n') + '\n'); safeRename(tmp, this.file)
      this.offsets.set(this.writer + '.jsonl', fs.statSync(this.file).size); this.lines = keep.length
      return keep.length
    } catch (e) { this.log('ledger compact failed: ' + e.message); return -1 }
  }
}

// One-time import of the older saved placed-block log (brain/placed.js) so the ledger starts with everything that was already known: { worlds: { key: { "x,y,z": [name, by, t] } } }
function importPlaced(store, file, worldKey, writer = 'placed-log') {
  let all; try { all = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return 0 }
  const w = ((all && all.worlds) || {})[worldKey] || {}
  let n = 0
  for (const [k, r] of Object.entries(w)) {
    if (store.cells.has(k) || !Array.isArray(r)) continue
    const [x, y, z] = k.split(',').map(Number)
    const rec = { op: store.isOurs(r[1]) ? 'p' : 'f', x, y, z, block: r[0], by: r[1], t: Number(r[2]) || 0, space: null, via: 'placed-log' }
    if (store.apply(rec, writer)) n++
  }
  return n
}

module.exports = { Store, Journal, MADE, vol, key, worldHash, defsFromRegistry, defsFromState, spaceAt, importPlaced, toLine, fromLine }
