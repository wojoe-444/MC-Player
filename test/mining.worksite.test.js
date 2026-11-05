// Work-site chest (Walter's time economy rule): far from the final chests the haul goes into a chest placed in the mine and is carried once at the end.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const H = require('./mining.helpers')
const { rig, runJob, fakeCtx } = H

// bag: pickaxe + chest + stacks of cooked beef (never stashed), so that only a few free slots remain
function mk({ chest = 1, freeSlots = 8, config = {}, dispatch = null, deposit = true, torchCount = 0 } = {}) {
  const dep = []
  const r = rig({ torches: true, torchCount, config: { storageChests: [], ...config }, dispatch, deposit: deposit ? async (o) => { dep.push({ force: !!o.force, digs: r.bot.digs }); return { moved: {}, left: [], full: false } } : null })
  if (chest) r.bot.give('chest', chest)
  while (r.bot.inventory.emptySlotCount() > freeSlots) r.bot.give('cooked_beef', 64)
  r.dep = dep
  return r
}

test('worksite: when the bag fills far from home a chest goes into a finished hallway, the haul goes in there, and one trip at the end empties it and picks the chest up', async () => {
  const r = mk()
  r.bot.setBlock(2, -58, 0, 'andesite')                       // the second new item type: free slots drop to 6 once branches 0:L and 0:R are finished
  r.bot.setBlock(5, -58, -1, 'diamond_ore')                   // valuables are stashed too and still count
  r.bot.setBlock(4, -58, 1, 'diamond_ore')
  const res = await runJob(r, 'diamond', 50)
  assert.strictEqual(res.status, 'done')
  const chests = r.bot.placed.filter(p => p[3] === 'chest')
  assert.strictEqual(chests.length, 1, 'one work-site chest')
  const [cx, cy, cz] = chests[0]
  assert.strictEqual(cx, 0); assert.strictEqual(cy, -58); assert.ok(Math.abs(cz) === 1, 'first cell of a finished branch, beside the junction')
  assert.ok(r.added.some(a => a[0] === 'mine diamond') && r.added.some(a => a[0] === 'worksite mining'))
  assert.deepStrictEqual(r.removed, ['worksite mining'])
  // exactly one haul, forced, after the last dig
  assert.strictEqual(r.dep.length, 1); assert.strictEqual(r.dep[0].force, true); assert.strictEqual(r.dep[0].digs, r.bot.digs - 1)
  // the chest is gone again and back in the bag; nothing is lost
  assert.strictEqual(r.bot.blockAt(new Vec3(cx, cy, cz)).name, 'air')
  assert.strictEqual(r.bot.count('chest'), 1)
  assert.strictEqual(r.state.worksite, null)
  assert.strictEqual(r.bot.count('diamond'), 2); assert.strictEqual(r.state.job.gained, 2)
  assert.ok(r.bot.count('andesite') >= 1)
  assert.deepStrictEqual(r.bot.losViolations, [], 'placing, opening and breaking the chest all had a clear line of sight')
  assert.ok(r.said.some(s => /Work-site chest is down/.test(s)) && r.said.some(s => /picked the chest up/.test(s)))
})
test('worksite: the ledger survives a kill, and a fresh "haul" finishes the job from it', async () => {
  const r = mk()
  r.bot.setBlock(2, -58, 0, 'andesite')
  r.engine.begin('diamond', 50)
  const ctx = fakeCtx({ checkpoint() { if (r.state.worksite && r.state.worksite.items.andesite && r.bot.digs > 40) throw Object.assign(new Error('stop'), { name: 'AbortError' }) } })
  await assert.rejects(() => r.engine.run(ctx), /stop/)                 // killed while the chest still holds stock
  assert.ok(r.state.worksite, 'ledger survives')
  assert.ok(r.state.worksite.items.andesite >= 1)
  assert.strictEqual(r.bot.count('chest'), 0)
  const [x, y, z] = r.state.worksite.pos
  const stored = r.bot.chestItems(x, y, z).andesite
  assert.ok(stored >= 1)
  await r.engine.haulOnly(fakeCtx())
  assert.strictEqual(r.state.worksite, null)
  assert.ok(r.bot.count('andesite') >= stored)
  assert.strictEqual(r.bot.blockAt(new Vec3(x, y, z)).name, 'air')
  assert.strictEqual(r.bot.count('chest'), 1)
  assert.ok(r.dep.length >= 1 && r.dep.every(d => d.force))
})
test('worksite: no chest in the bag -> asks the crafting module for one and places it', async () => {
  const r = mk({ chest: 0, dispatch: (u, t) => { if (t === 'craft chest') r.bot.give('chest', 1); return true } })
  r.bot.setBlock(2, -58, 0, 'andesite')
  await runJob(r, 'diamond', 50)
  assert.ok(r.calls.dispatch.includes('craft chest'))
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'chest').length, 1)
  assert.ok(r.said.some(s => /Making a chest/.test(s)))
})
test('worksite: if no chest can be had it falls back to the normal haul (and keeps mining)', async () => {
  const r = mk({ chest: 0, dispatch: () => true })
  r.bot.setBlock(2, -58, 0, 'andesite')
  const res = await runJob(r, 'diamond', 50)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'chest').length, 0)
  assert.ok(r.calls.dispatch.filter(t => t === 'craft chest').length <= 2)
  assert.ok(r.dep.length >= 1, 'the ordinary deposit was used')
  assert.strictEqual(r.state.mines[0].trunk, 6)
})
test('worksite: near the final chests the ordinary deposit is used (no work-site chest)', async () => {
  const r = mk({ config: { worksite: { home: [0, -58, 0], minDistance: 60 } } })
  r.bot.setBlock(2, -58, 0, 'andesite')
  await runJob(r, 'diamond', 50)
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'chest').length, 0)
  assert.ok(r.dep.length >= 1)
})
test('worksite: a nearly full chest is hauled in the middle of the job, the chest stays, and a final haul still follows', async () => {
  const r = mk({ config: { worksite: { haulAt: 0.04 } } })
  r.bot.setBlock(2, -58, 0, 'andesite')
  r.bot.setBlock(3, -58, 1, 'diorite'); r.bot.setBlock(1, -58, 3, 'granite')
  await runJob(r, 'diamond', 50)
  assert.ok(r.dep.length >= 2, `hauled ${r.dep.length} times`)
  assert.ok(r.dep[0].digs < r.bot.digs - 1, 'one haul happened mid-job')
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'chest').length, 1, 'the same chest all along')
  assert.strictEqual(r.state.worksite, null)
})
test('worksite: a chest that is gone is forgotten, never searched for; nothing is opened or broken', async () => {
  const r = mk()
  r.state.worksite = { pos: [0, -58, -1], stand: [0, -58, 0], items: { andesite: 5 }, slots: 1, cap: 27, jobStartedAt: 'x' }
  await r.engine.haulOnly(fakeCtx())
  assert.strictEqual(r.state.worksite, null)
  assert.ok(r.said.some(s => /chest is gone/.test(s)))
  assert.ok(!r.bot.actions.some(a => a[0] === 'open'))
  assert.strictEqual(r.bot.digs, 0)
})
test('worksite: chat phrases', () => {
  const P = require('../brain/mining').phrases
  for (const t of ['haul mining', 'haul the worksite', 'empty the work-site chest', 'unload the mining chest', 'work site chest haul']) assert.ok(P.HAUL.test(t), t)
  for (const t of ['craft chest', 'mine diamonds 5', 'stop mining', 'mining status', 'open the chest']) assert.ok(!P.HAUL.test(t), t)
})
test('worksite: only torches and the work-site chest are ever placed', async () => {
  const r = mk({ torchCount: 10 })
  r.bot.setBlock(2, -58, 0, 'andesite')
  await runJob(r, 'diamond', 50)
  assert.ok(r.bot.placed.length >= 2)
  assert.ok(r.bot.placed.every(p => p[3] === 'torch' || p[3] === 'chest'))
})
