// brain/autopilot/ironkit.js: the iron pickaxe and the ladders the bag has the materials for and no step made (14 h, both bots, 2026-11-11).
const test = require('node:test')
const assert = require('node:assert/strict')
const kit = require('../brain/autopilot/ironkit')

// a bag and a craft that follows the real recipes closely enough: pickaxe = 3 ingots + 2 sticks, ladder x3 = 7 sticks, 2 planks = 4 sticks, 1 log = 4 planks
function rig(bag) {
  const b = { ...bag }
  const n = (k) => b[k] || 0
  const S = {
    count: (w) => (w instanceof RegExp ? Object.entries(b).filter(([k]) => w.test(k)).reduce((s, [, v]) => s + v, 0) : n(w)),
    planks: () => n('oak_planks'), logs: () => n('oak_log'),
    craft: async (name, count) => {
      const sticks = (need) => { while (n('stick') < need) { if (n('oak_planks') >= 2) { b.oak_planks -= 2; b.stick = n('stick') + 4 } else if (n('oak_log') >= 1) { b.oak_log -= 1; b.oak_planks = n('oak_planks') + 4 } else return false } return true }
      if (name === 'iron_pickaxe') { if (n('iron_ingot') < 3 || !sticks(2)) return false; b.iron_ingot -= 3; b.stick -= 2; b.iron_pickaxe = n('iron_pickaxe') + 1; return true }
      if (name === 'ladder') { const times = Math.ceil((count - n('ladder')) / 3); if (!sticks(7 * times)) return false; b.stick -= 7 * times; b.ladder = n('ladder') + 3 * times; return true }
      return false
    },
  }
  return { S, b }
}

test('the bag Walter saw (20 ingots, 6 sticks, 9 planks, no iron pickaxe, no ladders): tool-kit wants it and makes the pickaxe and 3 ladders', async () => {
  const { S, b } = rig({ iron_ingot: 20, stick: 6, oak_planks: 9, stone_pickaxe: 3 })
  assert.equal(kit.wants(S), true, 'a step that holds the materials for the kit must want to make it')
  const notes = []
  const r = await kit.make(S, (m) => notes.push(m))
  assert.deepEqual(r, { pick: true, ladders: true })
  assert.equal(b.iron_pickaxe, 1); assert.equal(b.ladder, 3); assert.equal(b.iron_ingot, 17)
  assert.equal(kit.wants(S), false, 'nothing left to want once the kit is made')
  assert.equal(notes.length, 2)
})

test('already holding an iron pickaxe and 3 ladders: nothing wanted, nothing crafted', async () => {
  const { S, b } = rig({ iron_ingot: 20, stick: 20, iron_pickaxe: 1, ladder: 3 })
  assert.equal(kit.wants(S), false)
  assert.deepEqual(await kit.make(S), { pick: true, ladders: true }); assert.equal(b.iron_ingot, 20)
})

test('two ingots is not enough for a pickaxe: it is not wanted, and ladders alone are still made when the sticks are there', async () => {
  const { S, b } = rig({ iron_ingot: 2, stick: 7 })
  assert.equal(kit.wantsPick(S), false); assert.equal(kit.wantsLadders(S), true)
  await kit.make(S); assert.equal(b.iron_pickaxe, undefined); assert.equal(b.ladder, 3)
})

test('a diamond pickaxe counts: no iron pickaxe is made on top of it', () => {
  const { S } = rig({ iron_ingot: 20, stick: 30, diamond_pickaxe: 1, ladder: 3 })
  assert.equal(kit.wantsPick(S), false)
})

test('a craft that fails is reported, not thrown, and the kit still reads as wanted', async () => {
  const { S } = rig({ iron_ingot: 5, stick: 2 }); S.craft = async () => { throw new Error('updateSlot timeout') }
  const r = await kit.make(S); assert.deepEqual(r, { pick: false, ladders: false })
})
