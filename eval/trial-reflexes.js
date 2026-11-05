#!/usr/bin/env node
// Trial of P3 (profile + stance gate) and P4 (reflex leases) against a REAL (throwaway, offline) vanilla server, using the real brain modules.
//   node .claude/skills/trial-server/scripts/server.js setup --version 1.21.6 --port 25599 --ops TrialA --mode flat
//   node .claude/skills/trial-server/scripts/server.js start
//   node eval/trial-reflexes.js [port]            (from the repo root; prints one JSON line per check and "TRIAL RESULT: PASS|FAIL", exit code 0 on pass)
//   node .claude/skills/trial-server/scripts/server.js stop
// Never point this at the real world: it uses slash commands (the bot is op) and teleports.
// Checks: A reflexes register and combat holds `melee` while safety keeps its saved fight mode; B combat kills 3 zombies with safety never swinging;
//         C breath leases `body` in deep water and gets the head out; D safehand stows a lava bucket (hands lease granted); E the stance gate
//         (task: the autopilot cannot run even with ap.enabled = true; autonomous: it runs; the stance is saved in profile.json).
const fs = require('fs')
const os = require('os')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const PORT = Number(process.argv[2]) || 25599
const NAME = 'TrialA'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = {}) => { results.push({ name, ok: !!ok }); console.log(JSON.stringify({ check: name, ok: !!ok, ...detail })) }
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100) } return !!(await fn()) }

const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: NAME, version: '1.21.6' })
bot.loadPlugin(pathfinder)
bot.on('error', e => console.log('ERR', e.message))
bot.on('kicked', r => console.log('KICKED', JSON.stringify(r).slice(0, 200)))
const hardStop = setTimeout(() => { console.log('TRIAL RESULT: FAIL (timeout)'); process.exit(1) }, 240000)

bot.once('spawn', async () => {
  const cmd = async (c) => { bot.chat(c); await sleep(250) }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-reflex-'))
  const stateDir = path.join(tmp, 'state'); fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'profile.json'), JSON.stringify({ version: 1, name: NAME, role: 'hillclimber', stance: 'task', planner: { enabled: false } }))
  let brain
  try {
    await cmd('/gamerule doMobSpawning false'); await cmd('/gamerule doImmediateRespawn true'); await cmd('/gamemode survival')
    await cmd('/kill @e[type=!minecraft:player]'); await cmd('/clear @s'); await cmd('/time set 6000'); await cmd('/weather clear')
    await cmd('/give @s minecraft:iron_sword'); await cmd('/give @s minecraft:cobblestone 32'); await cmd('/give @s minecraft:cooked_beef 16')
    await sleep(500)
    const mv = new Movements(bot); mv.canDig = false; bot.pathfinder.setMovements(mv)
    const say = (t) => console.log('SAY', t)
    const root = path.join(__dirname, '..', 'brain')
    const only = ['safety', 'combat', 'breath', 'autopilot', 'mode']
    brain = require('../brain')({
      bot, say, goals, tryGoto: async (g) => { try { await bot.pathfinder.goto(g); return { ok: true, secs: 0 } } catch (e) { return { ok: false, err: e.message } } },
      stopNav: () => { try { bot.pathfinder.setGoal(null) } catch {} }, dir: tmp, stateDir, ownerName: NAME, handleCommand: () => false, jobs: {}, routines: { farm: false },
      saveRoutines() {}, navigateRaw() {}, navActive: () => false, stopAllLegacy() {}, sleepWanted: () => false,
      moduleEntries: only.map(n => ({ name: n, path: path.join(root, n, 'index.js') })), safetyCooldownMs: 1000, idleAfterMs: 1000
    })
    await sleep(1500)
    const R = brain.api.reflexes
    const names = () => R.status().reflexes.map(r => r.name)

    // ---- A: registry
    check('A reflexes registered', ['safety', 'combat', 'breath', 'safehand'].every(n => names().includes(n)), { names: names() })
    check('A combat holds melee for good', R.holder('melee') === 'combat', { leases: R.status().leases })
    const ss = brain.api.safety.status()
    check('A safety keeps its saved fight mode and sees combat holding melee', ss.mode === 'fight' && ss.meleeBy === 'combat', { mode: ss.mode, meleeBy: ss.meleeBy })

    // ---- E (first half): task stance gate. The autopilot must not run even when something sets ap.enabled = true.
    const ap = bot._ap
    ap.enabled = true
    await sleep(3000)
    const running = () => (brain.scheduler.status().running || {}).name
    check('E task stance: ap.active() is false with ap.enabled = true', ap.enabled === true && ap.active() === false && running() !== 'autopilot', { running: running() })

    // ---- B: combat vs 3 zombies
    const p = bot.entity.position.floored()
    const hp0 = bot.health
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6]]) await cmd(`/summon minecraft:zombie ${p.x + dx} ${p.y} ${p.z + dz} {PersistenceRequired:1b,IsBaby:0b}`)
    const zombies = () => Object.values(bot.entities).filter(e => e.name === 'zombie' && e.position.distanceTo(bot.entity.position) < 30).length
    let seen = 0
    await until(() => { seen = Math.max(seen, zombies()); return seen >= 3 }, 10000)         // non-vacuous: all three must really have appeared
    const killed = await until(() => zombies() === 0, 40000)
    const safetyGrants = R.status().reflexes.find(r => r.name === 'safety').grants
    check('B combat kills the 3 zombies', seen >= 3 && killed && bot.health > 0, { seen, hp0, hp: bot.health, left: zombies() })
    check('B safety never swung (no melee grants) and combat still holds melee', safetyGrants === 0 && R.holder('melee') === 'combat', { safetyGrants, holder: R.holder('melee') })

    // ---- C: breath in deep water (7x7 glass pool, 5 deep, open top); bot teleported to the bottom
    await cmd('/kill @e[type=!minecraft:player]'); await cmd('/effect clear @s')
    const g = p.y
    await cmd(`/fill ${p.x + 20} ${g - 1} ${p.z + 20} ${p.x + 28} ${g + 5} ${p.z + 28} minecraft:glass`)      // walls only up to the water surface: open top, there must be air to reach
    await cmd(`/fill ${p.x + 21} ${g} ${p.z + 21} ${p.x + 27} ${g + 5} ${p.z + 27} minecraft:water`)
    await cmd(`/fill ${p.x + 20} ${g + 6} ${p.z + 20} ${p.x + 28} ${g + 9} ${p.z + 28} minecraft:air`)
    await sleep(1500)
    await cmd(`/tp @s ${p.x + 24} ${g} ${p.z + 24}`)
    let sawBreath = false
    const headWet = () => { const b = bot.blockAt(bot.entity.position.offset(0, 1.62, 0)); return !!b && b.name === 'water' }
    const surfaced = await until(() => { if (R.holder('body') === 'breath') sawBreath = true; return !headWet() && bot.entity.position.y > g + 3 }, 40000)
    check('C breath leased the body and the head came out of the water', sawBreath && surfaced && bot.health > 0, { sawBreath, surfaced, hp: bot.health, y: bot.entity.position.y })
    await cmd(`/tp @s ${p.x} ${g} ${p.z}`); await sleep(1500)
    await sleep(3000)
    check('C body lease is free again on land', R.holder('body') === null, { holder: R.holder('body') })

    // ---- D: safehand
    await cmd('/give @s minecraft:lava_bucket'); await sleep(800)
    const lava = bot.inventory.items().find(i => i.name === 'lava_bucket')
    const before = R.status().reflexes.find(r => r.name === 'safehand').grants
    if (lava) await bot.equip(lava, 'hand').catch(() => {})
    await sleep(1200)
    const sh = R.status().reflexes.find(r => r.name === 'safehand')
    check('D safehand stowed the lava bucket and was granted hands', !!lava && !(bot.heldItem && bot.heldItem.name === 'lava_bucket') && sh.grants > before, { held: bot.heldItem && bot.heldItem.name, grants: sh.grants })

    // ---- E (second half): autonomous opens the gate and the stance is saved in profile.json
    const handled = brain.commands.dispatch(NAME, 'autonomous mode')
    const on = await until(() => ap.active() && running() === 'autopilot', 15000)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'profile.json'), 'utf8'))
    check('E autonomous stance: the "autonomous mode" chat command is handled, the autopilot runs and profile.json keeps the stance', handled === true && on && saved.stance === 'autonomous' && saved.name === NAME, { running: running(), saved })
    brain.commands.dispatch(NAME, 'task mode')
    const off = await until(() => !ap.active() && running() !== 'autopilot', 15000)
    check('E back to task stance: the autopilot stops', off, { running: running() })
  } catch (e) {
    check('trial ran without throwing', false, { error: e.stack })
  }
  try { brain && brain.stop() } catch {}
  const pass = results.length > 0 && results.every(r => r.ok)
  console.log(`TRIAL RESULT: ${pass ? 'PASS' : 'FAIL'} (${results.filter(r => r.ok).length}/${results.length})`)
  clearTimeout(hardStop)
  bot.quit(); setTimeout(() => process.exit(pass ? 0 : 1), 500)
})
