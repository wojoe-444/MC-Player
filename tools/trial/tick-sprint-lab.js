#!/usr/bin/env node
// Does `/tick sprint` speed up a mineflayer bot's actions? (insights doc, Haiku check 3)
// Measures, with and without a server tick sprint, over the same real-time window: server ticks elapsed (world age), blocks walked,
// and time plus success of digging 8 stone blocks. mineflayer's physics sends one move packet per 50 ms of real time, so if actions
// only gain from more server ticks, distance walked per real second would rise; if not, only the world age rises.
//   node .claude/skills/trial-server/scripts/server.js start
//   node tools/trial/tick-sprint-lab.js [--port 25599] [--rounds 5]
'use strict'
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const PORT = +opt('port', 25599), ROUNDS = +opt('rounds', 5)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main () {
  const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialA', version: '1.21.6', auth: 'offline' })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej) })
  const cmd = async c => { bot.chat(c); await sleep(300) }
  await bot.waitForChunksToLoad()
  await cmd('/gamemode survival'); await cmd('/clear @s'); await cmd('/give @s minecraft:stone_pickaxe'); await cmd('/gamerule doMobSpawning false')
  const base = bot.entity.position.floored()
  const rows = []
  for (const mode of ['normal', 'sprint']) {
    for (let r = 0; r < ROUNDS; r++) {
      // /tick sprint <n>t runs n ticks as fast as the server can (about 5000 a second here), so the sprint must be long enough to outlast the test
      await cmd(`/tp @s ${base.x + 0.5} ${base.y} ${base.z + 0.5} -90 0`)
      for (let dx = 1; dx <= 4; dx++) for (let dy = 0; dy <= 1; dy++) bot.chat(`/setblock ${base.x + dx} ${base.y + dy} ${base.z} minecraft:stone`), await sleep(150)
      await sleep(600)
      await cmd(`/tp @s ${base.x + 0.5} ${base.y} ${base.z + 0.5} -90 0`); await sleep(800)
      const pick = bot.inventory.items().find(i => i.name === 'stone_pickaxe'); if (pick) await bot.equip(pick, 'hand')
      // dig test first (stone line in front), then walk test, each under its own sprint
      if (mode === 'sprint') await cmd('/tick sprint 60000t')
      await sleep(500)
      let ok = 0; const d0 = Date.now(); const ageD0 = bot.time.age
      for (const [dx, dy] of [[1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1], [4, 0], [4, 1]]) {
        const b = bot.blockAt(new Vec3(base.x + dx, base.y + dy, base.z))
        if (!b || b.name !== 'stone') continue
        try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); await bot.dig(b, true); ok++ } catch (e) {}
      }
      const digMs = Date.now() - d0, digTicks = bot.time.age - ageD0
      if (mode === 'sprint') { await sleep(300); await cmd('/tick freeze'); await cmd('/tick unfreeze') } // abort whatever is left of the sprint
      await cmd(`/tp @s ${base.x + 0.5} ${base.y} ${base.z + 8.5} -90 0`); await sleep(1200)
      if (mode === 'sprint') await cmd('/tick sprint 60000t')
      await sleep(500)
      const p0 = bot.entity.position.clone(), age0 = bot.time.age
      bot.setControlState('forward', true)
      await sleep(5000)
      bot.setControlState('forward', false)
      const walked = bot.entity.position.distanceTo(p0), ageD = bot.time.age - age0
      if (mode === 'sprint') { await cmd('/tick freeze'); await cmd('/tick unfreeze') }
      rows.push({ mode, round: r, blocksWalkedIn5s: +walked.toFixed(2), serverTicksIn5s: ageD, dugOf8: ok, digMs, serverTicksDuringDig: digTicks })
      await sleep(1500)
    }
  }
  const avg = (m, k) => +(rows.filter(r => r.mode === m).reduce((a, r) => a + r[k], 0) / ROUNDS).toFixed(1)
  const md = ['| mode | blocks walked in 5 s | server ticks in 5 s | stone dug of 8 | ms to dig 8 | server ticks while digging |', '|---|---|---|---|---|---|',
    ...['normal', 'sprint'].map(m => `| ${m} | ${avg(m, 'blocksWalkedIn5s')} | ${avg(m, 'serverTicksIn5s')} | ${avg(m, 'dugOf8')} | ${avg(m, 'digMs')} | ${avg(m, 'serverTicksDuringDig')} |`)].join('\n')
  console.log(JSON.stringify(rows)); console.log(md)
  bot.quit(); setTimeout(() => process.exit(0), 500)
}
main().catch(e => { console.error(e); process.exit(1) })
