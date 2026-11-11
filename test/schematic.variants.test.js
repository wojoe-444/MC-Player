// brain/schematic/variants.js + store.js: every schematic is a collection of variants; a flat file is the single variant "Main".
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const F = require('../brain/schematic/format')
const S = require('../brain/schematic/store')
const V = require('../brain/schematic/variants')
const D = require('../brain/schematic/designs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sch-var-'))

test('a flat schematic (format 2) reads as a collection with the single variant Main, and projects back to exactly what readers expect', () => {
  const hut = D.starterHut()
  const doc = V.normalize(hut)
  assert.strictEqual(doc.v, 3); assert.strictEqual(doc.variants.length, 1); assert.strictEqual(doc.defaultVariant, 'main'); assert.strictEqual(doc.variants[0].name, 'Main')
  const flat = V.project(doc)
  assert.strictEqual(flat.v, 2); assert.strictEqual(flat.id, hut.id); assert.deepStrictEqual(flat.size, hut.size); assert.deepStrictEqual(flat.rle, hut.rle); assert.strictEqual(flat.mode, 'aesthetic')
  assert.strictEqual(flat.variant, 'main'); assert.deepStrictEqual(flat.variants.map(v => v.id), ['main'])
  assert.deepStrictEqual(F.cellsOf(flat), F.cellsOf(hut), 'same cells')
})
test('format 1 files still read (upgraded, then wrapped)', () => {
  const v1 = { v: 1, id: 'old', name: 'Old', kind: 'room', size: [1, 1, 1], origin: [0, 0, 0], palette: [{ role: 'any' }, { role: 'solid' }], rle: [1, 1], counts: { 1: 1 }, sources: { 1: { cobblestone: 4 } } }
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify(v1))
  const s = S.load([dir], 'old'); assert.strictEqual(s.palette[1].block, 'stone'); assert.strictEqual(s.variant, 'main')
})
test('adding a variant: the new one is filed next to Main, ids that are taken get a number, the base is untouched', () => {
  const hut = D.starterHut(), doc = V.normalize(hut)
  const big = { ...hut, size: [20, 10, 20] }
  const a = V.withVariant(doc, big, { name: 'Large', description: 'wider' })
  assert.strictEqual(a.variantId, 'large'); assert.deepStrictEqual(a.doc.variants.map(v => v.id), ['main', 'large'])
  const b = V.withVariant(a.doc, big, { name: 'Large' }); assert.strictEqual(b.variantId, 'large-2')
  assert.strictEqual(doc.variants.length, 1, 'the input was not changed')
  const p = V.project(b.doc, 'large'); assert.deepStrictEqual(p.size, [20, 10, 20]); assert.strictEqual(p.variantName, 'Large'); assert.strictEqual(p.variantDescription, 'wider')
  assert.deepStrictEqual(V.project(b.doc).size, hut.size, 'the default variant is still Main')
  assert.deepStrictEqual(V.project(b.doc, 'no-such').size, hut.size, 'an unknown variant falls back to the default one')
  const r = V.withVariant(b.doc, { ...hut, size: [5, 5, 5] }, { id: 'large', replace: true })
  assert.deepStrictEqual(V.project(r.doc, 'large').size, [5, 5, 5]); assert.strictEqual(V.project(r.doc, 'large').variantName, 'Large', 'replacing keeps the name'); assert.strictEqual(r.doc.variants.length, 3)
})
test('store: a format 3 file lists, loads by variant and survives a round trip; a later directory wins as a whole', () => {
  const lib = tmp(), shared = tmp(), hut = D.starterHut()
  S.save(lib, hut)
  const base = S.loadDoc([lib], hut.id).doc
  const { doc } = V.withVariant(base, { ...hut, size: [9, 9, 9] }, { name: 'Tall' })
  S.saveDoc(shared, doc)
  const dirs = [lib, shared]
  assert.deepStrictEqual(S.load(dirs, hut.id, 'tall').size, [9, 9, 9]); assert.deepStrictEqual(S.load(dirs, hut.id).size, hut.size)
  const l = S.list(dirs).find(e => e.schematic.id === hut.id); assert.deepStrictEqual(l.schematic.variants.map(v => v.id), ['main', 'tall'], 'list() gives the default variant, with the variant list')
  assert.strictEqual(S.listDocs(dirs).length, 1, 'one schematic however many variants')
  assert.deepStrictEqual(S.load([lib], hut.id).variants.map(v => v.id), ['main'], 'the library alone has only Main')
  assert.strictEqual(S.load(dirs, 'missing'), null)
})
test('a variant of another size has its own palette and cells (nothing is shared between variants)', () => {
  const a = D.starterHut(), b = F.capture((x, y, z) => ({ name: y === 0 ? 'stone_bricks' : 'air', props: {} }), { x0: 0, y0: 0, z0: 0, x1: 2, y1: 1, z1: 2 }, { id: a.id, name: a.name, kind: 'house', mode: 'aesthetic', surround: 0 })
  const doc = V.withVariant(V.normalize(a), b, { name: 'Foundation only' }).doc
  const pa = V.project(doc, 'main'), pb = V.project(doc, 'foundation-only')
  assert.ok(pa.palette.length > pb.palette.length); assert.strictEqual(F.cellsOf(pb).length, 18)
})
