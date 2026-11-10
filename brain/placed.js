// brain/placed.js: a saved log of blocks placed by players (both bots and Walter) that are still standing (Walter 2026-11-10: "a thorough and
// automatic log of blocks placed by the players (that haven't been removed yet)").
//
//   Own placements: mineflayer's 'blockPlaced' event (every bot.placeBlock / _placeBlockWithOptions that the server confirmed).
//   Other players:  a block update from air (or a replaceable plant/snow) to something solid, within 6 blocks of a player who swung an arm in the
//                   last 700 ms (vanilla clients swing on every place). Bots log their own; this catches Walter's and other people's.
//   Removal:        any block update at a logged position to a different block (broken, burnt, exploded, pushed) drops the entry.
//
// File: Downloads/bot-shared/placed-blocks.json  { worlds: { "<spawn x,z>": { "x,y,z": [name, by, t] } } }, shared by both bots (merged on save).
// The log only holds what the server sent this client for loaded chunks; it never asks for anything. Consulted by S.isEstablished (plan.js).
const fs = require('fs')
const path = require('path')
const FILE = process.env.BOT_PLACED || path.join(__dirname, '..', '..', 'bot-shared', 'placed-blocks.json')
const SOFT = /^(air|cave_air|void_air|short_grass|tall_grass|grass|fern|large_fern|snow|dead_bush|vine|glow_lichen|seagrass|water|lava|fire)$/
const NOT_BUILDS = /^(air|cave_air|void_air|water|lava|fire|soul_fire|bubble_column|snow|powder_snow|moving_piston|piston_head|frosted_ice)$/
// Block changes that happen on their own near a working player (docs/BUG-HUNT-2026-11-10.md, finding 14): ice freezing out of water, obsidian/cobblestone/stone out of
// a lava or water flow, leaves of a growing tree, and blocks that fall (sand, gravel, concrete powder, anvils). They are never credited to a player.
const FLUID_RESULT = /^(ice|blue_ice|packed_ice|obsidian|cobblestone|stone|basalt)$/
const GROWS_OR_FALLS = /(_leaves|_concrete_powder)$|^(sand|red_sand|gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone)$/
function naturalChange(oldName, newName) {
  if (/^(water|lava)$/.test(oldName) && FLUID_RESULT.test(newName)) return true
  return GROWS_OR_FALLS.test(newName)
}
const k = (p) => `${p.x},${p.y},${p.z}`

const safeRename = (tmp, dst) => { try { fs.renameSync(tmp, dst) } catch (e) { if (!/EPERM|EBUSY|EACCES/.test(String(e.code || e.message))) throw e; try { fs.writeFileSync(dst, fs.readFileSync(tmp)); fs.unlinkSync(tmp) } catch (e2) { throw e2 } } }
function attach(bot, log = () => {}) {
  if (bot._placed && bot._placed.v === 1) return bot._placed
  if (bot._placed && bot._placed.dispose) try { bot._placed.dispose() } catch {}
  const me = () => bot.username
  let world = 'unknown', map = new Map(), adds = new Map(), dels = new Set(), dirty = false, saveT = null
  const worldKey = () => { const sp = bot.spawnPoint; return sp ? `spawn ${Math.floor(sp.x)},${Math.floor(sp.z)}` : 'unknown' }
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { worlds: {} } } }
  function load() {
    world = worldKey()
    const all = read(), w = (all.worlds || {})[world] || {}
    map = new Map(Object.entries(w))
  }
  function save() {
    saveT = null
    if (!dirty) return
    try {
      const all = read(); all.worlds = all.worlds || {}
      const w = all.worlds[world] || {}
      for (const [key, rec] of adds) w[key] = rec
      for (const key of dels) delete w[key]
      all.worlds[world] = w
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      const tmp = FILE + '.' + me() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(all)); safeRename(tmp, FILE)
      map = new Map(Object.entries(w)); adds.clear(); dels.clear(); dirty = false
    } catch (e) { log('placed log save: ' + e.message) }
  }
  const later = () => { dirty = true; if (!saveT) saveT = setTimeout(save, 5000) }
  function add(p, name, by) {
    if (NOT_BUILDS.test(name)) return
    const rec = [name, by, Date.now()], key = k(p)
    map.set(key, rec); adds.set(key, rec); dels.delete(key); later()
  }
  function drop(key) { if (!map.has(key)) return; map.delete(key); adds.delete(key); dels.add(key); later() }

  // who swung an arm lately (other players; bots log their own placements)
  const swings = new Map()
  const onSwing = (e) => { if (e && e.type === 'player' && e.username && e.username !== me()) swings.set(e.username, { t: Date.now(), e }) }
  const onPlaced = (oldB, newB) => { try { if (newB && newB.position) add(newB.position, newB.name, me()) } catch {} }
  const onUpdate = (oldB, newB) => {
    try {
      if (!newB || !newB.position) return
      const key = k(newB.position), rec = map.get(key)
      if (rec && rec[0] !== newB.name) drop(key)
      if (!oldB || !SOFT.test(oldB.name) || SOFT.test(newB.name) || NOT_BUILDS.test(newB.name) || naturalChange(oldB.name, newB.name)) return
      if (map.has(key)) return
      const t = Date.now()
      for (const [name, s] of swings) {
        if (t - s.t > 700) continue
        const pe = (bot.players[name] && bot.players[name].entity) || s.e
        if (pe && pe.position && pe.position.distanceTo(newB.position.offset(0.5, 0.5, 0.5)) <= 6) { add(newB.position, newB.name, name); break }
      }
    } catch {}
  }
  const onSpawn = () => { try { save(); load() } catch {} }
  bot.on('entitySwingArm', onSwing); bot.on('blockPlaced', onPlaced); bot.on('blockUpdate', onUpdate); bot.on('spawn', onSpawn)
  try { load() } catch {}

  const api = {
    v: 1,
    // the record at a position if the block there is still the one that was placed
    at: (p, name) => { const r = map.get(k(p)); return r && (!name || r[0] === name) ? { name: r[0], by: r[1], t: r[2] } : null },
    count: () => map.size,
    byWho: () => { const n = {}; for (const r of map.values()) n[r[1]] = (n[r[1]] || 0) + 1; return n },
    near: (p, r = 8) => { const out = []; for (const [key, rec] of map) { const [x, y, z] = key.split(',').map(Number); if (Math.abs(x - p.x) <= r && Math.abs(y - p.y) <= r && Math.abs(z - p.z) <= r) out.push({ x, y, z, name: rec[0], by: rec[1] }) } return out },
    save,
    dispose: () => { bot.removeListener('entitySwingArm', onSwing); bot.removeListener('blockPlaced', onPlaced); bot.removeListener('blockUpdate', onUpdate); bot.removeListener('spawn', onSpawn); save() },
  }
  bot._placed = api
  return api
}

module.exports = { attach, FILE, naturalChange }
