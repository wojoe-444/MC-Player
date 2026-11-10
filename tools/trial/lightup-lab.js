#!/usr/bin/env node
// Lab for the light-up task (brain/autopilot/lightup.js) on a throwaway vanilla 1.21.6 server.
//   node .claude/skills/trial-server/scripts/server.js start --minutes 60
//   node tools/trial/lightup-lab.js [--port 25599] [--zombies 6] [--no-check] [--out result.json]
//
// A stone block holds (a) a sealed mob-farm platform (the diamond room, dark on purpose), (b) a rest corridor, (c) a cave system around it: four chambers,
// tunnels, a lower chamber reached by a staircase, a sealed pocket nobody can walk to, and two torches that already stand. The bot is a survival player with a
// stone sword, the real combat reflex and the real skills (S); zombies stand in two of the chambers. It runs G.lightUp.run() and the lab then judges the result
// with the SERVER's own light, not the client's model: a datapack predicate (location_check, light 0..0) is evaluated at sampled cells before and after.
//   - every cell the model called dark must be dark in vanilla before the run (the scan does not invent spots);
//   - cells the run lit must be lit in vanilla after; cells it left dark and the sealed pocket stay dark;
//   - the farm platform stays dark (no torch light reached it);
//   - torches keep the spacing rule (some axis differs by 3 or more) and no torch is put in the platform.
'use strict'
const os = require('os'), path = require('path'), fs = require('fs')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const PORT = +opt('port', 25599), NZ = +opt('zombies', 6), NC = +opt('creepers', 0), NS = +opt('static', 0), ABORT = +opt('abort-hp', 0), OUT = opt('out', null), CHECK = !args.includes('--no-check'), SAMPLE = +opt('sample', 90)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lightup-'))
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
  const chat = []; bot.on('messagestr', m => chat.push(m))
  let deaths = 0; bot.on('death', () => { deaths++; console.log('!!! BOT DIED') })
  bot.on('kicked', (r) => console.log('KICKED', r)); bot.on('error', (e) => console.log('ERR', e.message))
  const cmd = async (c, ms = 130) => { bot.chat(c); await sleep(ms) }
  await bot.waitForChunksToLoad()
  await cmd('/gamemode creative'); await cmd('/gamerule doMobSpawning false'); await cmd('/difficulty peaceful'); await cmd('/kill @e[type=!minecraft:player]')
  await cmd('/gamerule doDaylightCycle false'); await cmd('/time set 18000'); await cmd('/gamerule doImmediateRespawn true'); await cmd('/gamerule doMobLoot false')
  await cmd('/reload', 2500)

  // ---------------------------------------------------------------- the world
  const X0 = 200, X1 = 266, Z0 = -40, Z1 = 42, Y = 30
  const fill = (a, b, c, d, e, f, blk) => cmd(`/fill ${a} ${b} ${c} ${d} ${e} ${f} minecraft:${blk}`, 160)
  await cmd(`/tp @s ${X0 + 7} ${Y + 2} 0`); await sleep(2500)
  for (let y = 8; y <= 44; y += 4) await fill(X0 - 2, y, Z0, X1, Math.min(44, y + 3), Z1, 'stone')      // /fill takes 32768 blocks at most
  const air = (x0, y0, z0, x1, y1, z1) => fill(Math.min(x0, x1), y0, Math.min(z0, z1), Math.max(x0, x1), y1, Math.max(z0, z1), 'air')
  // the platform: diamond |dx|+|dz| <= 9 around (230, 0), two high at y30..31, floor y29 (the hole cell is (230,29,0))
  const HX = 230, HZ = 0, R = 9
  for (let dz = -R; dz <= R; dz++) { const w = R - Math.abs(dz); await air(HX - w, Y, HZ + dz, HX + w, Y + 1, HZ + dz) }
  // the rest corridor and the cave system
  await air(205, Y, 0, 210, Y + 1, 0)                       // rest corridor (rest cell 207,30,0), sealed from the platform by rock (x 211..220)
  await air(206, Y, -26, 206, Y + 1, 0)                     // north tunnel
  await air(200, Y, -34, 215, Y + 2, -22)                   // chamber A
  await air(216, Y, -28, 248, Y + 1, -28)                   // east tunnel north of the platform
  await air(249, Y, -34, 262, Y + 3, -20)                   // chamber B
  await air(206, Y, 0, 206, Y + 1, 24)                      // south tunnel
  await air(200, Y, 25, 214, Y + 1, 36)                     // chamber C
  for (let s = 0; s < 10; s++) await air(215 + s, Y - s, 30, 215 + s, Y - s + 2, 30)      // staircase down, one step per block east, 3 high (walking off a ledge needs the head room one level up)
  await air(225, Y - 10, 26, 240, Y - 8, 34)                // chamber E (lower, y20..22)
  await air(245, Y, 15, 250, Y + 1, 19)                     // sealed pocket F
  // two torches that already stand (on the floor, cells y30)
  await cmd(`/setblock 206 ${Y} -10 minecraft:torch`); await cmd(`/setblock 225 ${Y} -28 minecraft:torch`)
  await sleep(500)

  // ---------------------------------------------------------------- the config the real farm would have written
  const cfg = { builder: 'mobfarmbuild', platform: { y: Y, centre: [HX, Y - 1, HZ], radius: R }, rest: [207, Y, 0], killSpot: [HX - 3, Y - 22, HZ], killBox: { x0: HX, x1: HX, y0: Y - 22, y1: Y - 21, z0: HZ, z1: HZ }, chests: [[HX, Y - 24, HZ]] }
  fs.writeFileSync(path.join(TMP, 'mobfarm.json'), JSON.stringify(cfg))

  // ---------------------------------------------------------------- the bot: survival, stone sword, torches, the real combat reflex and skills
  await cmd('/clear @s'); await cmd(`/tp @s 207.5 ${Y} 0.5`); await sleep(1500); await cmd('/gamemode survival')
  for (const g of ['stone_sword', 'torch 48', 'bread 16', 'cobblestone 32', 'shield']) await cmd(`/give @s minecraft:${g}`, 100)
  await cmd('/effect give @s minecraft:resistance 1 0 true')
  const reflex = require('../../brain/combat/reflex')
  bot._combat = reflex.create(bot, { yieldIdle: true, idleSprint: false }, {})
  const apiStub = { safehand: { ensureSafeForMove: async () => {} }, statePath: (f) => path.join(TMP, f), say: () => {}, log: (t, m) => log(t, m), nav: null }
  const makeSkills = require('../../brain/autopilot/skills'), makeMining = require('../../brain/autopilot/mining')
  const S = makeSkills({ bot, api: apiStub, log })
  const M = makeMining(S, apiStub, log)
  const G = { state: {}, note: (m) => console.log('NOTE ' + m), save() {}, steps: [] }
  const step = require('../../brain/autopilot/lightup')(G, S, M, apiStub, log)
  await sleep(1000)

  // ---------------------------------------------------------------- vanilla light by predicate
  const vanillaDark = async (cells) => {
    const found = new Set(); const seen = []
    const onMsg = (m) => { const q = /DARK (-?\d+) (-?\d+) (-?\d+)/.exec(m); if (q) found.add(q[1] + ',' + q[2] + ',' + q[3]) }
    bot.on('messagestr', onMsg)
    for (const c of cells) { bot.chat(`/execute positioned ${c[0]} ${c[1]} ${c[2]} if predicate lab:dark run say DARK ${c[0]} ${c[1]} ${c[2]}`); seen.push(c); await sleep(110) }
    await sleep(600); bot.removeListener('messagestr', onMsg)
    return found
  }
  const sampleOf = (arr, n) => { const out = [], a = arr.slice(); while (out.length < n && a.length) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); return out }
  const L = require('../../brain/autopilot/light')
  const P = require('../../brain/lightup/plan'), makeWorld = require('../../brain/lightup/world')
  const centre = [HX, Y - 1, HZ]
  const model = async () => {
    const Lb = L(bot, Vec3), lv = await Lb.compute(new Vec3(...centre), 56, 40), w = makeWorld(bot, Vec3, Lb, lv)
    return { w, sc: await P.scan(w, centre, { r: 56, dy: 40, exclude: () => false }) }
  }

  // ---------------------------------------------------------------- before
  const before = await G.lightUp.scan({ r: 56 })
  console.log('SCAN BEFORE', JSON.stringify(before))
  const m0 = await model()
  const inPlatform = (c) => Math.abs(c[0] - HX) + Math.abs(c[2] - HZ) <= R && c[1] >= Y && c[1] <= Y + 1
  const darkAll = m0.sc.cells
  const platformCells = darkAll.filter(inPlatform), caveCells = darkAll.filter(c => !inPlatform(c))
  console.log('model dark cells', darkAll.length, '(platform', platformCells.length, ', caves', caveCells.length + ')')
  let checkBefore = null
  if (CHECK) {
    const sample = sampleOf(caveCells, SAMPLE)
    const dk = await vanillaDark(sample)
    checkBefore = { sampled: sample.length, vanillaDark: sample.filter(c => dk.has(c.join(','))).length }
    console.log('VANILLA BEFORE: of', sample.length, 'model-dark cave cells', checkBefore.vanillaDark, 'are dark in vanilla')
  }

  // ---------------------------------------------------------------- zombies in chamber A and the lower chamber E
  await cmd('/difficulty normal')
  // some right beside the first torch spots the plan chose (a mob standing on the spot is the case the dance exists for), the rest in chamber A and the lower chamber
  const near = (before.sample || []).slice(0, 3).map(c => [c[0] + 2, c[1], c[2] + 1])
  const zs = [...near, [204, Y, -30], [210, Y, -26], [230, Y - 10, 28], [236, Y - 10, 32], [212, Y, -32], [202, Y, -24]].slice(0, NZ)
  for (const [x, y, z] of zs) await cmd(`/summon minecraft:zombie ${x + 0.5} ${y} ${z + 0.5} {PersistenceRequired:1b,CanPickUpLoot:0b}`, 200)
  // creepers beside the later torch spots (chamber A tunnel mouth and chamber B): the bot must keep away and come back to those spots later
  await cmd('/gamerule mobGriefing false')
  for (const [x, y, z] of [[208, Y, -26], [252, Y, -26], [208, Y, 28]].slice(0, NC)) await cmd(`/summon minecraft:creeper ${x + 0.5} ${y} ${z + 0.5} {PersistenceRequired:1b}`, 200)
  // frozen creepers (NoAI, cannot explode or move) right beside torch spots: the spot must be postponed, tried again later, and the bot falls back when it is the last one
  for (const c of (args.includes('--static-first') ? [before.sample[4]] : (before.sample || []).slice(1, 1 + NS))) await cmd(`/summon minecraft:creeper ${c[0] + 1.5} ${c[1]} ${c[2] + 0.5} {PersistenceRequired:1b,NoAI:1b}`, 200)
  await sleep(1000)

  // ---------------------------------------------------------------- the run
  const hp0 = bot.health, t0 = Date.now()
  let minHp = bot.health; const hpTimer = setInterval(() => { if (bot.health < minHp) minHp = bot.health }, 100)
  let res = null
  try { res = await G.lightUp.run({ r: 56, ...(ABORT ? { abortHealth: ABORT, minHealth: 5 } : {}) }) } catch (e) { console.log('RUN ERROR', e.stack || e.message) }
  const secs = Math.round((Date.now() - t0) / 1000); clearInterval(hpTimer)
  const zombiesLeft = Object.values(bot.entities).filter(e => e && (e.name === 'zombie' || e.name === 'creeper')).length
  console.log('COMBAT', JSON.stringify(bot._combat.stats || {}), 'min health', minHp, 'zombies still alive', zombiesLeft)
  console.log('RUN', JSON.stringify(res), secs + 's', 'health', bot.health, 'deaths', deaths)
  bot._combat.stop()
  await cmd('/kill @e[type=!minecraft:player]'); await sleep(500)

  // ---------------------------------------------------------------- after: judge by the model and by vanilla
  const torchCells = bot.findBlocks({ matching: (b) => b && /^(torch|wall_torch)$/.test(b.name), point: new Vec3(...centre), maxDistance: 80, count: 500 }).map(t => [t.x, t.y, t.z])
  const spacingBad = []
  for (let i = 0; i < torchCells.length; i++) for (let j = i + 1; j < torchCells.length; j++) { const a = torchCells[i], b = torchCells[j]; if (Math.abs(a[0] - b[0]) < 3 && Math.abs(a[1] - b[1]) < 3 && Math.abs(a[2] - b[2]) < 3) spacingBad.push([a, b]) }
  const torchInPlatform = torchCells.filter(inPlatform)
  const m1 = await model()
  const after = m1.sc.cells
  const afterCave = after.filter(c => !inPlatform(c))
  const sealedF = afterCave.filter(c => c[0] >= 245 && c[0] <= 250 && c[2] >= 15 && c[2] <= 19)
  console.log('torches now', torchCells.length, 'spacing violations', spacingBad.length, 'in platform', torchInPlatform.length)
  console.log('model dark after: caves', afterCave.length, '(sealed pocket', sealedF.length + ')', 'platform', after.filter(inPlatform).length, 'of', platformCells.length)
  let checkAfter = null
  if (CHECK) {
    const key = c => c.join(',')
    const afterSet = new Set(after.map(key))
    const lit = sampleOf(caveCells.filter(c => !afterSet.has(key(c))), SAMPLE)          // the model says these got light
    const stillDark = sampleOf(afterCave.filter(c => !sealedF.some(s => key(s) === key(c))), 20)
    const plat = sampleOf(platformCells, 25), pocket = sampleOf(sealedF, 10)
    const dk = await vanillaDark([...lit, ...stillDark, ...plat, ...pocket])
    checkAfter = {
      lit: { sampled: lit.length, darkInVanilla: lit.filter(c => dk.has(key(c))).length },
      stillDark: { sampled: stillDark.length, darkInVanilla: stillDark.filter(c => dk.has(key(c))).length },
      platform: { sampled: plat.length, darkInVanilla: plat.filter(c => dk.has(key(c))).length },
      sealedPocket: { sampled: pocket.length, darkInVanilla: pocket.filter(c => dk.has(key(c))).length },
    }
    console.log('VANILLA AFTER', JSON.stringify(checkAfter))
  }
  const summary = { static: NS, abortHp: ABORT, endPos: bot.entity.position.toString(), zombies: NZ, creepers: NC, secs, hp0, hpEnd: bot.health, minHp, zombiesLeft, combat: bot._combat.stats || null, deaths, run: res, before, modelDarkBefore: darkAll.length, platformCells: platformCells.length, caveDarkBefore: caveCells.length, caveDarkAfter: afterCave.length, sealedLeft: sealedF.length, platformDarkAfter: after.filter(inPlatform).length, torches: torchCells.length, spacingViolations: spacingBad.length, torchInPlatform: torchInPlatform.length, checkBefore, checkAfter }
  console.log('SUMMARY ' + JSON.stringify(summary))
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(summary, null, 1))
  bot.quit()
  const okVanilla = !CHECK || (checkAfter.lit.darkInVanilla === 0 && checkAfter.platform.darkInVanilla === checkAfter.platform.sampled && checkBefore.vanillaDark === checkBefore.sampled)
  process.exit(deaths === 0 && spacingBad.length === 0 && torchInPlatform.length === 0 && summary.platformDarkAfter === platformCells.length && okVanilla ? 0 : 3)
}
main().catch(e => { console.log('LAB ERROR', e.stack || e.message); process.exit(1) })
