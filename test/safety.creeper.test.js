const test = require('node:test')
const assert = require('node:assert')
const { planCreeper, FuseTracker } = require('../brain/safety/creeper')
const { assess } = require('../brain/safety/assess')
const { Vec3 } = require('vec3')
const { rig, addMob, until, wait, creeperSim } = require('./safety.combat.helpers')

const base = (o = {}) => ({
  creeper: { dist: 9, approaching: true }, fuse: { est: 0, fusing: false, fusingMs: 0 }, others: 0, mode: 'fight', health: 20,
  hasSword: true, hasBow: false, hasArrows: false, los: true, phase: 'idle', sinceHitMs: Infinity, cycles: 0, cornered: false, ...o
})
const d = (x) => ({ creeper: { dist: x, approaching: true } })

test('planCreeper: flee inside 7 blocks, strike run only from outside it', () => {
  assert.strictEqual(planCreeper(base(d(5))).type, 'flee')
  assert.strictEqual(planCreeper(base(d(9))).type, 'strike')
  assert.strictEqual(planCreeper(base(d(12))).type, 'none')
  assert.strictEqual(planCreeper(base({ ...d(9), creeper: { dist: 9, approaching: false } })).type, 'none')
})

test('planCreeper: warn mode / low health / other mobs never strike', () => {
  assert.strictEqual(planCreeper(base({ mode: 'warn', ...d(9) })).type, 'none')
  assert.strictEqual(planCreeper(base({ health: 10, ...d(9) })).type, 'none')
  assert.strictEqual(planCreeper(base({ others: 1, ...d(9) })).type, 'none')
  assert.strictEqual(planCreeper(base({ hasSword: false, ...d(9) })).type, 'none')
})

test('planCreeper: fuse started -> urgent flee, even mid-withdraw', () => {
  const p = planCreeper(base({ ...d(4), fuse: { est: 3, fusing: true, fusingMs: 900 }, phase: 'withdraw', sinceHitMs: 300 }))
  assert.strictEqual(p.type, 'flee'); assert.ok(p.urgent)
})

test('planCreeper: a young fuse does not cancel a committed strike, an old one does', () => {
  assert.strictEqual(planCreeper(base({ phase: 'approach', ...d(3), fuse: { est: 4, fusing: true, fusingMs: 200 } })).type, 'strike')
  assert.strictEqual(planCreeper(base({ phase: 'approach', ...d(3), fuse: { est: 12, fusing: true, fusingMs: 800 } })).type, 'flee')
})

test('planCreeper: withdraw until 5.5 blocks and 0.9 s after the hit', () => {
  assert.strictEqual(planCreeper(base({ phase: 'withdraw', sinceHitMs: 300, ...d(3) })).type, 'withdraw')
  assert.strictEqual(planCreeper(base({ phase: 'withdraw', sinceHitMs: 2000, ...d(4.5) })).type, 'withdraw')
  assert.strictEqual(planCreeper(base({ phase: 'withdraw', sinceHitMs: 2000, ...d(6) })).type, 'flee', 'still inside 7: keep going')
})

test('planCreeper: bow when there are arrows and line of sight, but only from 8 blocks out', () => {
  const b = { hasBow: true, hasArrows: true }
  assert.strictEqual(planCreeper(base({ ...b, ...d(15) })).type, 'shoot')
  assert.strictEqual(planCreeper(base({ ...b, ...d(6) })).type, 'flee', 'kite first')
  assert.strictEqual(planCreeper(base({ ...b, los: false, ...d(15) })).type, 'none')
  assert.strictEqual(planCreeper(base({ ...b, mode: 'warn', ...d(15) })).type, 'shoot', 'shooting is allowed in warn mode: it is defence from a distance')
})

test('planCreeper: strike cycles are capped', () => {
  assert.strictEqual(planCreeper(base({ cycles: 8, ...d(9) })).type, 'none')
})

test('FuseTracker: counts proximity, winds down, reports fusing since', () => {
  const f = new FuseTracker()
  f.update(0, [{ id: 1, dist: 2, fusing: false }]); f.update(500, [{ id: 1, dist: 2, fusing: true }])
  assert.ok(f.get(1, 600).est >= 9 && f.get(1, 600).fusing)
  assert.strictEqual(f.get(1, 1500).fusingMs, 1000)
  f.update(1000, [{ id: 1, dist: 6, fusing: false }]); f.update(1600, [{ id: 1, dist: 6, fusing: false }])
  assert.strictEqual(f.get(1, 1600).est, 0); assert.strictEqual(f.get(1, 1600).fusing, false)
})

// ---- assess integration (pure) ----
const snap = (o = {}) => ({
  now: 1e6, me: { pos: new Vec3(0, 64, 0) }, health: 20, mode: 'fight', hasWeapon: true, owner: null, mobs: [], hurtBy: null, hurtRecently: false,
  recentHits: 0, recovering: false, giveUp: new Set(), fleeingSinceMs: null, ...o
})
const cm = (x, z, o = {}) => ({ id: 9, name: 'creeper', pos: new Vec3(x, 64, z), ...o })

test('assess: creeper at 5 blocks = flee, never fight (fight mode, sword)', () => {
  const r = assess(snap({ mobs: [cm(5, 0)] }))
  assert.strictEqual(r.action, 'flee'); assert.match(r.reason, /creeper/)
})
test('assess: hissing creeper = urgent flee', () => {
  const r = assess(snap({ mobs: [cm(4, 0)], creeper: { fuse: { 9: { est: 5, fusing: true, fusingMs: 1000 } } } }))
  assert.strictEqual(r.action, 'flee'); assert.strictEqual(r.urgent, true)
})
test('assess: approaching creeper at 9 in fight mode -> strike; in warn mode just watches', () => {
  assert.strictEqual(assess(snap({ mobs: [cm(9, 0, { closing: 3 })] })).style, 'strike')
  assert.strictEqual(assess(snap({ mode: 'warn', mobs: [cm(9, 0, { closing: 3 })] })).action, 'warn')
})
test('assess: bow in inventory -> shoot a creeper 12 blocks out', () => {
  const r = assess(snap({ hasBow: true, hasArrows: true, los: { 9: true }, mobs: [cm(12, 0, { closing: 3 })] }))
  assert.strictEqual(r.action, 'shoot')
})
test('assess: zombie with a creeper close -> run from the creeper first', () => {
  const r = assess(snap({ mobs: [cm(5, 0), { id: 2, name: 'zombie', pos: new Vec3(2, 64, 0) }] }))
  assert.strictEqual(r.action, 'flee'); assert.match(r.reason, /creeper/)
})
test('assess: melee mobs are fought when they come within 5 (or walk at us within 8), not chased from afar', () => {
  const z = (x, o = {}) => ({ id: 2, name: 'zombie', pos: new Vec3(x, 64, 0), ...o })
  assert.strictEqual(assess(snap({ mobs: [z(4)] })).action, 'fight')
  assert.strictEqual(assess(snap({ mobs: [z(8, { closing: 3 })] })).action, 'fight')
  assert.strictEqual(assess(snap({ mobs: [z(8)] })).action, 'warn')
  assert.strictEqual(assess(snap({ mobs: [z(6)] })).action, 'warn', 'fight mode holds its ground, no pointless retreat')
})

// ---- simulation: the acceptance scenarios ----
async function simulate(name, { creeper, ...rigOpts }, ms, extra = {}) {
  const r = rig(rigOpts)
  const sim = creeperSim(r.bot, creeper)
  r.rt.start()
  await until(() => sim.st.exploded || sim.st.dead, ms)
  await wait(150)
  r.rt.stop(); sim.stop()
  return { ...r, sim: sim.st }
}

test('SIM sword + fight mode: creeper walks in from 12 blocks -> killed with hit-and-retreat, no explosion damage', async () => {
  const { bot, sim, slog } = await simulate('strike', { creeper: { x: 12, z: 0 }, items: ['stone_sword'], config: { creeperStrike: true } }, 14000)
  assert.ok(!sim.exploded, `exploded at ${sim.distAtBoom}, damage ${sim.damage}, hits ${sim.hits}, maxSwell ${sim.maxSwell}\n${slog.join('\n')}`)
  assert.strictEqual(bot.health, 20)
  assert.ok(sim.dead, `creeper not killed (hits ${sim.hits}, hp ${sim.hp}, maxSwell ${sim.maxSwell})\n${slog.join('\n')}`)
  assert.ok(sim.maxSwell < 22, `fuse got to ${sim.maxSwell}`)
})

test('SIM warn mode: creeper walks in -> bot keeps away, never hit, never attacks', async () => {
  const { bot, sim } = await simulate('warn', { mode: 'warn', creeper: { x: 10, z: 0 } }, 6000)
  assert.ok(!sim.exploded); assert.strictEqual(bot.health, 20)
  assert.ok(!bot.actions.some(a => a[0] === 'attack'))
  assert.ok(sim.minDist > 3, `came within ${sim.minDist}`)
})

test('SIM no sword at all: still runs away from a creeper', async () => {
  const { bot, sim } = await simulate('nosword', { creeper: { x: 9, z: 0 }, items: ['cobblestone'] }, 5000)
  assert.ok(!sim.exploded); assert.strictEqual(bot.health, 20)
})

test('SIM creeper that appears at 5 blocks (round a corner): flees in time, no damage', async () => {
  const { bot, sim } = await simulate('close', { creeper: { x: 5, z: 0 } }, 6000)
  assert.ok(!sim.exploded, `exploded at ${sim.distAtBoom} damage ${sim.damage}`); assert.strictEqual(bot.health, 20)
})

test('SIM bow: creeper shot from range before it gets close', async () => {
  const r = rig({ items: ['stone_sword', 'bow', 'arrow'] })
  const sim = creeperSim(r.bot, { x: 16, z: 0, speed: 1.0, hp: 18 })     // slow walker so the test stays short
  const bot = r.bot
  // an arrow "hits" when the bow is released with the creeper in range and roughly aimed at it
  const origDeact = bot.deactivateItem
  bot.deactivateItem = () => { origDeact(); const c = sim.entity.position, me = bot.entity.position; if (bot.heldItem && bot.heldItem.name === 'bow' && Math.abs(Math.atan2(-(c.x - me.x), -(c.z - me.z)) - bot.entity.yaw) < 0.05) { sim.st.hits++; sim.st.hp -= 6; if (sim.st.hp <= 0) { sim.st.dead = true; delete bot.entities[50] } } }
  r.rt.start()
  await until(() => sim.st.dead || sim.st.exploded, 12000)
  r.rt.stop(); sim.stop()
  assert.ok(!sim.st.exploded); assert.strictEqual(bot.health, 20)
  assert.ok(bot.actions.some(a => a[0] === 'activateItem' && a[1] === 'bow'))
  assert.ok(sim.st.dead, `hits ${sim.st.hits}`)
  assert.ok(sim.st.minDist > 6, `came within ${sim.st.minDist}`)
})
