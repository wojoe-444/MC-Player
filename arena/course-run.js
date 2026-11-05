// Obstacle-course eval runner (job type "courseRun"). White block (start) -> red block (finish), fixed mob placements, combat layer + waypoint navigation.
// Job: { label, courseRun: true, n, module, params, kit, mobs: 'none'|'T1'|'T2'|..., capSec }. Appends one row per run to results/trials.jsonl (row.course = {...}).
const fs = require('fs'), path = require('path')
const { Vec3 } = require('vec3')
const START = { x: -65, y: -60, z: 8 }, FINISH = { x: -104, y: -60, z: 46 }
// waypoints from a successful walk of the course: the pathfinder always has a complete path to the next one
// the ladder-and-wall section is left to the pathfinder: planning it in one go worked, but intermediate goals up the ladder did not
const WP = [[-83.4, -60, 9.2], [-90.7, -60, 8.7], [-98.5, -59.1, 13.7], [-98.7, -59.3, 15.6], [-93.4, -58.7, 19.9], [-87.2, -58.8, 23.5], [-78.1, -60, 23.8], [-70, -60, 28.9], [-61.5, -60, 34.2], [-66.9, -60.2, 40.8], [-76.5, -60, 42], [-77.5, -58.5, 35.5], [-77.7, -51, 32.8], [-80.5, -53.7, 35.9], [-79.6, -59.2, 37.2], [-87.9, -60, 43.5], [-97.1, -60, 46.5], [FINISH.x + 0.5, FINISH.y, FINISH.z + 0.5]]
const ROUTE = [[START.x, START.z], ...WP.map(w => [w[0], w[2]])]
const SEG = ROUTE.slice(1).map((p, i) => Math.hypot(p[0] - ROUTE[i][0], p[1] - ROUTE[i][1])), TOTAL = SEG.reduce((a, b) => a + b, 0)
const progressAt = (wi, p) => { // fraction of route length covered: completed waypoints plus partial along the current leg
  let done = SEG.slice(0, wi).reduce((a, b) => a + b, 0); if (wi < SEG.length) { const a = ROUTE[wi], b = ROUTE[wi + 1], L = SEG[wi]; const t = Math.max(0, Math.min(1, ((p.x - a[0]) * (b[0] - a[0]) + (p.z - a[1]) * (b[1] - a[1])) / (L * L))); done += t * L }
  return Math.min(1, done / TOTAL)
}
// fixed mob placements (x, z; feet at y=-60). Room 1 is the start room (x -69..-61, z 4..13).
const R1 = [['zombie', -61.5, 4.5], ['zombie', -68.5, 4.5], ['zombie', -61.5, 11.5], ['zombie', -68.5, 11.5], ['zombie', -65.0, 12.8], ['zombie', -65.0, 4.2], ['skeleton', -61.5, 8.0], ['skeleton', -68.5, 8.0], ['skeleton', -63.0, 12.8], ['creeper', -68.5, 12.5], ['spider', -62.5, 6.5]]   // 11 mobs, none closer than 3 blocks to the start (-65, 8)
const REST = [['zombie', -90.5, 8.5], ['zombie', -85.5, 6.5], ['zombie', -80.5, 10.5], ['skeleton', -78.5, 5.5], ['skeleton', -95.5, 6.5], ['spider', -92.5, 11.5],
  ['zombie', -92.5, 20.5], ['zombie', -85.5, 26.5], ['zombie', -75.5, 19.5], ['zombie', -68.5, 24.5], ['zombie', -64.5, 30.5], ['skeleton', -95.5, 28.5], ['skeleton', -72.5, 29.5], ['creeper', -80.5, 22.5],
  ['zombie', -66.5, 44.5], ['zombie', -72.5, 46.5], ['zombie', -88.5, 44.5], ['skeleton', -95.5, 40.5], ['skeleton', -68.5, 40.5], ['creeper', -80.5, 45.5]]
// difficulty ladder with mobs spread evenly along the route: about 3 zombies + 1 skeleton per section, a spider or creeper here and there
const E1 = [['zombie', -61.5, 12.5], ['skeleton', -68.5, 4.5],                                                                                       // start room: light (it is only 9 blocks wide, so every mob in it is on the bot within a second)
  ['zombie', -90.5, 8.5], ['zombie', -85.5, 6.5], ['zombie', -80.5, 10.5], ['skeleton', -78.5, 5.5], ['spider', -92.5, 11.5],                       // top corridor
  ['zombie', -95.5, 20.5], ['zombie', -92.5, 28.5], ['zombie', -88.5, 24.5], ['skeleton', -96.5, 31.5],                                              // mid band west
  ['zombie', -75.5, 19.5], ['zombie', -68.5, 24.5], ['zombie', -64.5, 30.5], ['skeleton', -72.5, 29.5], ['creeper', -80.5, 22.5],                  // mid band east
  ['zombie', -66.5, 44.5], ['zombie', -70.5, 38.5], ['zombie', -72.5, 46.5], ['skeleton', -68.5, 40.5],                                             // south band east
  ['zombie', -88.5, 44.5], ['zombie', -95.5, 40.5], ['zombie', -84.5, 40.5], ['skeleton', -92.5, 46.5], ['creeper', -88.5, 38.5], ['spider', -98.5, 44.5]]  // south band west, near the finish
const jitter = (list, dx, dz) => list.map(([m, x, z]) => [m, x + dx, z + dz])
const E2 = E1.concat(jitter(E1, 1.2, 1.2))
const E3 = E2.concat(jitter(E1, -1.2, 1.2))
const TIERS = { none: [], R1: R1, T1: R1.concat(REST), REST: REST, E1, E2, E3 }
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0 }

module.exports = async function (bot, cmd, sleep, job) {
  const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
  if (!bot.pathfinder) bot.loadPlugin(pathfinder)
  const mv = new Movements(bot); mv.canDig = false; mv.allow1by1towers = false; mv.allowParkour = true; mv.allowSprinting = true; mv.scafoldingBlocks = []; mv.maxDropDown = 3; mv.canOpenDoors = true
  bot.pathfinder.setMovements(mv); bot.pathfinder.thinkTimeout = 20000; bot.pathfinder.tickTimeout = 50
  for (const k of Object.keys(require.cache)) if (k.startsWith(__dirname) && /combat|threat/.test(k)) delete require.cache[k]
  const combatMod = require('./' + (job.module || 'combat_v3'))
  const rows = []
  const cmds = async (...a) => { for (const c of a) cmd(c); await sleep(120 * a.length + 200) }
  for (let i = 0; i < (job.n || 1); i++) {
    const idx = (job.idxStart || 0) + i, t0w = Date.now()
    await cmds('/gamemode creative', '/kill @e[type=!minecraft:player]', '/clear @s', '/effect clear @s', '/time set 18000')
    const st = job.startAt || [START.x, START.y, START.z]
    await cmds(`/tp @s ${st[0]} ${st[1]} ${st[2]} 0 0`)
    await cmds('/item replace entity @s weapon.offhand with minecraft:shield', '/give @s minecraft:iron_sword', '/give @s minecraft:bow', '/give @s minecraft:arrow 64', '/give @s minecraft:baked_potato 64', '/effect give @s minecraft:instant_health 1 10 true', '/effect give @s minecraft:saturation 1 10 true')
    if (job.kit && job.kit.armor) for (const [s, it] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) cmd(`/item replace entity @s armor.${s} with minecraft:iron_${it}`)
    const mobs = TIERS[job.mobs || 'none'] || []
    for (const [m, x, z] of mobs) cmd(`/summon minecraft:${m} ${x} -60 ${z} {PersistenceRequired:1b}`)
    await sleep(300 + mobs.length * 130); await sleep(1200)
    cmd('/gamemode survival'); await sleep(700)
    let dead = false, deathAt = 0, cause = null
    const onDeath = () => { dead = true; deathAt = Date.now() }; bot.once('death', onDeath)
    let dmg = 0, last = bot.health; const dmgBy = {}
    const onHealth = () => { if (bot.health < last) dmg += last - bot.health; last = bot.health }; bot.on('health', onHealth)
    const params = { ...(job.params || {}), yieldIdle: true, idleSprint: false, rngSeed: 4242 + idx }
    let wiRef = 0
    const combat = combatMod.create(bot, params, { routeDir: () => { const t = WP[Math.min(wiRef, WP.length - 1)], q = bot.entity.position, dx = t[0] - q.x, dz = t[2] - q.z, n = Math.hypot(dx, dz); return n > 1 ? { x: dx / n, z: dz / n } : null } })
    let wi = job.startWi || 0, best = 0, engagedPrev = false, lastGoalAt = 0, goalSet = false, diving = false
    const rad = (i) => i === WP.length - 1 ? 1.8 : (i >= 12 && i <= 14 ? 1.9 : 1.6)
    const goalFor = () => new goals.GoalNear(WP[wi][0], WP[wi][1], WP[wi][2], rad(wi))
    const t0 = Date.now(), cap = (job.capSec || 150) * 1000
    const samples = [], debugs = []
    const statuses = []; const onPath = (r) => { statuses.push(r.status + (r.path ? ':' + r.path.length : '')); if (statuses.length > 40) statuses.shift() }; bot.on('path_update', onPath)
    let finished = false, lastMove = Date.now(), lastPos = bot.entity.position.clone(), stuckEvents = 0
    while (!dead && Date.now() - t0 < cap) {
      await sleep(100)
      const p = bot.entity.position; wiRef = wi
      const engaged = combat.engaged && combat.engaged()
      if (engaged) { if (!engagedPrev) { bot.pathfinder.stop(); stuckEvents += 0 } lastMove = Date.now() }
      else if (engagedPrev || !goalSet) { bot.pathfinder.setGoal(goalFor()); lastGoalAt = Date.now(); goalSet = true }   // never re-issue the goal mid-walk: that restarts the plan and drops the bot off ladders
      engagedPrev = !!engaged
      if (!engaged && !diving && !bot.pathfinder.goal && wi < WP.length) { bot.pathfinder.setGoal(goalFor()); lastGoalAt = Date.now() }   // the pathfinder drops its goal after a noPath or a goal-reached; never leave the bot without one
      // water chamber: swimming up-and-down (the pathfinder jumps) never gets out; hold sneak to sink to the bottom, then carry on
      // tower roof: the pathfinder will not plan the 8-block drop down the 1-wide hole, so walk to the hole (-80,33) and step in; the shaft drops into the water chamber
      const onRoof = p.x > -82.6 && p.x < -76.4 && p.z > 30.5 && p.z < 34.4 && p.y > -52.4 && p.y < -50.4
      if (wi >= 12 && wi <= 13 && onRoof && !engaged) {
        if (!diving) { bot.pathfinder.stop(); diving = true }
        bot.setControlState('jump', false); bot.setControlState('sprint', false); bot.setControlState('sneak', false)
        bot.lookAt(new Vec3(-79.7, p.y + 1.6, p.z < 33.0 ? 33.5 : 35.6), true)
        bot.setControlState('forward', true)
        continue
      }
      // out of the chamber (south of the pool, on the plate row): the tower section is done, skip its remaining waypoints
      if (wi >= 12 && wi <= 14 && p.y < -59 && p.z > 37.5 && p.x > -84.5 && p.x < -78) { wi = 15; bot.pathfinder.setGoal(goalFor()); lastGoalAt = Date.now(); diving = false; bot.setControlState('forward', false) }
      // chamber floor: after sinking, walk south along the bottom onto the plate row and out (z >= 37.7), then hand back to the pathfinder
      const inChamber = p.x > -82.7 && p.x < -79.3 && p.z > 34.6 && p.z < 37.7 && p.y < -58.9
      if (wi >= 12 && wi <= 15 && inChamber && !engaged) {
        if (!diving) { bot.pathfinder.stop(); diving = true }
        bot.setControlState('sprint', false); bot.setControlState('sneak', false); bot.setControlState('jump', false)
        bot.lookAt(new Vec3(-81.4, p.y + 0.4, 38.8), true); bot.setControlState('forward', true)
        continue
      }
      const inShaft = p.x > -83 && p.x < -79.2 && p.z > 34.5 && p.z < 37.6 && p.y > -57.5 && p.y < -49.5
      if (wi >= 13 && wi <= 15 && p.y > -59.4 && !engaged && (bot.entity.isInWater || inShaft)) {
        if (!diving) { bot.pathfinder.stop(); diving = true }
        bot.setControlState('jump', false); bot.setControlState('sprint', false)
        if (bot.entity.isInWater) { bot.setControlState('forward', false); bot.setControlState('sneak', true) }                 // sink to the bottom
        else { bot.setControlState('sneak', false); bot.lookAt(new Vec3(-80.5, p.y + 1.6, 36.2), true); bot.setControlState('forward', Math.hypot(p.x + 80.5, p.z - 36.2) > 0.5) }   // step off the ledge into the water
        continue
      }
      else if (diving) { diving = false; bot.setControlState('sneak', false); bot.setControlState('forward', false); bot.pathfinder.setGoal(goalFor()); lastGoalAt = Date.now() }
      if (wi < WP.length && Math.hypot(p.x - WP[wi][0], p.z - WP[wi][2]) < rad(wi) + 0.7 && Math.abs(p.y - WP[wi][1]) < (WP[wi][1] > -59 ? 2.2 : 3.5)) { wi++; if (wi >= WP.length) { finished = true; break } bot.pathfinder.setGoal(goalFor()); lastGoalAt = Date.now() }
      best = Math.max(best, progressAt(wi, p))
      if (wi === 15 && samples.length * 3000 <= Date.now() - t0 && !job.noDebug) { const bl = bot.blockAt(p.offset(0, -0.5, 0)), cs = bot.controlState; debugs.push({ t: Math.round((Date.now() - t0) / 1000), below: bl && bl.name, inWater: bot.entity.isInWater, moving: bot.pathfinder.isMoving && bot.pathfinder.isMoving(), cs: Object.keys(cs).filter(k => cs[k]).join('+'), goal: bot.pathfinder.goal ? 'set' : 'none', vel: [+bot.entity.velocity.x.toFixed(2), +bot.entity.velocity.y.toFixed(2), +bot.entity.velocity.z.toFixed(2)] }); if (debugs.length > 12) debugs.shift() }
      if (samples.length * 3000 <= Date.now() - t0) samples.push([Math.round((Date.now() - t0) / 1000), +p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1), wi, engaged ? 1 : 0, +bot.health.toFixed(0)])
      if (!engaged) { if (p.distanceTo(lastPos) > 0.6) { lastPos = p.clone(); lastMove = Date.now() } else if (Date.now() - lastMove > 12000) { stuckEvents++; lastMove = Date.now(); wi = Math.max(0, wi - 1); bot.pathfinder.setGoal(goalFor()) } }
    }
    const timeSec = (Math.min(dead ? deathAt : Date.now(), Date.now()) - t0) / 1000
    bot.pathfinder.setGoal(null); bot.pathfinder.stop(); bot.clearControlStates(); combat.stop()
    bot.removeListener('path_update', onPath); bot.removeListener('health', onHealth); bot.removeListener('death', onDeath)
    if (dead) { await sleep(700) }
    const progress = Math.round((finished ? 1 : best) * 100)
    const score = progress + (finished ? 100 - Math.min(100, timeSec / 3) : 0) - 0.3 * dmg
    const row = { label: job.label, idx, ts: new Date().toISOString(), survivedSec: +timeSec.toFixed(1), died: dead, cause: dead ? 'died on the course' : (finished ? null : 'timeout'), kills: combat.stats.kills, damage: +dmg.toFixed(1), dmgBy, kit: job.kit || { armor: false }, params: job.params || {}, course: { cap: job.capSec || 150, mobs: job.mobs || 'none', progress, finished, timeSec: +timeSec.toFixed(1), stuckEvents, score: +score.toFixed(1), wi, samples, statuses, debugs }, stats: combat.stats, events: (combat.events || []).slice(-30) }
    fs.appendFileSync(path.join(__dirname, 'results', 'trials.jsonl'), JSON.stringify(row) + '\n')
    rows.push(row)
    cmd('/gamemode creative'); cmd('/kill @e[type=!minecraft:player]'); await sleep(900)
  }
  cmd('/gamemode creative')
  return rows.map(r => ({ idx: r.idx, finished: r.course.finished, progress: r.course.progress, timeSec: r.course.timeSec, dmg: r.damage, kills: r.kills, stuck: r.course.stuckEvents }))
}
