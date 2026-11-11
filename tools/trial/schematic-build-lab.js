#!/usr/bin/env node
// End-to-end lab for FOLLOWING A SCHEMATIC (brain/autopilot/schematicbuild.js + brain/schematic) on a throwaway vanilla server.
// A small farm-like room is built with commands in a block of stone (hopper over a chest, a slab, a trapdoor, a wall torch, a floor torch, a ladder, a water
// source; a hopper emptying sideways into a chest), captured as a schematic from the real world, the room is erased, and a survival bot with the real skills digs and builds it back from the schematic alone.
// The finish line is the diff against the world, nothing else.
//   node .claude/skills/trial-server/scripts/server.js start --minutes 40
//   node tools/trial/schematic-build-lab.js [--port 25599] [--minutes 12]
'use strict'
const os = require('os'), path = require('path'), fs = require('fs')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const PORT = +opt('port', 25599), MINUTES = +opt('minutes', 12)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'schbuild-'))
process.env.BOT_REGISTRY = path.join(TMP, 'registry.json')
process.env.BOT_SHARED = path.join(TMP, 'shared')
process.env.BOT_SCHEMATIC_CLAIM = path.join(TMP, 'claim.json')
fs.mkdirSync(path.join(process.env.BOT_SHARED, 'schematics'), { recursive: true })
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (t, m) => console.log('  [' + t + '] ' + m)

async function main() {
  const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialA', version: '1.21.6', auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej) })
  bot.on('death', () => console.log('!!! BOT DIED'))
  const cmd = async (c, ms = 120) => { bot.chat(c); await sleep(ms) }
  await bot.waitForChunksToLoad()
  await cmd('/gamemode creative'); await cmd('/gamerule doMobSpawning false'); await cmd('/difficulty peaceful'); await cmd('/time set 6000'); await cmd('/gamerule doDaylightCycle false')
  // ---- the rock: x 300..322, z 290..320, y -60..-42 stone; the hall at x 306..312, z 307..313, y -55..-51 (7 x 5 x 7)
  const X0 = 306, Z0 = 307, Y0 = -55
  await cmd('/tp @s 300 -40 300'); await sleep(2500)
  const fill = (a, b, c, d, e, f, blk, mode = '') => cmd(`/fill ${a} ${b} ${c} ${d} ${e} ${f} minecraft:${blk} ${mode}`.trim(), 250)
  await fill(300, -60, 290, 322, -42, 320, 'stone')
  await fill(X0, Y0, Z0, X0 + 6, Y0 + 4, Z0 + 6, 'air')
  const set = (x, y, z, b) => cmd(`/setblock ${x} ${y} ${z} minecraft:${b}`, 100)
  const cx = X0 + 3, cz = Z0 + 3
  await set(cx + 2, Y0, cz, 'chest[facing=north]'); await set(cx + 1, Y0, cz, 'hopper[facing=east]')      // a hopper emptying sideways into a chest, both on the hall floor
  await set(cx + 1, Y0 + 1, cz, 'cobblestone_slab[type=bottom]')                                          // a slab over the hopper
  await set(cx, Y0 + 3, Z0, 'oak_trapdoor[facing=south,half=top,open=true]')
  await set(cx + 1, Y0 + 2, Z0, 'wall_torch[facing=south]')
  await set(X0 + 6, Y0, Z0 + 6, 'torch')
  await set(X0, Y0 + 1, Z0, 'ladder[facing=south]'); await set(X0, Y0 + 2, Z0, 'ladder[facing=south]')
  await set(X0 + 6, Y0, Z0, 'water[level=0]')
  await sleep(1500)
  // ---- capture the design from the real world (the same reader the bot uses)
  const grid = require('../../brain/inspect/grid'), F = require('../../brain/schematic/format'), Sx = require('../../brain/schematic/store')
  const box = { x0: X0 - 1, y0: Y0 - 3, z0: Z0 - 1, x1: X0 + 7, y1: Y0 + 5, z1: Z0 + 7 }
  const get = grid.liveBlockAt(bot)
  const schem = F.capture((x, y, z) => get(x, y, z), box, { id: 'lab-hall', kind: 'mobfarm', surround: 0, seeds: [[cx, Y0 + 1, cz + 1]], source: { world: 'trial' } })
  schem.anchors = { killSpot: [cx, Y0, cz + 2], killBox: { x0: cx, x1: cx, y0: Y0, y1: Y0 + 1, z0: cz, z1: cz }, chests: [[cx + 2, Y0, cz]] }
  Sx.save(path.join(process.env.BOT_SHARED, 'schematics'), schem)
  const T0 = require('../../brain/schematic/follow').progress(schem, (x, y, z) => get(x, y, z), schem.origin)
  console.log('DESIGN', schem.size.join('x'), 'palette', schem.palette.length - 1, 'checked cells', T0.checked, 'complete', T0.complete, T0.pct + '%')
  if (!T0.complete) { console.log('the design is not its own answer key', T0.work.slice(0, 5)); process.exit(3) }
  // ---- erase the room and everything in it, leave a corridor from the south to the wall (x cx, z 300..Z0-2, y Y0 and Y0+1) for the bot to stand in
  await fill(X0 - 1, Y0 - 4, Z0 - 1, X0 + 7, Y0 + 6, Z0 + 7, 'stone')
  await fill(cx, Y0, 296, cx, Y0 + 1, Z0 - 2, 'air')                               // the corridor ends one cell short of the shell's wall (z Z0-1)
  await sleep(800)
  const D0 = require('../../brain/schematic/follow').progress(schem, (x, y, z) => get(x, y, z), schem.origin)
  console.log('AFTER ERASE', D0.pct + '%', JSON.stringify(D0.counts))
  // ---- the bot: survival, in the corridor, with what the build needs
  await cmd('/clear @s'); await cmd(`/tp @s ${cx + 0.5} ${Y0} 298.5`); await sleep(1500); await cmd('/gamemode survival')
  for (const g of ['stone_pickaxe 3', 'oak_planks 16', 'cobblestone 96', 'hopper', 'chest', 'cobblestone_slab 2', 'oak_trapdoor 2', 'torch 6', 'ladder 4', 'water_bucket', 'bread 16', 'stone_sword']) await cmd(`/give @s minecraft:${g}`, 100)
  await sleep(500)
  // ---- the real skills, the schematic module, the executor
  const apiStub = { safehand: { ensureSafeForMove: async () => {} }, statePath: (f) => path.join(TMP, f), say: () => {}, log: (t, m) => log(t, m), nav: null, registryFile: process.env.BOT_REGISTRY, now: () => Date.now() }
  fs.writeFileSync(process.env.BOT_REGISTRY, JSON.stringify({ worlds: { 'spawn 0,0': { shafts: [], rooms: [] } } }))
  bot.spawnPoint = { x: 0, z: 0 }
  const makeSkills = require('../../brain/autopilot/skills'), makeMining = require('../../brain/autopilot/mining')
  const S = makeSkills({ bot, api: apiStub, log })
  const M = makeMining(S, apiStub, log)
  M.LD = require('../../brain/autopilot/ladder')(bot, S, S.goals, S.v, log)
  const G = { state: {}, note: (m) => console.log('NOTE ' + m), save() {}, steps: [] }
  require('../../brain/autopilot/mobfarmbuild')(G, S, M, apiStub, log)
  const mod = require('../../brain/schematic')({ bot, now: () => Date.now(), log, statePath: apiStub.statePath, registryFile: process.env.BOT_REGISTRY })
  const step = require('../../brain/autopilot/schematicbuild')(G, S, M, apiStub, log)
  const j = bot._schematic.startJob({ kind: 'mobfarm', id: 'lab-hall', at: schem.origin, reason: 'lab' })
  if (!j.ok) { console.log('START FAILED', j.why); process.exit(4) }
  const t0 = Date.now()
  for (let i = 0; i < 6; i++) {
    const ok = await G.schematicBuild.run(MINUTES * 60000 / 3).catch(e => { console.log('RUN ERROR', e.stack || e.message); return false })
    const jb = bot._schematic.job()
    console.log('--- run', i + 1, 'ok', ok, jb.state, jb.pct + '%', 'off', jb.off, JSON.stringify(jb.counts || {}), 'first wrong', (jb.lastWrong || []).slice(0, 3))
    if (jb.state === 'complete' || bot.health <= 0 || Date.now() - t0 > MINUTES * 60000) break
  }
  const jb = bot._schematic.job()
  console.log('RESULT', jb.state, jb.pct + '%', 'in', Math.round((Date.now() - t0) / 1000) + 's', 'health', bot.health, 'stuck cells', JSON.stringify(G.state.schematicBuild && G.state.schematicBuild.stuck))
  const final = require('../../brain/schematic/follow').progress(schem, (x, y, z) => get(x, y, z), schem.origin)
  console.log('FINAL DIFF', final.pct + '%', 'off', final.off, JSON.stringify(final.counts), final.work.slice(0, 12).map(w => `${w.x},${w.y},${w.z} ${w.kind} want ${w.want} got ${w.got}`))
  const rooms = JSON.parse(fs.readFileSync(process.env.BOT_REGISTRY, 'utf8')).worlds['spawn 0,0'].rooms
  console.log('ROOMS', JSON.stringify(rooms.map(r => ({ id: r.id, type: r.type, schematic: r.schematic }))))
  console.log('MOBFARM.JSON', fs.existsSync(path.join(TMP, 'mobfarm.json')) ? fs.readFileSync(path.join(TMP, 'mobfarm.json'), 'utf8').replace(/\s+/g, ' ').slice(0, 300) : 'none')
  mod.stop && mod.stop(); bot.quit(); process.exit(jb.state === 'complete' ? 0 : 2)
}
main().catch(e => { console.error(e); process.exit(1) })
