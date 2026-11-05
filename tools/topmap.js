// Renders brain/state/topmap.json (written by the bot: top block per column around home) into brain/state/topmap.png.
// Colors by block kind, shading by height, markers for torches, beds, chests, farmland, crops, placed scaffolding.
// usage: node tools/topmap.js [scale] [in.json] [out.png]
const fs = require('fs')
const { createCanvas } = require('canvas')
const d = JSON.parse(fs.readFileSync(process.argv[3] || 'brain/state/topmap.json', 'utf8'))
const S = Number(process.argv[2]) || 8, N = d.size
const cv = createCanvas(N * S, N * S + 40), g = cv.getContext('2d')
const COL = [
  [/water/, [40, 90, 200]], [/lava/, [230, 90, 20]], [/grass_block|moss/, [80, 160, 60]], [/leaves/, [40, 120, 40]], [/_log|_wood/, [110, 80, 40]],
  [/sand/, [220, 210, 150]], [/gravel/, [140, 135, 130]], [/dirt|farmland|podzol|mud/, [130, 90, 60]], [/cobble/, [120, 120, 120]],
  [/stone|andesite|diorite|granite|tuff|deepslate/, [150, 150, 150]], [/planks|_door|_stairs|_slab|fence/, [170, 130, 80]], [/snow|ice/, [240, 240, 250]],
  [/wheat|carrots|potatoes|berry/, [200, 200, 60]], [/./, [200, 100, 200]]
]
const color = (n) => (COL.find(([re]) => re.test(n)) || [, [255, 0, 255]])[1]
const ys = d.cells.filter(Boolean).map(c => c[1]), y0 = Math.min(...ys), y1 = Math.max(...ys)
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const c = d.cells[i * N + j]; if (!c) continue
  const [name, y] = c, k = 0.55 + 0.45 * ((y - y0) / Math.max(1, y1 - y0))
  const [r, gg, b] = color(name)
  g.fillStyle = `rgb(${Math.round(r * k)},${Math.round(gg * k)},${Math.round(b * k)})`
  g.fillRect(j * S, i * S, S, S)
}
// spawnable cells (block light 0 on a solid floor with 2 free cells above): purple tint; light 1-5 (old threshold, not spawnable): faint
const tint = (list, fill) => { g.fillStyle = fill; for (const [x, z] of list || []) { const j = x - d.x0, i = z - d.z0; if (i >= 0 && j >= 0 && i < N && j < N) g.fillRect(j * S, i * S, S, S) } }
tint(d.dark, 'rgba(120,0,160,0.55)')
tint(d.lowl, 'rgba(255,255,255,0.25)')
const mark = (list, fill, r) => { g.fillStyle = fill; for (const [x, z] of list || []) { const j = x - d.x0, i = z - d.z0; if (i < 0 || j < 0 || i >= N || j >= N) continue; g.beginPath(); g.arc(j * S + S / 2, i * S + S / 2, r, 0, 7); g.fill() } }
mark(d.torches, 'rgb(255,220,0)', S * 0.25)
mark(d.scaffold, 'rgb(255,0,0)', S * 0.3)
mark(d.chests, 'rgb(150,80,0)', S * 0.45)
mark(d.beds, 'rgb(0,200,255)', S * 0.5)
mark(d.mine, 'rgb(0,0,0)', S * 0.5)
mark([[d.me[0], d.me[2]]], 'rgb(255,255,255)', S * 0.5)
g.fillStyle = '#fff'; g.fillRect(0, N * S, N * S, 40); g.fillStyle = '#000'; g.font = (S < 8 ? 10 : 14) + 'px sans-serif'
g.fillText(`top-down ${N}x${N} around home ${d.home.join(',')}  y ${y0}-${y1}   yellow=torch red=scaffold placed by bot  brown=chest  cyan=bed  black=mine  white=bot  purple=mobs can spawn (light 0): ${(d.dark || []).length}  torches ${d.torches.length}`, 6, N * S + 25)
const OUT = process.argv[4] || 'brain/state/topmap.png'
fs.writeFileSync(OUT, cv.toBuffer('image/png'))
console.log('wrote', OUT, N * S, 'px')
