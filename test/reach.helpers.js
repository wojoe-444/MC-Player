// Test rig for brain/nav/reach.js: the nav.helpers.js sim plus a stateful fake bot.dig / bot.placeBlock / inventory, so walls really come
// down and go back up in the real pathfinder + physics.
const { rig, goals, mcData } = require('./nav.helpers')

const DROP = { stone: 'cobblestone', grass_block: 'dirt', stone_bricks: 'stone_bricks', oak_planks: 'oak_planks', iron_door: 'iron_door', glass: null, deepslate: 'cobbled_deepslate' }

// the sim keeps its inventory in a closed-over array: wrap give() so armDigging can list it with counts that change
function makeRig(simOpts, build, navOpts) {
  return rig(simOpts, build, navOpts).then(r => {
    const items = []
    r.sim.give = (name, count = 1) => { const mc = mcData; const it = { name, count, type: (mc.itemsByName[name] || {}).id }; items.push(it); return it }
    r.bot.inventory.items = () => items.filter(i => i.count > 0)
    r.bot.inventory.count = (type) => items.filter(i => i.type === type).reduce((s, i) => s + i.count, 0)
    return r
  })
}

async function setup(build, { items = { cobblestone: 16, iron_pickaxe: 1 }, pos = [0.5, 64, 0.5], digTicks = 6, reach = {} } = {}) {
  const r = await makeRig({ pos }, build, { config: { escalate: true, reach: { thinkBase: 700, thinkMax: 2500, planMsBase: 8000, planMsPerBlock: 300, planMsMax: 30000, ...reach } } })
  const { sim, bot } = r
  for (const [n, c] of Object.entries(items)) sim.give(n, c)
  const wait = (n) => new Promise(res => { let k = 0; const f = () => { if (++k >= n) { bot.removeListener('physicsTick', f); res() } }; bot.on('physicsTick', f) })
  const log = { dug: [], placed: [] }
  bot.dig = async (block) => {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 5.2) throw new Error('too far to dig')
    await wait(digTicks)
    const cur = bot.blockAt(block.position)
    if (!cur || cur.type !== block.type) throw new Error('block changed')
    const old = sim.set(block.position.x, block.position.y, block.position.z, 'air')
    log.dug.push(`${block.name}@${block.position.x},${block.position.y},${block.position.z}`)
    const d = block.name in DROP ? DROP[block.name] : block.name
    if (d) { const have = bot.inventory.items().find(i => i.name === d); if (have) have.count++; else sim.give(d, 1) }
    bot.emit('blockUpdate', old, bot.blockAt(block.position))
  }
  bot.placeBlock = async (ref, face) => {
    const it = bot.heldItem
    if (!it || !(it.count > 0)) throw new Error('nothing in hand')
    const p = ref.position.plus(face)
    const me = bot.entity.position
    if (Math.abs(me.x - (p.x + 0.5)) < 0.9 && Math.abs(me.z - (p.z + 0.5)) < 0.9 && me.y + 1.8 > p.y && me.y < p.y + 1) throw new Error('inside the bot')
    const here = bot.blockAt(p)
    if (here && here.boundingBox !== 'empty') throw new Error('occupied')
    await wait(2)
    const old = sim.set(p.x, p.y, p.z, it.name)
    it.count--
    log.placed.push(`${it.name}@${p.x},${p.y},${p.z}`)
    bot.emit('blockUpdate', old, bot.blockAt(p))
  }
  r.log = log
  r.run = async (goal, o = {}) => {
    let res = null
    r.nav.goto(goal, { label: 'test', ms: 4000, ...o }).then(x => { res = x })
    const t = await sim.run(() => res, o.maxTicks || 6000)
    return res || { ok: false, err: 'no result in ' + t.ticks + ' ticks' }
  }
  return r
}


module.exports = { setup, makeRig, DROP }
