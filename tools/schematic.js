#!/usr/bin/env node
// tools/schematic.js: capture, show and diff schematics against a world SAVE (the region files Minecraft wrote). For people and agents; the bots capture from the
// chunks they have loaded (brain/schematic/index.js).
//   node tools/schematic.js capture --save <World folder> --box x0,y0,z0,x1,y1,z1 --id mobfarm-x --name "..." [--kind mobfarm] [--mode functional|aesthetic] [--surround 2] [--seeds x,y,z;x,y,z] [--mask box;box (keep only these boxes)] [--purpose "..."] [--world "name"] [--out file]
//   node tools/schematic.js migrate <old.json> [--out file]              a format-1 file as format 2 (every cell names its block)
//   node tools/schematic.js show    <schematic.json> [--layers y0-y1]        ASCII plan, one layer per y (. air, # solid, W water, H hopper, C chest, ...)
//   node tools/schematic.js diff    --save <World folder> <schematic.json> [--at x,y,z]     cell by cell; --at moves the schematic (default: where it was captured)
//   node tools/schematic.js design  --id chicago-design --out file [--ox -6018 --oz -2355 --dx -1 --dz 0 --yp 59]   the bots' own mob farm design (brain/mobfarm/geometry.js) as a schematic
//   node tools/schematic.js hut     --out file                          the built-for-looks example (an oak hut in a fenced yard) as an aesthetic schematic
//   node tools/schematic.js import  <file.schem> [--id x] [--name "..."] [--kind house] [--category Builds] [--tags a,b] [--mode aesthetic|functional] [--scenery dirt,grass_block] [--purpose "..."] [--out file]   a Sponge .schem (WorldEdit / Litematica) as format 2; default out: brain/schematic/library/<id>.json
//   node tools/schematic.js world   <id | file.json | file.schem> [--name "Test - ..."] [--kind grass|void] [--saves <saves dir>] [--overwrite] [--surface N [--rock viewer.html]] [--x X --y Y --z Z]   the build as a creative superflat test world (a 1.21.6 save, region files written directly)
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

const GLYPH = (e) => e.role === 'any' ? ' ' : e.scenery ? ',' : e.role === 'air' ? '.' : e.role === 'solid' ? '#' : e.role === 'water' ? (String(e.level) === '0' ? 'W' : String(e.level)) : e.role === 'lava' ? 'L'
  : /hopper/.test(e.block) ? 'H' : /chest|barrel/.test(e.block) ? 'C' : /trapdoor/.test(e.block) ? 'T' : /slab/.test(e.block) ? (e.props && e.props.type === 'top' ? '^' : '_') : /torch/.test(e.block) ? 'i' : /ladder/.test(e.block) ? 'l' : /stairs/.test(e.block) ? 's' : /log/.test(e.block) ? 'O' : /plank/.test(e.block) ? 'p' : /fence/.test(e.block) ? 'f' : /glass/.test(e.block) ? 'g' : /door/.test(e.block) ? 'D' : (e.block || '?')[0]

function show(s, layers) {
  const cells = F.cellsOf(s), [W0, H0, D0] = s.size
  const [a, b] = layers ? layers.split('-').map(Number) : [s.origin[1], s.origin[1] + H0 - 1]
  for (let y = Math.min(b, s.origin[1] + H0 - 1); y >= Math.max(a, s.origin[1]); y--) {
    console.log(`y=${y}`)
    for (let z = 0; z < D0; z++) { let r = ''; for (let x = 0; x < W0; x++) r += GLYPH(s.palette[cells[F.idx(s.size, x, y - s.origin[1], z)]]); console.log(String(s.origin[2] + z).padStart(5) + ' ' + r) }
  }
  console.log('x from ' + s.origin[0] + ' (left) to ' + (s.origin[0] + W0 - 1))
  for (const l of F.legend(s)) console.log(`${String(l.cells).padStart(6)}  ${(l.block && l.role === 'solid' ? l.block : l.label).padEnd(34)} ${l.scenery ? 'scenery' : 'needs ' + l.needs}`)
}

if (cmd === 'capture') {
  const box = nums(opt('box')), save = opt('save')
  const w = W.openSave(save)
  const s = F.capture(w.get, { x0: box[0], y0: box[1], z0: box[2], x1: box[3], y1: box[4], z1: box[5] }, {
    masks: opt('mask') ? opt('mask').split(';').map(nums).map(m => ({ x0: m[0], y0: m[1], z0: m[2], x1: m[3], y1: m[4], z1: m[5] })) : null, seeds: opt('seeds') ? opt('seeds').split(';').map(nums) : null, id: opt('id'), name: opt('name'), kind: opt('kind', 'build'), mode: opt('mode', 'functional'), surround: opt('surround') != null ? +opt('surround') : undefined, purpose: opt('purpose', ''),
    source: { world: opt('world', path.basename(save)), save: path.basename(save), capturedAt: new Date().toISOString(), by: opt('by', 'tools/schematic.js') } })
  w.close()
  const out = opt('out', `${s.id}.json`); fs.writeFileSync(out, JSON.stringify(s)); console.log(`wrote ${out}: ${s.size.join('x')} cells, ${s.palette.length - 1} kinds of block, ${s.unknownCells} unreadable cells`)
} else if (cmd === 'show') show(JSON.parse(fs.readFileSync(positional, 'utf8')), opt('layers'))
else if (cmd === 'migrate') { const s = F.upgrade(JSON.parse(fs.readFileSync(positional, 'utf8'))); const out = opt('out', positional); fs.writeFileSync(out, JSON.stringify(s)); console.log(`wrote ${out}: format ${s.v}, ${s.palette.length - 1} kinds of block`) }
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
} else if (cmd === 'hut') {
  const s = require('../brain/schematic/designs').starterHut({ id: opt('id', 'starter-hut') })
  const out = opt('out', `${s.id}.json`); fs.writeFileSync(out, JSON.stringify(s)); console.log(`wrote ${out}: ${s.size.join('x')}, ${s.palette.length - 1} kinds of block`)
} else if (cmd === 'import') {
  // a Sponge .schem (WorldEdit, Litematica) as a format 2 schematic; written to --out (default brain/schematic/library/<id>.json)
  const Sp = require('../brain/schematic/sponge')
  const id = require('../brain/schematic/store').safeId(opt('id', path.basename(positional, path.extname(positional))))
  Sp.read(positional, { id, name: opt('name'), kind: opt('kind', 'build'), category: opt('category'), tags: opt('tags') ? opt('tags').split(',') : [], mode: opt('mode', 'aesthetic'), purpose: opt('purpose', ''), scenery: opt('scenery') ? opt('scenery').split(',') : null, world: opt('world'), by: opt('by'), notes: opt('note') ? [opt('note')] : [] }).then(s => {
    const out = opt('out', path.join(__dirname, '..', 'brain', 'schematic', 'library', `${s.id}.json`)); fs.writeFileSync(out, JSON.stringify(s))
    console.log(`wrote ${out}: ${s.size.join('x')}, ${s.palette.length - 1} kinds of block, ${fs.statSync(out).size} bytes`)
  }).catch(e => { console.error('import failed: ' + e.message); process.exit(1) })
} else if (cmd === 'world') {
  // a catalog schematic (by id, or a path to a .json / a .schem) as a creative test world in the Minecraft saves folder
  const T = require('../brain/schematic/testworld'), St = require('../brain/schematic/store')
  const load = async () => {
    if (!positional) throw new Error('usage: node tools/schematic.js world <schematic id | file.json | file.schem> [--name "Test - ..."] [--kind grass|void] [--saves <saves dir>] [--overwrite] [--surface N (underground build: layer N is the first above ground)] [--rock viewer.html (which air is solid rock, from the generator viewer page)] [--x X --y Y --z Z (min corner)]')
    if (/\.schem$/i.test(positional)) return T.readSchemRaw(positional)   // the file as it is, every block property kept
    if (fs.existsSync(positional)) return JSON.parse(fs.readFileSync(positional, 'utf8'))
    const hit = St.list(St.dirsFor({})).find(x => x.schematic.id === positional)
    if (!hit) throw new Error(`no schematic "${positional}" in the catalog (brain/schematic/library or bot-shared/schematics)`)
    return hit.schematic
  }
  load().then(s => {
    const r = T.buildWorld(s, { name: opt('name'), kind: opt('kind', 'grass'), savesDir: opt('saves'), surface: opt('surface') != null ? +opt('surface') : undefined, rock: opt('rock') ? T.readRockMask(opt('rock'), s.raw ? s.raw.W * s.raw.H * s.raw.D : s.size[0] * s.size[1] * s.size[2]) : undefined, overwrite: argv.includes('--overwrite'), x: opt('x') != null ? +opt('x') : undefined, y: opt('y') != null ? +opt('y') : undefined, z: opt('z') != null ? +opt('z') : undefined })
    console.log(`wrote ${r.saveDir}\n  ${r.chunks} chunks, ${r.placed} blocks of "${s.id}" (${r.size.join('x')}) placed with its min corner at ${r.origin.join(',')}, ${r.settled} states settled (fences, walls, leaves, lanterns)${r.carved ? `, ${r.carved} cells of rooms cut out of the stone` : ''}\n  spawn ${r.spawn.join(',')} (north of the build, facing it), creative, daytime, ${r.kind} superflat\n  open Minecraft 1.21.6 > Singleplayer > "${r.name}"`)
  }).catch(e => { console.error('world failed: ' + e.message); process.exit(1) })
} else if (cmd === 'hoppers') {
  const w = W.openSave(opt('save')), x = +opt('x'), z = +opt('z'), r = +opt('r', 48), out = []
  for (let cz = (z - r) >> 4; cz <= (z + r) >> 4; cz++) for (let cx = (x - r) >> 4; cx <= (x + r) >> 4; cx++) for (const b of w.blockEntities(cx, cz)) if (/hopper|chest/.test(b.id) && Math.hypot(b.x - x, b.z - z) <= r) out.push(`${b.id.replace('minecraft:', '')} ${b.x},${b.y},${b.z} items=${(b.Items || []).length}`)
  console.log(out.join('\n')); w.close()
} else console.log('commands: capture | show | migrate | diff | design | hut | hoppers (see the header of this file)')
