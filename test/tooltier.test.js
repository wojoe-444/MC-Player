// brain/motor/tooltier.js: the lowest tier that does the job, for every site that used to pick the fastest tool.
const test = require('node:test')
const assert = require('node:assert')
const mc = require('minecraft-data')('1.21.6')
const Block = require('prismarine-block')('1.21.6')
const { minimumTool, rankOf } = require('../brain/motor/tooltier')

const block = (name) => Block.fromStateId(mc.blocksByName[name].defaultState, 0)
const item = (name) => ({ name, type: mc.itemsByName[name].id, count: 1 })
const bag = (...n) => n.map(item)
const pick = (b, ...n) => { const r = minimumTool(block(b), bag(...n)); return r && r.name }

test('stone is the default: stone before iron before diamond on stone; wood only when nothing else will do', () => {
  assert.strictEqual(pick('stone', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'), 'stone_pickaxe')
  assert.strictEqual(pick('stone', 'diamond_pickaxe', 'iron_pickaxe'), 'iron_pickaxe')
  assert.strictEqual(pick('stone', 'wooden_pickaxe', 'stone_pickaxe'), 'stone_pickaxe')
  assert.strictEqual(pick('stone', 'wooden_pickaxe'), 'wooden_pickaxe')                                 // wood when it is all there is
  assert.ok(rankOf('stone_axe') < rankOf('iron_axe') && rankOf('iron_axe') < rankOf('diamond_axe') && rankOf('diamond_axe') < rankOf('netherite_axe') && rankOf('golden_axe') < rankOf('wooden_axe'))
})

test('a higher tier only when the block requires it: iron for diamond ore, diamond for obsidian; nothing when the bag cannot do it', () => {
  assert.strictEqual(pick('diamond_ore', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe'), 'iron_pickaxe')
  assert.strictEqual(pick('iron_ore', 'iron_pickaxe', 'stone_pickaxe'), 'stone_pickaxe')
  assert.strictEqual(pick('obsidian', 'iron_pickaxe', 'diamond_pickaxe'), 'diamond_pickaxe')
  assert.strictEqual(pick('obsidian', 'iron_pickaxe', 'stone_pickaxe'), null)
  assert.strictEqual(pick('diamond_ore', 'stone_pickaxe'), null)
})

test('the right kind of tool: shovel for dirt, axe for logs, never a sword unless asked, worn-out tools skipped', () => {
  assert.strictEqual(pick('dirt', 'diamond_shovel', 'stone_shovel', 'iron_pickaxe'), 'stone_shovel')
  assert.strictEqual(pick('oak_log', 'iron_axe', 'stone_axe', 'iron_sword'), 'stone_axe')
  assert.strictEqual(pick('oak_log', 'iron_sword'), null)
  assert.strictEqual(minimumTool(block('bamboo'), bag('stone_sword', 'iron_axe'), { allowSword: true }).name, 'stone_sword')
  const items = bag('stone_pickaxe', 'iron_pickaxe'); items[0].worn = true
  assert.strictEqual(minimumTool(block('stone'), items, { durLeft: (it) => (it.worn ? 1 : 100) }).name, 'iron_pickaxe')
})

test('fallback: a caller that needs some tool in hand gets the LOWEST one for a block that needs none, never the best; blocks with a harvest list still get null', () => {
  assert.strictEqual(minimumTool(block('dirt'), bag('diamond_pickaxe', 'stone_pickaxe'), { fallback: true }).name, 'stone_pickaxe')
  assert.strictEqual(minimumTool(block('dirt'), bag('diamond_pickaxe', 'stone_pickaxe')), null)
  assert.strictEqual(minimumTool(block('diamond_ore'), bag('stone_pickaxe'), { fallback: true }), null)
})
