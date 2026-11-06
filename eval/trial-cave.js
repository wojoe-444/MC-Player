#!/usr/bin/env node
// Cave-fight trial on a REAL (throwaway, offline) vanilla server with the real brain modules (safety, combat, breath, optionally the autopilot).
// Reproduces the 2026-11-05 cave deaths: point-blank skeleton, zombie swarm plus creeper, creeper in a corridor, with the bot holding a pickaxe or bread.
//   node .claude/skills/trial-server/scripts/server.js setup --version 1.21.6 --port 25599 --ops TrialA --mode flat
//   node .claude/skills/trial-server/scripts/server.js start --minutes 12
//   node eval/trial-cave.js [port] [scenario,scenario|all] [--runs N] [--ap] [--out file.jsonl]
//   node .claude/skills/trial-server/scripts/server.js stop
// Never point this at the real world: it uses slash commands (the bot is op), teleports and fills blocks.
// Prints one JSON line per run (survived, min hp, kills, seconds to first swing, items held, who held the body lease) and a summary.
// Exit code 0 when every run survived and never dropped below 6 hp, 1 otherwise.
const fs = require('fs')
const os = require('os')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const argv = process.argv.slice(2)
const flag = (k) => argv.includes('--' + k)
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(runs|out|mods)$/.test(argv[i - 1])))
const PORT = Number(pos[0]) || 25599
const WANT = (pos[1] || 'all').split(',')
const RUNS = Number(opt('runs', '1'))
const OUT = opt('out', null)
const AP = flag('ap')
const NAME = 'TrialA'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---- scenarios -------------------------------------------------------------------------------------------------------------------------------
// Geometry (all relative to the corridor origin O = floor cell of the bot): a stone slab 40 x 40 x 8 with a straight corridor (1 wide, 2 high) along +x
// from x=-6 to x=+24, a 9x9x4 chamber at the far end (x 25..33), and an optional side pocket. The bot stands in the corridor at x=0.
// mob = [type, dx, dz, nbt]; held = hotbar item in hand when the fight starts; hp = health to start with; shield = shield in the off hand.
const SK = ',HandItems:[{id:"minecraft:bow",count:1},{}]'
const SCEN = {
  // 16:11: one skeleton 1-4 blocks away in a corridor, bot holding the pickaxe, full iron, sword in the bag
  'skel-point-blank': { mobs: [['skeleton', 3, 0]], held: 'pickaxe', hp: 20, desc: 'skeleton 3 blocks away in a 1-wide corridor, pickaxe in hand' },
  'skel-adjacent': { mobs: [['skeleton', 1, 0]], held: 'pickaxe', hp: 20, desc: 'skeleton right next to the bot' },
  'skel-bread': { mobs: [['skeleton', 4, 0]], held: 'bread', hp: 14, desc: 'bread in hand at 14 hp, skeleton 4 blocks away' },
  'skel-chamber': { mobs: [['skeleton', 9, 0]], held: 'pickaxe', hp: 20, bot: [26, 0], desc: 'skeleton 9 blocks away across the open chamber' },
  // 17:13: the iron sword had just been crafted and lay in the main inventory with a full hotbar; holdSlot() only knows hotbar slots
  'skel-sword-inv': { mobs: [['skeleton', 3, 0]], held: 'pickaxe', hp: 20, swordIn: 'inv', desc: 'sword only in the main inventory (hotbar full), skeleton 3 blocks away' },
  'zombies-sword-inv': { mobs: [['zombie', 5, 0], ['zombie', 7, 0], ['zombie', 9, 0]], held: 'pickaxe', hp: 17, swordIn: 'inv', desc: 'sword only in the main inventory, three zombies' },
  // 17:46 and 18:21: a creeper walked up to a bot with a stone sword and no shield and blew it up from full health (18:21 had no armor either)
  'creeper-open-bare': { mobs: [['creeper', 9, 0]], held: 'sword', hp: 20, bot: [27, 0], noArmor: true, sword: 'stone_sword', desc: 'one creeper across the open chamber, stone sword, no armor, no shield (18:21)' },
  'creeper-open-bare-pick': { mobs: [['creeper', 9, 0]], held: 'pickaxe', hp: 20, bot: [27, 0], noArmor: true, sword: 'stone_sword', desc: 'same, pickaxe in hand' },
  'skel-far': { mobs: [['skeleton', 12, 0]], held: 'pickaxe', hp: 20, desc: 'skeleton 12 blocks away with a clear line down the corridor, pickaxe in hand' },
  'skel-far-hurt': { mobs: [['skeleton', 12, 0]], held: 'bread', hp: 11, desc: 'skeleton 12 blocks away, bot hurt (11 hp) with bread in hand' },
  'skel-two': { mobs: [['skeleton', 3, 0], ['skeleton', 7, 0]], held: 'pickaxe', hp: 20, desc: 'two skeletons in the corridor' },
  // 17:13: zombie group walking up a corridor while the bot mines with an iron pickaxe
  'zombies-4': { mobs: [['zombie', 5, 0], ['zombie', 7, 0], ['zombie', 9, 0], ['zombie', 11, 0]], held: 'pickaxe', hp: 17, desc: 'four zombies walking up the corridor, pickaxe in hand' },
  'zombies-creeper': { mobs: [['zombie', 5, 0], ['zombie', 7, 0], ['zombie', 9, 0], ['creeper', 11, 0]], held: 'pickaxe', hp: 17, desc: 'three zombies and a creeper behind them' },
  // 17:46 and 18:21: a creeper walks up while the bot is busy, no shield
  'creeper-corridor': { mobs: [['creeper', 8, 0]], held: 'pickaxe', hp: 20, desc: 'creeper in a corridor, no shield' },
  'creeper-two': { mobs: [['creeper', 7, 0], ['creeper', 10, 0]], held: 'sword', hp: 20, desc: 'two creepers one after another, sword in hand' },
  'creeper-zombie': { mobs: [['creeper', 6, 0], ['zombie', 4, 0], ['zombie', 8, 0]], held: 'bread', hp: 20, desc: 'creeper plus zombies, bread in hand' },
}

function pick(list) { return WANT.includes('all') ? list : list.filter(n => WANT.includes(n)) }

const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: NAME, version: '1.21.6' })
bot.loadPlugin(pathfinder)
bot.on('error', e => console.log('ERR', e.message))
bot.on('kicked', r => console.log('KICKED', JSON.stringify(r).slice(0, 200)))
const hardStop = setTimeout(() => { console.log('TRIAL RESULT: FAIL (timeout)'); process.exit(1) }, 25 * 60000)

bot.once('spawn', async () => {
  const cmd = async (c) => { bot.chat(c); await sleep(220) }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-cave-'))
  const stateDir = path.join(tmp, 'state'); fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'profile.json'), JSON.stringify({ version: 1, name: NAME, role: 'hillclimber', stance: AP ? 'autonomous' : 'task', planner: { enabled: false } }))
  const summary = []
  let brain
  try {
    await cmd('/gamerule doMobSpawning false'); await cmd('/gamerule doImmediateRespawn true'); await cmd('/gamemode survival')
    await cmd('/kill @e[type=!minecraft:player]'); await cmd('/time set 18000'); await cmd('/weather clear'); await cmd('/difficulty hard')
    await sleep(500)
    const base = bot.entity.position.floored()
    // slab is built well away from spawn, on the flat surface
    const O = { x: base.x + 10, y: base.y, z: base.z + 10 }   // O = the floor cell (feet) of the corridor at its x=0
    const say = (t) => console.log('SAY', t)
    const mv = new Movements(bot); mv.canDig = false; bot.pathfinder.setMovements(mv)
    const root = path.join(__dirname, '..', 'brain')
    const only = ['safety', 'combat', 'breath', 'mode'].concat(AP ? ['autopilot'] : [])
    brain = require('../brain')({
      bot, say, goals, tryGoto: async (g) => { try { await bot.pathfinder.goto(g); return { ok: true, secs: 0 } } catch (e) { return { ok: false, err: e.message } } },
      stopNav: () => { try { bot.pathfinder.setGoal(null) } catch {} }, dir: tmp, stateDir, ownerName: NAME, handleCommand: () => false, jobs: {}, routines: { farm: false },
      saveRoutines() {}, navigateRaw() {}, navActive: () => false, stopAllLegacy() {}, sleepWanted: () => false,
      moduleEntries: only.map(n => ({ name: n, path: path.join(root, n, 'index.js') })), safetyCooldownMs: 1000, idleAfterMs: 1000
    })
    const R = brain.api.reflexes

    // ---- build the cave once
    const f = (x1, y1, z1, x2, y2, z2, b) => cmd(`/fill ${O.x + x1} ${O.y + y1} ${O.z + z1} ${O.x + x2} ${O.y + y2} ${O.z + z2} ${b}`)
    await f(-12, -1, -20, 40, 8, 20, 'minecraft:stone')                    // slab (floor row y=-1 stays stone too)
    const carve = async () => {
      await f(-8, 0, 0, 24, 1, 0, 'minecraft:air')                          // corridor
      await f(25, 0, -4, 37, 3, 4, 'minecraft:air')                         // chamber
      await f(-9, 0, 0, -9, 1, 0, 'minecraft:stone')                        // dead end behind the bot
      await f(-8, 2, -1, 24, 2, 1, 'minecraft:stone'); await f(-8, 0, -1, 24, 1, -1, 'minecraft:stone'); await f(-8, 0, 1, 24, 1, 1, 'minecraft:stone')   // walls rebuilt after the previous run
    }
    await carve()
    await cmd('/forceload add ' + (O.x - 12) + ' ' + (O.z - 20) + ' ' + (O.x + 40) + ' ' + (O.z + 20))
    await sleep(800)

    const names = pick(Object.keys(SCEN))
    for (const name of names) for (let run = 1; run <= RUNS; run++) {
      const S = SCEN[name]
      // ---- reset
      await cmd('/kill @e[type=!minecraft:player]'); await cmd('/effect clear @s'); await carve()
      const bx = (S.bot ? S.bot[0] : 0), bz = (S.bot ? S.bot[1] : 0)
      for (let k = 0; k < 4; k++) {           // a death between runs (a late creeper blast) respawns the bot at the world spawn: tp back and check
        await cmd(`/tp @s ${O.x + bx + 0.5} ${O.y} ${O.z + bz + 0.5} -90 0`); await sleep(500)
        const q = bot.entity.position
        if (bot.health > 0 && Math.abs(q.x - (O.x + bx + 0.5)) < 1.5 && Math.abs(q.z - (O.z + bz + 0.5)) < 1.5) break
      }
      await cmd('/clear @s')
      await cmd('/effect give @s minecraft:saturation 5 10 true'); await cmd('/effect give @s minecraft:instant_health 1 20 true')
      if (!S.noArmor) for (const [slot, id] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']]) await cmd(`/item replace entity @s ${slot} with minecraft:${id}`)
      if (S.shield !== false) await cmd('/item replace entity @s weapon.offhand with minecraft:air')
      // hotbar: 0 pickaxe, 1 sword, 2 bread, 3 cobblestone; the "held" item is selected
      await cmd('/item replace entity @s hotbar.0 with minecraft:iron_pickaxe')
      if (S.swordIn === 'inv') { for (let h = 4; h < 9; h++) await cmd(`/item replace entity @s hotbar.${h} with minecraft:dirt 64`); await cmd('/item replace entity @s inventory.3 with minecraft:iron_sword') }
      else await cmd(`/item replace entity @s hotbar.1 with minecraft:${S.sword || 'iron_sword'}`)
      await cmd('/item replace entity @s hotbar.2 with minecraft:bread 16'); await cmd('/item replace entity @s hotbar.3 with minecraft:cobblestone 32')
      await sleep(600)
      bot.setQuickBarSlot({ pickaxe: 0, sword: 1, bread: 2 }[S.held])
      await sleep(300)
      if (S.hp < 20) { await cmd(`/damage @s ${20 - S.hp} minecraft:generic`); await sleep(500) }
      // wait out the invulnerability and make sure we are standing on the right cell
      await sleep(1500)
      const lines0 = (() => { try { return fs.readFileSync(path.join(tmp, 'idle.log'), 'utf8').split('\n').length } catch { return 0 } })()
      const combat0 = brain.api.combat ? { ...brain.api.combat.stats } : {}
      // ---- spawn the mobs and watch
      for (const [type, dx, dz] of S.mobs) {
        const nbt = type === 'skeleton' ? '{PersistenceRequired:1b' + SK + '}' : '{PersistenceRequired:1b}'
        await cmd(`/summon minecraft:${type} ${O.x + (S.bot ? S.bot[0] : 0) + dx + 0.5} ${O.y} ${O.z + (S.bot ? S.bot[1] : 0) + dz + 0.5} ${nbt}`)
      }
      const t0 = Date.now()
      const held = []; let minHp = bot.health, deadAt = null, hp0 = bot.health, firstSwingAt = null, lastHeld = null, bodyBy = new Set(), meleeNear = 0, firstMeleeNear = null
      const hostiles = () => Object.values(bot.entities).filter(e => e !== bot.entity && e.position && /^(zombie|skeleton|creeper|spider)$/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 40)
      bot.once('death', () => { deadAt = (Date.now() - t0) / 1000 })
      const onArm = (e) => { if (e === bot.entity && firstSwingAt === null) firstSwingAt = (Date.now() - t0) / 1000 }
      bot.on('entitySwing', onArm)
      const swingsBefore = () => (brain.api.combat ? brain.api.combat.stats.swings : 0)
      const sw0 = swingsBefore()
      const LIMIT = Number(opt('secs', '40')) * 1000
      let quietSince = null, lastPh = '', phases = []
      while (Date.now() - t0 < LIMIT) {
        await sleep(100)
        if (bot.health > 0) minHp = Math.min(minHp, bot.health)
        const h = bot.heldItem ? bot.heldItem.name : 'none'
        if (h !== lastHeld) { held.push([+((Date.now() - t0) / 1000).toFixed(1), h]); lastHeld = h }
        const b = R.holder('body'); if (b) bodyBy.add(b)
        try { const ss = brain.api.safety.status(); const ph = (ss.entombed ? 'ENT ' : '') + (ss.wantEntomb ? 'wantEnt ' : '') + ss.action; if (ph !== lastPh) { lastPh = ph; phases.push([+((Date.now() - t0) / 1000).toFixed(1), ph, +bot.health.toFixed(1)]) } } catch {}
        const hs = hostiles(); const near = hs.reduce((m, e) => Math.min(m, e.position.distanceTo(bot.entity.position)), 99)
        if (near < 3 && firstMeleeNear === null) firstMeleeNear = (Date.now() - t0) / 1000
        if (deadAt !== null) break
        if (hs.length === 0) { if (quietSince === null) quietSince = Date.now(); if (Date.now() - quietSince > 2500) break } else quietSince = null
      }
      bot.removeListener('entitySwing', onArm)
      const left = hostiles().length
      const me = bot.entity.position.floored()
      const solid = (dx, dy, dz) => { const b = bot.blockAt(me.offset(dx, dy, dz)); return !!b && b.boundingBox === 'block' }
      const placed = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].filter(([dx, dy, dz]) => { const b = bot.blockAt(me.offset(dx, dy, dz)); return b && b.name === 'cobblestone' }).length
      const nearestEnd = hostiles().reduce((m, e) => Math.min(m, +e.position.distanceTo(bot.entity.position).toFixed(1)), 99)
      const swings = swingsBefore() - sw0
      let log = []; try { log = fs.readFileSync(path.join(tmp, 'idle.log'), 'utf8').split('\n').slice(lines0).filter(l => /combat|safety|SCHED|REFLEX|entomb|yield/i.test(l)).map(l => l.slice(11, 140)) } catch {}
      const rec = { scenario: name, run, survived: deadAt === null && bot.health > 0, deadAt, minHp: +minHp.toFixed(1), startHp: +hp0.toFixed(1), left, nearestEnd: left ? nearestEnd : null, sealed: placed >= 1, swings, firstSwingAt, firstMeleeNear, held: held.slice(0, 14), phases: phases.slice(0, 16), body: [...bodyBy], combatEvents: (brain.api.combat ? brain.api.combat.events.slice(-6).map(e => e.type + (e.mob ? ':' + e.mob : '')) : []), log: log.slice(0, 25) }
      console.log(JSON.stringify(rec)); summary.push(rec)
      if (OUT) fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n')
      await cmd('/kill @e[type=!minecraft:player]'); await sleep(1200)
    }
  } catch (e) { console.log('FATAL', e.stack) }
  try { brain && brain.stop() } catch {}
  const bad = summary.filter(r => !r.survived || r.minHp < 6)   // a death, or a close call (mobs still standing at the end are fine: skeletons wander off)
  console.log('SUMMARY ' + summary.map(r => `${r.scenario}#${r.run}:${r.survived ? 'ok' : 'DEAD'} minHp=${r.minHp} swings=${r.swings} left=${r.left}`).join(' | '))
  console.log(`TRIAL RESULT: ${summary.length && !bad.length ? 'PASS' : 'FAIL'} (${summary.length - bad.length}/${summary.length})`)
  clearTimeout(hardStop)
  bot.quit(); setTimeout(() => process.exit(summary.length && !bad.length ? 0 : 1), 500)
})
