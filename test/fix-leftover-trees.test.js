// Work order leftover-trees: trees cut only part of the way up. When the trunk cell under the remaining logs cannot be walked to, chopTree gave up
// with `return 0` before it counted the logs that stand. finishRemnant then reported {status:'done', left:0}; the tidy step (autopilot/plan.js)
// counted that as finished and never put the tree on its retry list, so the two trees at the top of its list were retried every pass and
// the rest were never tried.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { rig, growTree, blockName, fakeCtx } = require('./treefarm.helpers')

test('a remnant whose trunk cell cannot be walked to is reported as left, not as finished: the logs stand and the tidy step retries it later', async () => {
  const r = rig({ inv: { iron_axe: 1, dirt: 30, oak_sapling: 2 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 11 })
  for (let y = 64; y <= 69; y++) bot.setBlock(4, y, 3, 'air')          // the ground pass cut 64..69; 70..74 stand on nothing
  bot.entity.position = new Vec3(-20.5, 64, -20.5)                     // far from the trunk
  bot.gotoFails = (goal, label) => label === 'a tree'                  // no path to the trunk cell under the logs
  const res = await r.engine.finishRemnant(fakeCtx(), new Vec3(4, 70, 3))
  assert.strictEqual(blockName(bot, 4, 70, 3), 'oak_log', 'nothing was touched')
  assert.ok(res.left > 0, 'the logs that stand are reported as left: ' + JSON.stringify(res))
  r.stop()
})
