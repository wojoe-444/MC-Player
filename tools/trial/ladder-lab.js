#!/usr/bin/env node
// Ladder body lab (insights doc, Haiku check 4): climb a 30 block ladder up and down with plain control states and measure speed,
// direction reversals and server corrections. If the body always climbs in one direction at a steady speed, ladder bobbing is a
// planner problem (two steps taking turns), not a body problem.
//   node .claude/skills/trial-server/scripts/server.js start
//   node tools/trial/ladder-lab.js [--port 25599] [--runs 20] [--height 30]
'use strict'
const mineflayer = require('mineflayer')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const PORT = +opt('port', 25599), RUNS = +opt('runs', 20), H = +opt('height', 30)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main () {
  const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialA', version: '1.21.6', auth: 'offline' })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej) })
  const cmd = async c => { bot.chat(c); await sleep(300) }
  await bot.waitForChunksToLoad()
  await cmd('/gamemode survival'); await cmd('/gamerule doMobSpawning false')
  await cmd('/tp @s 0.5 -60 0.5'); await sleep(2500) // known start (the server remembers the last position of this name)
  const b = bot.entity.position.floored()
  const x = b.x + 20, z = b.z + 20, y0 = b.y
  // 3x3 stone column H+3 tall, a 1x1 shaft with ladders on the north wall (facing south)
  await cmd(`/fill ${x - 1} ${y0 - 1} ${z - 1} ${x + 1} ${y0 + H + 5} ${z + 1} minecraft:stone`)
  await cmd(`/fill ${x} ${y0} ${z} ${x} ${y0 + H + 3} ${z} minecraft:air`)
  for (let i = 0; i <= H; i++) { if (i % 10 === 0) await sleep(400); bot.chat(`/setblock ${x} ${y0 + i} ${z} minecraft:ladder[facing=south]`); await sleep(120) }
  await sleep(1000)
  const Vec3 = require('vec3').Vec3
  const probe = bot.blockAt(new Vec3(x, y0 + 1, z)); if (!probe || probe.name !== 'ladder') throw new Error('ladder shaft not built (block at shaft is ' + (probe && probe.name) + ')')
  let corrections = 0
  bot.on('forcedMove', () => { corrections++ })
  const rows = []
  for (const dir of ['up', 'down']) {
    for (let r = 0; r < RUNS; r++) {
      const startY = dir === 'up' ? y0 : y0 + H
      await cmd(`/tp @s ${x + 0.5} ${startY} ${z + 0.5} 0 0`)
      await sleep(1200)
      corrections = 0
      await bot.look(0, 0, true)
      const t0 = Date.now(), yAtStart = bot.entity.position.y; let lastY = bot.entity.position.y, rev = 0, lastSign = 0, stalls = 0
      if (dir === 'up') { bot.setControlState('forward', true); bot.setControlState('jump', true) } else { bot.setControlState('forward', false); bot.setControlState('jump', false) }
      const target = dir === 'up' ? y0 + H : y0
      while (Date.now() - t0 < 30000) {
        await sleep(50)
        const y = bot.entity.position.y, dy = y - lastY
        const s = Math.abs(dy) < 1e-4 ? 0 : Math.sign(dy)
        if (s !== 0 && lastSign !== 0 && s !== lastSign) rev++
        if (s !== 0) lastSign = s
        if (s === 0) stalls++
        lastY = y
        if (dir === 'up' ? y >= target - 0.2 : y <= target + 0.2) break
      }
      bot.clearControlStates()
      const secs = (Date.now() - t0) / 1000
      rows.push({ dir, run: r, secs: +secs.toFixed(2), blocksPerSec: +(Math.abs(bot.entity.position.y - yAtStart) / secs).toFixed(2), reversals: rev, stalls50ms: stalls, serverCorrections: corrections, reached: dir === 'up' ? bot.entity.position.y >= target - 0.5 : bot.entity.position.y <= target + 0.5 })
    }
  }
  const agg = d => { const rr = rows.filter(r => r.dir === d); const a = k => +(rr.reduce((s, r) => s + r[k], 0) / rr.length).toFixed(2); return `| ${d} ${H} blocks | ${rr.length} | ${rr.filter(r => r.reached).length} | ${a('blocksPerSec')} | ${a('reversals')} | ${a('stalls50ms')} | ${a('serverCorrections')} |` }
  const md = ['| run | n | reached | blocks/s | reversals | stalled 50 ms samples | server corrections |', '|---|---|---|---|---|---|---|', agg('up'), agg('down')].join('\n')
  console.log(JSON.stringify(rows)); console.log(md)
  bot.quit(); setTimeout(() => process.exit(0), 500)
}
main().catch(e => { console.error(e); process.exit(1) })
