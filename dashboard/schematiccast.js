// dashboard/schematiccast.js: schematics (brain/schematic) for the Schematics page. `index` lists them; `detail` is one schematic as the viewer needs it: the palette and run-length
// cells (every cell names a specific block and a role), a bill of materials grouped by block (with the palette entries to isolate), and the raw materials it comes down to.
'use strict'
const path = require('path')
const S = require('../brain/schematic/store')
const BOM = require('../brain/schematic/bom')
const V = require('../brain/schematic/variants')

function dirsOf({ sharedDir, botDirs = [] }) {
  return S.dirsFor({ sharedDir }).concat(botDirs.map(b => path.join(b.dir || b, 'brain', 'state', 'schematics')))
}
// `category` (optional on a schematic) groups the catalog; without one the kind does. `tags` (optional) are searchable.
const summary = (s) => ({ id: s.id, name: s.name, kind: s.kind, category: s.category || s.kind || 'build', tags: Array.isArray(s.tags) ? s.tags.map(String) : [], mode: s.mode || 'functional', purpose: s.purpose || '', size: s.size, origin: s.origin, world: (s.source && s.source.world) || null, capturedAt: (s.source && s.source.capturedAt) || null, by: (s.source && s.source.by) || null })
// every schematic is a collection of variants (a single build is the variant "Main"); the summary is the default variant's, with the list of all of them
function index(opts) {
  return { generatedAt: new Date().toISOString(), schematics: S.listDocs(dirsOf(opts)).map(({ doc }) => ({ ...summary(V.project(doc)), variants: V.variantList(doc), defaultVariant: doc.defaultVariant })) }
}

// one variant of a schematic (the default one without `variant`); null when there is no such schematic or variant
function detail(opts, id, variant) {
  const e = S.loadDoc(dirsOf(opts), id); if (!e) return null
  if (variant && !V.find(e.doc, variant)) return null
  const s = V.project(e.doc, variant), bom = BOM.bom(s)
  return {
    ...summary(s), v: s.v, variant: s.variant, variantName: s.variantName, variantDescription: s.variantDescription, variants: s.variants, defaultVariant: e.doc.defaultVariant, source: s.source || {}, notes: [...(s.notes || []), ...(s.unknownCells ? [`${s.unknownCells} cells could not be read when it was captured and are left open ("anything").`] : [])],
    palette: s.palette, rle: s.rle, counts: s.counts || {}, bom, raw: BOM.rawMaterials(bom),
  }
}
module.exports = { index, detail, cast: detail }
