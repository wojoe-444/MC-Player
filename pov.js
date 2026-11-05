#!/usr/bin/env node
// First-person view of the bot (OzoGo444), rendered out-of-process.
//
// Connects to the prismarine-viewer socket that join.js already serves on :3007 (the same feed the web page uses),
// rebuilds the nearby world locally and ray-casts a first-person image with real block textures.
// Needs no browser or GPU, never touches the bot process, and works on 1.21.6 (the web page bundle does not).
//
//   node pov.js [out.png] [options]
//     --look north|east|south|west|up|down   absolute direction (default: the way the bot is facing)
//     --turn DEG        turn left (+) / right (-) relative to the chosen direction
//     --pitch DEG       absolute pitch, + looks up (default: the bot's pitch)
//     --at X,Y,Z        render from another feet position inside the loaded area (debug / peek around)
//     --around          2x2 contact sheet: forward, left, back, right (level, unless --pitch; ignores --look/--turn)
//     --w 960 --h 540   output size (per tile with --around; default 960x540)
//     --fov 70          vertical field of view in degrees
//     --range 96        max render distance in blocks
//     --port 3007       viewer port
//     --no-hud          skip the corner text and name tags
//   Prints one JSON line: file, bot position, facing, block under the crosshair and the entities in view.
const fs = require('fs')
const path = require('path')
const { io } = require('socket.io-client')
const { createCanvas, loadImage } = require('canvas')
const { Vec3 } = require('vec3')

const argv = process.argv.slice(2)
const flag = (n) => argv.includes('--' + n)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--around', '--no-hud'].includes(argv[i - 1])))
const OUT = path.resolve(positional[0] || path.join(__dirname, 'pov', 'latest.png'))
const PORT = Number(opt('port', 3007))
const W = Number(opt('w', 960)), H = Number(opt('h', 540))
const FOV = Number(opt('fov', 70)) * Math.PI / 180
const RANGE = Number(opt('range', 96))
const TEX_DIR = path.join(__dirname, 'node_modules/prismarine-viewer/public/textures/1.21.6/blocks')
const EYE = 1.62
const rad = (d) => d * Math.PI / 180

// ---------------------------------------------------------------- feed
function collect() {
  return new Promise((resolve, reject) => {
    const sock = io(`http://localhost:${PORT}`, { transports: ['websocket'], reconnection: false, timeout: 5000 })
    const st = { version: null, raw: [], cam: null, entities: new Map(), updates: [], unloaded: [] }
    let lastChunk = Date.now()
    sock.on('connect_error', e => reject(new Error(`cannot reach the viewer on :${PORT} (is join.js running?): ${e.message}`)))
    sock.on('version', v => { st.version = v })
    sock.on('loadChunk', c => { st.raw.push(c); lastChunk = Date.now() })
    sock.on('unloadChunk', c => st.unloaded.push(c))
    sock.on('blockUpdate', u => st.updates.push(u))
    sock.on('position', p => { st.cam = p })
    sock.on('entity', e => {
      if (e.delete) return void st.entities.delete(e.id)
      const old = st.entities.get(e.id) || {}
      st.entities.set(e.id, { ...old, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) })
    })
    const t0 = Date.now()
    const timer = setInterval(() => {
      const quiet = Date.now() - lastChunk > 600
      if ((st.cam && st.raw.length && quiet) || Date.now() - t0 > 15000) {
        clearInterval(timer); sock.close()
        st.cam && st.raw.length ? resolve(st) : reject(new Error('timed out waiting for position/chunks from the viewer'))
      }
    }, 100)
  })
}

// ---------------------------------------------------------------- world
function buildWorld(st) {
  const Chunk = require('prismarine-chunk')(st.version)
  const world = { chunks: new Map(), ids: new Set() }
  const v = new Vec3(0, 0, 0)
  for (const { x, z, chunk } of st.raw) {
    const col = Chunk.fromJson(chunk)
    const minY = col.minY, height = col.worldHeight
    const arr = new Uint16Array(16 * 16 * height)
    for (let y = 0; y < height; y++) for (let zz = 0; zz < 16; zz++) for (let xx = 0; xx < 16; xx++) {
      v.x = xx; v.y = y + minY; v.z = zz
      const id = col.getBlockStateId(v)
      arr[((y * 16) + zz) * 16 + xx] = id
      world.ids.add(id)
    }
    world.chunks.set(`${x >> 4},${z >> 4}`, { arr, minY, height })
  }
  for (const c of st.unloaded) world.chunks.delete(`${c.x >> 4},${c.z >> 4}`)
  for (const u of st.updates) {
    const c = world.chunks.get(`${u.pos.x >> 4},${u.pos.z >> 4}`)
    if (!c) continue
    const y = u.pos.y - c.minY
    if (y < 0 || y >= c.height) continue
    c.arr[((y * 16) + (u.pos.z & 15)) * 16 + (u.pos.x & 15)] = u.stateId
    world.ids.add(u.stateId)
  }
  return world
}

// ---------------------------------------------------------------- block appearance
const NEVER = new Set(['air', 'cave_air', 'void_air', 'light', 'barrier', 'structure_void', 'moving_piston', 'structure_block'])
const GRASS = [124, 189, 107], FOLIAGE = [89, 174, 48], WATER = [44, 80, 200]
const FIXED_LEAVES = { spruce_leaves: [97, 153, 97], birch_leaves: [128, 167, 85], cherry_leaves: null, azalea_leaves: null, flowering_azalea_leaves: null }
const texCache = new Map()
async function readTex(name) {
  if (texCache.has(name)) return texCache.get(name)
  let out = null
  const file = path.join(TEX_DIR, name + '.png')
  if (fs.existsSync(file)) {
    const img = await loadImage(file)
    const size = img.width // animated strips: first square frame
    const cv = createCanvas(size, size); const cx = cv.getContext('2d')
    cx.drawImage(img, 0, 0, size, size, 0, 0, size, size)
    out = { size, data: cx.getImageData(0, 0, size, size).data }
  }
  texCache.set(name, out)
  return out
}
const exists = (n) => fs.existsSync(path.join(TEX_DIR, n + '.png'))
const first = (list) => list.find(exists)
function baseNames(name) {
  const stripped = name.replace(/^(waxed_|stripped_)/, '')
  const m = stripped.match(/^(.*?)_(stairs|slab|wall|fence_gate|fence|button|pressure_plate|sign|wall_sign|hanging_sign|door|trapdoor)$/)
  const b = m ? m[1] : stripped
  return [name, stripped, b, b + '_planks', b + 's', b + '_block', b.replace(/_brick$/, '_bricks'), b + '_log', b.replace(/_wood$/, '_log'), b.replace(/_hyphae$/, '_stem')]
}
function pickTextures(name) {
  const cands = baseNames(name)
  const any = (suffixes) => first(cands.flatMap(c => suffixes.map(s => c + s)))
  const side = any(['_side', '']) || any(['_top', '_front'])
  const up = any(['_top', '']) || side
  const down = any(['_bottom', '_top', '']) || side
  return { up, down, side }
}
const hashColor = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return [80 + (h & 127), 80 + ((h >> 7) & 127), 80 + ((h >> 14) & 127)] }

async function prepareBlocks(world, mcData) {
  const shapesTable = mcData.blockCollisionShapes
  const info = new Map()
  for (const id of world.ids) {
    const b = mcData.blocksByStateId[id]
    const name = b ? b.name : 'unknown'
    if (!b || NEVER.has(name)) { info.set(id, { kind: 0 }); continue }
    if (name === 'water') { info.set(id, { kind: 4 }); continue }
    let d = { kind: 1, name, tint: null, tex: {}, fallback: hashColor(name) }
    if (name === 'lava') d.lava = true
    if (b.boundingBox === 'empty' && name !== 'lava') d.kind = 3
    else if (shapesTable && shapesTable.blocks[name] !== undefined) {
      const s = shapesTable.blocks[name]
      const sid = Array.isArray(s) ? s[id - b.minStateId] : s
      const boxes = shapesTable.shapes[sid] || []
      const isCube = boxes.length === 1 && boxes[0].every((v, i) => v === [0, 0, 0, 1, 1, 1][i])
      if (!isCube) { d.kind = 2; d.boxes = boxes; if (!boxes.length) d.kind = 3 }
    }
    const names = name === 'lava' ? { up: 'lava_still', down: 'lava_still', side: 'lava_still' } : pickTextures(name)
    for (const k of ['up', 'down', 'side']) d.tex[k] = names[k] ? await readTex(names[k]) : null
    if (name === 'grass_block') {
      d.tex.up = await readTex('grass_block_top'); d.tex.side = await readTex('grass_block_side'); d.tex.down = await readTex('dirt')
      d.overlay = await readTex('grass_block_side_overlay'); d.tint = 'grass'; d.tintFaces = 'up'
    } else if (/(^|_)(short_grass|tall_grass|fern|large_fern|sugar_cane|vine)$/.test(name) || name === 'grass') d.tint = 'grass'
    else if (name.endsWith('_leaves')) d.tint = name in FIXED_LEAVES ? (FIXED_LEAVES[name] ? 'fixed' : null) : 'foliage'
    if (d.tint === 'fixed') d.fixed = FIXED_LEAVES[name]
    if (d.kind === 3 && !(d.tex.side || d.tex.up)) d.kind = 0 // invisible helper-type blocks with no texture
    info.set(id, d)
  }
  return info
}

// ---------------------------------------------------------------- render
const SHADE = { up: 1.0, down: 0.5, x: 0.8, z: 0.65 }
const SKY_TOP = [112, 165, 255], SKY_HOR = [196, 218, 255]
function sampleTex(tex, u, v) {
  const s = tex.size
  const x = Math.min(s - 1, Math.max(0, (u * s) | 0)), y = Math.min(s - 1, Math.max(0, (v * s) | 0))
  const i = (y * s + x) * 4
  return [tex.data[i], tex.data[i + 1], tex.data[i + 2], tex.data[i + 3]]
}
function tintOf(d) { return d.tint === 'grass' ? GRASS : d.tint === 'foliage' ? FOLIAGE : d.tint === 'fixed' ? d.fixed : null }

function rayBox(o, dx, dy, dz, b) { // returns [t, axis, sign] or null; b = [x0,y0,z0,x1,y1,z1] in world coords
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 1
  const O = [o[0], o[1], o[2]], D = [dx, dy, dz]
  for (let a = 0; a < 3; a++) {
    if (Math.abs(D[a]) < 1e-9) { if (O[a] < b[a] || O[a] > b[a + 3]) return null; continue }
    let t1 = (b[a] - O[a]) / D[a], t2 = (b[a + 3] - O[a]) / D[a], s = -1
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1 }
    if (t1 > tmin) { tmin = t1; axis = a; sign = s }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }
  if (tmax < 0) return null
  return [Math.max(tmin, 0), axis, sign]
}

function entityStyle(e) {
  if (e.username) return { color: [30, 150, 160], h: 1.8, w: 0.6, label: e.username }
  const name = e.name || 'mob'
  const known = { zombie: [60, 130, 70], creeper: [60, 190, 60], skeleton: [200, 200, 200], spider: [70, 50, 40], enderman: [20, 20, 20], cow: [90, 60, 40], pig: [240, 160, 160], sheep: [235, 235, 235], chicken: [240, 240, 240], bat: [60, 45, 35], item: [255, 220, 60], experience_orb: [140, 255, 80] }
  return { color: known[name] || hashColor(name), h: e.height || 1, w: e.width || 0.6, label: name === 'item' || name === 'experience_orb' ? null : name }
}

function render(world, info, mcData, ents, cam, yaw, pitch, width, height) {
  const cv = createCanvas(width, height), cx = cv.getContext('2d')
  const img = cx.createImageData(width, height)
  const px = img.data
  const o = [cam.x, cam.y + EYE, cam.z]
  const fx = -Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch)
  // right = forward x up (normalised), up = right x forward
  let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl
  const upx = -rz * fy, upy = rz * fx - rx * fz, upz = rx * fy
  const tanY = Math.tan(FOV / 2), tanX = tanY * width / height
  const boxes = [...ents.values()].map(e => ({ e, s: entityStyle(e) })).filter(b => b.e.pos).map(b => ({ ...b, box: [b.e.pos.x - b.s.w / 2, b.e.pos.y, b.e.pos.z - b.s.w / 2, b.e.pos.x + b.s.w / 2, b.e.pos.y + b.s.h, b.e.pos.z + b.s.w / 2] }))
  let center = null

  const getId = (x, y, z) => {
    const c = world.chunks.get(`${x >> 4},${z >> 4}`)
    if (!c) return -1
    const yy = y - c.minY
    if (yy < 0 || yy >= c.height) return 0
    return c.arr[((yy * 16) + (z & 15)) * 16 + (x & 15)]
  }

  for (let j = 0; j < height; j++) {
    const sy = (1 - 2 * (j + 0.5) / height) * tanY
    for (let i = 0; i < width; i++) {
      const sx = (2 * (i + 0.5) / width - 1) * tanX
      let dx = fx + rx * sx + upx * sy, dy = fy + upy * sy, dz = fz + rz * sx + upz * sy
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl
      const hit = castRay(o, dx, dy, dz)
      let r, g, b
      if (hit) { [r, g, b] = hit.rgb } else {
        const t = Math.min(1, Math.max(0, dy * 2)); r = SKY_HOR[0] + (SKY_TOP[0] - SKY_HOR[0]) * t; g = SKY_HOR[1] + (SKY_TOP[1] - SKY_HOR[1]) * t; b = SKY_HOR[2] + (SKY_TOP[2] - SKY_HOR[2]) * t
      }
      const k = (j * width + i) * 4
      px[k] = r; px[k + 1] = g; px[k + 2] = b; px[k + 3] = 255
      if (i === (width >> 1) && j === (height >> 1)) center = hit
    }
  }

  function castRay(o, dx, dy, dz, skipEnt) {
    let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2])
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1
    const tdx = Math.abs(1 / (dx || 1e-12)), tdy = Math.abs(1 / (dy || 1e-12)), tdz = Math.abs(1 / (dz || 1e-12))
    let tx = ((dx > 0 ? x + 1 : x) - o[0]) / (dx || 1e-12), ty = ((dy > 0 ? y + 1 : y) - o[1]) / (dy || 1e-12), tz = ((dz > 0 ? z + 1 : z) - o[2]) / (dz || 1e-12)
    let t = 0, face = 'y', waterT = 0, inWater = false, waterStart = 0
    let best = null
    // nearest entity along the ray (checked against the block hit afterwards)
    let ent = null
    for (const b of skipEnt ? [] : boxes) {
      const h = rayBox(o, dx, dy, dz, b.box)
      if (h && h[0] < RANGE && (!ent || h[0] < ent.t)) ent = { t: h[0], axis: h[1], b }
    }
    const finish = (res) => {
      // res: {t, rgb, ...} for a block hit or null for sky
      let out = res
      if (ent && (!res || ent.t < res.t)) {
        const sh = ent.axis === 1 ? 1 : ent.axis === 0 ? 0.8 : 0.65
        let col = ent.b.s.color
        if (ent.b.e.username) { const f = (o[1] + dy * ent.t - ent.b.box[1]) / ent.b.s.h; col = f < 0.42 ? [50, 55, 150] : f < 0.83 ? [0, 150, 150] : [190, 140, 110] }
        out = { t: ent.t, rgb: col.map(c => c * sh), entity: ent.b }
      }
      if (out && waterT > 0) { // blend water absorbed in front of the hit
        const a = Math.min(0.85, 1 - Math.exp(-0.2 * waterT))
        out = { ...out, rgb: out.rgb.map((c, n) => c * (1 - a) + WATER[n] * a) }
      } else if (!out && waterT > 0) {
        const a = Math.min(0.85, 1 - Math.exp(-0.2 * waterT))
        out = { t: RANGE, rgb: SKY_HOR.map((c, n) => c * (1 - a) + WATER[n] * a), sky: true }
        return out
      }
      if (out && out.t > RANGE * 0.6) { // fog
        const f = Math.min(1, (out.t - RANGE * 0.6) / (RANGE * 0.4))
        out = { ...out, rgb: out.rgb.map((c, n) => c * (1 - f) + SKY_HOR[n] * f) }
      }
      return out
    }
    for (let steps = 0; steps < RANGE * 3; steps++) {
      const id = getId(x, y, z)
      if (id === -1) return finish(best) // unloaded chunk: stop
      if (id > 0) {
        const d = info.get(id)
        if (d && d.kind === 4) { // water: accumulate path length through it
          if (!inWater) { inWater = true; waterStart = t }
        } else if (inWater) { waterT += t - waterStart; inWater = false }
        if (d && d.kind === 1) {
          const dir = face === 'y' ? (sy > 0 ? 'down' : 'up') : face
          const hx = o[0] + dx * t, hy = o[1] + dy * t, hz = o[2] + dz * t
          const px_ = shadeTex(d, dir, hx, hy, hz, x, y, z)
          if (px_) return finish({ t, rgb: px_, name: d.name, pos: [x, y, z], face: dir })
        } else if (d && d.kind === 2) {
          let bestT = Infinity, bi = null
          for (const bx of d.boxes) {
            const h = rayBox(o, dx, dy, dz, [x + bx[0], y + bx[1], z + bx[2], x + bx[3], y + bx[4], z + bx[5]])
            if (h && h[0] < bestT) { bestT = h[0]; bi = h }
          }
          if (bi) {
            const axisName = bi[1] === 1 ? (bi[2] > 0 ? 'up' : 'down') : (bi[1] === 0 ? 'x' : 'z')
            const hx = o[0] + dx * bestT, hy = o[1] + dy * bestT, hz = o[2] + dz * bestT
            const rgb = shadeTex(d, axisName, hx, hy, hz, x, y, z)
            if (rgb) return finish({ t: bestT, rgb, name: d.name, pos: [x, y, z], face: axisName })
          }
        } else if (d && d.kind === 3) { // cross-shaped plants / torches
          let bt = Infinity, brgb = null
          for (const diag of [0, 1]) {
            // plane z - z0 = (x - x0) (diag 0) or z - z0 = 1 - (x - x0) (diag 1)
            const den = diag === 0 ? (dz - dx) : (dz + dx)
            if (Math.abs(den) < 1e-9) continue
            const lx0 = o[0] - x, lz0 = o[2] - z
            const t2 = diag === 0 ? (lx0 - lz0) / (dz - dx) : (1 - lx0 - lz0) / (dx + dz)
            if (!(t2 > 0) || t2 >= bt) continue
            const lx = lx0 + dx * t2, ly = o[1] + dy * t2 - y, lz = lz0 + dz * t2
            if (lx < 0 || lx > 1 || lz < 0 || lz > 1 || ly < 0 || ly > 1) continue
            const tex = d.tex.side || d.tex.up
            if (!tex) continue
            const s = sampleTex(tex, lx, 1 - ly)
            if (s[3] < 128) continue
            const tn = tintOf(d)
            bt = t2; brgb = [s[0] * (tn ? tn[0] / 255 : 1) * 0.9, s[1] * (tn ? tn[1] / 255 : 1) * 0.9, s[2] * (tn ? tn[2] / 255 : 1) * 0.9]
          }
          if (brgb) { best = null; const res = { t: bt, rgb: brgb, name: d.name, pos: [x, y, z], face: 'plant' }; return finish(res) }
        }
      } else if (inWater) { waterT += t - waterStart; inWater = false }
      // step
      if (tx < ty && tx < tz) { t = tx; tx += tdx; x += sx; face = 'x' }
      else if (ty < tz) { t = ty; ty += tdy; y += sy; face = 'y' }
      else { t = tz; tz += tdz; z += sz; face = 'z' }
      if (t > RANGE) break
    }
    return finish(best)
  }
  function shadeTex(d, dir, hx, hy, hz, x, y, z) {
    const key = dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'side'
    const tex = d.tex[key]
    let u, v
    if (dir === 'up' || dir === 'down') { u = hx - Math.floor(hx); v = hz - Math.floor(hz) }
    else if (dir === 'x') { u = hz - Math.floor(hz); v = 1 - (hy - Math.floor(hy)) }
    else { u = hx - Math.floor(hx); v = 1 - (hy - Math.floor(hy)) }
    const sh = dir === 'up' ? SHADE.up : dir === 'down' ? SHADE.down : dir === 'x' ? SHADE.x : SHADE.z
    if (!tex) return d.fallback.map(c => c * sh)
    let s = sampleTex(tex, u, v)
    if (s[3] < 128) return null // transparent pixel (leaf holes, glass): let the ray continue
    let rgb = [s[0], s[1], s[2]]
    const tn = tintOf(d)
    if (tn && (!d.tintFaces || d.tintFaces === key)) rgb = rgb.map((c, n) => c * tn[n] / 255)
    if (d.overlay && key === 'side') {
      const ov = sampleTex(d.overlay, u, v)
      if (ov[3] > 128) rgb = [ov[0] * GRASS[0] / 255, ov[1] * GRASS[1] / 255, ov[2] * GRASS[2] / 255]
    }
    if (d.lava) return rgb
    return rgb.map(c => c * sh)
  }

  cx.putImageData(img, 0, 0)
  // name tags: project entity heads to screen
  const tags = []
  for (const b of boxes) {
    const wx = b.e.pos.x - o[0], wy = b.e.pos.y + b.s.h + 0.3 - o[1], wz = b.e.pos.z - o[2]
    const depth = wx * fx + wy * fy + wz * fz
    if (depth < 0.5 || depth > 48 || !b.s.label) continue
    const sx_ = (wx * rx + wz * rz) / depth / tanX, sy_ = (wx * upx + wy * upy + wz * upz) / depth / tanY
    if (Math.abs(sx_) > 1 || Math.abs(sy_) > 1) continue
    const X = (sx_ + 1) / 2 * width, Y = (1 - sy_) / 2 * height
    const mid = [b.e.pos.x - o[0], b.e.pos.y + b.s.h / 2 - o[1], b.e.pos.z - o[2]], ml = Math.hypot(...mid)
    const wall = castRay(o, mid[0] / ml, mid[1] / ml, mid[2] / ml, true)
    if (wall && wall.t < ml - 0.8) continue // behind a block
    tags.push({ X, Y, label: b.s.label, depth, e: b.e, isPlayer: !!b.e.username })
  }
  return { cv, cx, center, tags }
}

// ---------------------------------------------------------------- main
;(async () => {
  const T0 = Date.now(); const lap = (m) => { if (process.env.POV_TIMING) console.error(m, Date.now() - T0) }
  const st = await collect(); lap('collect')
  const mcData = require('minecraft-data')(st.version)
  const world = buildWorld(st); lap('world')
  const info = await prepareBlocks(world, mcData); lap('blocks')
  let cam = st.cam.pos
  if (opt('at')) { const [ax, ay, az] = opt('at').split(',').map(Number); cam = { x: ax, y: ay, z: az } }
  const baseYaw = st.cam.yaw, basePitch = st.cam.pitch || 0
  const dirs = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }
  let yaw = baseYaw, pitch = basePitch
  const look = opt('look')
  if (look === 'up') pitch = rad(75); else if (look === 'down') pitch = rad(-75); else if (look in dirs) yaw = dirs[look]
  else if (look) throw new Error(`unknown --look ${look}`)
  if (opt('turn') !== undefined) yaw += rad(Number(opt('turn')))
  if (opt('pitch') !== undefined) pitch = rad(Number(opt('pitch')))

  const hud = !flag('no-hud')
  const compass = (y) => ['north', 'west', 'south', 'east'][Math.round(((y % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4]
  const decorate = (r, w, h, label) => {
    const { cx, tags } = r
    if (!hud) return
    cx.font = `${Math.round(h / 38)}px sans-serif`; cx.textAlign = 'center'
    for (const t of tags) {
      const text = t.isPlayer ? t.label : `${t.label}`
      const tw = cx.measureText(text).width
      cx.fillStyle = 'rgba(0,0,0,0.5)'; cx.fillRect(t.X - tw / 2 - 3, t.Y - h / 38, tw + 6, h / 30)
      cx.fillStyle = t.isPlayer ? '#ffffff' : '#dddddd'; cx.fillText(text, t.X, t.Y)
    }
    cx.strokeStyle = 'rgba(255,255,255,0.8)'; cx.lineWidth = 2
    cx.beginPath(); cx.moveTo(w / 2 - 8, h / 2); cx.lineTo(w / 2 + 8, h / 2); cx.moveTo(w / 2, h / 2 - 8); cx.lineTo(w / 2, h / 2 + 8); cx.stroke()
    cx.textAlign = 'left'; cx.font = `${Math.round(h / 34)}px monospace`
    const text = `${label}  x${cam.x.toFixed(1)} y${cam.y.toFixed(1)} z${cam.z.toFixed(1)}`
    cx.fillStyle = 'rgba(0,0,0,0.55)'; cx.fillRect(6, 6, cx.measureText(text).width + 12, h / 28)
    cx.fillStyle = '#fff'; cx.fillText(text, 12, 6 + h / 34)
  }

  let outCanvas, summary
  const views = flag('around') ? [['forward', 0], ['left', 90], ['back', 180], ['right', -90]] : [[compass(yaw), 0]]
  const results = views.map(([label, off]) => {
    const r = render(world, info, mcData, st.entities, cam, (flag('around') ? baseYaw : yaw) + rad(off), flag('around') ? (opt('pitch') !== undefined ? pitch : 0) : pitch, W, H)
    decorate(r, W, H, flag('around') ? `OzoGo444 ${label} (${compass(baseYaw + rad(off))})` : `OzoGo444 facing ${compass(yaw)}`)
    return r
  })
  if (results.length === 1) outCanvas = results[0].cv
  else {
    outCanvas = createCanvas(W * 2, H * 2); const oc = outCanvas.getContext('2d')
    results.forEach((r, n) => oc.drawImage(r.cv, (n % 2) * W, Math.floor(n / 2) * H))
  }
  lap('render')
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, outCanvas.toBuffer('image/png'))
  const c = results[0].center
  const seen = results[0].tags.map(t => ({ name: t.label, dist: Number(t.depth.toFixed(1)) })).sort((a, b) => a.dist - b.dist).slice(0, 12)
  console.log(JSON.stringify({
    file: OUT, version: st.version,
    bot: { x: +cam.x.toFixed(2), y: +cam.y.toFixed(2), z: +cam.z.toFixed(2), yawDeg: +(baseYaw * 180 / Math.PI).toFixed(1), pitchDeg: +(basePitch * 180 / Math.PI).toFixed(1), facing: compass(baseYaw) },
    lookingAt: c && c.name ? { block: c.name, at: c.pos, face: c.face, dist: +c.t.toFixed(1) } : (c && c.entity ? { entity: c.entity.s.label, dist: +c.t.toFixed(1) } : null),
    entitiesInView: seen, chunks: world.chunks.size
  }))
})().catch(e => { console.error('POV_ERROR', e.message); process.exit(1) })
