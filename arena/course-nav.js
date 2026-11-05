// Probe job: can the bot walk the obstacle course from the white block to the red block with NO mobs? Pure pathfinding, no digging or placing.
// Params via env-free defaults; returns { success, timeSec, samples, stuck, statuses }.
const fs = require('fs'), path = require('path')
const START = { x: -65, y: -60, z: 8 }, FINISH = { x: -104, y: -60, z: 46 }
module.exports = async function (bot, cmd, sleep) {
  const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
  if (!bot.pathfinder) bot.loadPlugin(pathfinder)
  const mv = new Movements(bot)
  mv.canDig = false; mv.allow1by1towers = false; mv.allowParkour = true; mv.allowSprinting = true; mv.scafoldingBlocks = []; mv.maxDropDown = 3
  mv.canOpenDoors = true
  bot.pathfinder.setMovements(mv); bot.pathfinder.thinkTimeout = 10000; bot.pathfinder.tickTimeout = 40
  const results = []
  for (let run = 0; run < 3; run++) {
    cmd('/gamemode creative'); cmd('/kill @e[type=!minecraft:player]'); cmd(`/tp @s ${START.x} ${START.y} ${START.z} 0 0`); await sleep(2500); cmd('/gamemode survival'); await sleep(800)
    const statuses = [], samples = [], stuck = []
    const onPath = (r) => statuses.push(r.status + (r.path ? ':' + r.path.length : ''))
    bot.on('path_update', onPath)
    const t0 = Date.now(); let last = bot.entity.position.clone(), lastMove = Date.now(), success = false
    bot.pathfinder.setGoal(new goals.GoalNear(FINISH.x + 0.5, FINISH.y, FINISH.z + 0.5, 1.8))
    while (Date.now() - t0 < 180000) {
      await sleep(500)
      const p = bot.entity.position, d = Math.hypot(p.x - FINISH.x, p.z - FINISH.z)
      if (samples.length === 0 || Date.now() - t0 >= samples.length * 2000) samples.push([Math.round((Date.now() - t0) / 1000), +p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)])
      if (d < 2.2 && Math.abs(p.y - FINISH.y) < 2.5) { success = true; break }
      if (p.distanceTo(last) > 0.6) { last = p.clone(); lastMove = Date.now() } else if (Date.now() - lastMove > 10000) { stuck.push([Math.round((Date.now() - t0) / 1000), +p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)]); lastMove = Date.now(); bot.pathfinder.setGoal(new goals.GoalNear(FINISH.x + 0.5, FINISH.y, FINISH.z + 0.5, 1.8)) }
      if (bot.health <= 0) break
    }
    bot.pathfinder.setGoal(null); bot.clearControlStates(); bot.removeListener('path_update', onPath)
    results.push({ run, success, timeSec: +((Date.now() - t0) / 1000).toFixed(1), end: bot.entity.position, hp: bot.health, stuck, statuses: statuses.slice(0, 40), samples })
    if (!success) break
  }
  cmd('/gamemode creative'); await sleep(500)
  return results
}
