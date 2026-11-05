// Torch as you go: underground and dark, no torch within 6 blocks, 8+ blocks walked since the last one -> put a torch on the floor under the bot's feet.
// Uses brain/lighting/torches.js (Walter authorized torch placing; line of sight to the floor block, every placement logged). Never while digging, fighting or
// fleeing, and the item in hand is put back afterwards.
const { Vec3 } = require('vec3')

const LIGHT_DEFAULTS = { autoLight: true, lightEveryBlocks: 8, darkAt: 4, torchNearR: 6, lightCooldownMs: 4000 }

function makeLight({ bot, torches, log = () => {}, now = Date.now, cfg = {} }) {
  const C = { ...LIGHT_DEFAULTS, ...cfg }
  let lastPlaced = null, lastChecked = null, lastAt = 0, busy = false
  const stat = { placed: 0, skipped: 0, last: null }

  function underground() {
    const p = bot.entity.position, x = Math.floor(p.x), z = Math.floor(p.z), y = Math.floor(p.y) + 2
    for (let dy = 0; dy < 48; dy++) { const b = bot.blockAt(new Vec3(x, y + dy, z)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name || '')) return true }
    return false
  }

  // One torch now if it makes sense. Returns { ok, why }.
  async function lightHere({ force = false } = {}) {
    if (busy) return { ok: false, why: 'busy' }
    const t = now()
    if (!force && t - lastAt < C.lightCooldownMs) return { ok: false, why: 'cooldown' }
    busy = true
    const held = bot.heldItem && bot.heldItem.name
    try {
      if (!torches.count()) return { ok: false, why: 'no-torches' }
      const pos = bot.entity.position, feet = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
      if (!force) {
        lastChecked = pos.clone()
        if (!underground()) return { ok: false, why: 'open-sky' }
        const light = torches.lightOf(feet)
        if (light != null && light > C.darkAt) return { ok: false, why: 'bright-enough' }
        if (torches.torchNear(feet, C.torchNearR)) return { ok: false, why: 'torch-near' }
      }
      const floor = bot.blockAt(feet.offset(0, -1, 0)), above = bot.blockAt(feet)
      if (!torches.floorOk(floor, above)) return { ok: false, why: 'bad-floor' }
      const r = await torches.place(null, floor)
      lastAt = t
      if (r.ok) { stat.placed++; lastPlaced = pos.clone(); stat.last = { at: feet, t }; log(`light: torch at ${feet.x},${feet.y},${feet.z}`) } else { stat.skipped++; log(`light: skipped (${r.why})`) }
      return r
    } catch (e) { return { ok: false, why: e.message } }
    finally {
      busy = false
      try { if (held && (!bot.heldItem || bot.heldItem.name !== held)) { const it = bot.inventory.items().find(i => i.name === held); if (it) await bot.equip(it, 'hand') } } catch { /* ignore */ }
    }
  }

  // Cheap check for the scan loop: walked 8+ blocks since the last torch, and 4+ since the last look that found no need.
  function due() {
    if (!C.autoLight || busy) return false
    if (bot.targetDigBlock || bot.isSleeping) return false
    const p = bot.entity.position
    if (lastPlaced && p.distanceTo(lastPlaced) < C.lightEveryBlocks) return false
    if (lastChecked && p.distanceTo(lastChecked) < C.lightEveryBlocks / 2) return false
    return true
  }
  return { lightHere, due, stat, underground }
}

module.exports = { makeLight, LIGHT_DEFAULTS }
