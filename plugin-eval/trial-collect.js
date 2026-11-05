const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const tool = require('mineflayer-tool')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const bot = mineflayer.createBot({ host: 'localhost', port: 25599, username: 'TrialA', version: '1.21.6' })
bot.on('error', e => console.log('ERR', e.message)); bot.on('kicked', r => console.log('KICK', JSON.stringify(r).slice(0, 200)))
const log = (...a) => console.log(new Date().toISOString().slice(14, 19), ...a)
bot.once('spawn', async () => {
  try {
    bot.loadPlugin(pathfinder); bot.loadPlugin(tool.plugin); bot.loadPlugin(collectBlock)
    const mv = new Movements(bot); bot.pathfinder.setMovements(mv)
    const p = bot.entity.position.floored()
    const cmd = async (c) => { bot.chat(c); await sleep(250) }
    await cmd('/gamemode survival'); await cmd('/clear @s'); await cmd('/gamerule doMobSpawning false')
    await cmd('/give @s minecraft:iron_pickaxe'); await cmd('/give @s minecraft:iron_axe')
    // tree-ish logs scattered + stone patch, 12-20 blocks away
    for (let i = 0; i < 10; i++) await cmd(`/setblock ${p.x + 10 + (i % 5) * 2} ${p.y} ${p.z + 6 + Math.floor(i / 5) * 3} minecraft:oak_log`)
    await cmd(`/fill ${p.x - 18} ${p.y} ${p.z - 8} ${p.x - 14} ${p.y + 2} ${p.z - 4} minecraft:stone`)
    await sleep(1500)
    const t0 = Date.now()
    let logs = bot.findBlocks({ matching: bot.registry.blocksByName.oak_log.id, maxDistance: 40, count: 10 }).map(v => bot.blockAt(v))
    log('logs found', logs.length)
    try { await bot.collectBlock.collect(logs, { ignoreNoPath: true }) } catch (e) { log('collect logs err', e.message) }
    const got = bot.inventory.count(bot.registry.itemsByName.oak_log.id)
    log('RESULT logs', got + '/10', ((Date.now() - t0) / 1000).toFixed(1) + 's')
    const t1 = Date.now()
    let st = bot.findBlocks({ matching: bot.registry.blocksByName.stone.id, maxDistance: 40, count: 20 }).map(v => bot.blockAt(v))
    log('stone found', st.length)
    try { await bot.collectBlock.collect(st, { ignoreNoPath: true }) } catch (e) { log('collect stone err', e.message) }
    log('RESULT cobble', bot.inventory.count(bot.registry.itemsByName.cobblestone.id) + '/20', ((Date.now() - t1) / 1000).toFixed(1) + 's')
  } catch (e) { log('FATAL', e.stack) }
  bot.quit(); setTimeout(() => process.exit(0), 500)
})
