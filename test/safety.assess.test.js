const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { assess, Tracker } = require('../brain/safety/assess')
const { nextRecovering, shouldEat, chooseFood } = require('../brain/safety/health')
const { mcData } = require('./mock-bot')

const snap = (o = {}) => ({
  now: 1e6, me: { pos: new Vec3(0, 64, 0) }, health: 20, mode: 'warn', hasWeapon: true, owner: { pos: new Vec3(3, 64, 0) },
  mobs: [], hurtBy: null, hurtRecently: false, recentHits: 0, recovering: false, giveUp: new Set(), fleeingSinceMs: null, ...o
})
const mob = (name, x, z, id = 1, extra = {}) => ({ id, name, pos: new Vec3(x, 64, z), ...extra })

test('Tracker: closing speed and ETA for a walking zombie, none for a standing one', () => {
  const tr = new Tracker(), me = new Vec3(0, 64, 0)
  let r
  for (let i = 0; i <= 5; i++) r = tr.update(1000 + i * 300, me, [mob('zombie', 14 - i * 1.2, 0, 1), mob('skeleton', 12, 0, 2)])
  assert.ok(r.get(1).closing > 3.5 && r.get(1).closing < 4.5, `closing ${r.get(1).closing}`)
  assert.ok(r.get(1).eta > 1 && r.get(1).eta < 4)
  assert.strictEqual(r.get(2).closing, 0)
  assert.strictEqual(r.get(2).eta, Infinity)
})

test('Tracker: forgets mobs that left', () => {
  const tr = new Tracker(), me = new Vec3(0, 64, 0)
  tr.update(0, me, [mob('zombie', 5, 0, 1)]); tr.update(500, me, [])
  assert.strictEqual(tr.h.size, 0)
})

test('far zombie approaching -> heads-up with direction, but no action yet', () => {
  const d = assess(snap({ mobs: [mob('zombie', 0, -14, 1, { closing: 3 })] }))
  assert.strictEqual(d.action, 'none')
  assert.match(d.warnings[0].text, /zombie approaching from north, 14 blocks/)
})

test('far zombie standing still beyond alert range -> silent', () => {
  assert.strictEqual(assess(snap({ mobs: [mob('zombie', 0, -14)] })).warnings.length, 0)
})

test('close approaching zombie says so', () => {
  const d = assess(snap({ mobs: [mob('zombie', 6, 0, 1, { closing: 3 })] }))
  assert.match(d.warnings.find(w => w.key === 'bot:zombie').text, /approaching, 6 blocks east/)
})

test('skeleton shoots from range: warn mode backs away at 12 blocks, fight mode charges', () => {
  assert.strictEqual(assess(snap({ mobs: [mob('skeleton', 12, 0)] })).action, 'flee')
  assert.strictEqual(assess(snap({ mode: 'fight', mobs: [mob('skeleton', 12, 0)] })).action, 'fight')
})

test('mobs on another floor are ignored', () => {
  const m = { id: 1, name: 'zombie', pos: new Vec3(2, 40, 0) }
  assert.strictEqual(assess(snap({ mobs: [m] })).action, 'none')
})

test('warden is noticed from 20 blocks and always means flee', () => {
  const d = assess(snap({ mode: 'fight', mobs: [mob('warden', 18, 0)] }))
  assert.strictEqual(d.action, 'flee')
})

test('low health with nobody near -> recover (hold + eat), retreat hint is Walter', () => {
  const d = assess(snap({ health: 5 }))
  assert.strictEqual(d.action, 'recover'); assert.strictEqual(d.retreat, 'owner')
})

test('recovering latch keeps fight mode off between 8 and 12 health', () => {
  const d = assess(snap({ mode: 'fight', health: 10, recovering: true, mobs: [mob('zombie', 5, 0)] }))
  assert.strictEqual(d.action, 'flee')
  assert.strictEqual(assess(snap({ mode: 'fight', health: 10, recovering: false, mobs: [mob('zombie', 5, 0)] })).action, 'fight')
})

test('retreat target at low health is Walter, otherwise away', () => {
  assert.strictEqual(assess(snap({ health: 5, mobs: [mob('zombie', 5, 0)] })).retreat, 'owner')
  assert.strictEqual(assess(snap({ mobs: [mob('zombie', 5, 0)] })).retreat, 'away')
})

test('repeated hits by an adjacent melee mob while retreating -> self-defence fight', () => {
  const d = assess(snap({ recentHits: 3, hurtBy: 1, mobs: [mob('zombie', 2, 0, 1)] }))
  assert.strictEqual(d.action, 'fight'); assert.match(d.reason, /self-defence/)
})

test('cornered at low health by a single zombie -> last stand; by two -> keep running', () => {
  const one = assess(snap({ health: 4, recentHits: 3, recovering: true, mobs: [mob('zombie', 2, 0, 1)] }))
  assert.strictEqual(one.action, 'fight'); assert.match(one.reason, /last stand/)
  const two = assess(snap({ health: 4, recentHits: 3, recovering: true, mobs: [mob('zombie', 2, 0, 1), mob('zombie', 2.5, 0, 2)] }))
  assert.strictEqual(two.action, 'flee')
})

test('no sword: never fights, even when cornered', () => {
  const d = assess(snap({ hasWeapon: false, recentHits: 5, mobs: [mob('zombie', 2, 0, 1)] }))
  assert.strictEqual(d.action, 'flee')
})

test('unknown hostile type is treated as a melee mob', () => {
  const d = assess(snap({ mobs: [mob('some_new_mob', 4, 0)] }))
  assert.strictEqual(d.action, 'flee')
})

// ---- health policy ----
test('nextRecovering has hysteresis: in below 10 (9.5 included), out at 14', () => {
  assert.strictEqual(nextRecovering(false, 9.5), true)
  assert.strictEqual(nextRecovering(false, 10), false)
  assert.strictEqual(nextRecovering(true, 12), true)
  assert.strictEqual(nextRecovering(true, 14), false)
})

test('shouldEat: emergency unless a mob is on top of us', () => {
  assert.strictEqual(shouldEat({ health: 5, food: 10, nearestThreat: 10 }).eat, true)
  assert.strictEqual(shouldEat({ health: 5, food: 10, nearestThreat: 3 }).eat, false)
  assert.strictEqual(shouldEat({ health: 5, food: 20, nearestThreat: 10 }).eat, false, 'full stomach')
})

test('shouldEat: with mobs about only when hurt and the mob is not near; idle eating is off by default', () => {
  assert.strictEqual(shouldEat({ health: 12, food: 15, nearestThreat: 8 }).eat, true)
  assert.strictEqual(shouldEat({ health: 12, food: 15, nearestThreat: 5 }).eat, false)
  assert.strictEqual(shouldEat({ health: 20, food: 6 }).eat, false, 'farm.js owns idle eating')
  assert.strictEqual(shouldEat({ health: 20, food: 6 }, { idleEat: true }).eat, true)
})

test('shouldEat: recovering with food below 18 eats so natural regen can run', () => {
  assert.strictEqual(shouldEat({ health: 10, food: 16, recovering: true }).eat, true)
  assert.strictEqual(shouldEat({ health: 10, food: 19, recovering: true }).eat, false)
})

const inv = (...names) => names.map(n => ({ name: n, count: 5 }))
test('chooseFood: skips bad food, spares farm stock and golden food, uses golden only in an emergency', () => {
  const f = mcData.foodsByName
  assert.strictEqual(chooseFood(inv('rotten_flesh', 'spider_eye', 'poisonous_potato'), f, { food: 10 }), null)
  assert.strictEqual(chooseFood(inv('carrot', 'bread'), f, { food: 10 }).name, 'bread')
  assert.strictEqual(chooseFood(inv('carrot'), f, { food: 10 }).name, 'carrot', 'farm stock if nothing else')
  assert.strictEqual(chooseFood(inv('golden_apple'), f, { food: 10 }), null)
  assert.strictEqual(chooseFood(inv('golden_apple'), f, { food: 10, emergency: true }).name, 'golden_apple')
  assert.strictEqual(chooseFood(inv('enchanted_golden_apple'), f, { food: 1, emergency: true }), null, 'never the enchanted one')
  assert.strictEqual(chooseFood(inv('cooked_beef', 'bread'), f, { food: 15 }).name, 'bread', 'do not waste a steak on a small deficit')
  assert.strictEqual(chooseFood(inv('cooked_beef', 'bread'), f, { food: 4 }).name, 'cooked_beef')
})
