#!/usr/bin/env node
// Mob farm physics lab (ROADMAP Phase 2 item 8). Builds the farm from brain/mobfarm/geometry.js with /fill on a throwaway server, then checks what
// the design promises, in vanilla physics:
//   1. water: the trench settles with the last flowing cell next to the hole and NO water in the drop column
//   2. flow: zombies put on the pads walk into the trench, are carried into the hole and fall to the landing cell
//   3. fall damage: how many HP a 20 HP mob has left on landing (the XP kill is the bot's), for the configured drop
//   4. kill: the bot hits a landed mob through the slit from K, and the drops end up in the chest through the hopper
//   node .claude/skills/trial-server/scripts/server.js start --minutes 30
//   node tools/trial/mobfarm-lab.js [--port 25599] [--drop 22] [--zombies 8] [--secs 150]
'use strict'
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const G = require('../../brain/mobfarm/geometry')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const PORT = +opt('port', 25599), DROP = +opt('drop', 22), NZ = +opt('zombies', 8), SECS = +opt('secs', 150)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialA', version: '1.21.6', auth: 'offline' })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej) })
  const out = []
  bot.on('messagestr', (m) => out.push(m))
  const cmd = async (c, ms = 120) => { bot.chat(c); await sleep(ms) }
  await bot.waitForChunksToLoad()
  await cmd('/gamemode creative'); await cmd('/gamerule doMobSpawning false'); await cmd('/difficulty normal'); await cmd('/gamerule doMobLoot true'); await cmd('/time set 18000')
  await cmd('/tp @s 0.5 -60 0.5'); await sleep(2000)
  const ox = 40, oz = 0, Yp = -20
  const L = G.layout({ ox, oz, d: [1, 0], yPlatform: Yp }, { drop: DROP })
  const B = L.box
  // stone block around the farm, then carve
  const fill = async (x0, y0, z0, x1, y1, z1, b) => cmd(`/fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} minecraft:${b}`, 150)
  // load the area first (teleport over the middle)
  await cmd(`/tp @s ${ox + 10} ${Yp + 4} ${oz}`); await sleep(2500)
  await fill(B.x0 - 2, B.y0 - 3, B.z0 - 2, B.x1 + 2, B.y1 + 4, B.z1 + 2, 'stone')
  // runs of cells -> fill commands
  const runs = (cells) => {
    const m = new Map(); for (const c of cells) m.set(G.key(c), c)
    const done = new Set(), res = []
    for (const c of cells) {
      if (done.has(G.key(c))) continue
      let z1 = c[2]; while (m.has(`${c[0]},${c[1]},${z1 + 1}`) && !done.has(`${c[0]},${c[1]},${z1 + 1}`)) z1++
      for (let z = c[2]; z <= z1; z++) done.add(`${c[0]},${c[1]},${z}`)
      res.push([c[0], c[1], c[2], c[0], c[1], z1])
    }
    return res
  }
  for (const r of runs(L.dig)) await fill(...r, 'air')
  await cmd(`/setblock ${L.chamber.chest.join(' ')} minecraft:chest`)
  await cmd(`/setblock ${L.chamber.hopper.join(' ')} minecraft:hopper[facing=down]`)
  // dark: no light anywhere (the lab room is sealed)
  const flowers = L.platform.sources
  for (const s of L.platform.sources) await cmd(`/setblock ${s.join(' ')} minecraft:water`, 200)
  await sleep(6000)
  // 1. water
  const wlev = G.waterLevels(L)
  const lab = {}
  const got = (c) => { const b = bot.blockAt(new Vec3(...c)); return b ? b.name : '?' }
  lab.holeWater = got(L.platform.hole)
  lab.columnWater = L.column.filter(c => /water/.test(got(c))).length
  lab.trenchWet = L.platform.trench.filter(c => got(c) === 'water').length + '/' + L.platform.trench.length
  const lvl = (c) => { const b = bot.blockAt(new Vec3(...c)); return b && b.name === 'water' ? b.metadata : null }
  lab.levelsNextToHole = [lvl(L.at(L.kc, 1, Yp - 1)), lvl(L.at(L.kc, -1, Yp - 1))]
  console.log('WATER', JSON.stringify(lab))
  // 2/3. zombies on random pads
  const pads = L.platform.pads.filter(c => Math.abs(c[2] - oz) >= 1 || Math.abs(c[0] - L.at(L.kc, 0, 0)[0]) >= 2)
  const rnd = (() => { let s = 4444; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 })()
  const picks = []; while (picks.length < NZ) { const c = pads[Math.floor(rnd() * pads.length)]; if (!picks.some(q => q === c)) picks.push(c) }
  // stand the bot at K (it hears nothing from the platform: no line of sight)
  await cmd(`/tp @s ${L.chamber.K[0] + 0.5} ${L.chamber.K[1]} ${L.chamber.K[2] + 0.5}`); await sleep(1500)
  await cmd('/gamemode survival')
  for (const c of picks) await cmd(`/summon minecraft:zombie ${c[0] + 0.5} ${Yp} ${c[2] + 0.5} {PersistenceRequired:1b,Tags:["lab"],CanBreakDoors:0b}`, 200)
  const t0 = Date.now(), seen = new Map(), landed = new Map()
  const hole = L.at(L.kc, 0, 0)
  while (Date.now() - t0 < SECS * 1000) {
    await sleep(250)
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'zombie') continue
      const p = e.position, s = seen.get(e.id) || { first: Date.now() - t0, minY: p.y }
      s.minY = Math.min(s.minY, p.y); s.last = p.clone(); seen.set(e.id, s)
      if (Math.abs(p.x - (hole[0] + 0.5)) < 0.8 && Math.abs(p.z - (hole[2] + 0.5)) < 0.8 && p.y < Yp - 3 && !s.inCol) s.inCol = Date.now() - t0
      if (p.y < L.Y0 + 0.5 && Math.abs(p.x - (hole[0] + 0.5)) < 0.8 && !landed.has(e.id)) landed.set(e.id, Date.now() - t0)
    }
    if (landed.size >= NZ) break
  }
  console.log('FLOW', JSON.stringify({ zombies: seen.size, enteredColumn: [...seen.values()].filter(s => s.inCol).length, landed: landed.size, landedAtSecs: [...landed.values()].map(t => Math.round(t / 1000)) }))
  // 4. kill through the slit and check the chest
  const K = L.chamber.K
  const inPocket = () => Object.values(bot.entities).filter(e => e.name === 'zombie' && Math.abs(e.position.x - (hole[0] + 0.5)) < 0.8 && Math.abs(e.position.z - (hole[2] + 0.5)) < 0.8 && e.position.y < L.Y0 + 1.5)
  const hp = (e) => { const m = (e.metadata || []).find(x => typeof x === 'number' && x <= 20 && x >= 0 && !Number.isInteger(x)); return m }
  let kill = { tried: 0, killed: 0, hpOnLanding: [], dists: [] }
  for (let round = 0; round < 12; round++) {
    const t = inPocket()[0]; if (!t) { await sleep(1000); continue }
    kill.tried++; kill.hpOnLanding.push(hp(t)); kill.dists.push(+t.position.distanceTo(bot.entity.position.offset(0, 1.62, 0)).toFixed(2))
    for (let i = 0; i < 12 && bot.entities[t.id]; i++) { await bot.lookAt(t.position.offset(0, 1.2, 0), true); bot.attack(t); await sleep(700) }
    if (!bot.entities[t.id]) kill.killed++
    await sleep(1500)
  }
  await sleep(3000)
  out.length = 0
  await cmd(`/data get block ${L.chamber.chest.join(' ')} Items`, 800)
  kill.chest = out.slice(-2).join(' | ')
  console.log('MSGS', JSON.stringify(out.slice(-4)))
  console.log('KILL', JSON.stringify(kill))
  bot.quit()
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
