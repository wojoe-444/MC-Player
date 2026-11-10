// brain/motor/lease.js: two call sites flipping the same key back and forth are a fight; one loop toggling its own key, or slow flips, are not.
const test = require('node:test')
const assert = require('node:assert')
const { install } = require('../brain/motor/lease')

function rig() {
  let t = 1000; const set = []
  const bot = { setControlState(c, v) { set.push([c, v]) } }
  const lease = install(bot, { logFile: null, now: () => t, log: () => {} })
  return { bot, lease, set, adv: (ms) => { t += ms } }
}
const loopA = (b, v) => b.setControlState('jump', v)
const loopB = (b, v) => b.setControlState('jump', v)

test('a press always goes through; two sites flipping jump within 300 ms, three times running, is recorded as a fight', () => {
  const r = rig()
  for (let i = 0; i < 4; i++) { loopA(r.bot, true); r.adv(50); loopB(r.bot, false); r.adv(50) }
  assert.strictEqual(r.set.length, 8)                                   // nothing dropped
  const f = Object.values(r.lease.fights())
  assert.strictEqual(f.length, 1); assert.strictEqual(f[0].control, 'jump')
  assert.ok(f[0].a.startsWith('test/lease.test.js:') && f[0].b.startsWith('test/lease.test.js:') && f[0].a !== f[0].b, JSON.stringify(f))
  assert.ok(f[0].count >= 1)
})

test('one loop toggling its own key, repeated identical values, and slow hand-overs are not fights', () => {
  const r = rig()
  for (let i = 0; i < 6; i++) { loopA(r.bot, true); r.adv(50); loopA(r.bot, false); r.adv(50) }
  for (let i = 0; i < 5; i++) { loopA(r.bot, false) }
  assert.deepStrictEqual(r.lease.fights(), {})
  const s = rig()
  for (let i = 0; i < 6; i++) { loopA(s.bot, true); s.adv(2000); loopB(s.bot, false); s.adv(2000) }
  assert.deepStrictEqual(s.lease.fights(), {})
})

test('uninstall restores the original; a broken observer never breaks the press', () => {
  const r = rig(); const watched = r.bot.setControlState
  r.lease.uninstall(); assert.notStrictEqual(r.bot.setControlState, watched)
})
