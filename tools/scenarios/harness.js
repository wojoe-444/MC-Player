// Scenario harness: runs a scenario N times on a vanilla trial server and reports a RATE with a 95% interval, not one trace
// (docs/HILLCLIMB-INSIGHTS.md items 1, 5 and 6: "gate on rates, not single runs").
//
//   node tools/scenarios/run.js [filter] [--runs 30] [--port 25599] [--bots TrialA,TrialB,TrialC,TrialD] [--out dir]
//
// Setup (about a minute, see .claude/skills/trial-server): jar in .trial-server/server.jar, `server.js setup --ops TrialA,TrialB,TrialC,TrialD --mode flat`, `server.js start --minutes 40`.
// Each worker is one op'd offline bot working in its own 64-block-wide region; scenarios are handed out from a queue so bots run in parallel.
// A scenario is { name, note, items: {name: count}, build(w) , start: [dx, dy, dz], yaw, act(ctx) -> { pass, ...metrics }, timeoutMs }, see scenarios.js.
// Flat world: surface block y=-61, feet y=-60. The server remembers each name's last position, so every run starts with /tp.
'use strict'
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const FEET_Y = -60
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function wilson(k, n, z = 1.96) {                                   // 95% interval for a rate, fine at n = 20..30 and at 0 or n
  if (!n) return [0, 1]
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]
}

async function connect({ host = 'localhost', port, name }) {
  const bot = mineflayer.createBot({ host, port, username: name, version: '1.21.6', auth: 'offline', checkTimeoutInterval: 120000 })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', (k) => rej(new Error('kicked ' + JSON.stringify(k)))) })
  await bot.waitForChunksToLoad(); await bot.waitForTicks(10)
  bot.once('end', () => { bot._ended = true })
  return bot
}

// chat commands, paced (the server kicks for spam); every command waits a few ticks so the world has changed before the next one
async function cmd(bot, c, ticks = 3) { bot.chat(c); await bot.waitForTicks(ticks) }

function world(bot, ox, oz) {
  const w = {
    ox, oz, y0: FEET_Y,
    cmd: (c, t) => cmd(bot, c, t),
    fill: (x0, y0, z0, x1, y1, z1, b) => cmd(bot, `/fill ${ox + x0} ${y0} ${oz + z0} ${ox + x1} ${y1} ${oz + z1} minecraft:${b}`),
    set: (x, y, z, b) => cmd(bot, `/setblock ${ox + x} ${y} ${oz + z} minecraft:${b}`),
    cell: (x, y, z) => new Vec3(ox + x, y, oz + z),
    at: (x, y, z) => bot.blockAt(new Vec3(ox + x, y, oz + z)),
    clear: () => cmd(bot, `/fill ${ox - 8} ${FEET_Y} ${oz - 8} ${ox + 8} ${FEET_Y + 40} ${oz + 8} minecraft:air`, 6)
  }
  return w
}

async function resetBot(bot, name) {
  for (const c of ['/gamemode survival', '/clear @s', '/effect clear @s', '/kill @e[type=!minecraft:player]', '/gamerule doMobSpawning false', '/gamerule doDaylightCycle false', '/time set 6000', '/gamerule doImmediateRespawn true', '/difficulty peaceful']) await cmd(bot, c, 2)
}

async function runOnce(bot, name, sc, region, runNo) {
  const w = world(bot, region.ox, region.oz)
  const t0 = Date.now()
  let res
  try {
    if (bot.health <= 0 || !bot.entity) await bot.waitForTicks(20)
    await resetBot(bot, name)
    await cmd(bot, `/tp @s ${region.ox + 6.5} ${FEET_Y} ${region.oz + 6.5}`, 20)         // stand clear of the build, on the ground (a drop from height kills the bot and empties the bag)
    await w.clear()
    await sc.build(w)
    await bot.waitForTicks(6)
    for (const [item, n] of Object.entries(sc.items || {})) await cmd(bot, `/give @s minecraft:${item} ${n}`, 4)
    const st = sc.start || [0.5, 0, 0.5]
    await cmd(bot, `/tp @s ${region.ox + st[0]} ${FEET_Y + st[1]} ${region.oz + st[2]} ${sc.yaw ?? 0} 0`, 3)
    for (let i = 0; i < 40 && !(bot.entity.onGround && bot.inventory.items().length >= Object.keys(sc.items || {}).length); i++) await bot.waitForTicks(2)
    await bot.waitForTicks(8)
    res = await Promise.race([sc.act({ bot, w, name, run: runNo, region }), sleep(sc.timeoutMs || 60000).then(() => ({ pass: false, why: 'timeout' }))])
  } catch (e) { res = { pass: false, why: 'error: ' + String(e && e.message || e).slice(0, 160) } }
  return { scenario: sc.name, run: runNo, bot: name, ms: Date.now() - t0, ...res }
}

// jobs: [{ sc, run }] handed out to the bots; returns every result
async function runAll({ port, bots, scenarios, runs, log = console.log, onResult = () => {} }) {
  const jobs = []
  for (const sc of scenarios) for (let r = 0; r < runs; r++) jobs.push({ sc, run: r })
  const results = []
  const workers = await Promise.all(bots.map(async (name, i) => ({ name, bot: await connect({ port, name }), region: { ox: 64 * i + 32, oz: 32 } })))
  let next = 0
  await Promise.all(workers.map(async (wk) => {
    while (next < jobs.length) {
      const j = jobs[next++]
      let r = await runOnce(wk.bot, wk.name, j.sc, wk.region, j.run)
      if (!r.pass && /error|Cannot|ended|kicked/i.test(r.why || '') && wk.bot._ended) { try { wk.bot = await connect({ port, name: wk.name }) } catch (e) { log('reconnect failed: ' + e.message) } }
      results.push(r); onResult(r)
      log(`${r.pass ? 'pass' : 'FAIL'} ${r.scenario} #${r.run} ${wk.name} ${r.ms}ms ${r.pass ? '' : (r.why || '')}`)
    }
  }))
  for (const wk of workers) { try { wk.bot.quit() } catch { /* ignore */ } }
  return results
}

function summarize(results) {
  const by = {}
  for (const r of results) (by[r.scenario] = by[r.scenario] || []).push(r)
  return Object.entries(by).map(([name, rs]) => {
    const n = rs.length, k = rs.filter(r => r.pass).length, [lo, hi] = wilson(k, n)
    const nums = (key) => rs.map(r => r[key]).filter(v => typeof v === 'number')
    const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null
    const why = {}; for (const r of rs) if (!r.pass) why[r.why || 'unknown'] = (why[r.why || 'unknown'] || 0) + 1
    return { scenario: name, runs: n, pass: k, rate: +(k / n).toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), refusalsMean: mean(nums('refusals')), msMean: mean(nums('ms')), why }
  })
}
function table(rows) {
  const out = ['| scenario | runs | pass | rate (95% interval) | refusals/run | ms/run | failures |', '| --- | ---: | ---: | --- | ---: | ---: | --- |']
  for (const r of rows) out.push(`| ${r.scenario} | ${r.runs} | ${r.pass} | ${(r.rate * 100).toFixed(0)}% (${(r.lo * 100).toFixed(0)}-${(r.hi * 100).toFixed(0)}%) | ${r.refusalsMean ?? ''} | ${r.msMean ?? ''} | ${Object.entries(r.why).map(([k, v]) => `${v}x ${k}`).join('; ')} |`)
  return out.join('\n')
}

module.exports = { connect, cmd, world, runAll, summarize, table, wilson, FEET_Y, sleep }
