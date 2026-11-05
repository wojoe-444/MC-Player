// brain/pilot-kit/slice.js: a vertical cross-section next to the top-down map, so mining, caves, shafts and cliffs can be read at a glance.
//
//   const s = slice.capture(bot, { axis: 'auto', halfW: 24, up: 12, down: 20 })     // plain JSON (see below)
//   fs.writeFileSync('slice.png', slice.render(s, 10))                              // PNG buffer (needs the `canvas` package)
//   node brain/pilot-kit/slice.js in.json out.png [scale]                           // render a saved capture
//
// NO X-RAY. Only cells the bot has a clear line of sight to are drawn (a ray from its eyes reaches the cell without hitting another
// solid block first). Everything else is drawn as unknown hatching. Standing in a tunnel, you see the tunnel; standing on a cliff you see
// the cliff face and the valley; buried ore stays hidden until it is actually exposed in view. This is the same rule as mining/sight.js.
//
// JSON: { v:1, axis:'x'|'z', at, a0, a1, y0, y1, me:{a,y}, palette:[names], rows:[[idx|-1|-2 ...] top row first], mobs:[{name,a,y}], spawn:[[a,y]...], facing }
//   a = the horizontal coordinate along the plane (x when axis is 'z', z when axis is 'x'). idx = palette index, -1 = not in view, -2 = air in view.
const { Vec3 } = require('vec3')
const sight = require('./sight')

const AIRS = new Set(['air', 'cave_air', 'void_air'])

function pickAxis(bot, axis) {
  const yaw = bot.entity.yaw || 0
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw)       // mineflayer yaw 0 faces -z
  const facing = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
  if (axis === 'x' || axis === 'z') return { axis, facing }
  // plane that contains the facing direction: facing east/west runs along x, so the plane is z = const (axis 'z')
  return { axis: (facing === 'east' || facing === 'west') ? 'z' : 'x', facing }
}

function capture(bot, o = {}) {
  const halfW = o.halfW ?? 24, up = o.up ?? 12, down = o.down ?? 20
  const { axis, facing } = pickAxis(bot, o.axis || 'auto')
  const p = bot.entity.position
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z)
  const at = axis === 'z' ? fz : fx
  const here = axis === 'z' ? fx : fz
  const a0 = here - halfW, a1 = here + halfW, y0 = fy - down, y1 = fy + up
  const palette = [], pi = new Map(), rows = [], spawn = []
  const cell = (a, y) => axis === 'z' ? new Vec3(a, y, at) : new Vec3(at, y, a)
  const seen = (pos) => sight.cellView(bot, pos)
  for (let y = y1; y >= y0; y--) {
    const row = []
    for (let a = a0; a <= a1; a++) {
      const pos = cell(a, y)
      const b = bot.blockAt(pos)
      if (!b) { row.push(-1); continue }
      const s = seen(pos)
      if (s === 'hidden') { row.push(-1); continue }
      if (AIRS.has(b.name) || (b.boundingBox === 'empty' && !/water|lava|torch|ladder|vine|rail|sign|button|lever|fire|web/.test(b.name))) {
        row.push(-2)
        if (b.light === 0) { const below = bot.blockAt(pos.offset(0, -1, 0)); if (below && below.boundingBox === 'block') spawn.push([a, y]) }
        continue
      }
      if (!pi.has(b.name)) { pi.set(b.name, palette.length); palette.push(b.name) }
      row.push(pi.get(b.name))
    }
    rows.push(row)
  }
  const mobs = []
  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (!e || e === bot.entity || !e.position || (e.type !== 'hostile' && e.type !== 'player')) continue
    const off = axis === 'z' ? Math.abs(e.position.z - (at + 0.5)) : Math.abs(e.position.x - (at + 0.5))
    if (off > 2.5) continue
    const a = axis === 'z' ? e.position.x : e.position.z
    if (a < a0 || a > a1 + 1 || e.position.y < y0 || e.position.y > y1 + 1) continue
    const vis = sight.pointVisible(bot, e.position.offset(0, 1, 0))
    if (vis) mobs.push({ name: e.username || e.name || e.type, a: Math.round((a - 0.5) * 10) / 10, y: Math.round(e.position.y * 10) / 10 })
  }
  return { v: 1, axis, at, a0, a1, y0, y1, me: { a: here, y: fy }, palette, rows, mobs, spawn, facing }
}

// ---------- rendering ----------
const COL = [
  [/diamond_ore/, [90, 230, 230]], [/emerald_ore/, [40, 200, 90]], [/gold_ore/, [250, 210, 60]], [/iron_ore/, [220, 160, 120]], [/copper_ore/, [200, 120, 70]],
  [/coal_ore/, [40, 40, 40]], [/redstone_ore/, [220, 30, 30]], [/lapis_ore/, [40, 70, 200]],
  [/lava/, [240, 100, 20]], [/water/, [50, 100, 210]], [/grass_block|moss/, [80, 160, 60]], [/leaves/, [40, 120, 40]], [/_log|_wood/, [110, 80, 40]],
  [/sand/, [220, 210, 150]], [/gravel/, [140, 135, 130]], [/dirt|farmland|podzol|mud|rooted/, [130, 90, 60]], [/cobble/, [120, 120, 120]],
  [/deepslate|tuff/, [90, 90, 100]], [/bedrock/, [30, 30, 30]], [/stone|andesite|diorite|granite|basalt|netherrack/, [150, 150, 150]],
  [/planks|_door|_stairs|_slab|fence|ladder/, [170, 130, 80]], [/torch/, [255, 220, 0]], [/chest|barrel/, [150, 80, 0]], [/snow|ice/, [240, 240, 250]],
  [/./, [200, 100, 200]]
]
const color = (n) => (COL.find(([re]) => re.test(n)) || [, [255, 0, 255]])[1]

function render(s, scale = 10) {
  const { createCanvas } = require('canvas')
  const W = s.a1 - s.a0 + 1, H = s.y1 - s.y0 + 1
  const cv = createCanvas(W * scale, H * scale + 44), g = cv.getContext('2d')
  g.fillStyle = '#0d0d12'; g.fillRect(0, 0, cv.width, cv.height)
  const unknown = (x, y) => { g.fillStyle = '#23232b'; g.fillRect(x, y, scale, scale); g.strokeStyle = '#34343f'; g.beginPath(); g.moveTo(x, y + scale); g.lineTo(x + scale, y); g.stroke() }
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const v = s.rows[r][c], x = c * scale, y = r * scale
    if (v === -1) unknown(x, y)
    else if (v === -2) { g.fillStyle = '#0a1018'; g.fillRect(x, y, scale, scale) }
    else { const [R, G, B] = color(s.palette[v]); g.fillStyle = `rgb(${R},${G},${B})`; g.fillRect(x, y, scale, scale); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.strokeRect(x + 0.5, y + 0.5, scale - 1, scale - 1) }
  }
  g.fillStyle = 'rgba(120,0,160,0.55)'
  for (const [a, y] of s.spawn || []) g.fillRect((a - s.a0) * scale, (s.y1 - y) * scale, scale, scale)
  const dot = (a, y, fill, rad) => { g.fillStyle = fill; g.beginPath(); g.arc((a - s.a0 + 0.5) * scale, (s.y1 - y + 0.5) * scale, rad, 0, Math.PI * 2); g.fill() }
  for (const m of s.mobs || []) dot(m.a, m.y, 'rgb(255,60,60)', scale * 0.4)
  dot(s.me.a, s.me.y, 'rgb(255,255,255)', scale * 0.45)
  g.fillStyle = '#fff'; g.fillRect(0, H * scale, W * scale, 44); g.fillStyle = '#000'; g.font = (scale < 8 ? 10 : 13) + 'px sans-serif'
  const axisName = s.axis === 'z' ? `x runs left to right at z=${s.at}` : `z runs left to right at x=${s.at}`
  g.fillText(`vertical slice, ${axisName}, facing ${s.facing}, y ${s.y0}..${s.y1}   white=bot  red=mobs in view  purple=mobs can spawn  hatched=not in line of sight`, 6, H * scale + 17)
  g.fillText(`view range ${s.a0}..${s.a1}   only cells the bot can actually see are drawn (no x-ray)`, 6, H * scale + 35)
  return cv.toBuffer('image/png')
}

module.exports = { capture, render }
module.exports.meta = { name: 'slice', version: 1 }

if (require.main === module) {
  const fs = require('fs')
  const [, , input, output, sc] = process.argv
  if (!input || !output) { console.log('usage: node slice.js in.json out.png [scale]'); process.exit(1) }
  fs.writeFileSync(output, render(JSON.parse(fs.readFileSync(input, 'utf8')), Number(sc) || 10))
  console.log('wrote', output)
}
