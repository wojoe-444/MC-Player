// dashboard/schematiccast.js: schematics (brain/schematic) for the Schematics page. `index` lists them; `detail` is one schematic as the viewer needs it: the palette and run-length
// cells (every cell names a specific block and a role), a bill of materials grouped by block (with the palette entries to isolate), and the raw materials it comes down to.
'use strict'
const path = require('path')
const S = require('../brain/schematic/store')
const BOM = require('../brain/schematic/bom')

function dirsOf({ sharedDir, botDirs = [] }) {
  return S.dirsFor({ sharedDir }).concat(botDirs.map(b => path.join(b.dir || b, 'brain', 'state', 'schematics')))
}
const summary = (s) => ({ id: s.id, name: s.name, kind: s.kind, mode: s.mode || 'functional', purpose: s.purpose || '', size: s.size, origin: s.origin, world: (s.source && s.source.world) || null, capturedAt: (s.source && s.source.capturedAt) || null, by: (s.source && s.source.by) || null })
function index(opts) {
  return { generatedAt: new Date().toISOString(), schematics: S.list(dirsOf(opts)).map(({ schematic }) => summary(schematic)) }
}

function detail(opts, id) {
  const e = S.list(dirsOf(opts)).find(x => x.schematic.id === id); if (!e) return null
  const s = e.schematic, bom = BOM.bom(s)
  return {
    ...summary(s), v: s.v, source: s.source || {}, notes: [...(s.notes || []), ...(s.unknownCells ? [`${s.unknownCells} cells could not be read when it was captured and are left open ("anything").`] : [])],
    palette: s.palette, rle: s.rle, counts: s.counts || {}, bom, raw: BOM.rawMaterials(bom),
  }
}
module.exports = { index, detail, cast: detail }
