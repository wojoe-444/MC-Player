// brain/nav/reach.js: the go-to that does not give up. Real pathfinder planner + real physics over a fake voxel world (test/nav.helpers.js),
// with a stateful fake bot.dig / bot.placeBlock / inventory so walls really come down and go back up (test/reach.helpers.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('./nav.helpers')
const { setup } = require('./reach.helpers')

const flat = (sim) => { sim.floor(-30, -30, 40, 40, 63) }

test('walled-in target: the bot tears the wall down, gets there, and puts the wall back', async () => {
  const r = await setup((sim) => {
    flat(sim)
    // a 7x7 ring wall (stone bricks, 3 high) around the target at (10, 64, 0); the bot is outside at 0,64,0
    for (let y = 64; y <= 66; y++) for (let x = 7; x <= 13; x++) for (let z = -3; z <= 3; z++) if (x === 7 || x === 13 || z === -3 || z === 3) sim.set(x, y, z, 'stone_bricks')
    sim.fill(7, 67, -3, 13, 67, 3, 'stone_bricks')            // roof too
  })
  try {
    const res = await r.run(new goals.GoalBlock(10, 64, 0), { maxTicks: 4000 })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-12).join('\n'))
    const p = r.bot.entity.position
    assert.ok(Math.hypot(p.x - 10.5, p.z - 0.5) < 1.2, `ended at ${p}`)
    assert.ok(r.log.dug.length >= 2, 'it had to dig: ' + r.log.dug.join(' '))
    // every dug stone_bricks cell is stone bricks again (walls rebuilt from the inside)
    await r.sim.run(null, 400)
    const holes = r.log.dug.filter(s => s.startsWith('stone_bricks')).map(s => s.split('@')[1].split(',').map(Number)).filter(([x, y, z]) => r.sim.blockName(x, y, z) !== 'stone_bricks')
    assert.deepEqual(holes, [], 'wall not rebuilt: ' + holes.join(' | ') + '\n' + r.logs.slice(-15).join('\n'))
  } finally { r.close() }
})

test('a gap too wide to jump is bridged with the blocks in the bag', async () => {
  const r = await setup((sim) => {
    sim.floor(-10, -10, 6, 10, 63); sim.floor(14, -10, 30, 10, 63)           // 7-wide void between x=7..13
  })
  try {
    const res = await r.run(new goals.GoalBlock(20, 64, 0), { maxTicks: 3000 })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-10).join('\n'))
    assert.ok(r.log.placed.length >= 2, 'placed ' + r.log.placed.length)
  } finally { r.close() }
})

test('a target sealed inside solid rock is reached by tunnelling (natural stone is left as a tunnel)', async () => {
  const r = await setup((sim) => {
    flat(sim)
    sim.fill(5, 64, -5, 25, 70, 5, 'stone')
    sim.clear(5, 64, 0); sim.clear(5, 65, 0)                                  // the bot is in a cove at x<=4; target pocket at x=20
    for (const y of [64, 65]) sim.clear(20, y, 0)
  })
  try {
    const res = await r.run(new goals.GoalBlock(20, 64, 0), { maxTicks: 6000 })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-10).join('\n'))
    assert.ok(r.log.dug.length >= 8, 'dug ' + r.log.dug.length)
  } finally { r.close() }
})

test('a sealed tower is climbed with a pillar when the target is straight up', async () => {
  const r = await setup((sim) => {
    flat(sim)
    sim.fill(-1, 64, -1, 1, 90, 1, 'air')
  }, { pos: [0.5, 64, 0.5] })
  try {
    const res = await r.run(new goals.GoalBlock(0, 70, 0), { maxTicks: 3000, startAtDig: true })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-10).join('\n'))
    assert.ok(r.bot.entity.position.y >= 68.9, 'y ' + r.bot.entity.position.y)
  } finally { r.close() }
})

test('chests are never dug, the walls a ladder hangs on stay up', async () => {
  const r = await setup((sim) => {
    flat(sim)
    // a wall at x=8 with a chest in the middle of it and ladders on the far side hanging on part of it
    for (let y = 64; y <= 66; y++) for (let z = -30; z <= 40; z++) sim.set(8, y, z, 'stone_bricks')
    sim.set(8, 64, 0, 'chest', { facing: 'west', type: 'single', waterlogged: false })
    sim.set(8, 65, 0, 'chest', { facing: 'west', type: 'single', waterlogged: false })
    sim.ladder(9, 64, 66, -1, 'east')                                          // ladder cells at x=9 facing east: they hang on x=8
    sim.set(9, 64, -1, 'ladder', { facing: 'east', waterlogged: false })
  })
  try {
    const res = await r.run(new goals.GoalBlock(14, 64, 0), { maxTicks: 4000 })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-10).join('\n'))
    assert.equal(r.sim.blockName(8, 64, 0), 'chest')
    assert.equal(r.sim.blockName(8, 65, 0), 'chest')
    assert.ok(!r.log.dug.some(s => /chest|ladder/.test(s)), r.log.dug.join(' '))
    assert.ok(!r.log.dug.some(s => /@8,6[4-6],-1$/.test(s)), 'dug the ladder wall: ' + r.log.dug.join(' '))
  } finally { r.close() }
})

test('an iron door is a wall like any other', async () => {
  const r = await setup((sim) => {
    flat(sim)
    for (let y = 64; y <= 66; y++) for (let z = -30; z <= 40; z++) sim.set(8, y, z, 'stone_bricks')
    sim.door(8, 64, 0, { facing: 'east', name: 'iron_door' })
  })
  try {
    const res = await r.run(new goals.GoalBlock(14, 64, 0), { maxTicks: 4000 })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-10).join('\n'))
    await r.sim.run(null, 300)
    // the breach through the door is closed again
    const cells = [64, 65].map(y => r.sim.blockName(8, y, 0))
    assert.ok(cells.every(n => n !== 'air'), 'doorway left open: ' + cells.join(','))
    assert.ok(r.log.dug.length >= 1, 'it had to break the door: ' + r.log.dug.join(' '))
  } finally { r.close() }
})

test('a stop in the middle ends the escalation at once', async () => {
  const r = await setup((sim) => {
    flat(sim)
    sim.fill(5, 64, -5, 60, 70, 5, 'stone')
    sim.clear(5, 64, 0); sim.clear(5, 65, 0)
  }, { digTicks: 10 })
  try {
    let res = null
    r.nav.goto(new goals.GoalBlock(50, 64, 0), { label: 'far', ms: 3000 }).then(x => { res = x })
    await r.sim.run(() => res, 300)
    assert.equal(res, null, 'still working after 300 ticks')
    r.nav.stop('aborted')
    const t = await r.sim.run(() => res, 200)
    assert.ok(res && res.ok === false, 'no stop: ' + JSON.stringify(res))
    assert.ok(t.ticks < 120, 'took ' + t.ticks + ' ticks to stop')
  } finally { r.close() }
})

test('a door the server will not open is torn down and the doorway is put back', async () => {
  const r = await setup((sim) => {
    flat(sim)
    for (let y = 64; y <= 66; y++) for (let z = -30; z <= 40; z++) sim.set(8, y, z, 'stone_bricks')
    sim.door(8, 64, 0, { facing: 'east', name: 'oak_door' }); sim.locked.add('8,64,0')
  })
  try {
    const res = await r.run(new goals.GoalBlock(14, 64, 0), { maxTicks: 4000 })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-10).join('\n'))
    await r.sim.run(null, 300)
    assert.ok(r.log.dug.length >= 1, 'dug ' + r.log.dug.join(' '))
    // whatever was broken in the wall line is back (stone bricks); the door cells are closed again by something solid or the door item
    const col = [64, 65].map(y => r.sim.blockName(8, y, 0))
    assert.ok(col.every(n => n !== 'air'), 'doorway left open: ' + col.join(','))
  } finally { r.close() }
})

test('lava is never walked into, dug beside, or bridged blindly: the bot goes round it', async () => {
  const r = await setup((sim) => {
    flat(sim)
    sim.fill(10, 63, -10, 12, 63, 10, 'lava')                         // a lava river with a way round at z>10
  })
  try {
    const touched = []
    r.bot.on('physicsTick', () => { const p = r.bot.entity.position; const b = r.bot.blockAt(p); if (b && b.name === 'lava') touched.push(p.toString()) })
    const res = await r.run(new goals.GoalBlock(20, 64, 0), { maxTicks: 4000 })
    assert.equal(res.ok, true, JSON.stringify(res) + '\n' + r.logs.slice(-10).join('\n'))
    assert.deepEqual(touched, [])
  } finally { r.close() }
})
