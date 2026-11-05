// mineflayer's craft() waits for the server's slot update after each click (20 s default); the server sometimes never sends it.
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('events')
const { rig, mcData } = require('./crafting.helpers')

const callCraft = (r, name, n, opts) => r.brain.api.crafting.craft(null, name, n, opts)

test('a craft stuck waiting for updateSlot:0 is unstuck after ~1.5 s instead of 20 s, and the product check passes', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 4 } })
  const win = new EventEmitter(); win.slots = new Array(46).fill(null)
  r.bot.currentWindow = win
  const real = r.bot.craft
  let stuckOnce = 0
  r.bot.craft = async (rec, n, t) => {
    if (!stuckOnce++) await new Promise(res => win.once('updateSlot:0', res))   // mineflayer's putAway(0) waiting for the result slot
    return real(rec, n, t)
  }
  const t0 = Date.now()
  const res = await callCraft(r, 'stick', 4, { chests: false })
  const secs = (Date.now() - t0) / 1000
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('stick'), 4)
  assert.ok(secs < 4, `took ${secs}s`)
  r.stop()
})
test('a batch of which only part arrives is finished with what is still missing instead of failing', async () => {
  const r = rig({ chests: [], bag: { oak_planks: 12 } })
  const real = r.bot.craft
  let first = true
  r.bot.craft = async (rec, n, t) => { if (first && n > 1) { first = false; return real(rec, 2, t) } return real(rec, n, t) }   // server only did 2 of the 5 crafts
  const res = await callCraft(r, 'stick', 20, { chests: false })
  assert.strictEqual(res.ok, true, res.text)
  assert.strictEqual(r.bot.count('stick'), 20)
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'craft-ignored').length, 0)
  r.stop()
})
