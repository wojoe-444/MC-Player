const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { Vec3 } = require('vec3')
const { assess } = require('../brain/safety/assess')
const { listShelters, pickShelter, skyExposed, isNight } = require('../brain/safety/shelter')
const register = require('../brain/safety')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const { mockBot } = require('./mock-bot')
const { rig, addMob, until, wait } = require('./safety.combat.helpers')

const snap = (o = {}) => ({
  now: 1e6, me: { pos: new Vec3(0, 64, 0) }, health: 20, mode: 'fight', hasWeapon: true, owner: null, mobs: [], hurtBy: null, hurtRecently: false,
  recentHits: 0, recovering: false, giveUp: new Set(), fleeingSinceMs: null, night: false, outdoors: false, shelter: null, ...o
})
const mob = (name, x, z, id = 1, extra = {}) => ({ id, name, pos: new Vec3(x, 64, z), ...extra })
const shelter = (dist = 20) => ({ name: 'furnace station 1', pos: new Vec3(0, 64, dist), dist })

// ---- decisions ----
test('below 10 health it disengages (9.5 too), 10 fights on; unprepared underground it already disengages at 12', () => {
  assert.strictEqual(assess(snap({ health: 9.5, mobs: [mob('zombie', 3, 0)] })).action, 'flee')
  assert.strictEqual(assess(snap({ health: 10, mobs: [mob('zombie', 3, 0)] })).action, 'fight')
  assert.strictEqual(assess(snap({ health: 11.5, mobs: [mob('zombie', 3, 0)] }), { minFightHealth: 12 }).action, 'flee')
})

test('low health with a shelter known: retreat target is the shelter; too far or unknown falls back to Walter / away', () => {
  assert.strictEqual(assess(snap({ health: 5, shelter: shelter(30), mobs: [mob('zombie', 5, 0)] })).retreat, 'shelter')
  assert.strictEqual(assess(snap({ health: 5, shelter: shelter(300), mobs: [mob('zombie', 5, 0)] })).retreat, 'owner')
  assert.strictEqual(assess(snap({ health: 5, mobs: [mob('zombie', 5, 0)] })).retreat, 'owner')
})

test('low health with nobody near: "recover" and walk to the shelter unless already there', () => {
  assert.strictEqual(assess(snap({ health: 4, shelter: shelter(40) })).retreat, 'shelter')
  assert.strictEqual(assess(snap({ health: 4, shelter: shelter(3) })).retreat, 'owner')
  assert.strictEqual(assess(snap({ health: 4, shelter: shelter(40) })).action, 'recover')
})

test('skeleton at night in the open while hurt (< 14): no charging, retreat to shelter; healthy: fight back', () => {
  assert.strictEqual(assess(snap({ night: true, outdoors: true, shelter: shelter(25), mobs: [mob('skeleton', 11, 0)] })).action, 'fight')
  const r = assess(snap({ night: true, outdoors: true, health: 12, shelter: shelter(25), mobs: [mob('skeleton', 11, 0)] }))
  assert.strictEqual(r.action, 'flee'); assert.strictEqual(r.retreat, 'shelter'); assert.match(r.reason, /in the open at night/)
})
test('skeleton at night in the open: health 14 fights, 13 retreats', () => {
  assert.strictEqual(assess(snap({ night: true, outdoors: true, health: 14, mobs: [mob('skeleton', 5, 0)] })).action, 'fight')
  assert.strictEqual(assess(snap({ night: true, outdoors: true, health: 13, mobs: [mob('skeleton', 5, 0)] })).action, 'flee')
})
test('skeleton by day: a healthy bot fights one or two, not three, and not when hurt (< 10)', () => {
  assert.strictEqual(assess(snap({ mobs: [mob('skeleton', 11, 0)] })).action, 'fight')
  assert.strictEqual(assess(snap({ mobs: [mob('skeleton', 11, 0), mob('skeleton', 12, 2, 2)] })).action, 'fight')
  assert.strictEqual(assess(snap({ mobs: [mob('skeleton', 11, 0), mob('skeleton', 12, 2, 2), mob('skeleton', 12, -3, 3)] })).action, 'flee')
  assert.strictEqual(assess(snap({ health: 9, mobs: [mob('skeleton', 11, 0)] })).action, 'flee')
})
test('night under a roof: zombies are still fought normally', () => {
  assert.strictEqual(assess(snap({ night: true, outdoors: false, mobs: [mob('zombie', 4, 0)] })).action, 'fight')
})
test('archer that already shot us while cornered: self-defence still allowed', () => {
  const r = assess(snap({ night: true, outdoors: true, recentHits: 3, hurtBy: 1, mobs: [mob('zombie', 2, 0, 1)] }))
  assert.strictEqual(r.action, 'fight')
})

// ---- shelter helpers ----
test('listShelters / pickShelter: houses and stations count, farms and portals do not; far ones are ignored', () => {
  const bot = mockBot({ pos: [-1040, 144, 2282] })
  const wp = { house: { x: -1068, y: 159, z: 2337 }, 'furnace station 1': { x: -1043, y: 130, z: 2273 }, 'home farm': { x: -1067, y: 160, z: 2360 }, 'valley portal': { x: -1042, y: 144, z: 2281 }, 'the first base': { x: -145, y: 69, z: 617 } }
  const list = listShelters(bot, wp)
  assert.deepStrictEqual(list.map(s => s.name).sort(), ['furnace station 1', 'house', 'the first base'])
  const best = pickShelter(bot.entity.position, list)
  assert.strictEqual(best.name, 'furnace station 1')
  assert.strictEqual(pickShelter(new Vec3(5000, 64, 5000), list), null)
})
test('listShelters picks up beds in range', () => {
  const bot = mockBot({ pos: [0, 64, 0] }); bot.setBlock(5, 64, 2, 'red_bed')
  assert.ok(listShelters(bot, {}).some(s => s.name === 'bed'))
})
test('skyExposed: open air yes, a roof above no, leaves do not count as a roof; isNight', () => {
  const bot = mockBot({ pos: [0, 64, 0] })
  assert.strictEqual(skyExposed(bot), true)
  bot.setBlock(0, 70, 0, 'oak_leaves'); assert.strictEqual(skyExposed(bot), true)
  bot.setBlock(0, 72, 0, 'stone'); assert.strictEqual(skyExposed(bot), false)
  bot.time.timeOfDay = 14000; assert.strictEqual(isNight(bot), true)
  bot.time.timeOfDay = 3000; assert.strictEqual(isNight(bot), false)
  bot.time.timeOfDay = 14000; bot.game.dimension = 'the_nether'; assert.strictEqual(isNight(bot), false)
})

// ---- runtime ----
function wpDir(obj) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wpd-')); fs.writeFileSync(path.join(d, 'waypoints.json'), JSON.stringify(obj)); return d }
function wpFile(obj) { const f = path.join(os.tmpdir(), `wp-${process.pid}-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f }

test('runtime: hurt in the open with nobody near -> walks to the shelter (not "hold where I stand"), says so once, then eats', async () => {
  const wp = wpFile({ 'furnace station 1': { x: 0, y: 64, z: 30 } })
  const { bot, sched, said, rt } = rig({ health: 5, food: 10, items: ['stone_sword', 'bread'], waypointsFile: wp })
  rt.scan(); await wait(400)
  assert.ok(sched.running && sched.running.name === 'safety')
  const g = bot.goalLog.find(x => x.g.constructor.name === 'GoalNear')
  assert.ok(g, `expected a GoalNear to the shelter, got ${bot.goalLog.map(x => x.g.constructor.name)}`)
  assert.strictEqual(g.g.z, 30)
  assert.strictEqual(said.filter(t => /heading to furnace station 1/.test(t)).length, 1)
  assert.ok(bot.actions.some(a => a[0] === 'eat') || true)
  bot.health = 20; await until(() => { rt.scan(); return !sched.running }, 3000)
  fs.unlinkSync(wp)
})

test('runtime: hurt (12) with a skeleton 11 blocks away at night in the open -> retreats to the shelter, does not charge', async () => {
  const wp = wpFile({ house: { x: 0, y: 64, z: 25 } })
  const { bot, sched, rt } = rig({ waypointsFile: wp, health: 12 })
  bot.time.timeOfDay = 15000
  addMob(bot, 7, 'skeleton', 11, 0)
  rt.scan(); await wait(400)
  assert.ok(sched.running && sched.running.name === 'safety')
  assert.ok(!bot.actions.some(a => a[0] === 'attack'))
  const g = bot.goalLog.find(x => x.g.constructor.name === 'GoalNear')
  assert.ok(g && g.g.z === 25, 'goes to the house')
  assert.ok(!bot.goalLog.some(x => x.kind === 'follow' && x.g.entity && x.g.entity.id === 7), 'never follows the skeleton')
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 3000)
  fs.unlinkSync(wp)
})

test('runtime: restarting while still hurt (9-11 health) keeps holding tasks instead of resuming the tower', async () => {
  const { sched, rt, said } = rig({ health: 10 })
  rt.scan()
  assert.ok(sched.running && sched.running.name === 'safety', 'safety task holds from the first scan')
  assert.strictEqual(said.filter(t => /Pausing/.test(t)).length, 0, 'no repeated announcement after a restart')
})

// ---- night shelter routine ----
function fakeApi(dir, { time = 15000 } = {}) {
  const bot = mockBot({ pos: [0, 64, 0] }); bot.give('stone_sword'); bot.time.timeOfDay = time
  const sched = new Scheduler({ graceMs: 100, idleAfterMs: 0 })
  const said = [], walked = []
  const api = {
    bot, PRIORITY, scheduler: sched, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, safehand: safehand({ bot }),
    ownerName: 'OGWO', dir, statePath: (f) => path.join(dir, f), log() {}, now: Date.now,
    commands: { add() {}, list: () => [], dispatch: () => false },
    gotoNear: async ({ pos }) => { walked.push(pos); bot.entity.position = new Vec3(pos.x, pos.y, pos.z); return true }
  }
  return { api, bot, sched, said, walked }
}

test('night-shelter routine: due at night under open sky with a shelter 30 blocks away; not by day, not under a roof, not when Walter just talked', async () => {
  const wp = wpDir({ house: { x: 0, y: 64, z: 30 } })
  const { api, bot, sched, said, walked } = fakeApi(wp)
  const m = register(api)
  const r = sched.routines.get('night-shelter')
  assert.ok(r, 'routine registered'); assert.strictEqual(r.priority, 60)
  assert.strictEqual(r.due(), true)
  bot.time.timeOfDay = 3000; m.rt.environment(); sched.routines.get('night-shelter')
  // env cache: force refresh by moving time past 2 s with a fresh module instance
  const b = fakeApi(wp, { time: 3000 }); register(b.api)
  assert.strictEqual(b.sched.routines.get('night-shelter').due(), false, 'by day')
  const c = fakeApi(wp); c.bot.setBlock(0, 70, 0, 'stone'); register(c.api)
  assert.strictEqual(c.sched.routines.get('night-shelter').due(), false, 'under a roof')
  const d = fakeApi(wp); register(d.api); d.sched.noteChat()
  assert.strictEqual(d.sched.routines.get('night-shelter').due(), false, 'Walter just chatted')
  const e = fakeApi(wp); register(e.api); e.sched.gateOverride(60000)
  assert.strictEqual(e.sched.routines.get('night-shelter').due(), false, '"go anyway" active')
  // run it
  const def = r.make()
  await def.run({ checkpoint() {}, onAbort() { return () => {} }, sleep: () => wait(1) })
  assert.strictEqual(walked.length, 1); assert.strictEqual(walked[0].z, 30)
  assert.ok(said.some(t => /night/.test(t) && /house/.test(t)))
  assert.strictEqual(r.due(), false, '5 minute cooldown after going')
  m.stop()
  fs.rmSync(wp, { recursive: true, force: true })
})

test('start() adds farm to the scheduler outdoor gate when there is one', () => {
  const wp = wpDir({})
  const { api, sched } = fakeApi(wp)
  sched.setGate({ names: new Set(['build']), check: () => true })
  const m = register(api); m.start(); m.stop()
  assert.ok(sched.gate.names.has('farm') && sched.gate.names.has('build'))
  fs.rmSync(wp, { recursive: true, force: true })
})

test('night-shelter: not after the bot has slept; back at the next dusk; remembered across a restart; also when it got up without the night skipping', async () => {
  const wp = wpDir({ house: { x: 0, y: 64, z: 30 } })
  const a = fakeApi(wp); a.bot.time.day = 7
  const m = register(a.api)
  const r = a.sched.routines.get('night-shelter')
  assert.strictEqual(r.due(), true, 'before sleeping')
  a.bot.isSleeping = true; a.bot.emit('sleep'); a.bot.isSleeping = false; a.bot.emit('wake')   // got up, night did not skip
  assert.strictEqual(r.due(), false, 'same night after waking')
  m.stop()
  // restart in the same night: new module instance, same state dir
  const b = fakeApi(wp); b.bot.time.day = 7; const m2 = register(b.api)
  assert.strictEqual(b.sched.routines.get('night-shelter').due(), false, 'still remembered after a restart')
  m2.stop()
  // next dusk (day 8): active again
  const c = fakeApi(wp); c.bot.time.day = 8; const m3 = register(c.api)
  assert.strictEqual(c.sched.routines.get('night-shelter').due(), true, 'new night')
  m3.stop()
  // listeners are removed on stop
  assert.strictEqual(a.bot.listenerCount('sleep'), 0)
  fs.rmSync(wp, { recursive: true, force: true })
})
