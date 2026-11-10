// Tree farm lab: the lit birch lattice farm (brain/treefarm/farm.js) against a real vanilla 1.21.6 trial server, with the real engine, real
// brain/los.js line-of-sight rules, real safehand and a real mineflayer bot (pathfinder walks, placeBlock, dig, jump-and-place pillar).
// What the mock bench cannot prove and this does: the server accepts every sapling and torch placement, saplings on the lattice at spacing 4
// really grow into birch trees (random ticks), torch light is what lets them grow at night (an unlit control group does not), harvesting works
// with real physics, felled spots are replanted, torches survive, a natural tree beside the farm stays, and leaves give saplings by hand.
//
//   node .claude/skills/trial-server/scripts/server.js setup --version 1.21.6 --port 25599 --ops TrialA,TrialB --mode flat
//   node .claude/skills/trial-server/scripts/server.js start --minutes 30
//   node tools/treefarm-lab.js [--port 25599] [--out lab-out.json] [--only build,grow,harvest,leaves]
//   node .claude/skills/trial-server/scripts/server.js stop
//
// Trial server only (cheats are used to set up and to speed up random ticks); never point it at the real world.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const los = require('../brain/los')
const util = require('../brain/util')
const safehand = require('../brain/safehand')
const stateStore = require('../brain/treefarm/state')
const createEngine = require('../brain/treefarm/engine')
const L = require('../brain/treefarm/layout')
const baseConfig = require('../brain/treefarm/config.json')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d }
const PORT = Number(arg('port', 25599)), OUT = arg('out', null), ONLY = (arg('only', 'build,grow,harvest,leaves')).split(',')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = { startedAt: new Date().toISOString(), checks: [], notes: [] }
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`) }

const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialA', version: '1.21.6' })
bot.loadPlugin(pathfinder)
bot.on('error', e => console.log('ERR', e.message))
bot.on('kicked', r => console.log('KICKED', JSON.stringify(r).slice(0, 200)))
const serverLines = []
bot.on('messagestr', (m) => { if (/cannot|can't|unknown|incorrect|error/i.test(m)) serverLines.push(m) })

const cmd = async (c, ms = 250) => { bot.chat(c); await sleep(ms) }
const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
const name = (x, y, z) => { const b = at(x, y, z); return b ? b.name : null }
const countBag = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)

async function tryGoto(goal, label, ms = 30000) {
  const mv = new Movements(bot)
  mv.canDig = false; mv.allow1by1towers = false; mv.allowParkour = false; mv.scafoldingBlocks = []
  bot.pathfinder.setMovements(mv)
  let timer
  try {
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms) })
    await Promise.race([bot.pathfinder.goto(goal), t])
    return { ok: true }
  } catch (e) {
    try { bot.pathfinder.stop() } catch { /* idle */ }
    if (process.env.LAB_DEBUG) {
      const p = bot.pathfinder.getPathTo(mv, goal, 4000)
      const me = bot.entity.position.floored()
      console.log('  [goto failed]', JSON.stringify(bot.controlStates), 'onGround', bot.entity.onGround, 'vel', bot.entity.velocity.toString(), 'pos', bot.entity.position.toString(), 'path', JSON.stringify(p.path.slice(0, 4).map(n => [n.x, n.y, n.z])), label, e.message, 'status', p.status, 'visited', p.visitedNodes, 'goal', goal.x, goal.y, goal.z, 'bot', me.toString(), 'ring:', [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => `${name(me.x + dx, me.y, me.z + dz)}/${name(me.x + dx, me.y + 1, me.z + dz)}`).join(' '))
    }
    return { ok: false, err: e.message }
  } finally { clearTimeout(timer) }
}
const ctx = { state: {}, resumed: false, aborted: false, checkpoint() {}, progress() {}, onAbort: () => () => {}, sleep }

function makeEngine(say = (t) => results.notes.push(t)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tflab-'))
  const file = path.join(dir, 'treefarm-state.json')
  const state = stateStore.load({ file })
  const sh = safehand({ bot })
  const stop = () => { try { bot.pathfinder.stop() } catch { /* idle */ } }
  const cfg = { ...baseConfig, storage: [], keepLogs: 999, plantWaitMs: 200, dropWaitMs: 400, farm: { ...baseConfig.farm } }
  const engine = createEngine({
    bot, say, goals, tryGoto, safehand: sh, stopNav: stop,
    gotoNear: (o) => util.gotoNear({ bot, goals, tryGoto, stop, ...o }),
    canSee: (t) => los.canSee(bot, t),
    ensureLineOfSight: (o) => los.ensureLineOfSight({ bot, goals, tryGoto, stop, ...o }),
    depositSmeltables: null, requestChest: null, config: cfg, state, save: () => stateStore.save(file, state), sitesFn: () => state.sites,
    now: Date.now, log: (m) => { if (process.env.LAB_LOG) console.log('  [log]', m) }
  })
  return { engine, state, cfg }
}

async function reset() {
  await cmd('/gamemode survival'); await cmd('/clear @s'); await cmd('/kill @e[type=!minecraft:player]')
  await cmd('/gamerule doMobSpawning false'); await cmd('/gamerule doDaylightCycle false'); await cmd('/gamerule doImmediateRespawn true')
  await cmd('/gamerule randomTickSpeed 3'); await cmd('/time set 6000')
  await cmd('/tp @s 0.5 -60 0.5')
  await sleep(600)
  for (let y = -60; y <= -30; y += 3) await cmd(`/fill -45 ${y} -45 45 ${Math.min(y + 2, -30)} 45 air`, 350)      // the fill limit is 32768 blocks: slices
  await cmd('/fill -45 -61 -45 45 -61 45 grass_block', 600)
  await sleep(800)
}
const give = async (item, n) => cmd(`/give @s minecraft:${item} ${n}`)

async function grow(kind, x, z) {      // a natural birch (non-persistent leaves) from the game's own feature
  await cmd(`/place feature minecraft:${kind} ${x} -60 ${z}`, 500)
}
function scanLogs(x0, x1, z0, z1, nameRe = /_log$/) {
  const out = []
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = -60; y <= -40; y++) { const b = at(x, y, z); if (b && nameRe.test(b.name)) out.push([x, y, z]) }
  return out
}

bot.once('spawn', async () => {
  const t0 = Date.now()
  try {
    await sleep(1500)
    await reset()
    const { engine, state } = makeEngine()
    const farm = engine.farm

    // ---------------------------------------------------------------- a natural tree the farm must keep (placed first, so the site search sees it)
    await grow('birch', -17, 4)
    const natural0 = scanLogs(-20, -14, 1, 8)
    check('setup: a natural birch stands next to the farm area', natural0.length >= 4, `${natural0.length} logs`)

    // ---------------------------------------------------------------- build
    if (ONLY.includes('build') || ONLY.includes('grow') || ONLY.includes('harvest')) {
      await give('torch', 64); await give('birch_sapling', 4); await give('dirt', 24); await give('stone_axe', 1)
      await sleep(600)
      const tb = Date.now()
      const out = await farm.build(ctx, { home: { x: 0, y: -60, z: 0 }, quiet: true })
      check('build: a site was found and the farm recorded', out.ok && state.farms.length === 1, JSON.stringify({ planted: out.planted, lit: out.lit, needs: out.needs, why: out.why }))
      const f = state.farms[0]
      if (!f) throw new Error('no farm, cannot continue')
      results.farm = { x: f.x, y: f.y, z: f.z, cols: f.cols, rows: f.rows }
      const sp = L.spots(f)
      const saplings = sp.filter(s => name(s.x, s.y, s.z) === 'birch_sapling')
      check('build: 4 birch saplings on the lattice (period 4)', saplings.length === 4 && saplings.every(s => (s.x - f.x) % 4 === 0 && (s.z - f.z) % 4 === 0), `${saplings.length} planted, ${((Date.now() - tb) / 1000).toFixed(0)} s`)
      const torches = L.torchCells(f).filter(t => { for (let y = f.y - 1; y <= f.y + 1; y++) if (name(t.x, y, t.z) === 'torch') return true; return false })
      check('build: a torch in every square, ring included (20)', torches.length === 20, `${torches.length}`)
      check('build: nothing refused by the server', serverLines.length === 0, serverLines.slice(0, 3).join(' | '))
      const natural1 = scanLogs(-20, -14, 1, 8)
      check('build: the natural tree was not touched', natural1.length === natural0.length)
      const b = L.bounds(f)
      check('build: the farm does not overlap the natural tree', !(natural0.some(([x, , z]) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1)))
    }

    // ---------------------------------------------------------------- grow (night: only the torches give light)
    if (ONLY.includes('grow') && state.farms[0]) {
      const f = state.farms[0], sp = L.spots(f)
      // control: 4 saplings in the dark, same area, 24 blocks from any torch
      const ctl = [[30, 30], [34, 30], [30, 34], [34, 34]]
      for (const [x, z] of ctl) await cmd(`/setblock ${x} -60 ${z} minecraft:birch_sapling`, 120)
      await cmd('/time set 18000')
      // the rest of the lattice gets its saplings now, so the whole farm grows together
      await give('birch_sapling', 8); await sleep(400)
      const t1 = await farm.tend(ctx, { quiet: true })
      check('tend: the remaining lattice spots are planted', sp.filter(s => name(s.x, s.y, s.z) === 'birch_sapling').length + sp.filter(s => /_log$/.test(name(s.x, s.y, s.z) || '')).length === 12, JSON.stringify({ planted: t1[0] && t1[0].planted }))
      await cmd('/gamerule randomTickSpeed 1500')      // fast growth only once everything is planted (planting while trees shoot up round the bot is not what is under test)
      // wait for growth, bot stays away so it does not stand in a trunk column
      await tryGoto(new goals.GoalNear(f.x - 6, f.y, f.z - 4, 1), 'wait spot', 20000)
      // (the client's light numbers in mineflayer are not reliable, so light is judged by what the server does: lit saplings grow at night, the unlit control group does not)
      let grown = 0
      for (let i = 0; i < 80 && grown < 12; i++) { await sleep(2000); grown = sp.filter(s => /_log$/.test(name(s.x, s.y, s.z) || '')).length }
      check('grow: the lit lattice saplings grew into birch trees at night', grown >= 10, `${grown} of 12 grown`)
      const ctlGrown = ctl.filter(([x, z]) => /_log$/.test(name(x, -60, z) || '')).length
      check('control: the same saplings in the dark did NOT grow at night', ctlGrown === 0, `${ctlGrown} of 4 grew`)
      await cmd('/gamerule randomTickSpeed 3'); await cmd('/time set 6000')
      await sleep(500)
      const s = L.summarize(f, (x, y, z) => at(x, y, z))
      results.afterGrowth = s
      check('grow: the summary sees the trees', s.trees >= 10, JSON.stringify(s))
    }

    // ---------------------------------------------------------------- harvest
    if (ONLY.includes('harvest') && state.farms[0]) {
      const f = state.farms[0], sp = L.spots(f)
      const grownBefore = sp.filter(s => /_log$/.test(name(s.x, s.y, s.z) || '')).length
      if (grownBefore < 2) check('harvest: needs grown trees (run with grow)', false, `${grownBefore}`)
      else {
        const torchBefore = L.torchState(f, (x, y, z) => at(x, y, z)).filter(t => t.has).length
        await give('birch_sapling', 4)
        const logs0 = countBag('birch_log')
        const th = Date.now()
        const r = await farm.harvest(ctx, { logs: 14, count: 4 })
        const gained = countBag('birch_log') - logs0
        check('harvest: at least 14 logs from lattice trees only', gained >= 14, `${gained} logs in ${((Date.now() - th) / 1000).toFixed(0)} s, status ${r.status}`)
        const grownAfter = sp.filter(s => /_log$/.test(name(s.x, s.y, s.z) || '')).length
        check('harvest: felled trees are gone, others stand', grownAfter < grownBefore && grownAfter > 0, `${grownBefore} -> ${grownAfter}`)
        const replanted = sp.filter(s => name(s.x, s.y, s.z) === 'birch_sapling').length
        check('harvest: felled spots were replanted with birch', replanted >= grownBefore - grownAfter, `${replanted} saplings`)
        const torchAfter = L.torchState(f, (x, y, z) => at(x, y, z)).filter(t => t.has).length
        check('harvest: the torches survived', torchAfter === torchBefore, `${torchBefore} -> ${torchAfter}`)
        const natural = scanLogs(-20, -14, 1, 8)
        check('harvest: the natural birch next to the farm still stands', natural.length === natural0.length, `${natural.length}/${natural0.length}`)
        const itemEnts = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 30)
        const items = itemEnts.length
        check('harvest: no wanted item left lying on the ground (one resting high on a leaf is picked up on the next tend)', itemEnts.filter(e => e.position.y < -59.5).filter(e => { try { const n = e.getDroppedItem().name; return /_log$|sapling|stick|apple|dirt/.test(n) } catch { return true } }).length === 0, itemEnts.map(e => { try { return e.getDroppedItem().name + '@' + e.position.floored() } catch { return '?' } }).join(', ') || 'none')
        const stray = scanLogs(f.x - 6, f.x + 20, f.z - 6, f.z + 14).filter(([x, y, z]) => !sp.some(s => s.x === x && s.z === z))
        check('harvest: no stray logs, no dirt pillar left', stray.length === 0 && countBlocksNear(f, 'dirt') === 0, `${stray.length} stray logs`)
      }
    }

    // ---------------------------------------------------------------- saplings from leaves (the trunk stays)
    if (ONLY.includes('leaves')) {
      await cmd('/clear @s minecraft:birch_sapling'); await sleep(400)
      const trunkBefore = scanLogs(-20, -14, 1, 8)
      const f = state.farms[0] || L.makeFarm({ x: 0, y: -60, z: 0 })
      await tryGoto(new goals.GoalNear(-14, -60, 4, 2), 'to the birch', 30000)
      const tl = Date.now()
      const r = await farm.saplings(ctx, f, 2, {})
      const got = countBag('birch_sapling')
      results.leaves = { saplings: got, sources: r.sources, hint: r.hint, ms: Date.now() - tl, broken: state.stats.leavesBroken }
      check('leaves: a few leaves were broken by hand, at most 10 per tree (3 trees here)', state.stats.leavesBroken >= 1 && state.stats.leavesBroken <= 30, `${state.stats.leavesBroken} leaves, ${got} saplings (drop chance is 5% per leaf)`)
      check('leaves: the trunk stayed', scanLogs(-20, -14, 1, 8).length === trunkBefore.length)
    }
  } catch (e) {
    check('lab ran to the end', false, e.stack || e.message)
  }
  results.seconds = Math.round((Date.now() - t0) / 1000)
  const failed = results.checks.filter(c => !c.ok).length
  console.log(`\n${results.checks.length - failed} passed, ${failed} failed, ${results.seconds} s`)
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
  bot.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 500)
})

function countBlocksNear(f, nm) {
  let n = 0
  for (let x = f.x - 8; x <= f.x + 24; x++) for (let z = f.z - 8; z <= f.z + 16; z++) for (let y = -60; y <= -30; y++) if (name(x, y, z) === nm) n++
  return n
}
