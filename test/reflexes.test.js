// P4: the reflex registry with leased claims.
const test = require('node:test')
const assert = require('node:assert')
const { createReflexes, holderOf } = require('../brain/reflexes')

function fixture() {
  let t = 1000
  const rf = createReflexes({ now: () => t })
  return { rf, tick: (ms) => { t += ms }, now: () => t }
}

test('a free resource is granted, held by name, and expires', () => {
  const { rf, tick } = fixture()
  const breath = rf.register({ name: 'breath', priority: 90, claims: ['body'] })
  assert.strictEqual(rf.holder('body'), null)
  assert.strictEqual(breath.claim('body', 3000, 'gravel'), true)
  assert.strictEqual(rf.holder('body'), 'breath'); assert.strictEqual(breath.holds('body'), true)
  tick(2999); assert.strictEqual(rf.holder('body'), 'breath')
  tick(2); assert.strictEqual(rf.holder('body'), null)
})

test('the holder renews; release frees only your own lease; Infinity lasts until released', () => {
  const { rf, tick } = fixture()
  const combat = rf.register({ name: 'combat', priority: 70, claims: ['melee'] }), other = rf.register({ name: 'safety', priority: 60, claims: ['melee'] })
  combat.claim('melee', Infinity); tick(1e9); assert.strictEqual(rf.holder('melee'), 'combat')
  assert.strictEqual(other.release('melee'), false); assert.strictEqual(rf.holder('melee'), 'combat')
  assert.strictEqual(combat.release('melee'), true); assert.strictEqual(rf.holder('melee'), null)
  combat.claim('melee', 100); tick(90); combat.claim('melee', 100); tick(90); assert.strictEqual(rf.holder('melee'), 'combat')
})

test('higher priority takes a held resource, equal or lower is refused', () => {
  const { rf } = fixture()
  const a = rf.register({ name: 'night-guard', priority: 40, claims: ['body'] }), b = rf.register({ name: 'breath', priority: 90, claims: ['body'] }), c = rf.register({ name: 'x', priority: 90, claims: ['body'] })
  assert.ok(a.claim('body', 5000)); assert.strictEqual(rf.holder('body'), 'night-guard')
  assert.ok(b.claim('body', 5000)); assert.strictEqual(rf.holder('body'), 'breath')
  assert.strictEqual(a.claim('body', 5000), false); assert.strictEqual(c.claim('body', 5000), false)
  assert.strictEqual(rf.holder('body'), 'breath'); assert.strictEqual(rf.status().preemptions, 1)
})

test('a reflex can only claim what it declared; unknown resources cannot be declared', () => {
  const { rf } = fixture()
  const r = rf.register({ name: 'safehand', priority: 95, claims: ['hands'] })
  assert.strictEqual(r.claim('melee', 1000), false); assert.strictEqual(rf.claim('ghost', 'hands', 1000), false)
  assert.throws(() => rf.register({ name: 'bad', claims: ['teleport'] }), /unknown resource/)
})

test('heldByOther and holderOf (the bot-only view) work, and are null without a registry', () => {
  const { rf } = fixture()
  const breath = rf.register({ name: 'breath', priority: 90, claims: ['body'] }); breath.claim('body', 1000)
  assert.strictEqual(rf.heldByOther('body', 'combat'), 'breath'); assert.strictEqual(rf.heldByOther('body', 'breath'), null)
  assert.strictEqual(holderOf({ _reflexes: rf }, 'body'), 'breath'); assert.strictEqual(holderOf({}, 'body'), null); assert.strictEqual(holderOf(null, 'body'), null)
})

test('status lists reflexes by priority with what they hold', () => {
  const { rf } = fixture()
  rf.register({ name: 'combat', priority: 70, claims: ['melee'] }).claim('melee', Infinity, 'always on')
  rf.register({ name: 'breath', priority: 90, claims: ['body'] })
  const s = rf.status()
  assert.deepStrictEqual(s.reflexes.map(r => r.name), ['breath', 'combat'])
  assert.strictEqual(s.leases.length, 1); assert.strictEqual(s.leases[0].holder, 'combat'); assert.strictEqual(s.leases[0].leftMs, null)
  assert.strictEqual(JSON.parse(JSON.stringify(s)).reflexes[1].holds[0].resource, 'melee')
})
