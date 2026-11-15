// Work order flag-stuck: the bot stays put while the pathfinder and the controls are active. The stuck monitor (brain/nav/stuck.js) pushes
// at an obstacle, gives up, and then goes on pushing: (1) a go-to that the navigator finished (stop, abort, timeout) while a recovery
// maneuver ran was resumed when the maneuver ended; (2) the last rung ("giving up") left the pathfinder goal set, so the same wall
// was pushed at again, episode after episode.
const test = require('node:test')
const assert = require('node:assert')
const { rig, goals } = require('./nav.helpers')

const flat = (s) => s.floor(-5, -5, 40, 20, 63)
const wall = (s) => { flat(s); for (let z = -5; z <= 20; z++) { s.hide(5, 64, z); s.hide(5, 65, z) } }      // an invisible wall across the whole area
const G = (x, y, z) => new goals.GoalBlock(x, y, z)

test('after giving up, the stuck monitor releases the goal: the bot does not keep pushing at the wall', async () => {
  const r = await rig({}, wall)
  let failed = false
  r.nav.stuck.on('stuck-fail', () => { failed = true })
  r.bot.pathfinder.setGoal(G(10, 64, 0))                                    // a goal with no go-to behind it
  await r.sim.run(() => failed, 1000)
  assert.ok(failed, 'the monitor gave up')
  const episodes = r.nav.stuck.stats.episodes
  await r.sim.run(null, 400)
  assert.strictEqual(r.bot.pathfinder.goal, null, 'the goal is still set after giving up')
  assert.strictEqual(r.nav.stuck.stats.episodes, episodes, 'the bot went on pushing at the wall after giving up')
  r.close()
})

test('a go-to stopped while a recovery maneuver runs stays stopped: the maneuver does not resume it', async () => {
  const r = await rig({}, wall)
  let res = null
  r.nav.goto(G(10, 64, 0), { ms: 60000 }).then(x => { res = x })
  await r.sim.run(() => r.nav.stuck.maneuvering, 400)                       // the monitor is jumping / backing up at the wall
  r.nav.stop('stop test')
  await r.sim.run(() => !r.nav.stuck.maneuvering, 200)                      // the maneuver ends
  const episodes = r.nav.stuck.stats.episodes
  await r.sim.run(null, 300)
  assert.ok(res && res.err === 'stop test', JSON.stringify(res))
  assert.strictEqual(r.bot.pathfinder.goal, null, 'the stopped go-to was resumed after the maneuver')
  assert.strictEqual(r.nav.stuck.stats.episodes, episodes, 'the bot went on pushing at the wall after the stop')
  r.close()
})
