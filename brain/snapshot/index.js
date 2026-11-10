// brain/snapshot: an incident becomes a replayable scenario (docs/HILLCLIMB-INSIGHTS.md, items 1 and 5).
//
//   capture(bot, { flag, dir, commit, keep })   on a high flag: write brain/state/snapshots/<id>.json  {position, yaw, held slot, the bag by window slot,
//                                                the step and task, time of day, mobs, and the blocks within RADIUS (palette + run-length cells)}
//   buildCommands(snapshot, { shift, ... })     pure: the trial-server commands that rebuild it (boxes merged greedily so a 25-block cube is a few dozen commands)
//   decodeCells(snapshot)                       pure: back to a Map of "x,y,z" -> block string, for verification
//
// The fail test of a scenario built from a snapshot is the detector that fired (the flag kind in the snapshot); the pass test is the step's own goal plus that detector staying quiet.
// tools/snapshot-rebuild.js prints or runs the commands on a trial server. Capture is an observer: it reads the world the bot already has loaded and never asks for more.
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const RADIUS = 12
const VERSION = 1
const SKIP_PROPS = { waterlogged: 'false', snowy: 'false', persistent: undefined, distance: undefined, powered: 'false' }

function blockString(b) {
  if (!b) return null
  let props = {}
  try { props = (b.getProperties ? b.getProperties() : b._properties) || {} } catch { props = {} }
  const keep = Object.keys(props).filter(k => !(k in SKIP_PROPS) || (SKIP_PROPS[k] !== undefined && String(props[k]) !== SKIP_PROPS[k])).sort()
  return keep.length ? `${b.name}[${keep.map(k => `${k}=${props[k]}`).join(',')}]` : b.name
}

// cells in order x fastest, then z, then y: run-length encoded as [paletteIndex, runLength, ...]. Unloaded cells are palette entry "?" (skipped on rebuild).
function encodeWorld(bot, center, radius = RADIUS) {
  const [cx, cy, cz] = center, size = radius * 2 + 1
  const palette = [], index = new Map(), runs = []
  const idx = (s) => { let i = index.get(s); if (i === undefined) { i = palette.length; palette.push(s); index.set(s, i) } return i }
  for (let y = 0; y < size; y++) for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    let s = '?'
    try { s = blockString(bot.blockAt(new Vec3(cx - radius + x, cy - radius + y, cz - radius + z))) || '?' } catch { /* unloaded */ }
    const i = idx(s), n = runs.length
    if (n && runs[n - 2] === i) runs[n - 1]++; else runs.push(i, 1)
  }
  return { radius, origin: [cx - radius, cy - radius, cz - radius], size, palette, runs }
}

function decodeCells(snap) {
  const w = snap.world, out = new Map(), size = w.size
  let pos = 0
  for (let r = 0; r < w.runs.length; r += 2) {
    const s = w.palette[w.runs[r]]
    for (let k = 0; k < w.runs[r + 1]; k++, pos++) {
      if (s === '?') continue
      const x = pos % size, z = Math.floor(pos / size) % size, y = Math.floor(pos / (size * size))
      out.set(`${w.origin[0] + x},${w.origin[1] + y},${w.origin[2] + z}`, s)
    }
  }
  return out
}

function describeBag(bot) {
  const out = []
  const slots = (bot.inventory && bot.inventory.slots) || []
  slots.forEach((it, slot) => { if (it) out.push({ slot, name: it.name, count: it.count }) })
  return out
}

function capture(bot, ctx = {}) {
  const e = bot.entity; if (!e) return null
  const t = ctx.now ? ctx.now() : Date.now()
  const p = e.position, center = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  const mobs = []
  try { for (const m of Object.values(bot.entities || {})) if (m && m !== e && m.position && m.type !== 'player' && m.name && m.name !== 'item' && m.position.distanceTo(p) <= 20) mobs.push({ name: m.name, x: +m.position.x.toFixed(2), y: +m.position.y.toFixed(2), z: +m.position.z.toFixed(2) }) } catch { /* ignore */ }
  const ap = bot._ap && bot._ap.G
  const snap = {
    v: VERSION, id: `s${Math.floor(t / 1000)}-${(ctx.flag && ctx.flag.kind) || 'manual'}`, at: new Date(t).toISOString(), t,
    flag: ctx.flag ? { kind: ctx.flag.kind, sev: ctx.flag.sev, msg: ctx.flag.msg, data: ctx.flag.data } : null,
    commit: ctx.commit || (bot._runInfo && bot._runInfo.commit && bot._runInfo.commit()) || null,
    bot: { name: bot.username, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), yaw: +(e.yaw || 0).toFixed(3), pitch: +(e.pitch || 0).toFixed(3), onGround: !!e.onGround, health: bot.health, food: bot.food, dimension: bot.game && bot.game.dimension, gameMode: bot.game && bot.game.gameMode },
    timeOfDay: bot.time && bot.time.timeOfDay, day: bot.time && bot.time.day,
    quickBarSlot: bot.quickBarSlot, held: bot.heldItem ? bot.heldItem.name : null,
    step: ap ? ap.lastStep : null, task: ctx.task || null,
    bag: describeBag(bot), mobs,
    world: encodeWorld(bot, center, ctx.radius || RADIUS)
  }
  if (ctx.dir) {
    try {
      fs.mkdirSync(ctx.dir, { recursive: true })
      fs.writeFileSync(path.join(ctx.dir, snap.id + '.json'), JSON.stringify(snap))
      const files = fs.readdirSync(ctx.dir).filter(f => /^s\d+-.*\.json$/.test(f)).sort()
      for (const f of files.slice(0, Math.max(0, files.length - (ctx.keep || 30)))) try { fs.unlinkSync(path.join(ctx.dir, f)) } catch { /* ignore */ }
    } catch { /* a snapshot is a nicety */ }
  }
  return snap
}

// ---- rebuilding ----
// merge the cells into boxes: runs along x, then equal runs on consecutive z, then equal slabs on consecutive y
function boxes(snap) {
  const w = snap.world, size = w.size, cells = new Array(size * size * size)
  let pos = 0
  for (let r = 0; r < w.runs.length; r += 2) for (let k = 0; k < w.runs[r + 1]; k++) cells[pos++] = w.runs[r]
  const air = w.palette.findIndex(s => s === 'air' || s === 'cave_air' || s === 'void_air'), unknown = w.palette.indexOf('?')
  const skip = (i) => i === unknown || i === undefined
  const lines = []                                                              // [y, z, x0, x1, idx]
  for (let y = 0; y < size; y++) for (let z = 0; z < size; z++) {
    let x = 0
    while (x < size) {
      const i = cells[(y * size + z) * size + x]; let x1 = x
      while (x1 + 1 < size && cells[(y * size + z) * size + x1 + 1] === i) x1++
      if (!skip(i)) lines.push([y, z, x, x1, i])
      x = x1 + 1
    }
  }
  const byYZ = new Map(lines.map(l => [`${l[0]},${l[1]},${l[2]},${l[3]},${l[4]}`, l]))
  const used = new Set(), zboxes = []                                           // [y, z0, z1, x0, x1, idx]
  for (const l of lines) {
    const key = `${l[0]},${l[1]},${l[2]},${l[3]},${l[4]}`; if (used.has(key)) continue
    let z1 = l[1]; used.add(key)
    for (;;) { const nk = `${l[0]},${z1 + 1},${l[2]},${l[3]},${l[4]}`; if (byYZ.has(nk) && !used.has(nk)) { used.add(nk); z1++ } else break }
    zboxes.push([l[0], l[1], z1, l[2], l[3], l[4]])
  }
  const byBox = new Map(zboxes.map(b => [b.join(','), b])), usedB = new Set(), out = []
  for (const b of zboxes) {
    const key = b.join(','); if (usedB.has(key)) continue
    usedB.add(key); let y1 = b[0]
    for (;;) { const nk = [y1 + 1, b[1], b[2], b[3], b[4], b[5]].join(','); if (byBox.has(nk) && !usedB.has(nk)) { usedB.add(nk); y1++ } else break }
    out.push({ x0: b[3], x1: b[4], y0: b[0], y1, z0: b[1], z1: b[2], block: w.palette[b[5]], air: b[5] === air })
  }
  return out
}

const ARMOR_SLOT = { 5: 'armor.head', 6: 'armor.chest', 7: 'armor.legs', 8: 'armor.feet', 45: 'weapon.offhand' }
function slotName(slot) { if (ARMOR_SLOT[slot]) return ARMOR_SLOT[slot]; if (slot >= 36 && slot <= 44) return `hotbar.${slot - 36}`; if (slot >= 9 && slot <= 35) return `inventory.${slot - 9}`; return null }

// -> array of { cmd, kind } in the order to run them. shift = [dx, dy, dz] moves the whole scenario (parallel cells of one trial world).
function buildCommands(snap, opts = {}) {
  const [dx, dy, dz] = opts.shift || [0, 0, 0], w = snap.world, o = w.origin, size = w.size
  const cmds = []
  const add = (cmd, kind) => cmds.push({ cmd, kind })
  add('/gamemode survival', 'setup'); add('/gamerule doMobSpawning false', 'setup'); add('/gamerule doDaylightCycle false', 'setup')
  add('/kill @e[type=!minecraft:player]', 'setup'); add('/clear @s', 'setup'); add('/effect clear @s', 'setup')
  add(`/fill ${o[0] + dx} ${o[1] + dy} ${o[2] + dz} ${o[0] + dx + size - 1} ${o[1] + dy + size - 1} ${o[2] + dz + size - 1} minecraft:air`, 'clear')
  for (const b of boxes(snap)) {
    if (b.air) continue
    const mc = b.block.includes(':') ? b.block : 'minecraft:' + b.block
    const from = `${o[0] + dx + b.x0} ${o[1] + dy + b.y0} ${o[2] + dz + b.z0}`, to = `${o[0] + dx + b.x1} ${o[1] + dy + b.y1} ${o[2] + dz + b.z1}`
    add(b.x0 === b.x1 && b.y0 === b.y1 && b.z0 === b.z1 ? `/setblock ${from} ${mc}` : `/fill ${from} ${to} ${mc}`, 'block')
  }
  for (const it of snap.bag || []) {
    const sn = slotName(it.slot); if (sn) add(`/item replace entity @s ${sn} with minecraft:${it.name} ${it.count}`, 'bag')
  }
  for (const m of snap.mobs || []) add(`/summon minecraft:${m.name} ${(m.x + dx).toFixed(2)} ${(m.y + dy).toFixed(2)} ${(m.z + dz).toFixed(2)} {PersistenceRequired:1b}`, 'mob')
  if (snap.timeOfDay != null) add(`/time set ${snap.timeOfDay}`, 'setup')
  const b = snap.bot
  // /tp takes yaw and pitch in degrees; mineflayer's yaw is radians counter-clockwise from -z, Minecraft's is degrees clockwise from +z
  const yawDeg = (((Math.PI - (b.yaw || 0)) * 180 / Math.PI) % 360 + 360) % 360
  add(`/tp @s ${(b.x + dx).toFixed(3)} ${(b.y + dy).toFixed(3)} ${(b.z + dz).toFixed(3)} ${yawDeg.toFixed(1)} ${(-(b.pitch || 0) * 180 / Math.PI).toFixed(1)}`, 'tp')
  return cmds
}

module.exports = { capture, buildCommands, decodeCells, encodeWorld, boxes, blockString, slotName, RADIUS, VERSION }
