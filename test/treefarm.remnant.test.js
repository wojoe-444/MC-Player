// Finishing a half-felled tree (Walter 2026-11-11: trees cut only part of the way up, the logs that stayed keeping whole canopies alive). engine.finishRemnant takes
// logs that stand on nothing the rest of the way down with the same machinery as a whole felling: the pillar from the trunk column, the canopy by hand, the descent.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { rig, growTree, addBranch, blockName, fakeCtx } = require('./treefarm.helpers')

const logsOf = (bot, cx, cz, r = 6) => { let n = 0; for (let x = cx - r; x <= cx + r; x++) for (let y = 64; y < 90; y++) for (let z = cz - r; z <= cz + r; z++) if (/_log$/.test(bot.blockAt(new Vec3(x, y, z)).name)) n++; return n }
const leavesAround = (bot, cx, cz, r = 8) => { let n = 0; for (let x = cx - r; x <= cx + r; x++) for (let y = 62; y < 100; y++) for (let z = cz - r; z <= cz + r; z++) if (/_leaves$/.test(bot.blockAt(new Vec3(x, y, z)).name)) n++; return n }
const cutFromBottom = (bot, x, z, upTo) => { for (let y = 64; y <= upTo; y++) bot.setBlock(x, y, z, 'air') }

test('a tree cut up to 6 blocks: finishRemnant takes the remaining logs and limbs down from a pillar, clears the canopy, and leaves no scaffold behind', async () => {
  const r = rig({ inv: { iron_axe: 1, dirt: 30, oak_sapling: 2 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 11 })
  addBranch(bot, { x: 4, z: 3, y: 71, dx: 1, dz: 0, len: 3 })
  cutFromBottom(bot, 4, 3, 69)                                          // the ground pass got 6 logs; the rest stands on nothing
  assert.ok(logsOf(bot, 4, 3) >= 5)
  const pos = new Vec3(4, 70, 3)
  const res = await r.engine.finishRemnant(fakeCtx(), pos)
  assert.strictEqual(res.status, 'done', JSON.stringify(res))
  assert.strictEqual(logsOf(bot, 4, 3), 0, 'every log is gone')
  assert.strictEqual(leavesAround(bot, 4, 3), 0, 'and the canopy that hung on them')
  assert.strictEqual(Object.values(bot.entities).filter(e => e.name === 'item' && e.itemName === 'dirt').length, 0, 'no dirt pile on the ground')
  for (let y = 65; y < 80; y++) assert.strictEqual(blockName(bot, 4, y, 3), 'air', `column clear at ${y}`)
  assert.ok(Math.abs(bot.entity.position.y - 64) < 0.01, 'back on the ground')
  assert.strictEqual(bot.losViolations.length, 0, bot.losViolations.join(' | '))
  r.stop()
})

test('finishRemnant refuses a living tree (it stands on soil) and a position with no log', async () => {
  const r = rig({ inv: { iron_axe: 1, dirt: 30 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 7 })
  const a = await r.engine.finishRemnant(fakeCtx(), new Vec3(4, 66, 3))
  assert.strictEqual(a.status, 'gone'); assert.strictEqual(blockName(bot, 4, 70, 3), 'oak_log', 'untouched')
  const b = await r.engine.finishRemnant(fakeCtx(), new Vec3(20, 66, 20))
  assert.strictEqual(b.status, 'gone')
  r.stop()
})

test('with no dirt to climb with, it reports it instead of looping', async () => {
  const r = rig({ inv: { iron_axe: 1 }, storage: false }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 11 }); cutFromBottom(bot, 4, 3, 69)
  const res = await r.engine.finishRemnant(fakeCtx(), new Vec3(4, 70, 3))
  assert.ok(res.status === 'done' && (res.noScaffold || res.left > 0), JSON.stringify(res))
  r.stop()
})

// ---- the autopilot's own chopper (S.chopTree) hands the rest of the tree to the engine instead of leaving it ----
const EE = require('events')
const makeSkills = require('../brain/autopilot/skills')
function chopper(treefarm) {
  const bot = new EE(); bot.version = '1.21.6'; bot.entity = { position: new Vec3(0.5, 64, 0.5) }; bot.inventory = { items: () => [], slots: [] }
  bot.pathfinder = { setMovements() {}, setGoal() {} }; bot.clickWindow = async () => {}; bot.equip = async () => {}; bot.unequip = async () => {}; bot.registry = require('minecraft-data')('1.21.6')
  const logs = []
  const S = makeSkills({ bot, api: { statePath: (f) => '/tmp/' + f, log() {}, say() {}, treefarm }, log(t, m) { logs.push(t + ' ' + m) } })
  clearInterval(bot._resyncTimer); clearInterval(bot._hotbarTimer)
  return { S, bot, logs }
}

test('S.chopTree: logs above the bot\'s reach are no longer left standing: after the ground pass the engine finishes the tree, before anything is replanted', async () => {
  const world = new Map(); const order = []
  for (let y = 64; y <= 73; y++) world.set(`4,${y},3`, 'oak_log')                      // a 10-log trunk, 4 blocks from the bot
  let finished = null
  const finishRemnant = async (ctx, pos) => { finished = pos.clone(); order.push('finish'); let n = 0; for (const [k, nm] of [...world]) if (nm === 'oak_log') { world.set(k, 'air'); n++ } return { status: 'done', logs: n, left: 0 } }
  const { S } = chopper({ engine: { finishRemnant }, naturalPolicy: () => ({ natural: true }) })
  S.ctx = { checkpoint() {}, sleep: () => Promise.resolve() }
  const blk = (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) || (p.y < 64 ? 'dirt' : 'air'), position: new Vec3(p.x, p.y, p.z), boundingBox: 'block' })
  S.block = blk; S.isAir = (b) => !b || b.name === 'air'
  S.check = () => {}; S.freeSlots = () => 20; S.logs = () => 0; S.planks = () => 0; S.items = () => [{ name: 'oak_sapling', count: 1 }]; S.pickup = async () => 0; S.ban = () => {}
  S.seen = () => [...world].filter(([, n]) => n === 'oak_log').map(([k]) => { const [x, y, z] = k.split(',').map(Number); return blk(new Vec3(x, y, z)) })
  S.mine = async (b) => { if (b.position.y - 64 > 5) return false; world.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air'); return true }   // what an arm can reach from the ground
  S.placeAgainst = async (ref, face, name) => { order.push('replant ' + name); return true }
  const got = await S.chopTree(4, { ms: 5000 })
  assert.ok(finished, 'the engine was asked to finish the tree')
  assert.strictEqual(finished.y, 70, 'from the lowest log still standing (the ground pass cut 64..69)')
  assert.deepStrictEqual(order, ['finish', 'replant oak_sapling'], 'finished first, replanted after')
  assert.strictEqual([...world.values()].filter(n => n === 'oak_log').length, 0)
  assert.ok(got >= 10, 'the logs of the finish count: ' + got)
})

test('S.chopTree: without the engine it behaves as before (no crash)', async () => {
  const world = new Map()
  for (let y = 64; y <= 68; y++) world.set(`4,${y},3`, 'oak_log')
  const { S } = chopper(null)
  S.ctx = { checkpoint() {}, sleep: () => Promise.resolve() }
  const blk = (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) || 'air', position: new Vec3(p.x, p.y, p.z), boundingBox: 'block' })
  S.block = blk; S.isAir = (b) => !b || b.name === 'air'; S.check = () => {}; S.freeSlots = () => 20; S.logs = () => 0; S.planks = () => 0; S.items = () => []; S.pickup = async () => 0; S.ban = () => {}
  S.seen = () => [...world].filter(([, n]) => n === 'oak_log').map(([k]) => { const [x, y, z] = k.split(',').map(Number); return blk(new Vec3(x, y, z)) })
  S.mine = async (b) => { world.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air'); return true }
  assert.strictEqual(await S.chopTree(2, { ms: 3000 }), 5)
})
