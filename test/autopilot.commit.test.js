// brain/autopilot/commit.js: A,B,A,B makes the picker stay with B until it is done, fails, or the hold runs out.
const test = require('node:test')
const assert = require('node:assert')
const { createCommit } = require('../brain/autopilot/commit')

function rig(opts = {}) { let t = 0; const c = createCommit({ now: () => t, urgent: new Set(['eat']), ...opts }); return { c, at: (ms) => { t = ms } } }

test('A,B,A,B inside the window starts a commitment to B; A is skipped while B still wants to run', () => {
  const { c, at } = rig()
  assert.strictEqual(c.note('light-mine'), null); at(60000); assert.strictEqual(c.note('tool-kit'), null); at(120000); assert.strictEqual(c.note('light-mine'), null)
  at(180000); const cm = c.note('tool-kit'); assert.deepStrictEqual([cm.id, cm.over], ['tool-kit', 'light-mine'])
  assert.strictEqual(c.skips('light-mine', () => true), true)
  assert.strictEqual(c.skips('wood', () => true), false)               // only the step that keeps re-arming it is held back
  assert.strictEqual(c.skips('tool-kit', () => true), false)
  assert.strictEqual(c.stats.skipped, 1); assert.strictEqual(c.stats.byPair['light-mine|tool-kit'], 1)
})

test('B done or failed (no longer wanted) releases A at once; the hold also times out', () => {
  const { c, at } = rig()
  for (const [t, id] of [[0, 'a'], [1, 'b'], [2, 'a'], [3, 'b']]) { at(t * 1000); c.note(id) }
  assert.strictEqual(c.skips('a', () => false), false); assert.strictEqual(c.active, null)       // B finished: back to normal
  const r = rig({ holdMs: 5000 })
  for (const [t, id] of [[0, 'a'], [1, 'b'], [2, 'a'], [3, 'b']]) { r.at(t * 1000); r.c.note(id) }
  r.at(3000 + 6000); assert.strictEqual(r.c.skips('a', () => true), false)
})

test('slow ping-pong, A,A,B runs, and survival steps never start a commitment', () => {
  const { c, at } = rig()
  for (const [t, id] of [[0, 'a'], [400000, 'b'], [800000, 'a'], [1200000, 'b']]) { at(t); assert.strictEqual(c.note(id), null) }      // 20 minutes for the four: not a loop
  const r = rig()
  for (const [t, id] of [[0, 'eat'], [1, 'b'], [2, 'eat'], [3, 'b']]) { r.at(t * 1000); assert.strictEqual(r.c.note(id), null) }
  const s = rig()
  for (const [t, id] of [[0, 'a'], [1, 'a'], [2, 'b'], [3, 'b'], [4, 'a']]) { s.at(t * 1000); assert.strictEqual(s.c.note(id), null) }   // repeats of the same step are one pick
})
