// brain/schematic/sponge.js: a Sponge .schem file (WorldEdit / Litematica export, versions 2 and 3) as a format 2 schematic. Pure apart from `read`, which parses the file.
//
// A .schem names a block state per cell (`minecraft:oak_stairs[facing=north,half=bottom]`) and nothing about roles, so every cell becomes its own block (B.describeExact):
// that is mode 'aesthetic' (a build made for looks: what you see is what is wanted). Pass mode 'functional' to turn plain walls into role `solid` instead.
// Cell order in a .schem is x fastest, then z, then y: the same as ours. `Offset` (the WorldEdit paste offset) is not a world position, so origin is [0,0,0].
// `scenery`: block names (or a RegExp) whose cells are kept as scenery (the natural ground around a build) instead of as the build.
'use strict'
const fs = require('fs')
const B = require('./blocks')

// 'minecraft:oak_stairs[facing=north,half=bottom]' -> { name, props }
function parseState(s) {
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(String(s)); const props = {}
  if (m[2]) for (const kv of m[2].split(',')) { const i = kv.indexOf('='); if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1) }
  return { name: m[1], props }
}

// the cells (palette index per cell) out of a varint-encoded BlockData
function decodeVarints(data, total) {
  const out = new Uint16Array(total); let p = 0
  for (let i = 0; i < total; i++) {
    let v = 0, shift = 0, b
    do { if (p >= data.length) throw new Error(`BlockData ends after ${i} of ${total} cells`); b = data[p++]; v |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
    out[i] = v
  }
  return out
}

// root: nbt.simplify(parsed) of the file (the `Schematic` compound in version 3, the root itself in 2)
function fromSimplified(root, meta = {}) {
  const r = root.Schematic || root
  const W = r.Width, H = r.Height, L = r.Length, total = W * H * L
  const pal = r.Palette || (r.Blocks && r.Blocks.Palette), data = r.BlockData || (r.Blocks && r.Blocks.Data)
  if (!pal || !data || !(W > 0 && H > 0 && L > 0)) throw new Error('not a Sponge schematic (no Palette / BlockData / size)')
  const byIndex = []
  for (const [state, i] of Object.entries(pal)) byIndex[i] = parseState(state)
  const cells = decodeVarints(data, total)
  const aesthetic = meta.mode !== 'functional'
  const scenery = meta.scenery instanceof RegExp ? meta.scenery : Array.isArray(meta.scenery) ? new RegExp('^(' + meta.scenery.join('|') + ')$') : null
  const palette = [{ role: 'any' }], key = new Map([['any', 0]]), map = new Array(byIndex.length)
  for (let i = 0; i < byIndex.length; i++) {
    const b = byIndex[i]; if (!b) { map[i] = 0; continue }
    let d = aesthetic ? B.describeExact(b.name, b.props) : B.describe(b.name, b.props)
    if (d.role === 'air') { map[i] = null; continue }
    if (scenery && scenery.test(B.strip(b.name))) d = { ...d, scenery: true }
    const k = JSON.stringify(d); if (!key.has(k)) { key.set(k, palette.length); palette.push(d) }
    map[i] = key.get(k)
  }
  // air stays an open cell in a functional build (the room matters); in an aesthetic one it is not kept (`any`)
  const airIdx = (() => { if (aesthetic) return 0; const d = { role: 'air' }, k = JSON.stringify(d); if (!key.has(k)) { key.set(k, palette.length); palette.push(d) } return key.get(k) })()
  const counts = {}, rle = []
  let prev = -1, run = 0
  for (let k = 0; k < total; k++) {
    const m = map[cells[k]]; const v = m == null ? airIdx : m
    if (v === prev) run++
    else { if (run) { rle.push(prev, run); counts[prev] = (counts[prev] || 0) + run } prev = v; run = 1 }
  }
  if (run) { rle.push(prev, run); counts[prev] = (counts[prev] || 0) + run }
  const md = r.Metadata || {}
  return { v: 2, id: meta.id || 'schematic', name: meta.name || md.Name || meta.id || 'schematic', kind: meta.kind || 'build', mode: aesthetic ? 'aesthetic' : 'functional', purpose: meta.purpose || '',
    source: { world: meta.world || 'imported schematic file', save: null, file: meta.file || null, capturedAt: meta.capturedAt || new Date().toISOString(), by: meta.by || (md.Author ? md.Author : 'brain/schematic/sponge.js'), box: { x0: 0, y0: 0, z0: 0, x1: W - 1, y1: H - 1, z1: L - 1 }, dataVersion: r.DataVersion || null },
    origin: [0, 0, 0], size: [W, H, L], palette, rle, counts, notes: meta.notes || [], unknownCells: 0 }
}

async function read(file, meta = {}) {
  const nbt = require('prismarine-nbt')
  const { parsed } = await nbt.parse(fs.readFileSync(file))
  return fromSimplified(nbt.simplify(parsed), { file: require('path').basename(file), ...meta })
}

module.exports = { parseState, decodeVarints, fromSimplified, read }
