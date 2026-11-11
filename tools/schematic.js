#!/usr/bin/env node
// tools/schematic.js: capture, show and diff schematics against a world SAVE (the region files Minecraft wrote). For people and agents; the bots capture from the
// chunks they have loaded (brain/schematic/index.js).
//   node tools/schematic.js capture --save <World folder> --box x0,y0,z0,x1,y1,z1 --id mobfarm-x --name "..." [--kind mobfarm] [--seeds x,y,z;x,y,z] [--mask box;box (keep only these boxes)] [--purpose "..."] [--world "name"] [--out file]
//   node tools/schematic.js show    <schematic.json> [--layers y0-y1]        ASCII plan, one layer per y (. air, # solid, W water, H hopper, C chest, ...)
//   node tools/schematic.js diff    --save <World folder> <schematic.json> [--at x,y,z]     cell by cell; --at moves the schematic (default: where it was captured)
//   node tools/schematic.js design  --id chicago-design --out file [--ox -6018 --oz -2355 --dx -1 --dz 0 --yp 59]   the bots' own mob farm design (brain/mobfarm/geometry.js) as a schematic
//   node tools/schematic.js hoppers --save <World folder> --x X --z Z [--r 48]          where the hoppers and chests are near a point (to find a farm)
'use strict'
const fs = require('fs')
const path = require('path')
const F = require('../brain/schematic/format')
const B = require('../brain/schematic/blocks')
const W = require('../brain/schematic/world')

const argv = process.argv.slice(2), cmd = argv[0]
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const nums = (s) => String(s).split(',').map(Number)
const positional = argv.slice(1).find((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')))

const GLYPH = (e) => e.role === 'any' ? ' ' : e.role === 'air' ? '.' : e.role === 'solid' ? '#' : e.role === 'water' ? (String(e.level) === '0' ? 'W' : String(e.level)) : e.role === 'lava' ? 'L'
  : /hopper/.test(e.block) ? 'H' : /chest|barrel/.test(e.block) ? 'C' : /trapdoor/.test(e.block) ? 'T' : /slab/.test(e.block) ? (e.props && e.props.type === 'top' ? '^' : '_') : /torch/.test(e.block) ? 'i' : /ladder/.test(e.block) ? 'l' : /stairs/.test(e.block) ? 's' : '?'

function show(s, layers) {
  const cells = F.cellsOf(s), [W0, H0, D0] = s.size
  const [a, b] = layers ? layers.split('-').map(Number) : [s.origin[1], s.origin[1] + H0 - 1]
  for (let y = Math.min(b, s.origin[1] + H0 - 1); y >= Math.max(a, s.origin[1]); y--) {
    console.log(`y=${y}`)
    for (let z = 0; z < D0; z++) { let r = ''; for (let x = 0; x < W0; x++) r += GLYPH(s.palette[cells[F.idx(s.size, x, y - s.origin[1], z)]]); console.log(String(s.origin[2] + z).padStart(5) + ' ' + r) }
  }
  console.log('x from ' + s.origin[0] + ' (left) to ' + (s.origin[0] + W0 - 1))
  for (const l of F.legend(s)) console.log(`${String(l.cells).padStart(6)}  ${l.label.padEnd(34)} needs ${l.needs}${l.sources.length ? '  (was: ' + l.sources.map(x => x.block + ' ' + x.cells).join(', ') + ')' : ''}`)
}

if (cmd === 'capture') {
  const box = nums(opt('box')), save = opt('save')
  const w = W.openSave(save)
  const s = F.capture(w.get, { x0: box[0], y0: box[1], z0: box[2], x1: box[3], y1: box[4], z1: box[5] }, {
    masks: opt('mask') ? opt('mask').split(';').map(nums).map(m => ({ x0: m[0], y0: m[1], z0: m[2], x1: m[3], y1: m[4], z1: m[5] })) : null, seeds: opt('seeds') ? opt('seeds').split(';').map(nums) : null, id: opt('id'), name: opt('name'), kind: opt('kind', 'build'), purpose: opt('purpose', ''),
    source: { world: opt('world', path.basename(save)), save: path.basename(save), capturedAt: new Date().toISOString(), by: opt('by', 'tools/schematic.js') } })
  w.close()
  const out = opt('out', `${s.id}.json`); fs.writeFileSync(out, JSON.stringify(s)); console.log(`wrote ${out}: ${s.size.join('x')} cells, ${s.palette.length - 1} kinds of block, ${s.unknownCells} unreadable cells`)
} else if (cmd === 'show') show(JSON.parse(fs.readFileSync(positional, 'utf8')), opt('layers'))
else if (cmd === 'diff') {
  const s = JSON.parse(fs.readFileSync(positional, 'utf8')), w = W.openSave(opt('save'))
  const at = opt('at') ? nums(opt('at')) : s.origin
  const r = F.diff(s, w.get, at); w.close()
  console.log(JSON.stringify({ id: s.id, at, checked: r.checked, matched: r.matched, unknown: r.unknown, wrong: r.wrong.length, byRole: r.byRole, ok: r.ok, first: r.wrong.slice(0, 25) }, null, 1))
} else if (cmd === 'design') {
  const MF = require('../brain/mobfarm/geometry')
  const L = MF.layout({ ox: +opt('ox', -6018), oz: +opt('oz', -2355), d: [+opt('dx', -1), +opt('dz', 0)], yPlatform: +opt('yp', 59) })
  const s = require('../brain/schematic/designs').mobfarmDesign(L, { id: opt('id', 'mobfarm-design') })
  const out = opt('out', `${s.id}.json`); fs.writeFileSync(out, JSON.stringify(s)); console.log(`wrote ${out}: ${s.size.join('x')}`)
} else if (cmd === 'hoppers') {
  const w = W.openSave(opt('save')), x = +opt('x'), z = +opt('z'), r = +opt('r', 48), out = []
  for (let cz = (z - r) >> 4; cz <= (z + r) >> 4; cz++) for (let cx = (x - r) >> 4; cx <= (x + r) >> 4; cx++) for (const b of w.blockEntities(cx, cz)) if (/hopper|chest/.test(b.id) && Math.hypot(b.x - x, b.z - z) <= r) out.push(`${b.id.replace('minecraft:', '')} ${b.x},${b.y},${b.z} items=${(b.Items || []).length}`)
  console.log(out.join('\n')); w.close()
} else console.log('commands: capture | show | diff | design | hoppers (see the header of this file)')
