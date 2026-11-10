// Fixes from docs/BUG-HUNT-2026-11-10.md: #9 digDown over a cave, #12 thunder is dark, #15 shared files written atomically.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { Reach } = require('../brain/nav/reach')
const { darkOutside, thundering } = require('../brain/autopilot/daylight')

// a stub with just what digDown touches: a column of cells under the feet
function stub(cells) {                                    // cells: names for y = -1, -2, ... (rest: 'stone')
  const dug = []
  const blk = (x, y) => { const name = cells[-(y - 64) - 1]; if (name === undefined) return { name: 'stone', boundingBox: 'block' }; if (name === null) return null; return { name, boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block' } }
  const self = { feet: () => ({ x: 0, y: 64, z: 0 }), blk, isHazard: (b) => Reach.prototype.isHazard.call(self, b), digCell: async (c) => { dug.push(c); return true }, ticks: async () => {}, dug }
  return self
}
const dig = (cells) => { const s = stub(cells); return Reach.prototype.digDown.call(s, {}).then(r => ({ r, dug: s.dug.length })) }

test('digDown: refuses over a deep cave, over lava and over unloaded world; digs when something safe is within three blocks', async () => {
  assert.strictEqual((await dig(['stone', 'air', 'air', 'air', 'air', 'air', 'air'])).dug, 0)            // air all the way down: the old check passed this
  assert.strictEqual((await dig(['stone', 'air', 'air', 'air', 'air', 'stone'])).dug, 0)                  // landing 5 down: a damaging fall
  assert.strictEqual((await dig(['stone', 'lava'])).dug, 0)
  assert.strictEqual((await dig(['stone', 'air', 'lava'])).dug, 0)
  assert.strictEqual((await dig(['stone', 'air', 'air', 'magma_block'])).dug, 0)
  assert.strictEqual((await dig(['stone', null])).dug, 0)
  assert.strictEqual((await dig(['stone', 'air', 'air', 'stone'])).dug, 1)                                // a two-block drop onto stone is fine
  assert.strictEqual((await dig(['stone', 'air', 'air', 'air', 'stone'])).dug, 1)                         // exactly three blocks of fall
  assert.strictEqual((await dig(['stone', 'stone'])).dug, 1)
  assert.strictEqual((await dig(['stone', 'air', 'water'])).dug, 1)                                       // landing in water is fine
})

test('darkOutside: the night clock, or a thunderstorm at noon; rain alone and a fading storm are not', () => {
  const bot = (o) => ({ time: { timeOfDay: 6000 }, isRaining: false, thunderState: 0, ...o })
  assert.strictEqual(darkOutside(bot({})), false)
  assert.strictEqual(darkOutside(bot({ time: { timeOfDay: 15000 } })), true)
  assert.strictEqual(darkOutside(bot({ isRaining: true, thunderState: 0.9 })), true)
  assert.strictEqual(darkOutside(bot({ isRaining: true, thunderState: 0 })), false)
  assert.strictEqual(thundering(bot({ isRaining: true, thunderState: 0.3 })), false)
  assert.strictEqual(darkOutside(bot({ isRaining: false, thunderState: 0.9 })), false)
  assert.strictEqual(darkOutside({}), false)
})

test('the shared bot files are written through a per-bot temp name and renamed (source check)', () => {
  const root = path.join(__dirname, '..', 'brain', 'autopilot')
  assert.match(fs.readFileSync(path.join(root, 'ladder.js'), 'utf8'), /FILE \+ '\.' \+ \(bot\.username \|\| 'bot'\) \+ '\.tmp'/)
  assert.match(fs.readFileSync(path.join(root, 'plan.js'), 'utf8'), /SLEEP_FILE \+ '\.' \+ bot\.username \+ '\.tmp'[\s\S]{0,120}renameSync\(tmp, SLEEP_FILE\)/)
  assert.match(fs.readFileSync(path.join(root, 'mining.js'), 'utf8'), /GoalBlock\(b\.x, b\.y, b\.z\), \{ dig: false, ms: 12000, escalate: false \}/)
})

test('reach defaults carry no coordinates from the first world; the ladder wall fill picks a solid neighbour and the matching face (source check)', () => {
  const { DEFAULTS } = require('../brain/nav/reach')
  assert.strictEqual(DEFAULTS.baseCenter, null); assert.strictEqual(DEFAULTS.property, null)
  const src = fs.readFileSync(path.join(__dirname, '..', 'brain', 'autopilot', 'ladder.js'), 'utf8')
  assert.match(src, /below && below\.boundingBox === 'block' \? \{ b: below, face: v\(0, 1, 0\) \} : above && above\.boundingBox === 'block' \? \{ b: above, face: v\(0, -1, 0\) \}/)
  assert.ok(!/S\.block\(wb\.offset\(0, -1, 0\)\) \|\| S\.block\(wb\.offset\(0, 1, 0\)\)/.test(src))
})
