// Template: connect an op'd test bot to the trial server, set up a scenario with slash commands, measure, quit.
//   node example-trial.js [port] [name]     (run from a folder where `mineflayer` resolves, e.g. the repo root)
const mineflayer = require('mineflayer')
const PORT = Number(process.argv[2]) || 25599
const NAME = process.argv[3] || 'TrialA'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: NAME, version: '1.21.6' })
bot.on('error', e => console.log('ERR', e.message))
bot.on('kicked', r => console.log('KICKED', JSON.stringify(r).slice(0, 200)))

bot.once('spawn', async () => {
  const cmd = async (c) => { bot.chat(c); await sleep(200) } // pace commands, the server kicks for spam
  try {
    await cmd('/gamemode survival')
    await cmd('/clear @s')
    await cmd('/gamerule doMobSpawning false')
    await cmd('/give @s minecraft:iron_pickaxe')
    const p = bot.entity.position.floored()
    for (let i = 0; i < 5; i++) await cmd('/setblock ' + (p.x + 5 + i) + ' ' + p.y + ' ' + (p.z + 4) + ' minecraft:oak_log')
    await sleep(1000)
    // ---- plug the thing under test in here, then measure ----
    const logs = bot.findBlocks({ matching: bot.registry.blocksByName.oak_log.id, maxDistance: 32, count: 5 })
    console.log('logs in range:', logs.length)
  } catch (e) { console.log('FATAL', e.stack) }
  bot.quit()
  setTimeout(() => process.exit(0), 500)
})
