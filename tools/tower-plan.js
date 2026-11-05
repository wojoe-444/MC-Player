// Renders the tower plan from brain/build/blueprint.js: pov/tower-plan-iso.png (outside), pov/tower-plan-cutaway.png (south and east walls removed),
// pov/tower-plan-layers.png (one grid per course) and writes TOWER-PLAN.md. Pure drawing, never touches the bot.
//   node tools/tower-plan.js [ox oy oz]
const fs = require('fs')
const path = require('path')
const { createCanvas } = require('canvas')
const bp = require('../brain/build/blueprint')

const root = path.join(__dirname, '..')
let origin = { ox: 0, oy: 0, oz: 0 }
let site = null
try { site = JSON.parse(fs.readFileSync(path.join(root, 'brain/state/build-state.json'), 'utf8').replace(/^﻿/, '')).site } catch {}
const argv = process.argv.slice(2).map(Number)
if (argv.length === 3) origin = { ox: argv[0], oy: argv[1], oz: argv[2] }
else if (site && Number.isFinite(site.ox)) origin = { ox: site.ox, oy: site.oy, oz: site.oz }

const steps = bp.tower(origin)
const rel = (s) => ({ ...s, rx: s.x - origin.ox, ry: s.y - origin.oy, rz: s.z - origin.oz })
const cells = steps.map(rel).filter(s => s.block !== 'cobblestone')

const COLOR = {
  stone_bricks: '#8d8f94', spruce_log: '#4b3622', spruce_planks: '#8a6538', ladder: '#c9a35b', torch: '#ffd23f',
  spruce_door: '#6a4526', bed: '#c53a3a', chest: '#a8742c', crafting_table: '#b98748', cobblestone: '#6f6f6f'
}
const shade = (hex, f) => { const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * f)))); return `rgb(${c.join(',')})` }

function iso(list, file, title) {
  const S = 26, W = 1100, H = 900
  const cv = createCanvas(W, H), g = cv.getContext('2d')
  g.fillStyle = '#cfe5ff'; g.fillRect(0, 0, W, H)
  const px = (x, z) => W / 2 + (x - z) * S * 0.866
  const py = (x, y, z) => 640 + (x + z) * S * 0.5 - y * S
  // ground plane under the 9x9 area
  g.fillStyle = '#5b9a45'
  g.beginPath(); g.moveTo(px(-3, -3), py(-3, 0, -3)); g.lineTo(px(8, -3), py(8, 0, -3)); g.lineTo(px(8, 8), py(8, 0, 8)); g.lineTo(px(-3, 8), py(-3, 0, 8)); g.closePath(); g.fill()
  const order = list.slice().sort((a, b) => (a.rx + a.rz) - (b.rx + b.rz) || a.ry - b.ry)
  for (const s of order) {
    const c = COLOR[s.block] || '#ff00ff', x = s.rx, y = s.ry, z = s.rz
    const thin = s.block === 'ladder' || s.block === 'torch'
    const k = thin ? 0.35 : 1, ox = thin ? 0.325 : 0, oz2 = thin ? 0.325 : 0
    const X0 = x + ox, Z0 = z + oz2, X1 = X0 + k, Z1 = Z0 + k, Y1 = y + (s.block === 'torch' ? 0.6 : 1)
    const Y0 = s.block === 'torch' ? y : y
    // top
    g.fillStyle = shade(c, 1.12); g.beginPath()
    g.moveTo(px(X0, Z0), py(X0, Y1, Z0)); g.lineTo(px(X1, Z0), py(X1, Y1, Z0)); g.lineTo(px(X1, Z1), py(X1, Y1, Z1)); g.lineTo(px(X0, Z1), py(X0, Y1, Z1)); g.closePath(); g.fill()
    // south face (z = Z1), left on screen
    g.fillStyle = shade(c, 0.82); g.beginPath()
    g.moveTo(px(X0, Z1), py(X0, Y1, Z1)); g.lineTo(px(X1, Z1), py(X1, Y1, Z1)); g.lineTo(px(X1, Z1), py(X1, Y0, Z1)); g.lineTo(px(X0, Z1), py(X0, Y0, Z1)); g.closePath(); g.fill()
    // east face (x = X1), right on screen
    g.fillStyle = shade(c, 0.64); g.beginPath()
    g.moveTo(px(X1, Z1), py(X1, Y1, Z1)); g.lineTo(px(X1, Z0), py(X1, Y1, Z0)); g.lineTo(px(X1, Z0), py(X1, Y0, Z0)); g.lineTo(px(X1, Z1), py(X1, Y0, Z1)); g.closePath(); g.fill()
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.6; g.stroke()
  }
  g.fillStyle = '#111'; g.font = 'bold 22px sans-serif'; g.fillText(title, 24, 40)
  g.font = '15px sans-serif'
  g.fillText('Stone-brick walls, spruce-log corners, 9 courses; lookout deck at course 9 with a stone-brick parapet and 4 torches.', 24, 66)
  g.fillText('View from the south-east. Blue sky is just background; the green square is the ground.', 24, 88)
  fs.writeFileSync(path.join(root, 'pov', file), cv.toBuffer('image/png'))
}

iso(cells, 'tower-plan-iso.png', 'Personal tower: outside view (from the plan)')
iso(cells.filter(s => !((s.rx === 4 || s.rz === 4) && s.ry <= 8 && s.rx >= 0 && s.rz >= 0 && s.rx <= 4 && s.rz <= 4 && s.block !== 'ladder')), 'tower-plan-cutaway.png',
  'Personal tower: cutaway (south and east walls removed): interior floor, ladder, bed, chest, table')

// layer sheet: one 7x7 grid per course
{
  const levels = [...new Set(cells.map(s => s.ry))].sort((a, b) => a - b)
  const C = 34, pad = 18, cols = 4, gw = 7 * C + pad, gh = 7 * C + pad + 24
  const rows = Math.ceil(levels.length / cols)
  const cv = createCanvas(cols * gw + pad, rows * gh + 80), g = cv.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height)
  g.fillStyle = '#111'; g.font = 'bold 20px sans-serif'; g.fillText('Tower plan, one grid per course (north at the top, west at the left; x -1..5, z -1..5)', pad, 32)
  levels.forEach((lv, i) => {
    const gx = pad + (i % cols) * gw, gy = 54 + Math.floor(i / cols) * gh
    g.fillStyle = '#111'; g.font = 'bold 14px sans-serif'; g.fillText(`course ${lv}`, gx, gy + 14)
    g.fillStyle = '#eef3ea'; g.fillRect(gx, gy + 20, 7 * C, 7 * C)
    for (const s of cells.filter(s => s.ry === lv)) {
      const cx = gx + (s.rx + 1) * C, cy = gy + 20 + (s.rz + 1) * C
      g.fillStyle = COLOR[s.block] || '#f0f'
      if (s.block === 'ladder') g.fillRect(cx + 8, cy + 3, C - 16, C - 6)
      else if (s.block === 'torch') { g.beginPath(); g.arc(cx + C / 2, cy + C / 2, 6, 0, 7); g.fill() } else g.fillRect(cx + 1, cy + 1, C - 2, C - 2)
    }
    g.strokeStyle = '#bbb'; g.lineWidth = 0.5
    for (let k = 0; k <= 7; k++) { g.beginPath(); g.moveTo(gx + k * C, gy + 20); g.lineTo(gx + k * C, gy + 20 + 7 * C); g.stroke(); g.beginPath(); g.moveTo(gx, gy + 20 + k * C); g.lineTo(gx + 7 * C, gy + 20 + k * C); g.stroke() }
  })
  // legend
  const names = Object.keys(COLOR).filter(n => n !== 'cobblestone')
  let lx = pad; const ly = cv.height - 22
  g.font = '13px sans-serif'
  for (const n of names) { g.fillStyle = COLOR[n]; g.fillRect(lx, ly - 12, 16, 16); g.fillStyle = '#111'; g.fillText(n.replace(/_/g, ' '), lx + 22, ly + 1); lx += 22 + g.measureText(n.replace(/_/g, ' ')).width + 18 }
  fs.writeFileSync(path.join(root, 'pov', 'tower-plan-layers.png'), cv.toBuffer('image/png'))
}

// markdown
const count = {}
for (const s of cells) count[s.block] = (count[s.block] || 0) + 1
const bySite = site && Number.isFinite(site.ox) ? `x ${origin.ox}..${origin.ox + 4}, z ${origin.oz}..${origin.oz + 4}, first course at y ${origin.oy}` : 'to be chosen by the survey (best so far: about -957, 152, 2303)'
const md = `# My tower (OzoGo444's personal build)

Walter pre-approved this build (2026-10-26). It is survival-legit: every block is placed from a spot with a clear line of sight, nothing is dug except a temporary cobblestone pillar I stand on, and only the blocks below are ever placed.

**Pictures** (in \`pov\\\`): \`tower-plan-iso.png\` (outside), \`tower-plan-cutaway.png\` (interior), \`tower-plan-layers.png\` (every course as a grid).
Regenerate any time: \`node tools/tower-plan.js\` (it reads brain/build/blueprint.js, so it always matches the real build).

## Shape and size
- **5 x 5 tower**, walls 9 courses tall (courses 0-8), then a **lookout deck** at course 9 (an octagon of 45 cells, 7 x 7 with the four corners cut), a **stone-brick parapet** at course 10 and **4 torches** on top at course 11. Total height about 12 blocks above the ground.
- **Corners**: spruce logs (36). **Walls**: stone bricks. **Door** on the south face (2 high). **Window slits** (open air) at courses 2 and 6 in the middle of every face.
- **Inside**: a spruce-plank floor at course 4 (3 x 3 with an opening for the ladder), a **ladder** on the west wall from the ground to the deck, and on the ground floor my **bed, chest and crafting table** (placed if I have them), plus a wall torch.
- **Site**: ${bySite}. The survey wants flat, dry, tree-free ground away from your base; the first choice (the meadow at -984, 2292) was too hilly.

## Materials (blocks placed, from the blueprint)
| block | count |
|---|---|
${Object.entries(count).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${v} |`).join('\n')}

(The 4 torches on top plus 1 interior wall torch are the 5 torches; stone bricks are crafted from stone, planks from logs.)

## How it goes up
1. Foundation (fill low cells), then a temporary cobblestone pillar in the middle: I jump-place it up as I go (up to about 11 blocks).
2. Each course of the ring from the pillar top, bottom to top; the floor at course 4; the deck, parapet and torches at the top. Every block is placed against a block I can see.
3. I take the pillar down from the top with a pickaxe, then place the ladder bottom-up while climbing, fill the last deck and floor cells, furnish the inside, and put the door in last.

## Layers (relative cells, x east, z south, origin = north-west corner of the 5 x 5)
${[...new Set(cells.map(s => s.ry))].sort((a, b) => a - b).map(lv => {
  const l = cells.filter(s => s.ry === lv)
  const c = {}; for (const s of l) c[s.block] = (c[s.block] || 0) + 1
  return `- **course ${lv}**: ${Object.entries(c).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}`
}).join('\n')}
`
fs.writeFileSync(path.join(root, 'TOWER-PLAN.md'), md)
console.log('wrote TOWER-PLAN.md and 3 pictures in pov/', JSON.stringify(count), JSON.stringify(origin))
