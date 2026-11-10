// brain/plugins: community mineflayer plugins (Walter 2026-11-05: borrow open-source pieces where they beat ours).
//   mineflayer-auto-eat (ESM): eating when hungry, picking the best food. The safety module's eating hands over to it (one eater only).
//   mineflayer-armor-manager: puts on armor as soon as it is picked up, and the best pieces on a timer.
// Installed in vendor/ (not the shared node_modules of the Minecraft-Agent folder).
const path = require('path')
const VENDOR = path.join(__dirname, '..', '..', 'vendor', 'node_modules')

module.exports = function register(api) {
  const { bot } = api
  const log = (m) => api.log('plugins', m)
  let timer = null, guard = null, ok = { eat: false, armor: false }
  // no eating with a mob in reach: auto-eat kept a zombie's victim holding bread for six hits in a row (OzoGo444 died, 05:54); the sword comes first
  const threatClose = () => { try { const S = bot._ap && bot._ap.S; return !!(S && S.hostilesNear && S.hostilesNear(5).length) } catch { return false } }
  return {
    name: 'plugins',
    async start() {
      try {
        // Walter 2026-11-10: no armor (free mob-farm drops only, handled by the autopilot). The armor manager put on any armor picked up.
        if (process.env.ARMOR_MANAGER === '1') {
          if (!bot.armorManager) require(path.join(VENDOR, 'mineflayer-armor-manager'))(bot)
          ok.armor = true
          timer = setInterval(() => { try { if (bot.entity && !bot.currentWindow) bot.armorManager.equipAll().catch(() => {}) } catch {} }, 60000)
        }
      } catch (e) { log('armor-manager not loaded: ' + e.message) }
      try {
        if (!bot.autoEat) {
          const m = await import('file:///' + path.join(VENDOR, 'mineflayer-auto-eat', 'dist', 'index.js').replace(/\\/g, '/'))
          bot.loadPlugin(m.loader)
        }
        bot.autoEat.setOpts({ minHunger: 15, minHealth: 14, bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple'] })
        bot.autoEat.enableAuto()
        let paused = false
        guard = setInterval(() => {
          try {
            const close = threatClose()
            if (close && !paused) { paused = true; bot.autoEat.disableAuto(); if (bot.autoEat.isEating) { try { bot.deactivateItem() } catch {} } }
            else if (!close && paused) { paused = false; bot.autoEat.enableAuto() }
          } catch {}
        }, 250)
        bot._eatBlocked = () => threatClose()
        ok.eat = true
      } catch (e) { log('auto-eat not loaded: ' + e.message) }
      log(`loaded: auto-eat ${ok.eat}, armor-manager ${ok.armor}`)
    },
    stop() { clearInterval(timer); clearInterval(guard); try { bot.autoEat && bot.autoEat.disableAuto() } catch {} },
    status() { return ok }
  }
}
module.exports.meta = require('./meta.json')
