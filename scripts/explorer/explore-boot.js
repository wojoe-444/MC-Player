// boot: autopilot off, spectator, resume the spiral and the per-chunk village finder
module.exports = async function boot(bot, api, ap) {
  const fs = require('fs'), Vec3 = bot.entity.position.constructor
  ap.enabled = false; try { api.scheduler.cancel('autopilot') } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  if (bot.game.gameMode !== 'spectator') { bot.chat('/gamemode spectator ' + bot.username); await new Promise(r => setTimeout(r, 2500)) }
  delete require.cache[require.resolve(api.statePath('explore.js'))]
  if (bot._explore) bot._explore.stop()
  bot._explore = require(api.statePath('explore.js'))(bot, api, {})
  const file = api.statePath('villages.json')
  let V = []; try { V = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const bell = bot.registry.blocksByName.bell, lo = bell.minStateId, hi = bell.maxStateId
  if (bot._villageOnChunk) bot.world.removeListener('chunkColumnLoad', bot._villageOnChunk)
  bot._villageOnChunk = (pos) => { try {
    try { V = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const col = bot.world.getColumnAt(pos); if (!col || !col.sections) return
    for (let si = 0; si < col.sections.length; si++) {
      const sec = col.sections[si]; if (!sec || !sec.palette) continue
      const pal = sec.palette.data || sec.palette; if (!Array.isArray(pal) || !pal.some(id => id >= lo && id <= hi)) continue
      const y0 = (col.minY || -64) + si * 16
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) {
        const id = col.getBlockStateId(new Vec3(x, y0 + y, z)); if (id < lo || id > hi) continue
        const p = { x: pos.x + x, y: y0 + y, z: pos.z + z }
        const near = V.find(v => Math.hypot(v.x - p.x, v.z - p.z) < 96)
        if (near) near.bells = (near.bells || 1) + 1
        else { V.push({ ...p, bells: 1, at: Date.now() }); api.log('explore', `village found (${V.length} so far) at ${p.x},${p.y},${p.z}`) }
        fs.writeFileSync(file, JSON.stringify(V, null, 1)); return
      }
    }
  } catch (e) {} }
  bot.world.on('chunkColumnLoad', bot._villageOnChunk)
  return JSON.stringify({ mode: bot.game.gameMode, ex: bot._explore.status(), villages: V.length })
}
