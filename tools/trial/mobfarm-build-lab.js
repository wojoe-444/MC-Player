#!/usr/bin/env node
// End-to-end lab for the mob farm BUILD routine (brain/autopilot/mobfarmbuild.js) on a throwaway vanilla server: the real skills (S), mining (M) and
// ladder registry code drive a survival bot that digs the whole farm by hand out of solid stone, then the farm is tested with zombies and the
// existing kill routine (brain/autopilot/mobfarm.js).
//   node .claude/skills/trial-server/scripts/server.js start --minutes 40
//   node tools/trial/mobfarm-build-lab.js [--port 25599] [--zombies 6] [--secs 120] [--skip-build] [--from fit|water|column|platform]
'use strict'
const os = require('os'), path = require('path'), fs = require('fs')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const PORT = +opt('port', 25599), NZ = +opt('zombies', 6), SECS = +opt('secs', 120)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mfbuild-'))
process.env.BOT_REGISTRY = path.join(TMP, 'registry.json')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (t, m) => console.log('  [' + t + '] ' + m)

async function main() {
  const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialA', version: '1.21.6', auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej) })
  const out = []; bot.on('messagestr', m => out.push(m))
  bot.on('death', () => console.log('!!! BOT DIED'))
  const cmd = async (c, ms = 150) => { bot.chat(c); await sleep(ms) }
  await bot.waitForChunksToLoad()
  await cmd('/gamemode creative'); await cmd('/gamerule doMobSpawning false'); await cmd('/difficulty peaceful'); await cmd('/time set 18000'); await cmd('/gamerule doDaylightCycle false')
  // ---- the mine: a stone block with a laddered shaft, ladder on the west wall, entry (surface feet cell) at y41, bottom at y1
  const X0 = 200, Z0 = 0, ENTRY = 41, BOT = 1
  await cmd(`/tp @s ${X0 + 10} ${ENTRY + 2} ${Z0}`); await sleep(3000)
  const fill = (a, b, c, d, e, f, blk) => cmd(`/fill ${a} ${b} ${c} ${d} ${e} ${f} minecraft:${blk}`, 250)
  const FROM = opt('from', null)       // resume at a phase on the world the last run left (chamber is the start)
  if (!FROM) {
    await fill(X0 - 4, -2, Z0 - 14, X0 + 32, 20, Z0 + 14, 'stone')
    await fill(X0 - 4, 21, Z0 - 14, X0 + 32, ENTRY - 1, Z0 + 14, 'stone')
    await fill(X0, BOT, Z0, X0, ENTRY + 3, Z0, 'air')
    for (let y = BOT; y < ENTRY; y++) { await cmd(`/setblock ${X0} ${y} ${Z0} minecraft:ladder[facing=east]`, 60) }
  }
  await sleep(500)
  const spawn = bot.spawnPoint || { x: 0, z: 0 }
  const world = `spawn ${Math.floor(spawn.x)},${Math.floor(spawn.z)}`
  const sh = { id: 'lab-shaft', by: 'TrialA', entry: [X0, ENTRY, Z0], wall: [-1, 0], bottom: [X0, BOT, Z0], at: Date.now(), levels: [] }
  fs.writeFileSync(process.env.BOT_REGISTRY, JSON.stringify({ worlds: { [world]: { shafts: [sh], rooms: [] } } }))
  // ---- the bot: survival, at the shaft top, with the kit the routine needs
  await cmd('/clear @s'); await cmd(`/tp @s ${X0 + 1.5} ${ENTRY} ${Z0 + 0.5}`); await sleep(1500); await cmd('/gamemode survival')
  for (const g of ['stone_pickaxe 3', 'oak_planks 24', 'cobblestone 256', 'torch 16', 'hopper', 'chest 2', 'water_bucket 2', 'ladder 16', 'bread 16', 'stone_sword']) await cmd(`/give @s minecraft:${g}`, 100)
  await sleep(500)
  // ---- the real skills
  const apiStub = { safehand: { ensureSafeForMove: async () => {} }, statePath: (f) => path.join(TMP, f), say: () => {}, log: (t, m) => log(t, m), nav: null }
  const makeSkills = require('../../brain/autopilot/skills'), makeMining = require('../../brain/autopilot/mining')
  const S = makeSkills({ bot, api: apiStub, log })
  const M = makeMining(S, apiStub, log)
  const { goals } = S
  M.LD = require('../../brain/autopilot/ladder')(bot, S, goals, S.v, log)
  const G = { state: { mine: { ladder: true, shaft: sh.id } }, note: (m) => console.log('NOTE ' + m), save() {}, steps: [] }
  if (FROM) G.state.mobFarmBuild = { phase: FROM, shaft: sh.id, turn: 0, shift: 0, Y0: 14, Yp: 36, skip: [], fails: 0 }
  const F = require('../../brain/autopilot/mobfarmbuild')(G, S, M, apiStub, log)
  const t0 = Date.now()
  if (!args.includes('--skip-build')) {
    for (let i = 0; i < 8 && G.mobFarmBuild.status().phase !== 'done'; i++) {
      console.log('--- run', i + 1, JSON.stringify(G.mobFarmBuild.status()))
      try { await F.run() } catch (e) { console.log('RUN ERROR', e.stack || e.message) }
      if (bot.health <= 0) break
      await sleep(1000)
    }
  }
  const status = G.mobFarmBuild.status()
  console.log('BUILD', JSON.stringify(status), Math.round((Date.now() - t0) / 1000) + 's, health ' + bot.health)
  if (status.phase !== 'done') { bot.quit(); process.exit(2) }
  // ---- the farm, with zombies
  const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'mobfarm.json'), 'utf8'))
  console.log('CONFIG', JSON.stringify(cfg))
  const reg = JSON.parse(fs.readFileSync(process.env.BOT_REGISTRY, 'utf8')).worlds[world]
  console.log('ROOMS', JSON.stringify(reg.rooms.map(r => ({ id: r.id, type: r.type, y: r.y, platformY: r.platformY }))))
  const chestBlock = bot.blockAt(new Vec3(...cfg.chests[0])), hopperBlock = bot.blockAt(new Vec3(cfg.chests[0][0], cfg.chests[0][1] + 1, cfg.chests[0][2]))
  console.log('BLOCKS chest=' + (chestBlock && chestBlock.name) + ' hopper=' + (hopperBlock && hopperBlock.name) + ' slit=' + (bot.blockAt(new Vec3(cfg.killBox.x0 - 1, cfg.killSpot[1] + 1, cfg.killBox.z0)) || {}).name)
  await cmd('/difficulty normal')
  const P = cfg.platform
  // zombies on pads (row of 6 spread around the diamond)
  const pads = [[-5, 2], [-3, -4], [2, 3], [4, -2], [6, 1], [-6, -1], [1, -5], [3, 5], [-2, 4], [5, -3]].map(([dk, dj]) => [P.centre[0] + dk, P.centre[2] + dj])
  const pick = pads.slice(0, NZ)
  for (const [x, z] of pick) await cmd(`/summon minecraft:zombie ${x + 0.5} ${P.y} ${z + 0.5} {PersistenceRequired:1b,Tags:["lab"]}`, 200)
  const sinceLand = Date.now(); let landed = 0
  const hx = P.centre[0] + 0.5, hz = P.centre[2] + 0.5
  const mobfarm = require('../../brain/autopilot/mobfarm')(G, S, M, apiStub, log)
  G.steps.push(mobfarm)
  let kills = 0, hits = 0
  while (Date.now() - sinceLand < SECS * 1000) {
    await sleep(2000)
    const c = JSON.parse(fs.readFileSync(path.join(TMP, 'mobfarm.json'), 'utf8'))
    if (mobfarm.need()) { const r = await mobfarm.run(); console.log('MOBFARM run ->', r, JSON.stringify(G.state.mobFarm)); }
  }
  console.log('KILLS', JSON.stringify(G.state.mobFarm))
  out.length = 0; await sleep(300)
  await cmd(`/data get block ${cfg.chests[0].join(' ')} Items`, 700)
  console.log('CHEST', out.slice(-1)[0])
  console.log('HEALTH', bot.health)
  bot.quit(); process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
