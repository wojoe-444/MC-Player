// brain/plugins: community mineflayer plugins (Walter 2026-11-05: borrow open-source pieces where they beat ours).
//   mineflayer-auto-eat (ESM): eating when hungry, picking the best food. The safety module's eating hands over to it (one eater only).
//   mineflayer-armor-manager: puts on armor as soon as it is picked up, and the best pieces on a timer.
// Installed in vendor/ (not the shared node_modules of the Minecraft-Agent folder).
const path = require('path')
const VENDOR = path.join(__dirname, '..', '..', 'vendor', 'node_modules')

module.exports = function register(api) {
  const { bot } = api
  const log = (m) => api.log('plugins', m)
  let timer = null, ok = { eat: false, armor: false }
  return {
    name: 'plugins',
    async start() {
      try {
        if (!bot.armorManager) require(path.join(VENDOR, 'mineflayer-armor-manager'))(bot)
        ok.armor = true
        timer = setInterval(() => { try { if (bot.entity && !bot.currentWindow) bot.armorManager.equipAll().catch(() => {}) } catch {} }, 60000)
      } catch (e) { log('armor-manager not loaded: ' + e.message) }
      try {
        if (!bot.autoEat) {
          const m = await import('file:///' + path.join(VENDOR, 'mineflayer-auto-eat', 'dist', 'index.js').replace(/\\/g, '/'))
          bot.loadPlugin(m.loader)
        }
        bot.autoEat.setOpts({ minHunger: 15, minHealth: 14, bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple'] })
        bot.autoEat.enableAuto()
        ok.eat = true
      } catch (e) { log('auto-eat not loaded: ' + e.message) }
      log(`loaded: auto-eat ${ok.eat}, armor-manager ${ok.armor}`)
    },
    stop() { clearInterval(timer); try { bot.autoEat && bot.autoEat.disableAuto() } catch {} },
    status() { return ok }
  }
}
module.exports.meta = { name: 'plugins', version: 1 }
