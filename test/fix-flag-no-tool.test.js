// flag-no-tool (work order): the no_tool flag fired on bare-hand digs of dirt and oak leaves. Those break with any item (no harvestTools in minecraft-data),
// but brain/telemetry/detectors.js wrongToolFlag() counted every dig whose whitelisted tool class (shovel for dirt, hoe or shears for leaves) was not in the bag,
// so a speed preference read as a tool the bag lacks. The flag should count only a block that needs a tool to drop (a harvestTools list, as the bot's own
// canHarvest in brain/autopilot/skills.js treats it), with no tool of its class in the bag.
const test = require('node:test')
const assert = require('node:assert')
const data = require('minecraft-data')('1.21.6')
const D = require('../brain/telemetry/detectors')

const T0 = 1_700_000_000_000
const now = T0 + 60000
// a quiet minute of samples at 4 Hz, the way the telemetry ring holds them
const ring = () => Array.from({ length: 241 }, (_, i) => ({ t: T0 + i * 250, x: 0, y: 64, z: 0, g: 1, vy: 0, yaw: 0, h: '', mv: 0, act: 0, dg: '', tk: 'autopilot', hp: 20 }))

// one dig event as brain/telemetry/index.js recordDig writes it: the block as minecraft-data has it, the held item, the bag
function dig(i, name, held, bag) {
  const block = data.blocksByName[name], item = held ? data.itemsByName[held] : null
  const hn = block.harvestTools ? Object.keys(block.harvestTools).map(id => data.items[id].name) : null
  const c = D.toolCheck(block, item ? { name: held, type: item.id } : null, bag, hn)
  return { k: 'dig', t: T0 + 1000 + i * 1500, block: name, x: i, y: 64, z: 0, held: held || '', need: c.need, have: c.have, ok: c.ok, harvestOk: c.harvestOk, needsTool: c.needsTool }
}

test('dirt and oak leaves broken by hand need no tool: no no_tool flag, even with 8+ digs and no shovel or hoe in the bag', () => {
  // the order: dirt x8 bare-handed (15:01Z), oak_leaves x24 bare-handed (15:16Z); smeo: dirt with a stone_axe, no shovel in the bag
  const digs = [
    ...Array.from({ length: 8 }, (_, i) => dig(i, 'dirt', null, ['stone_pickaxe'])),
    ...Array.from({ length: 24 }, (_, i) => dig(8 + i, 'oak_leaves', null, ['stone_pickaxe'])),
    dig(40, 'dirt', 'stone_axe', ['stone_axe']),
  ]
  const flags = D.analyze(ring(), digs, now)
  assert.ok(!flags.some(f => f.kind === 'no_tool'), JSON.stringify(flags.filter(f => f.kind === 'no_tool').map(f => f.msg)))
})

test('stone dug by hand with no pickaxe in the bag still gets no_tool: a block that needs a tool the bag lacks', () => {
  const digs = Array.from({ length: 8 }, (_, i) => dig(i, 'stone', null, ['stone_sword']))
  const f = D.analyze(ring(), digs, now).find(x => x.kind === 'no_tool')
  assert.ok(f, 'stone needs a pickaxe and the bag has none')
  assert.match(f.msg, /8 digs in 5 min with no suitable tool in the bag at all: stone with bare hand x8/)
})
