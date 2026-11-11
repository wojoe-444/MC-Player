// brain/schematic/format.js: a schematic as the bots and the dashboard store it. Pure: no files, no bot.
//
//   { v: 1, id, name, kind ('mobfarm' ...), purpose?, source: { world, save, capturedAt, by, box }, origin: [x0,y0,z0] (world coordinates of the min corner when captured),
//     size: [W,H,D], palette: [{ role, ... }], palette[0] is always { role: 'any' },
//     rle: [index, run, index, run ...] over cells in the order x fastest, then z, then y,
//     counts: { palette index -> cells }, sources: { palette index -> { 'cobblestone': 412, ... } }  (what the blocks really were, for the legend),
//     notes: [..] }
//
// What is kept (capture): every open cell, every special block, and every solid cell that touches an open cell (the shell). Solid rock that touches nothing is
// `any`: the build does not care what it is. A cell nobody could read is `any` too (never "air"): a half-loaded world must not produce missing walls.
'use strict'
const B = require('./blocks')

const idx = (S, x, y, z) => x + S[0] * (z + S[2] * y)

// get(x, y, z) -> { name, props } | null (null = unknown). box = { x0, y0, z0, x1, y1, z1 } inclusive.
function capture(get, box, meta = {}) {
  const S = [box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1]
  const total = S[0] * S[1] * S[2]
  const blocks = new Array(total)
  for (let y = 0; y < S[1]; y++) for (let z = 0; z < S[2]; z++) for (let x = 0; x < S[0]; x++) blocks[idx(S, x, y, z)] = get(box.x0 + x, box.y0 + y, box.z0 + z)
  const palette = [{ role: 'any' }], key = new Map([['any', 0]])
  const sources = { 0: {} }
  const cells = new Uint16Array(total)
  const open = (b) => !!b && B.isOpenish(b.name) && !B.isSolid(b.name)
  const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const unknown = []
  // `seeds` (world cells inside the build): only what is connected to them through open space counts as the build. Trees, a neighbour's chests and cave vines in the
  // box are not the build; without seeds every open cell in the box is kept.
  // `masks` (boxes in world coordinates): only cells inside one of them are the build; the rest of the box is `any`. For a build that stands in the open.
  const masked = meta.masks && meta.masks.length ? (x, y, z) => meta.masks.some(m => x + box.x0 >= m.x0 && x + box.x0 <= m.x1 && y + box.y0 >= m.y0 && y + box.y0 <= m.y1 && z + box.z0 >= m.z0 && z + box.z0 <= m.z1) : () => true
  let inside = null
  if (meta.seeds && meta.seeds.length) {
    inside = new Uint8Array(total)
    const q = []
    for (const sd of meta.seeds) { const x = sd[0] - box.x0, y = sd[1] - box.y0, z = sd[2] - box.z0; if (x >= 0 && y >= 0 && z >= 0 && x < S[0] && y < S[1] && z < S[2] && !inside[idx(S, x, y, z)]) { inside[idx(S, x, y, z)] = 1; q.push([x, y, z]) } }
    while (q.length) {
      const [x, y, z] = q.pop()
      for (const [dx, dy, dz] of NB) {
        const nx = x + dx, ny = y + dy, nz = z + dz
        if (nx < 0 || ny < 0 || nz < 0 || nx >= S[0] || ny >= S[1] || nz >= S[2]) continue
        const k = idx(S, nx, ny, nz)
        if (!inside[k] && open(blocks[k]) && masked(nx, ny, nz)) { inside[k] = 1; q.push([nx, ny, nz]) }
      }
    }
  }
  const inBuild = (x, y, z) => masked(x, y, z) && (!inside || inside[idx(S, x, y, z)] === 1)
  for (let y = 0; y < S[1]; y++) for (let z = 0; z < S[2]; z++) for (let x = 0; x < S[0]; x++) {
    const b = blocks[idx(S, x, y, z)]
    if (!b) { cells[idx(S, x, y, z)] = 0; unknown.push(1); continue }
    const d = B.describe(b.name, b.props)
    let keep = true
    if (d.role === 'solid') keep = NB.some(([dx, dy, dz]) => { const nx = x + dx, ny = y + dy, nz = z + dz; return nx >= 0 && ny >= 0 && nz >= 0 && nx < S[0] && ny < S[1] && nz < S[2] && open(blocks[idx(S, nx, ny, nz)]) && inBuild(nx, ny, nz) })
    else if (!inBuild(x, y, z)) keep = false
    if (!keep) { cells[idx(S, x, y, z)] = 0; (sources[0][B.strip(b.name)] = (sources[0][B.strip(b.name)] || 0) + 1); continue }
    const k = JSON.stringify(d)
    if (!key.has(k)) { key.set(k, palette.length); palette.push(d) }
    const pi = key.get(k)
    cells[idx(S, x, y, z)] = pi
    const s = sources[pi] = sources[pi] || {}; s[B.strip(b.name)] = (s[B.strip(b.name)] || 0) + 1
  }
  const counts = {}
  const rle = []
  for (let i = 0; i < total;) { let j = i; while (j < total && cells[j] === cells[i]) j++; rle.push(cells[i], j - i); counts[cells[i]] = (counts[cells[i]] || 0) + (j - i); i = j }
  return { v: 1, id: meta.id || 'schematic', name: meta.name || meta.id || 'schematic', kind: meta.kind || 'build', purpose: meta.purpose || '', source: { ...(meta.source || {}), box: { ...box } },
    origin: [box.x0, box.y0, box.z0], size: S, palette, rle, counts, sources, notes: meta.notes || [], unknownCells: unknown.length }
}

function cellsOf(s) {
  const total = s.size[0] * s.size[1] * s.size[2], out = new Uint16Array(total)
  let p = 0
  for (let i = 0; i < s.rle.length; i += 2) { out.fill(s.rle[i], p, p + s.rle[i + 1]); p += s.rle[i + 1] }
  if (p !== total) throw new Error(`schematic ${s.id}: run lengths add up to ${p}, not ${total}`)
  return out
}
// the entry at a world position when the schematic is placed with its min corner at `at` (default: where it was captured)
function entryAt(s, cells, at, x, y, z) {
  const lx = x - at[0], ly = y - at[1], lz = z - at[2]
  if (lx < 0 || ly < 0 || lz < 0 || lx >= s.size[0] || ly >= s.size[1] || lz >= s.size[2]) return null
  return s.palette[cells[idx(s.size, lx, ly, lz)]]
}

// Compare a world with a schematic, cell by cell. get(x,y,z) -> { name, props } | null. `at` = world position of the schematic's min corner.
// -> { checked, unknown, matched, wrong: [{ x, y, z, want, got }], byRole: { role -> { checked, wrong } }, ok }
function diff(s, get, at = s.origin, opt = {}) {
  const cells = cellsOf(s)
  const res = { checked: 0, unknown: 0, matched: 0, wrong: [], byRole: {}, ok: true }
  for (let y = 0; y < s.size[1]; y++) for (let z = 0; z < s.size[2]; z++) for (let x = 0; x < s.size[0]; x++) {
    const e = s.palette[cells[idx(s.size, x, y, z)]]
    if (e.role === 'any') continue
    const wx = at[0] + x, wy = at[1] + y, wz = at[2] + z
    const b = get(wx, wy, wz)
    const r = res.byRole[B.label(e).split(' ')[0]] = res.byRole[B.label(e).split(' ')[0]] || { checked: 0, wrong: 0 }
    if (!b) { res.unknown++; continue }
    res.checked++; r.checked++
    if (B.matches(e, b.name, b.props)) res.matched++
    else { r.wrong++; if (res.wrong.length < (opt.max || 5000)) res.wrong.push({ x: wx, y: wy, z: wz, want: B.label(e), got: B.strip(b.name) + (b.props && b.props.level != null && /water|lava/.test(b.name) ? ' level ' + b.props.level : ''), role: e.role }) }
  }
  res.ok = res.wrong.length === 0
  return res
}

// a schematic from a design that lists its cells by role (the mob farm layout): { air: [[x,y,z]...], solidShell: bool ...} is built by the caller via capture(); this helper
// only turns a Map key -> { name, props } into a get().
const getterOf = (map) => (x, y, z) => map.get(x + ',' + y + ',' + z) || null

// "what the build needs", for the page and for people: one line per palette entry
function legend(s) {
  return s.palette.map((e, i) => ({ index: i, role: e.role, label: B.label(e), needs: B.requirementText(e), cells: (s.counts && s.counts[i]) || 0, sources: Object.entries((s.sources && s.sources[i]) || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => ({ block: n, cells: c })) })).filter(r => r.cells > 0)
}

module.exports = { capture, cellsOf, entryAt, diff, legend, getterOf, idx }
