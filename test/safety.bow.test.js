process.env.ALLOW_ARMOR = '1'   // these tests cover the armor logic itself; the live bots run with armor off (Act 2)
const test = require('node:test')
const assert = require('node:assert')
const { simulate, solvePitch, solveAim, bowItem, arrowCount, FULL_DRAW_MS } = require('../brain/safety/bow')
const { bestWeapon, cooldownMs, armorUpgrades } = require('../brain/safety/gear')

test('solvePitch: an arrow flown at that pitch really passes through the target point', () => {
  for (const [dist, dy] of [[10, 0], [20, 0], [30, -2], [15, 3], [40, 5]]) {
    const s = solvePitch(dist, dy)
    assert.ok(s, `reachable ${dist},${dy}`)
    assert.ok(Math.abs(simulate(s.pitch, dist).y - dy) < 0.02, `miss at ${dist},${dy}`)
  }
})
test('solvePitch: nothing beyond a bow range', () => {
  assert.strictEqual(solvePitch(400, 0), null)
})
test('gravity: a flat shot at 20 blocks needs a little upward pitch; farther needs more', () => {
  const p20 = solvePitch(20, 0).pitch, p40 = solvePitch(40, 0).pitch
  assert.ok(p20 > 0 && p20 < 0.06 && p40 > p20)
})
test('solveAim: yaw points at the target (mineflayer convention) and leads a walking target', () => {
  const from = { x: 0, y: 65.6, z: 0 }
  const still = solveAim(from, { x: 20, y: 65, z: 0 })
  assert.ok(Math.abs(still.yaw - Math.atan2(-20, 0)) < 1e-9)
  const lead = solveAim(from, { x: 20, y: 65, z: 0 }, { x: 0, y: 0, z: 4 })
  assert.notStrictEqual(lead.yaw, still.yaw, 'aims ahead of a target moving +z')
  assert.ok(FULL_DRAW_MS > 1000)
})
test('bow / arrow inventory helpers', () => {
  const inv = [{ name: 'bow', count: 1 }, { name: 'arrow', count: 12 }, { name: 'spectral_arrow', count: 3 }, { name: 'tipped_arrow', count: 1 }]
  assert.strictEqual(bowItem(inv).name, 'bow'); assert.strictEqual(arrowCount(inv), 16); assert.strictEqual(bowItem([]), null)
})

test('gear: best weapon prefers swords, then axes; cooldowns', () => {
  const inv = (...n) => n.map(name => ({ name, count: 1 }))
  assert.strictEqual(bestWeapon(inv('wooden_sword', 'stone_sword', 'diamond_axe')).name, 'stone_sword')
  assert.strictEqual(bestWeapon(inv('stone_axe', 'iron_axe')).name, 'iron_axe')
  assert.strictEqual(bestWeapon(inv('stone_pickaxe', 'bread')), null)
  assert.strictEqual(cooldownMs({ name: 'stone_sword' }), 650); assert.ok(cooldownMs({ name: 'iron_axe' }) > 1000)
})
test('gear: armor upgrades only from what is carried, per slot, only if better than worn', () => {
  const it = (name) => ({ name, count: 1 })
  const inv = [it('iron_helmet'), it('leather_chestplate'), it('diamond_chestplate'), it('iron_boots')]
  const ups = armorUpgrades(inv, { head: it('leather_helmet'), torso: null, legs: null, feet: it('diamond_boots') })
  const by = Object.fromEntries(ups.map(u => [u.slot, u.item.name]))
  assert.deepStrictEqual(by, { head: 'iron_helmet', torso: 'diamond_chestplate' })
  assert.deepStrictEqual(armorUpgrades([], {}), [])
})
