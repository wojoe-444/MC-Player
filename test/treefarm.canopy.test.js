// brain/treefarm: after the felling the bot stays and breaks the doomed leaves by hand (Walter), with line of sight, the right tool,
// and picks up what they drop.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { rig, growTree, addBranch, countBlocks, blockName, fakeCtx } = require('./treefarm.helpers')

const mk = (opts) => rig(opts)
const done = (r) => r.stop()
const run = (r, o = {}, ctx = fakeCtx()) => r.engine.run(ctx, { manual: true, ...o })
const leavesAround = (bot, cx, cz, r = 8) => {
  let n = 0
  for (let x = cx - r; x <= cx + r; x++) for (let y = 62; y < 100; y++) for (let z = cz - r; z <= cz + r; z++) if (/_leaves$/.test(bot.blockAt(new Vec3(x, y, z)).name)) n++
  return n
}
const items = (bot) => Object.values(bot.entities).filter(e => e.name === 'item')

test('after the felling every leaf of the tree is broken by hand, nothing is left on the ground, and it replants afterwards', async () => {
  const r = mk({ inv: { iron_axe: 1, dirt: 20, oak_sapling: 2 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 6 })
  const before = leavesAround(bot, 4, 3)
  assert.ok(before > 20)
  await run(r, { count: 1 })
  assert.strictEqual(leavesAround(bot, 4, 3), 0, 'canopy cleared')
  assert.strictEqual(items(bot).length, 0, 'no item piles: every drop was picked up')
  assert.ok(bot.count('stick') >= 1, 'the sticks the leaves dropped are in the bag')
  assert.strictEqual(blockName(bot, 4, 64, 3), 'oak_sapling', 'replanted after the canopy was cleared')
  assert.strictEqual(bot.losViolations.length, 0, bot.losViolations.join(' | '))
  assert.ok(r.said.some(t => /leaves cleared by hand/.test(t)), r.said.join(' | '))
  done(r)
})

test('a tall spruce: the high canopy is cleared from a pillar too, then the pillar is gone', async () => {
  const r = mk({ inv: { iron_axe: 1, dirt: 30, spruce_sapling: 2 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 14, species: 'spruce' })
  await run(r, { count: 1 })
  assert.strictEqual(leavesAround(bot, 4, 3), 0)
  assert.strictEqual(countBlocks(bot, 'dirt'), 0)
  assert.strictEqual(items(bot).filter(e => e.itemName === 'dirt').length, 0)
  assert.ok(Math.abs(bot.entity.position.y - 64) < 0.01)
  assert.strictEqual(bot.losViolations.length, 0)
  done(r)
})

test('only doomed leaves go: the leaves of a neighbouring tree that still has its logs are left alone', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 2 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 6 })
  growTree(bot, { x: 9, z: 3, h: 6 })                                   // close enough that the crowns touch
  const neighbourLeaves = () => { let n = 0; for (let x = 7; x <= 11; x++) for (let y = 66; y < 72; y++) for (let z = 1; z <= 5; z++) if (/_leaves$/.test(bot.blockAt(new Vec3(x, y, z)).name)) n++; return n }
  const n0 = neighbourLeaves()
  await run(r, { count: 1 })
  assert.ok(neighbourLeaves() >= n0 - 12, `neighbour keeps its crown (${neighbourLeaves()} of ${n0})`)
  assert.strictEqual(blockName(bot, 9, 66, 3), 'oak_log', 'and its logs')
  done(r)
})

test('the right tool: a hoe if there is one, shears next, otherwise the bare hand (never the axe)', async () => {
  const held = []
  for (const inv of [{ iron_axe: 1, dirt: 20, stone_hoe: 1, shears: 1, oak_sapling: 2 }, { iron_axe: 1, dirt: 20, shears: 1, oak_sapling: 2 }, { iron_axe: 1, dirt: 20, oak_sapling: 2 }]) {
    const r = mk({ inv }); const { bot } = r
    const base = bot.dig
    const used = new Set()
    bot.dig = async (b, f) => { if (/_leaves$/.test(b.name)) used.add(bot.heldItem ? bot.heldItem.name : 'hand'); return base(b, f) }
    growTree(bot, { x: 4, z: 3, h: 6 })
    await run(r, { count: 1 })
    held.push([...used].join(','))
    assert.strictEqual(leavesAround(bot, 4, 3), 0)
    done(r)
  }
  assert.deepStrictEqual(held, ['stone_hoe', 'shears', 'hand'])
})

test('with shears the leaf blocks are picked up too and put into the wood chest, not left lying around or kept', async () => {
  const r = mk({ inv: { iron_axe: 1, dirt: 20, shears: 1, oak_sapling: 2 } }); const { bot } = r
  const base = bot.dig
  bot.dig = async (b, f) => {                                            // shears: the leaf block itself drops
    if (!/_leaves$/.test(b.name)) return base(b, f)
    const { x, y, z } = b.position
    bot.actions.push(['dig', b.name, x, y, z]); bot.digs++
    bot.setBlock(x, y, z, 'air'); bot.addItemEntity(x + 0.5, y + 0.5, z + 0.5, b.name, 1)
  }
  growTree(bot, { x: 4, z: 3, h: 6 })
  await run(r, { count: 1, })
  assert.strictEqual(items(bot).length, 0)
  assert.strictEqual(bot.count('oak_leaves'), 0, 'not kept in the bag')
  assert.ok((bot.chestItems(10, 64, 10).oak_leaves || 0) + (bot.chestItems(12, 64, 10).oak_leaves || 0) > 10)
  done(r)
})

test('danger in the middle of the canopy work brings it down and pauses; nothing out of line of sight is broken', async () => {
  const r = mk({ inv: { iron_axe: 1, dirt: 30, spruce_sapling: 2 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 14, species: 'spruce' })
  let broke = 0
  bot.onDig = (n, b) => { if (/_leaves$/.test(b.name) && ++broke === 10 && bot.entity.position.y > 66) bot.entities[99] = { id: 99, name: 'zombie', position: new Vec3(2, bot.entity.position.y, 3) } }
  const res = await run(r, { count: 1 })
  assert.ok(['retry', 'done'].includes(res.status))
  assert.strictEqual(countBlocks(bot, 'dirt'), 0, 'pillar dug away')
  assert.strictEqual(r.state.pillar, null)
  assert.ok(Math.abs(bot.entity.position.y - 64) < 0.01)
  assert.strictEqual(bot.losViolations.length, 0)
  done(r)
})

test('clearLeaves:false keeps the old behaviour (leaves decay by themselves, drops collected on a later visit)', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 2 }, config: { clearLeaves: false } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 6 })
  await run(r, { count: 1 })
  assert.ok(leavesAround(bot, 4, 3) > 20)
  assert.strictEqual(r.state.decay.length, 1)
  done(r)
})
