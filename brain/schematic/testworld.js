// brain/schematic/testworld.js: a catalog schematic as a Minecraft 1.21.6 singleplayer save: a creative superflat world (grass, or void) in daylight with the build pasted at spawn.
// Writes the region files itself (anvil.js), so no game or server is needed and the existing saves are never touched (an existing target folder is refused unless `overwrite`
// is set, and then only a folder this tool made, marked by `.schematic-test-world`).
//
//   buildWorld(schematic, { savesDir, name, kind: 'grass' | 'void', overwrite })  -> { saveDir, name, chunks, placed, spawn, origin, size }
//
// The build's centre is at world x=0, z=0. On grass its lowest layer sits on the grass (y -60); in the void it sits at y=64 on a small platform next to spawn.
// The player spawns outside the build on the north side, facing it. A schematic keeps only some block properties, so `settle` adds fence connections, hanging lanterns
// and persistent leaves (see settle.js); blocks entities (chest contents, sign text) are not in a schematic and are left empty.
'use strict'
const fs = require('fs')
const path = require('path')
const F = require('./format')
const B = require('./blocks')
const A = require('./anvil')
const { settle } = require('./settle')

const MARK = '.schematic-test-world'
const defaultSavesDir = () => process.env.MC_SAVES_DIR || path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), '.minecraft', 'saves')
const safeName = (n) => String(n).replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim()

// the blocks of a schematic as states, one per palette entry (null = leave the world as it is). scenery is placed too: it is the ground the build stands on.
function stateOfEntry(e) {
  if (!e || e.role === 'any' || e.role === 'air') return null
  if (e.role === 'water' || e.role === 'lava') return { name: e.role, props: { level: String(e.level != null ? e.level : 0) } }
  return { name: e.block, props: { ...(e.props || {}) } }
}

function buildWorld(s, opt = {}) {
  if (!s.raw) s = F.upgrade(s)
  const kind = opt.kind === 'void' ? 'void' : 'grass'
  const savesDir = opt.savesDir || defaultSavesDir(), name = safeName(opt.name || `Test - ${s.name}`)
  if (!name) throw new Error('empty world name')
  const saveDir = path.join(savesDir, name)
  if (fs.existsSync(saveDir)) {
    if (!opt.overwrite || !fs.existsSync(path.join(saveDir, MARK))) throw new Error(`"${saveDir}" already exists${opt.overwrite ? ' and was not made by this tool' : ''}; pick another --name${fs.existsSync(path.join(saveDir, MARK)) ? ' or pass --overwrite' : ''}`)
    fs.rmSync(saveDir, { recursive: true, force: true })
  }
  const [W, H, D] = s.raw ? [s.raw.W, s.raw.H, s.raw.D] : s.size
  // opt.surface = the layer of the schematic that is the first one above the ground (an underground build: a mine, a bunker, "Deep Node"). The world's ground is then deep stone
  // up to the layer below it, and the rooms of the build are cut out of that stone (see carve below). Otherwise the build sits on a thin flat ground (grass at y -61).
  const surface = kind === 'grass' && opt.surface != null ? Math.max(1, Math.min(H, opt.surface | 0)) : null
  const y0 = opt.y != null ? opt.y : kind === 'void' ? 64 : surface != null ? -60 : -60
  const groundTop = surface != null ? y0 + surface - 1 : -61  // the grass layer of the flat preset: bedrock -64, dirt 2, grass; stone fills between when the ground is deeper
  if (y0 < A.MIN_Y || y0 + H > A.MIN_Y + A.HEIGHT) throw new Error(`the build is ${H} blocks tall and does not fit between y ${A.MIN_Y} and ${A.MIN_Y + A.HEIGHT - 1} when its bottom is at y ${y0}`)
  const x0 = opt.x != null ? opt.x : -(W >> 1), z0 = opt.z != null ? opt.z : -(D >> 1)

  // the box of whole chunks: the build plus a chunk of ground (grass) or nothing (void) on every side; the platform and spawn sit north of the build
  const margin = 2
  const cx0 = (x0 >> 4) - margin, cx1 = ((x0 + W - 1) >> 4) + margin, cz0 = ((z0 - 12) >> 4) - 1, cz1 = ((z0 + D - 1) >> 4) + margin
  const nx = cx1 - cx0 + 1, nz = cz1 - cz0 + 1, X = nx * 16, Z = nz * 16
  const cells = new Uint16Array(X * Z * A.HEIGHT)
  const states = [{ name: 'air', props: {} }], ids = new Map([[A.stateKey('air'), 0]])
  const intern = (n, props) => { const k = A.stateKey(B.strip(n), props); if (!ids.has(k)) { ids.set(k, states.length); states.push({ name: B.strip(n), props: props || {} }) } return ids.get(k) }
  const idx = (x, y, z) => (y - A.MIN_Y) * Z * X + (z - cz0 * 16) * X + (x - cx0 * 16)

  if (kind === 'grass') {
    const bedrock = intern('bedrock'), dirt = intern('dirt'), stone = intern('stone'), grass = intern('grass_block', { snowy: 'false' })
    for (let z = cz0 * 16; z < (cz1 + 1) * 16; z++) for (let x = cx0 * 16; x < (cx1 + 1) * 16; x++) for (let y = -64; y <= groundTop; y++) cells[idx(x, y, z)] = y === -64 ? bedrock : y === groundTop ? grass : y >= groundTop - 2 ? dirt : stone
  }
  let spawnX = x0 + (W >> 1), spawnZ = z0 - 8
  let spawnY = groundTop + 1
  if (kind === 'void') {   // a small stone platform to stand on
    const plat = intern('smooth_stone'); spawnY = y0
    for (let z = spawnZ - 4; z <= spawnZ + 4; z++) for (let x = spawnX - 4; x <= spawnX + 4; x++) cells[idx(x, y0 - 1, z)] = plat
  }

  // the build, cell by cell on a local grid first so settle() sees the neighbours
  const lgrid = { W, H, D, cells: new Uint16Array(W * H * D), states }
  let placed = 0
  if (s.raw) {   // a .schem read as it is: every block state with all its properties
    const map = s.raw.states.map(st => B.isAir(st.name) ? 0 : intern(st.name, st.props))
    for (let i = 0; i < s.raw.cells.length; i++) { const g = map[s.raw.cells[i]]; if (g) { lgrid.cells[i] = g; placed++ } }
  } else {
    const local = F.cellsOf(s), pal = s.palette.map(stateOfEntry)
    for (let i = 0; i < local.length; i++) { const st = pal[local[i]]; if (st) { lgrid.cells[i] = intern(st.name, st.props); placed++ } }
  }
  const settled = settle(lgrid, intern)
  // carve: in an underground build the air of the file is both "a room" and "the rock around it" (a .schem cannot tell them apart). The rock is the air that reaches the sides or
  // the bottom of the box without leaving the underground layers; every other open cell below the surface is a room and is cut out of the stone.
  let carved = 0
  const carve = surface != null ? new Uint8Array(W * H * D) : null
  if (carve) {
    const rock = opt.rock && opt.rock.length === W * H * D ? opt.rock : new Uint8Array(W * H * D), q = new Int32Array(W * H * D); let qh = 0, qt = 0
    const push = (x, y, z) => { const k = x + W * (z + D * y); if (!lgrid.cells[k] && !rock[k]) { rock[k] = 1; q[qt++] = k } }
    if (!(opt.rock && opt.rock.length === W * H * D)) for (let y = 0; y < surface; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (x === 0 || z === 0 || x === W - 1 || z === D - 1 || y === 0) push(x, y, z)
    while (qh < qt) {   // (skipped when the rock is given: qh = qt = 0)
      const k = q[qh++], x = k % W, z = Math.floor(k / W) % D, y = Math.floor(k / (W * D))
      if (x > 0) push(x - 1, y, z); if (x < W - 1) push(x + 1, y, z); if (z > 0) push(x, y, z - 1); if (z < D - 1) push(x, y, z + 1); if (y > 0) push(x, y - 1, z); if (y < surface - 1) push(x, y + 1, z)
    }
    for (let y = 0; y < (opt.rock ? surface - 1 : surface); y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) { const k = x + W * (z + D * y); if (!lgrid.cells[k] && !rock[k]) { carve[k] = 1; carved++ } }
    // spawn at the surface just north of whatever the build puts above the ground (an entrance house), not 140 blocks from it
    let zmin = D, xmin = W, xmax = -1
    for (let y = surface; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (lgrid.cells[x + W * (z + D * y)]) { zmin = Math.min(zmin, z); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x) }
    if (xmax >= 0) { spawnX = x0 + ((xmin + xmax) >> 1); spawnZ = z0 + zmin - 6 }
  }
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const k = x + W * (z + D * y), g = lgrid.cells[k]
    if (g || (carve && carve[k]) || (!s.raw && s.mode === 'functional' && s.palette[F.cellsOf(s)[k]].role === 'air')) cells[idx(x0 + x, y0 + y, z0 + z)] = g
  }

  fs.mkdirSync(saveDir, { recursive: true })
  const chunks = A.writeChunks(saveDir, { cx0, cz0, nx, nz, cells, states }, { biome: kind === 'void' ? 'minecraft:the_void' : 'minecraft:plains' })
  A.writeLevelDat(saveDir, { name, kind, groundTop, spawn: [spawnX, spawnY, spawnZ], time: 6000, seed: opt.seed || 0n })
  fs.writeFileSync(path.join(saveDir, MARK), `made by tools/schematic.js world from schematic "${s.id}" (${new Date().toISOString()})\n`)
  return { saveDir, name, kind, chunks, placed, settled, spawn: [spawnX, spawnY, spawnZ], origin: [x0, y0, z0], size: [W, H, D], carved, groundTop }
}

// The generator's own viewer page (deep_node_phase2_viewer.html) embeds which air cells are solid rock around the build ({ "rock": { "first": 0|1, "runs": base64 of uint32 run lengths } },
// cells in file order). That is the exact answer to "room or rock" that a .schem does not carry. -> Uint8Array(W*H*D) or null
function readRockMask(htmlFile, total) {
  const m = /"rock"\s*:\s*\{\s*"first"\s*:\s*([01])\s*,\s*"runs"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(fs.readFileSync(htmlFile, 'utf8'))
  if (!m) return null
  const b = Buffer.from(m[2], 'base64'), out = new Uint8Array(total); let v = +m[1], p = 0
  for (let i = 0; i + 3 < b.length; i += 4) { const r = b.readUInt32LE(i); if (v) out.fill(1, p, Math.min(total, p + r)); p += r; v ^= 1 }
  return p === total ? out : null
}

// a Sponge .schem as it is, without the roles-and-KEEP-properties step of a catalog schematic: nothing is lost (bed halves, hanging lanterns, wall connections, waterlogging)
async function readSchemRaw(file, meta = {}) {
  const nbt = require('prismarine-nbt'), { parseState, decodeVarints } = require('./sponge')
  const { parsed } = await nbt.parse(fs.readFileSync(file)), root = nbt.simplify(parsed), r = root.Schematic || root
  const W = r.Width, H = r.Height, D = r.Length, pal = r.Palette || (r.Blocks && r.Blocks.Palette), data = r.BlockData || (r.Blocks && r.Blocks.Data)
  if (!pal || !data || !(W > 0 && H > 0 && D > 0)) throw new Error('not a Sponge schematic (no Palette / BlockData / size)')
  const states = []
  for (const [st, i] of Object.entries(pal)) states[i] = parseState(st)
  const md = r.Metadata || {}
  return { id: meta.id || path.basename(file, path.extname(file)), name: meta.name || md.Name || path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), mode: 'aesthetic', size: [W, H, D], raw: { W, H, D, states, cells: decodeVarints(data, W * H * D) } }
}

module.exports = { buildWorld, readSchemRaw, readRockMask, stateOfEntry, defaultSavesDir, MARK }
