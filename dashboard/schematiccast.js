// dashboard/schematiccast.js: a schematic (brain/schematic) as the Bases page's metal cast: the OPEN space of the build (air, water, the pieces that stand in it), with the
// solid world taken away, in CastData shape (web/src/lib/cast/types.ts) so the same viewer draws it. What the walls must be is not cells: it is the legend ("a solid,
// light-blocking, non-flammable block", and what the captured world really used).
'use strict'
const path = require('path')
const F = require('../brain/schematic/format')
const B = require('../brain/schematic/blocks')
const S = require('../brain/schematic/store')

const KINDS = ['shaft', 'room', 'mobfarm', 'farm', 'tunnel', 'cave']

function dirsOf({ sharedDir, botDirs = [] }) {
  return S.dirsFor({ sharedDir }).concat(botDirs.map(b => path.join(b.dir || b, 'brain', 'state', 'schematics')))
}
function index(opts) {
  return { generatedAt: new Date().toISOString(), schematics: S.list(dirsOf(opts)).map(({ schematic: s }) => ({ id: s.id, name: s.name, kind: s.kind, purpose: s.purpose || '', size: s.size, origin: s.origin, world: (s.source && s.source.world) || null, capturedAt: (s.source && s.source.capturedAt) || null, by: (s.source && s.source.by) || null })) }
}

function cast(opts, id) {
  const e = S.list(dirsOf(opts)).find(x => x.schematic.id === id); if (!e) return null
  const s = e.schematic, cells = F.cellsOf(s)
  const parts = [], markers = [], partOf = new Map()
  const part = (pid, kind, label, detail) => { if (!partOf.has(pid)) { partOf.set(pid, parts.length); parts.push({ id: pid, kind, label, by: null, at: null, src: 'schematic', detail, cells: 0 }) } return partOf.get(pid) }
  const flat = []
  let minY = Infinity, maxY = -Infinity
  for (let y = 0; y < s.size[1]; y++) for (let z = 0; z < s.size[2]; z++) for (let x = 0; x < s.size[0]; x++) {
    const e2 = s.palette[cells[F.idx(s.size, x, y, z)]]
    if (e2.role === 'any' || e2.role === 'solid') continue
    const wx = s.origin[0] + x, wy = s.origin[1] + y, wz = s.origin[2] + z
    let pi
    if (e2.role === 'air') pi = part('air', 'room', 'Open space', 'air: a mob or the player can stand or walk here')
    else if (e2.role === 'water') pi = part('water', 'tunnel', 'Water', 'sources and flowing water, each at the level it must have')
    else if (e2.role === 'lava') pi = part('lava', 'tunnel', 'Lava', 'lava')
    else {
      const name = e2.block
      pi = part('piece:' + name, 'mobfarm', name.replace(/_/g, ' '), 'exactly this block' + (e2.props ? ' (' + Object.entries(e2.props).map(([k, v]) => `${k}=${v}`).join(', ') + ')' : ''))
      if (/^(chest|trapped_chest|barrel|hopper)$/.test(name)) markers.push({ type: name === 'hopper' ? 'hopper' : 'chest', x: wx, y: wy, z: wz, label: B.label(e2) })
    }
    parts[pi].cells++
    flat.push(wx, wy, wz, pi, 0)
    if (wy < minY) minY = wy; if (wy > maxY) maxY = wy
  }
  const n = flat.length / 5
  const legend = F.legend(s).map(l => ({ ...l, kind: l.role }))
  const c = [s.origin[0] + s.size[0] / 2, s.origin[1] + s.size[1] / 2, s.origin[2] + s.size[2] / 2].map(Math.round)
  return {
    base: { id: s.id, name: s.name, x: c[0], y: c[1], z: c[2], radius: Math.round(Math.max(...s.size) / 2) },
    generatedAt: new Date().toISOString(), kinds: KINDS, cells: flat, cellStride: 5, parts, markers,
    notes: [...(s.notes || []), ...(s.unknownCells ? [`${s.unknownCells} cells could not be read when it was captured and are left open ("anything").`] : [])],
    stats: { cells: n, recorded: 0, derived: n, digsRecorded: 0, placedInBase: 0, minY: n ? minY : null, maxY: n ? maxY : null, truncated: false },
    sources: { registry: false, placed: false, dugLog: false, world: null },
    schematic: { id: s.id, name: s.name, kind: s.kind, purpose: s.purpose || '', size: s.size, origin: s.origin, source: s.source || {}, legend },
  }
}
module.exports = { index, cast }
