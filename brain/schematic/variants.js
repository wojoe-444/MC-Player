// brain/schematic/variants.js: a schematic is a COLLECTION OF VARIANTS (Walter 2026-11-11). A schematic with one variant has a variant called "Main". Pure: no files, no bot.
//
//   file format 3: { v: 3, id, name, kind, category?, tags?, purpose?, notes?, defaultVariant: 'main',
//                    variants: [{ id, name, description?, mode, size, origin, palette, rle, counts, notes?, source?, unknownCells?, anchors? }] }
//   The variant carries everything that is about CELLS (so a small and a large farm can differ in size, palette and anchors); the schematic carries what is about the
//   thing itself (name, kind, purpose). Files of format 1 and 2 (one flat build) are read as a schematic with the single variant Main, so nothing was migrated and nothing
//   that reads a flat schematic (brain/inspect, follow, the diff, the bot module) changed: `project(doc, variantId)` gives it the flat format-2 object of one variant.
'use strict'
const F = require('./format')

const MAIN = 'main'
// what belongs to a variant (the cells and whatever describes them); everything else on a flat file is the schematic's own
const CELL_FIELDS = ['mode', 'size', 'origin', 'palette', 'rle', 'counts', 'unknownCells', 'anchors', 'source']
const safeId = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40)

const isDoc = (raw) => !!raw && raw.v === 3 && Array.isArray(raw.variants)

// a flat format 1/2 schematic as one variant
function variantOf(flat, id = MAIN, name = 'Main', description = '') {
  const v = { id, name, description }
  for (const k of CELL_FIELDS) if (flat[k] !== undefined) v[k] = flat[k]
  if (flat.notes && flat.notes.length) v.notes = flat.notes
  return v
}

// any readable file -> a format 3 document (or null when it is not a schematic). Cell data is brought up to format 2 on the way (F.upgrade: v1 walls, the stone rule).
function normalize(raw) {
  if (!raw || !raw.id) return null
  if (isDoc(raw)) {
    const variants = raw.variants.filter(v => v && v.id && Array.isArray(v.rle) && Array.isArray(v.palette) && Array.isArray(v.size)).map(v => ({ ...v, ...cellsOnly(F.neutral({ ...v })) }))
    if (!variants.length) return null
    return { ...raw, variants, defaultVariant: variants.some(v => v.id === raw.defaultVariant) ? raw.defaultVariant : variants[0].id }
  }
  if ((raw.v !== 1 && raw.v !== 2) || !Array.isArray(raw.rle)) return null
  const flat = F.upgrade(raw); if (!flat) return null
  const { v, ...rest } = flat
  const doc = { v: 3, id: rest.id, name: rest.name, kind: rest.kind, purpose: rest.purpose || '', defaultVariant: MAIN, variants: [variantOf(flat)] }
  if (rest.category) doc.category = rest.category
  if (rest.tags) doc.tags = rest.tags
  return doc
}
const cellsOnly = (v) => { const o = {}; for (const k of CELL_FIELDS) if (v[k] !== undefined) o[k] = v[k]; return o }

const find = (doc, id) => doc.variants.find(v => v.id === id) || null
const variantList = (doc) => doc.variants.map(v => ({ id: v.id, name: v.name || v.id, description: v.description || '', size: v.size, mode: v.mode || 'functional' }))

// the flat format 2 schematic of one variant: what every reader of a single build expects. `variant` / `variants` say where it came from.
function project(doc, variantId) {
  const v = find(doc, variantId) || find(doc, doc.defaultVariant) || doc.variants[0]
  const { variants, defaultVariant, v: _v, notes, ...meta } = doc
  return { ...meta, v: 2, ...cellsOnly(v), notes: [...(notes || []), ...(v.notes || [])], variant: v.id, variantName: v.name || v.id, variantDescription: v.description || '', variants: variantList(doc) }
}

// the schematic document with a flat build as one of its variants: `mode` 'replace' puts it over the variant of that id (keeping its name), 'add' makes a new variant
// (an id that is taken gets -2, -3 ...). Returns { doc, variantId }.
function withVariant(doc, flat, { id, name, description, replace = false } = {}) {
  const variants = doc.variants.slice()
  let vid = safeId(id || name) || 'variant'
  const i = variants.findIndex(v => v.id === vid)
  if (replace && i >= 0) {
    const old = variants[i]
    variants[i] = { ...variantOf(flat, vid, name || old.name, description != null ? description : old.description), id: vid }
    return { doc: { ...doc, variants }, variantId: vid }
  }
  if (i >= 0) { let n = 2; while (variants.some(v => v.id === `${vid}-${n}`)) n++; vid = `${vid}-${n}` }
  variants.push(variantOf(flat, vid, name || vid, description || ''))
  return { doc: { ...doc, variants }, variantId: vid }
}

// a brand new document from a flat build: the one variant is Main (or the name given)
function newDoc(flat, meta = {}) {
  const doc = { v: 3, id: flat.id, name: flat.name, kind: flat.kind, purpose: flat.purpose || '', defaultVariant: MAIN, variants: [variantOf(flat, MAIN, 'Main')] }
  for (const k of ['category', 'tags']) if (meta[k] != null && meta[k].length !== 0) doc[k] = meta[k]
  return doc
}

module.exports = { MAIN, CELL_FIELDS, safeId, isDoc, normalize, variantOf, project, find, variantList, withVariant, newDoc }
