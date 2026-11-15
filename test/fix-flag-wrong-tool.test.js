// flag-wrong-tool (work order): the tree farm broke oak leaves with an axe while a stone hoe was in the bag, so the telemetry raised wrong_tool.
// brain/treefarm/engine.js clearLeaf() (the leaf in front of a log of the tree being felled) and raise() (the canopy in the way of a pillar jump)
// called equipAxe() before bot.dig. Leaves are whitelisted for a hoe or shears only (brain/telemetry/detectors.js toolCheck), so such a dig is
// flagged whenever a hoe is in the bag. The canopy pass (breakLeaf) already picks the hoe through equipLeafTool.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { toolCheck } = require('../brain/telemetry/detectors')
const { rig, fakeCtx } = require('./treefarm.helpers')

const done = (r) => r.stop()

// the telemetry's check at the start of each leaf dig: the block as minecraft-data has it (material "leaves;mineable/hoe")
function watchLeafDigs(bot) {
  const base = bot.dig, digs = []
  bot.dig = async (b, f) => {
    if (/_leaves$/.test(b.name)) {
      const held = bot.heldItem
      const c = toolCheck({ name: b.name, material: 'leaves;mineable/hoe', hardness: 0.2 }, held, bot.inventory.items().map(i => i.name), null)
      digs.push({ held: held ? held.name : 'hand', ok: c.ok, have: c.have })
    }
    return base(b, f)
  }
  return digs
}

test('felling: a leaf that hides a log in reach is broken with the hoe in the bag, not with the axe (no wrong_tool flag)', async () => {
  // a trunk, and one log above it walled in by leaves; the bot stands in reach with no way to walk to another view of that log
  const r = rig({ pos: [4.5, 64, 2.5], inv: { iron_axe: 1, stone_hoe: 1, dirt: 20, oak_sapling: 2 } }); const { bot } = r
  for (let y = 64; y <= 67; y++) bot.setBlock(4, y, 3, 'oak_log', { axis: 'y' })
  bot.setBlock(5, 68, 4, 'oak_log', { axis: 'y' })
  for (const [x, y, z] of [[4, 68, 4], [6, 68, 4], [5, 67, 4], [5, 69, 4], [5, 68, 3], [5, 68, 5], [3, 67, 3], [5, 67, 3], [4, 68, 3], [3, 68, 3], [4, 69, 3]]) bot.setBlock(x, y, z, 'oak_leaves', { persistent: false, distance: 1 })
  bot.tryGoto = async () => ({ ok: false })
  const digs = watchLeafDigs(bot)
  await r.engine.run(fakeCtx(), { manual: true, count: 1 })
  assert.strictEqual(bot.blockAt(new Vec3(5, 68, 4)).name, 'air', 'the walled-in log was felled once its leaf was broken')
  assert.ok(digs.length > 0, 'the leaves in front of the log were broken')
  const wrong = digs.filter(d => !d.ok && d.have).map(d => d.held)
  assert.deepStrictEqual(wrong, [], `leaves broken with ${[...new Set(wrong)].join(', ')} while a stone_hoe was in the bag`)
  done(r)
})
