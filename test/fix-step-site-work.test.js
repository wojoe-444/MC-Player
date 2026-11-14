// Work order step-site-work: 5 runs in 24 hours, 0 ok. The site step (brain/autopilot/site.js) picks the birch farm whenever it has trees or
// saplings to work, and its run starts by walking to the farm gate. skills.js S.goto refuses a goal outside the work zone that is not closer to
// the zone's centre than the bot is, so when the zone does not take in the gate, every run ends in "could not get in through the gate" and the
// goal fails. The step's need() does not ask the zone, so the step is picked again and again. The test drives the real skills and the real site
// step with a made-up zone.json and site.json; the bot stands inside the zone, the gate lies outside it.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const EE = require('events')
const { Vec3 } = require('vec3')
const makeSkills = require('../brain/autopilot/skills')

const SITE = { name: 'birch farm', box: { x0: 135, x1: 157, y0: 69, y1: 80, z0: 419, z1: 441 }, gate: [142, 69, 416], chests: [], stores: [],
  log: 'birch_log', leaves: 'birch_leaves', sapling: 'birch_sapling', pillar: 'cobblestone', spots: [] }

// a bot standing at (x, z) with 32 birch logs in the bag (the step's need() is true for that alone), and a zone.json with the given workZone
function rig({ zone, at = [142.5, 460.5] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-step-site-work-'))
  fs.writeFileSync(path.join(dir, 'site.json'), JSON.stringify(SITE))
  fs.writeFileSync(path.join(dir, 'zone.json'), JSON.stringify({ workZone: zone }))
  const bot = new EE()
  bot.version = '1.21.6'
  bot.entity = { position: new Vec3(at[0], 64, at[1]) }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.food = 20; bot.health = 20
  bot.inventory = { items: () => [{ name: 'birch_log', count: 32 }], emptySlotCount: () => 20, slots: [] }
  bot.pathfinder = { setMovements() {}, setGoal() {} }
  bot.clickWindow = async () => {}; bot.equip = async () => {}; bot.unequip = async () => {}
  bot.registry = require('minecraft-data')('1.21.6')
  bot.findBlocks = () => []
  bot.blockAt = () => null
  const api = { statePath: (f) => path.join(dir, f), log() {}, say() {} }
  const S = makeSkills({ bot, api, log: () => {} })
  clearInterval(bot._resyncTimer); clearInterval(bot._hotbarTimer)      // makeSkills starts two timers that would keep the test process alive
  const G = { state: {}, note() {} }
  const site = require('../brain/autopilot/site')(G, S, {}, api, () => {})
  return { site, S, dir }
}

test('the site is not picked while the work zone refuses its gate from where the bot stands', async () => {
  // the zone's centre is 54 blocks from the gate (142,416) and its radius 40: the gate is outside; the bot (9 blocks from the centre) is inside,
  // so a goto to the gate is refused (skills.js S.goto)
  const r = rig({ zone: { x: 142, z: 470, r: 40 } })
  assert.equal(r.S.inZone({ x: 142, z: 416 }), false, 'precondition: the gate is outside the work zone')
  const walk = await r.S.goto(new r.S.goals.GoalNear(142, 69, 416, 0), { dig: false, ms: 1000 })
  assert.deepEqual(walk, { ok: false, why: 'outside work zone' }, 'precondition: the walk to the gate is refused by the zone')
  assert.equal(r.site.need(), false, 'the step was picked although the work zone refuses its gate: every run ends at "could not get in through the gate"')
})

test('control: with the gate inside the work zone the site is picked as before', () => {
  const r = rig({ zone: { x: 142, z: 425, r: 60 } })
  assert.equal(r.S.inZone({ x: 142, z: 416 }), true, 'precondition: the gate is inside the work zone')
  assert.equal(r.site.need(), true)
})

test('control: a bot outside the zone that is nearer the gate than the centre is, is allowed in (the zone lets goals closer to it through)', () => {
  // the bot stands 69 blocks from the centre, the gate 54: the gate is closer, so goto to it is not refused and the site is still picked
  const r = rig({ zone: { x: 142, z: 470, r: 40 }, at: [142.5, 400.5] })
  assert.equal(r.S.inZone({ x: 142, z: 416 }), false, 'precondition: the gate is outside the work zone')
  assert.ok(Math.hypot(142 - 142, 416 - 470) < Math.hypot(142.5 - 142, 400.5 - 470), 'precondition: the gate is closer to the centre than the bot')
  assert.equal(r.site.need(), true)
})
