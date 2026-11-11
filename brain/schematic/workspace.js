// brain/schematic/workspace.js: a block grid a model (or a person) builds a schematic in. Pure: no files, no bot, no model.
//
// The schematic agent (agent.js) gives a model tools over one Workspace: set blocks, fill boxes, make cylinders and domes, copy / mirror / rotate parts, look at layers
// as text. When the model is done `toSchematic` turns the grid into a normal flat format 2 schematic (format.js `capture`), which variants.js then files as a variant.
//
// Coordinates are whole numbers from the grid's own corner: x east, y UP, z south, all starting at 0. A workspace has a fixed size (`grow` makes it bigger on the
// +x/+y/+z sides). Every cell holds one block state; what is kept of a state is what a schematic keeps (blocks.js KEEP: facing, half, type, open, level, hinge,
// axis, face, attached, shape). A block name that does not exist in 1.21.6, or a property value it cannot have, is refused with what is allowed (blockdata.js).
//
// mode 'functional'  a farm, a mine, a utility room: the background is `rock` (stone, to be dug out) or `air`; walls end up as role `solid` (any solid block),
//                    only the shell of rock that touches open space is kept.
// mode 'aesthetic'   a house, a statue, a tower built for looks: the background is air and every block is exact.
'use strict'
const B = require('./blocks')
const F = require('./format')
const D = require('./blockdata')

const MAX_CELLS = 4000000, MAX_SIDE = 320
const MAX_EDIT = 3000000                                       // cells of an existing schematic the agent may open for editing
const DOUBLE = /_door$|^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|tall_seagrass|pitcher_plant)$/
const NO_BED = /_bed$/
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air'])
const CARDINAL = ['north', 'east', 'south', 'west']
const idx3 = (S, x, y, z) => x + S[0] * (z + S[2] * y)

const strip = B.strip
const keyOf = (name, props) => name + (props && Object.keys(props).length ? '[' + Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(',') + ']' : '')

// the closest block names to a wrong one, for the error message
function suggest(name) {
  const all = Object.keys(D.blocks), n = name.toLowerCase()
  const parts = n.split('_').filter(Boolean)
  const scored = all.map(b => ({ b, s: (b.includes(n) ? 5 : 0) + parts.filter(p => b.includes(p)).length * 2 - Math.abs(b.length - n.length) / 20 })).filter(x => x.s > 0.5).sort((a, b) => b.s - a.s)
  return scored.slice(0, 6).map(x => x.b)
}

// A model's block (a name, maybe "minecraft:"-prefixed, and some properties given as strings, numbers or booleans) -> { name, props } with every property the schematic
// keeps present (defaults filled in), or { error }. `ignored` lists properties that were dropped because a schematic does not keep them (waterlogged, powered, lit ...).
function normBlock(rawName, rawProps) {
  let name = strip(String(rawName == null ? '' : rawName).trim().toLowerCase())
  if (!name) return { error: 'no block name' }
  if (AIR_NAMES.has(name)) return { name: 'air', props: {}, ignored: [] }
  const info = D.blocks[name]
  if (info === undefined) { const s = suggest(name); return { error: `"${name}" is not a Minecraft 1.21.6 block${s.length ? '. Did you mean ' + s.join(', ') + '?' : ''}` } }
  if (NO_BED.test(name)) return { error: `${name}: beds are not supported in schematics yet (a bed is two blocks and the schematic does not keep which half is which). Leave the place for it open.` }
  const given = {}
  for (const [k, v] of Object.entries(rawProps || {})) given[k] = String(v)
  const props = {}, ignored = []
  const allowed = (info && info.p) || {}
  for (const [k, v] of Object.entries(given)) {
    if (!(k in allowed)) { ignored.push(k); continue }
    if (!allowed[k].includes(v)) return { error: `${name}: ${k} can be ${allowed[k].join(', ')}, not "${v}"` }
    props[k] = v
  }
  if (info) for (const k of Object.keys(allowed)) if (!(k in props)) props[k] = info.d[k]
  if (name === 'water' || name === 'lava') props.level = String(props.level != null ? props.level : 0)
  return { name, props, ignored }
}

class Workspace {
  // { size: [W,H,D], mode: 'functional' | 'aesthetic', background: 'air' | 'rock' (functional only; default rock) }
  constructor({ size, mode = 'aesthetic', background } = {}) {
    if (!Array.isArray(size) || size.length !== 3 || !size.every(n => Number.isInteger(n) && n >= 1)) throw new Error('size must be [width, height, depth], whole numbers of at least 1')
    if (size.some(n => n > MAX_SIDE)) throw new Error(`no side of a workspace may be longer than ${MAX_SIDE}`)
    if (size[0] * size[1] * size[2] > MAX_CELLS) throw new Error(`a workspace may hold at most ${MAX_CELLS} cells (that is ${size[0]} x ${size[1]} x ${size[2]} = ${size[0] * size[1] * size[2]})`)
    this.size = size.slice()
    this.mode = mode === 'functional' ? 'functional' : 'aesthetic'
    this.background = this.mode === 'functional' && background !== 'air' ? 'rock' : 'air'
    this.palette = []; this.keys = new Map()
    this.bgName = this.background === 'rock' ? 'stone' : 'air'
    this.bg = this.entry(this.bgName, {})
    this.cells = new Uint16Array(size[0] * size[1] * size[2]); if (this.bg) this.cells.fill(this.bg)
    this.scenery = null
    this.edits = 0
    this.origin = [0, 0, 0]
  }
  entry(name, props = {}) {
    const k = keyOf(name, props)
    let i = this.keys.get(k)
    if (i == null) { i = this.palette.length; if (i > 65000) throw new Error('too many different blocks'); this.palette.push({ name, props: { ...props } }); this.keys.set(k, i) }
    return i
  }
  get total() { return this.cells.length }
  inside(x, y, z) { return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2] }
  at(x, y, z) { return this.palette[this.cells[idx3(this.size, x, y, z)]] }
  boxCheck(a, b) {
    for (const p of [a, b]) if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isInteger)) return { error: 'a corner is [x, y, z] with whole numbers' }
    const lo = [0, 1, 2].map(i => Math.min(a[i], b[i])), hi = [0, 1, 2].map(i => Math.max(a[i], b[i]))
    for (let i = 0; i < 3; i++) if (lo[i] < 0 || hi[i] >= this.size[i]) return { error: `the box ${JSON.stringify(a)}..${JSON.stringify(b)} leaves the workspace (size ${this.size.join(' x ')}: x 0..${this.size[0] - 1}, y 0..${this.size[1] - 1}, z 0..${this.size[2] - 1}). Use grow to make it bigger.` }
    return { lo, hi }
  }
  grow({ x = 0, y = 0, z = 0 } = {}) {
    const n = [this.size[0] + (x | 0), this.size[1] + (y | 0), this.size[2] + (z | 0)]
    if ([x, y, z].some(v => !(v >= 0))) return { error: 'grow only adds cells on the +x, +y and +z sides: give amounts of 0 or more' }
    if (n.some(v => v > MAX_SIDE) || n[0] * n[1] * n[2] > MAX_CELLS) return { error: `that would be ${n.join(' x ')}: too big (at most ${MAX_SIDE} per side and ${MAX_CELLS} cells)` }
    const out = new Uint16Array(n[0] * n[1] * n[2]); if (this.bg) out.fill(this.bg)
    const sc = this.scenery ? new Uint8Array(out.length) : null
    for (let yy = 0; yy < this.size[1]; yy++) for (let zz = 0; zz < this.size[2]; zz++) for (let xx = 0; xx < this.size[0]; xx++) {
      const a = idx3(this.size, xx, yy, zz), b = idx3(n, xx, yy, zz)
      out[b] = this.cells[a]; if (sc) sc[b] = this.scenery[a]
    }
    this.cells = out; this.scenery = sc; this.size = n
    return { ok: true, size: this.size.slice() }
  }

  // ---- writing
  put(x, y, z, bi) { const k = idx3(this.size, x, y, z); this.cells[k] = bi; if (this.scenery) this.scenery[k] = 0 }
  // One block (with doors and tall plants placing both halves). -> { ok, placed, ignored } | { error }
  set(x, y, z, name, props) {
    if (!this.inside(x, y, z)) return { error: `(${x}, ${y}, ${z}) is outside the workspace (size ${this.size.join(' x ')}); use grow to make it bigger` }
    const b = normBlock(name, props); if (b.error) return b
    if (DOUBLE.test(b.name) && !(props && props.half != null)) {
      if (!this.inside(x, y + 1, z)) return { error: `${b.name} is two blocks tall: (${x}, ${y + 1}, ${z}) is outside the workspace` }
      this.put(x, y, z, this.entry(b.name, { ...b.props, half: 'lower' })); this.put(x, y + 1, z, this.entry(b.name, { ...b.props, half: 'upper' }))
      this.edits += 2
      return { ok: true, placed: 2, ignored: b.ignored }
    }
    this.put(x, y, z, this.entry(b.name, b.props)); this.edits++
    return { ok: true, placed: 1, ignored: b.ignored }
  }
  // style: solid (all cells) | hollow (the six faces) | walls (the four sides, no floor or ceiling) | frame (the twelve edges) | floor (the lowest layer) | ceiling (the top layer)
  // only: replace only cells that hold this block now ('air' for open cells). -> { ok, placed } | { error }
  fill(a, b, name, props, { style = 'solid', only } = {}) {
    const bc = this.boxCheck(a, b); if (bc.error) return bc
    const blk = normBlock(name, props); if (blk.error) return blk
    if (DOUBLE.test(blk.name)) return { error: `${blk.name} is two blocks tall: place it with set_blocks, not fill` }
    const onlyN = only == null ? null : (AIR_NAMES.has(strip(only)) ? 'air' : strip(only))
    const bi = this.entry(blk.name, blk.props), { lo, hi } = bc
    let n = 0
    const want = (x, y, z) => {
      const ex = x === lo[0] || x === hi[0], ey = y === lo[1] || y === hi[1], ez = z === lo[2] || z === hi[2]
      switch (style) {
        case 'solid': return true
        case 'hollow': return ex || ey || ez
        case 'walls': return ex || ez
        case 'frame': return (ex ? 1 : 0) + (ey ? 1 : 0) + (ez ? 1 : 0) >= 2
        case 'floor': return y === lo[1]
        case 'ceiling': return y === hi[1]
        default: return true
      }
    }
    if (!['solid', 'hollow', 'walls', 'frame', 'floor', 'ceiling'].includes(style)) return { error: 'style is solid, hollow, walls, frame, floor or ceiling' }
    for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (let x = lo[0]; x <= hi[0]; x++) {
      if (!want(x, y, z)) continue
      if (onlyN && this.at(x, y, z).name !== onlyN) continue
      this.put(x, y, z, bi); n++
    }
    this.edits += n
    return { ok: true, placed: n, ignored: blk.ignored }
  }
  // kind: cylinder (base centre [cx, y, cz], radius, height; stands on y) | sphere (centre, radius) | dome (the upper half of a sphere; centre is the middle of its flat base)
  // hollow: only the shell one block thick (a cylinder gets no floor or roof unless `caps`)
  shape({ kind, center, radius, height = 1, block, props, hollow = false, caps = false, only }) {
    if (!Array.isArray(center) || center.length !== 3 || !center.every(Number.isInteger)) return { error: 'center is [x, y, z] with whole numbers' }
    if (!(Number.isInteger(radius) && radius >= 1 && radius <= 100)) return { error: 'radius is a whole number from 1 to 100' }
    const blk = normBlock(block, props); if (blk.error) return blk
    const bi = this.entry(blk.name, blk.props)
    const onlyN = only == null ? null : (AIR_NAMES.has(strip(only)) ? 'air' : strip(only))
    const [cx, cy, cz] = center, r2 = radius * radius + radius * 0.8, i2 = Math.max(0, (radius - 1) * (radius - 1) + (radius - 1) * 0.8)
    let n = 0, skipped = 0
    const put = (x, y, z) => { if (!this.inside(x, y, z)) { skipped++; return } if (onlyN && this.at(x, y, z).name !== onlyN) return; this.put(x, y, z, bi); n++ }
    if (kind === 'cylinder') {
      const h = Math.max(1, height | 0)
      for (let y = 0; y < h; y++) for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        const d = dx * dx + dz * dz; if (d > r2) continue
        if (hollow && d < i2 && !(caps && (y === 0 || y === h - 1))) continue
        put(cx + dx, cy + y, cz + dz)
      }
    } else if (kind === 'sphere' || kind === 'dome') {
      for (let dy = kind === 'dome' ? 0 : -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        const d = dx * dx + dy * dy + dz * dz; if (d > r2) continue
        if (hollow && d < i2 && !(kind === 'dome' && dy === 0 && caps)) continue
        put(cx + dx, cy + dy, cz + dz)
      }
    } else return { error: 'kind is cylinder, sphere or dome' }
    this.edits += n
    return { ok: true, placed: n, ...(skipped ? { outside: skipped, note: `${skipped} cells fell outside the workspace and were not placed` } : {}) }
  }
  // every cell of one block (and these properties) becomes another; limited to a box when given
  replace(fromName, toName, toProps, { box, fromProps } = {}) {
    const from = AIR_NAMES.has(strip(fromName)) ? 'air' : strip(String(fromName).toLowerCase())
    const to = normBlock(toName, toProps); if (to.error) return to
    let lo = [0, 0, 0], hi = this.size.map(n => n - 1)
    if (box) { const bc = this.boxCheck(box[0], box[1]); if (bc.error) return bc; lo = bc.lo; hi = bc.hi }
    const bi = this.entry(to.name, to.props)
    let n = 0
    for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (let x = lo[0]; x <= hi[0]; x++) {
      const e = this.at(x, y, z)
      if (e.name !== from) continue
      if (fromProps && !Object.entries(fromProps).every(([k, v]) => e.props[k] === String(v))) continue
      this.put(x, y, z, bi); n++
    }
    this.edits += n
    return { ok: true, replaced: n }
  }
  // copy a box to somewhere else. offset moves it; rotate 0|90|180|270 turns it clockwise seen from above around the box's own corner (the result's lowest corner goes to
  // the old lowest corner + offset); mirror 'x' or 'z' flips it east-west / north-south first. Stairs, doors, torches, ladders and so on face the right way afterwards.
  // skipAir (default true): air in the source leaves what is at the target alone.
  copy(a, b, offset, { rotate = 0, mirror = null, skipAir = true } = {}) {
    const bc = this.boxCheck(a, b); if (bc.error) return bc
    if (!Array.isArray(offset) || offset.length !== 3 || !offset.every(Number.isInteger)) return { error: 'offset is [dx, dy, dz] with whole numbers' }
    if (![0, 90, 180, 270].includes(rotate)) return { error: 'rotate is 0, 90, 180 or 270' }
    if (mirror != null && mirror !== 'x' && mirror !== 'z') return { error: 'mirror is "x", "z" or left out' }
    const { lo, hi } = bc, sx = hi[0] - lo[0] + 1, sy = hi[1] - lo[1] + 1, sz = hi[2] - lo[2] + 1
    const turns = rotate / 90
    const flip = (e) => this.turned(e, mirror, turns)
    const out = []
    for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const e = this.at(lo[0] + x, lo[1] + y, lo[2] + z)
      if (skipAir && e.name === 'air') continue
      let rx = mirror === 'x' ? sx - 1 - x : x, rz = mirror === 'z' ? sz - 1 - z : z, w = sx, d = sz
      for (let t = 0; t < turns; t++) { const nx = d - 1 - rz, nz = rx; rx = nx; rz = nz; const nw = d; d = w; w = nw }
      out.push([rx, y, rz, flip(e)])
    }
    let n = 0, outside = 0
    for (const [rx, ry, rz, e] of out) {
      const x = lo[0] + offset[0] + rx, y = lo[1] + offset[1] + ry, z = lo[2] + offset[2] + rz
      if (!this.inside(x, y, z)) { outside++; continue }
      this.put(x, y, z, this.entry(e.name, e.props)); n++
    }
    this.edits += n
    return { ok: true, copied: n, ...(outside ? { outside, note: `${outside} cells fell outside the workspace and were not copied (use grow first)` } : {}) }
  }
  turned(e, mirror, turns) {
    const props = { ...e.props }
    const rot = (f) => { const i = CARDINAL.indexOf(f); return i < 0 ? f : CARDINAL[(i + turns) % 4] }
    if (mirror === 'x' && props.facing === 'east') props.facing = 'west'; else if (mirror === 'x' && props.facing === 'west') props.facing = 'east'
    if (mirror === 'z' && props.facing === 'north') props.facing = 'south'; else if (mirror === 'z' && props.facing === 'south') props.facing = 'north'
    if (mirror) {
      if (props.hinge) props.hinge = props.hinge === 'left' ? 'right' : 'left'
      if (props.shape && /^(inner|outer)_(left|right)$/.test(props.shape)) props.shape = props.shape.replace(/left|right/, (m) => (m === 'left' ? 'right' : 'left'))
      if (props.type === 'left' || props.type === 'right') props.type = props.type === 'left' ? 'right' : 'left'
    }
    if (props.facing) props.facing = rot(props.facing)
    if (props.axis && turns % 2 === 1) props.axis = props.axis === 'x' ? 'z' : props.axis === 'z' ? 'x' : props.axis
    return { name: e.name, props }
  }
  // mark a box as the natural surroundings (drawn for the picture, never checked); clear: false = it is part of the build again
  markScenery(a, b, on = true) {
    const bc = this.boxCheck(a, b); if (bc.error) return bc
    if (!this.scenery) this.scenery = new Uint8Array(this.total)
    let n = 0
    for (let y = bc.lo[1]; y <= bc.hi[1]; y++) for (let z = bc.lo[2]; z <= bc.hi[2]; z++) for (let x = bc.lo[0]; x <= bc.hi[0]; x++) { const k = idx3(this.size, x, y, z); if (this.cells[k] !== this.bg || this.scenery[k]) { this.scenery[k] = on ? 1 : 0; n++ } }
    return { ok: true, cells: n }
  }
  clearAll() { this.cells.fill(this.bg); if (this.scenery) this.scenery.fill(0); this.edits++ }

  // ---- reading
  // bounding box of everything that is not background: { lo, hi, count } | null
  content() {
    const S = this.size
    let lo = [S[0], S[1], S[2]], hi = [-1, -1, -1], count = 0
    for (let y = 0; y < S[1]; y++) for (let z = 0; z < S[2]; z++) for (let x = 0; x < S[0]; x++) {
      if (this.cells[idx3(S, x, y, z)] === this.bg) continue
      count++
      if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z
      if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z
    }
    return count ? { lo, hi, count } : null
  }
  // block counts: [{ block, props?, cells }] biggest first (air and the rock background are left out unless asked)
  counts({ withBackground = false } = {}) {
    const c = new Map()
    for (let i = 0; i < this.cells.length; i++) c.set(this.cells[i], (c.get(this.cells[i]) || 0) + 1)
    const rows = []
    for (const [i, n] of c) { const e = this.palette[i]; if (!withBackground && i === this.bg) continue; if (e.name === 'air') continue; rows.push({ key: keyOf(e.name, e.props), name: e.name, cells: n }) }
    const byName = new Map()
    for (const r of rows) byName.set(r.name, (byName.get(r.name) || 0) + r.cells)
    return [...byName].map(([name, cells]) => ({ name, cells })).sort((a, b) => b.cells - a.cells)
  }
  // a text picture of a slice: axis 'y' (a layer, seen from above, north at the top, x to the right), 'x' (a cut across, seen from the east: z to the right, y up) or
  // 'z' (seen from the south: x to the right, y up). `index` is the layer / cut; `from`/`to` limit the other two axes ([min, max] pairs: the two axes in the order
  // y: x then z, x: z then y, z: x then y).
  render(axis, index, window = {}) {
    const S = this.size
    const ai = { x: 0, y: 1, z: 2 }[axis]
    if (ai == null) return { error: 'axis is x, y or z' }
    if (!Number.isInteger(index) || index < 0 || index >= S[ai]) return { error: `${axis} runs from 0 to ${S[ai] - 1}` }
    const [rowAxis, colAxis] = axis === 'y' ? [2, 0] : axis === 'x' ? [1, 2] : [1, 0]
    const lim = (a, w) => { const lo = w && Number.isInteger(w[0]) ? Math.max(0, w[0]) : 0, hi = w && Number.isInteger(w[1]) ? Math.min(S[a] - 1, w[1]) : S[a] - 1; return [lo, hi] }
    const [c0, c1] = lim(colAxis, window.cols), [r0, r1] = lim(rowAxis, window.rows)
    if (c1 - c0 + 1 > 120 || r1 - r0 + 1 > 120) return { error: 'a picture is at most 120 x 120 cells: pass cols and rows ranges to look at part of it' }
    const legend = new Map(), chars = '#=+*%&@$ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const charOf = (e) => {
      if (e.name === 'air') return '.'
      const k = keyOf(e.name, e.props)
      let l = legend.get(k)
      if (!l) { l = { ch: chars[legend.size % chars.length], e, n: 0 }; legend.set(k, l) }
      l.n++
      return l.ch
    }
    const lines = []
    const head = '     ' + Array.from({ length: c1 - c0 + 1 }, (_, i) => String((c0 + i) % 10)).join('')
    lines.push(head + `   (columns: ${'xyz'[colAxis]} ${c0}..${c1})`)
    for (let r = (axis === 'y' ? r0 : r1); axis === 'y' ? r <= r1 : r >= r0; axis === 'y' ? r++ : r--) {
      let row = String(r).padStart(4) + ' '
      for (let c = c0; c <= c1; c++) {
        const p = [0, 0, 0]; p[ai] = index; p[rowAxis] = r; p[colAxis] = c
        const e = this.at(p[0], p[1], p[2])
        row += this.scenery && this.scenery[idx3(S, p[0], p[1], p[2])] ? (e.name === 'air' ? '.' : charOf(e).toLowerCase()) : charOf(e)
      }
      lines.push(row)
    }
    const leg = [...legend.values()].map(l => `${l.ch} = ${keyOf(l.e.name, l.e.props)} (${l.n})`)
    const title = axis === 'y' ? `layer y=${index}: rows are z (${'z'} ${r0}..${r1}, north at the top), columns x` : axis === 'x' ? `cut x=${index} seen from the east: rows are y (up), columns z` : `cut z=${index} seen from the south: rows are y (up), columns x`
    return { ok: true, text: `${title}\n${lines.join('\n')}\nlegend: . = air${this.background === 'rock' ? ', # may be the rock background (stone)' : ''}; ${leg.join('; ')}` }
  }

  // Things a build usually gets wrong. Cheap checks only; each issue is one line with a position.
  check(max = 40) {
    const S = this.size, issues = []
    // a cell a torch, ladder or sign can hang on: a real block, not open space, not another thing that hangs
    const full = (x, y, z) => { if (!this.inside(x, y, z)) return false; const e = this.at(x, y, z); return e.name !== 'air' && !B.isOpenish(e.name) && !/torch|lantern|ladder|chain|_button|carpet|_pane|_door|_trapdoor|_sign|banner|_head|_plant|sapling|flower|pressure_plate/.test(e.name) }
    const OPP = { north: [0, 0, 1], south: [0, 0, -1], east: [-1, 0, 0], west: [1, 0, 0] }
    const note = (m) => { if (issues.length < max) issues.push(m) }
    let unsupported = 0
    for (let y = 0; y < S[1]; y++) for (let z = 0; z < S[2]; z++) for (let x = 0; x < S[0]; x++) {
      const e = this.at(x, y, z), n = e.name
      if (n === 'air') continue
      if (n === 'torch' || n === 'soul_torch') { if (!(this.inside(x, y - 1, z) && this.at(x, y - 1, z).name !== 'air')) { unsupported++; note(`${n} at (${x}, ${y}, ${z}) has nothing under it`) } }
      else if (n === 'wall_torch' || n === 'soul_wall_torch' || n === 'ladder' || /_wall_sign$|^wall_sign$/.test(n)) {
        const o = OPP[e.props.facing]; if (o && !full(x + o[0], y, z + o[2])) { unsupported++; note(`${n} at (${x}, ${y}, ${z}) facing ${e.props.facing} needs a solid block behind it at (${x + o[0]}, ${y}, ${z + o[2]})`) }
      } else if (DOUBLE.test(n) && e.props.half === 'lower') { const up = this.inside(x, y + 1, z) ? this.at(x, y + 1, z) : null; if (!up || up.name !== n || up.props.half !== 'upper') note(`${n} at (${x}, ${y}, ${z}) has no upper half`) }
      else if (DOUBLE.test(n) && e.props.half === 'upper') { const lo = this.inside(x, y - 1, z) ? this.at(x, y - 1, z) : null; if (!lo || lo.name !== n || lo.props.half !== 'lower') note(`${n} at (${x}, ${y}, ${z}) has no lower half`) }
      else if (/^(sand|red_sand|gravel|[a-z_]*concrete_powder)$/.test(n) && this.inside(x, y - 1, z) && this.at(x, y - 1, z).name === 'air') note(`${n} at (${x}, ${y}, ${z}) would fall: nothing under it`)
    }
    // pieces that are not joined to the rest (6-neighbour flood over every non-air, non-background cell)
    if (this.total <= 1500000) {
      const seen = new Uint8Array(this.total), comps = []
      const stack = []
      for (let y = 0; y < S[1]; y++) for (let z = 0; z < S[2]; z++) for (let x = 0; x < S[0]; x++) {
        const k = idx3(S, x, y, z)
        if (seen[k] || this.cells[k] === this.bg || this.at(x, y, z).name === 'air' || (this.scenery && this.scenery[k])) continue
        let size = 0, lowest = y; stack.push([x, y, z]); seen[k] = 1
        while (stack.length) {
          const [a, b, c] = stack.pop(); size++; if (b < lowest) lowest = b
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const nx = a + dx, ny = b + dy, nz = c + dz
            if (!this.inside(nx, ny, nz)) continue
            const kk = idx3(S, nx, ny, nz)
            if (seen[kk] || this.cells[kk] === this.bg || this.at(nx, ny, nz).name === 'air' || (this.scenery && this.scenery[kk])) continue
            seen[kk] = 1; stack.push([nx, ny, nz])
          }
        }
        comps.push({ size, at: [x, y, z], lowest })
      }
      if (this.mode === 'aesthetic' && comps.length > 1) {
        comps.sort((a, b) => b.size - a.size)
        const small = comps.slice(1).filter(c => c.size >= 1)
        if (small.length) note(`${small.length} separate piece(s) are not joined to the main build (face-to-face): ${small.slice(0, 6).map(c => `${c.size} block(s) near (${c.at.join(', ')})`).join('; ')}. Fine for a fence post or a lamp; a mistake if it is a roof or a wall.`)
      }
    }
    return issues
  }

  // ---- out: a flat format 2 schematic
  // meta: { id, name, kind, purpose, surround, source, notes }. The box is what the build occupies (plus one cell of rock all round for a functional build, so its shell is kept).
  toSchematic(meta = {}) {
    const c = this.content(); if (!c) return { error: 'the workspace is empty: nothing to save' }
    const pad = this.mode === 'functional' ? 1 : 0
    const box = { x0: Math.max(0, c.lo[0] - pad), y0: Math.max(0, c.lo[1] - pad), z0: Math.max(0, c.lo[2] - pad), x1: Math.min(this.size[0] - 1, c.hi[0] + pad), y1: Math.min(this.size[1] - 1, c.hi[1] + pad), z1: Math.min(this.size[2] - 1, c.hi[2] + pad) }
    const S = this.size, sc = this.scenery
    const get = (x, y, z) => { if (sc && sc[idx3(S, x, y, z)]) return null; return this.at(x, y, z) }
    const s = F.capture(get, box, { id: meta.id, name: meta.name, kind: meta.kind, purpose: meta.purpose, mode: this.mode, surround: meta.surround != null ? meta.surround : 0, source: meta.source, notes: meta.notes })
    s.origin = [box.x0 + this.origin[0], box.y0 + this.origin[1], box.z0 + this.origin[2]]
    if (sc) this.addScenery(s, box)
    s.unknownCells = 0
    return s
  }
  addScenery(s, box) {
    const cells = F.cellsOf(s), key = new Map(s.palette.map((e, i) => [JSON.stringify(e), i]))
    let any = false
    for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) for (let x = box.x0; x <= box.x1; x++) {
      if (!this.scenery[idx3(this.size, x, y, z)]) continue
      const e = this.at(x, y, z); if (e.name === 'air') continue
      const d = { ...B.describeExact(e.name, e.props), scenery: true }
      if (d.role === 'air') continue
      const k = JSON.stringify(d)
      if (!key.has(k)) { key.set(k, s.palette.length); s.palette.push(d) }
      cells[idx3(s.size, x - box.x0, y - box.y0, z - box.z0)] = key.get(k); any = true
    }
    if (!any) return
    const rle = [], counts = {}
    for (let i = 0; i < cells.length;) { let j = i; while (j < cells.length && cells[j] === cells[i]) j++; rle.push(cells[i], j - i); counts[cells[i]] = (counts[cells[i]] || 0) + (j - i); i = j }
    s.rle = rle; s.counts = counts
  }

  // ---- in: open an existing flat schematic for editing (or to start a variant from it)
  // `any` cells become the background (rock for a functional build, air for an aesthetic one); `alt` substitutes are not kept (the first-choice block is).
  // margin: free cells all round (the build sits inside at [margin, margin, margin]) so an edit can add a porch or a wing on any side; what is not used is trimmed again on the way out
  static fromSchematic(s, { margin = 0 } = {}) {
    const total = s.size[0] * s.size[1] * s.size[2]
    if (total > MAX_EDIT) throw new Error(`${s.id} has ${total} cells; the agent opens at most ${MAX_EDIT} (it would not be able to look at it anyway)`)
    let m = Math.max(0, margin | 0)
    while (m > 0 && ((s.size[0] + 2 * m) * (s.size[1] + 2 * m) * (s.size[2] + 2 * m) > MAX_EDIT || s.size.some(n => n + 2 * m > MAX_SIDE))) m--
    const ws = new Workspace({ size: [s.size[0] + 2 * m, s.size[1] + 2 * m, s.size[2] + 2 * m], mode: s.mode === 'aesthetic' ? 'aesthetic' : 'functional', background: 'rock' })
    ws.margin = m
    ws.origin = s.origin ? [s.origin[0] - m, s.origin[1] - m, s.origin[2] - m] : [-m, -m, -m]
    const cells = F.cellsOf(s), map = new Map(), sceneryOf = []
    let anyScenery = false
    s.palette.forEach((e, i) => {
      let bl
      if (e.role === 'any') bl = null
      else if (e.role === 'air') bl = { name: 'air', props: {} }
      else if (e.role === 'solid') bl = { name: 'stone', props: {} }
      else if (e.role === 'water' || e.role === 'lava') bl = { name: e.role, props: { level: String(e.level != null ? e.level : 0) } }
      else bl = { name: strip(e.block || 'stone'), props: { ...(e.props || {}) } }
      map.set(i, bl ? ws.entry(bl.name, bl.props) : ws.bg)
      sceneryOf[i] = !!e.scenery
      if (e.scenery) anyScenery = true
    })
    if (anyScenery) ws.scenery = new Uint8Array(ws.total)
    for (let y = 0; y < s.size[1]; y++) for (let z = 0; z < s.size[2]; z++) for (let x = 0; x < s.size[0]; x++) {
      const from = idx3(s.size, x, y, z), to = idx3(ws.size, x + m, y + m, z + m)
      ws.cells[to] = map.get(cells[from]); if (anyScenery && sceneryOf[cells[from]]) ws.scenery[to] = 1
    }
    ws.edits = 0
    return ws
  }
}

module.exports = { Workspace, normBlock, suggest, MAX_CELLS, MAX_SIDE, MAX_EDIT, keyOf }
