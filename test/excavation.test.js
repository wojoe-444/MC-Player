const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { rig, carve, fakeCtx, waitFor, cells, wait, SMALL, base, PRIORITY } = require('./excavation.helpers')
const plan = require('../brain/excavation/plan')
const stateStore = require('../brain/excavation/state')

const MAP = path.join(__dirname, '..', 'room-map.txt')
const run = (r, ctx = fakeCtx()) => r.engine.run(ctx)
const airAt = (r, key) => r.bot.blockAt(new Vec3(...key.split(',').map(Number))).name === 'air'

// ---------------------------------------------------------------- planning

test('sections: 3x3 serpentine, ids are the "gx,gz" corner that exc-state.json used', () => {
  const r = rig()
  const cols = plan.footprint(r.bot, r.engine.geo)
  assert.strictEqual(cols.length, 36)
  assert.deepStrictEqual(plan.groupsOf(cols, r.engine.geo).map(g => g.id), ['-1069,2299', '-1069,2302', '-1066,2302', '-1066,2299'])
})

test('real room-map.txt: 735 open columns, 90 sections, the 13 already-finished legacy sections are all part of it', { skip: !fs.existsSync(MAP) }, () => {
  const r = rig({ fromMap: MAP, pos: [-1061, 136, 2323] })
  const cols = plan.footprint(r.bot, r.engine.geo)
  const groups = plan.groupsOf(cols, r.engine.geo)
  assert.strictEqual(cols.length, 735)
  assert.strictEqual(groups.length, 90)
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'exc-state.json'), 'utf8')).done
  for (const id of legacy) assert.ok(groups.some(g => g.id === id), `legacy section ${id} missing`)
  const { tally, hazards } = plan.prescan(r.bot, cols, r.engine.geo)
  assert.strictEqual(hazards.liquidAdjacent, 0)
  assert.ok(tally.stone > 1000)
})

test('geometry is clamped: nothing at or above the hall (y151), at most 10 blocks tall (y136..145), never the floor', () => {
  const g = plan.makeGeometry({ ...base, digTo: 160, digFrom: 100 })
  assert.strictEqual(g.digTo, 145); assert.strictEqual(g.digFrom, 138)
  assert.deepStrictEqual(g.bands.map(b => [b.id, b.from, b.to]), [['base', 138, 141], ['ceiling', 142, 142], ['high', 143, 145]])
  const six = plan.makeGeometry({ ...base, digTo: 141 })
  assert.deepStrictEqual(six.bands.map(b => b.id), ['base'], 'the old 6-high room is a single band')
  const low = plan.makeGeometry({ ...base, hallMinY: 140, digTo: 141 })
  assert.strictEqual(low.digTo, 139)
  const tall = plan.makeGeometry({ ...base, hallMinY: 400, digTo: 400 })
  assert.ok(tall.digTo <= plan.HARD_MAX_Y && tall.digTo <= 145 && tall.hallMinY <= plan.HARD_MAX_Y + 1)
  const r = rig({ config: { digTo: 145 } })
  for (const y of [135, 136, 137, 146, 147, 150, 151, 152, 160]) assert.strictEqual(plan.checkCell(r.bot, -1067, y, 2301, r.engine.geo).ok, false, `y${y} must never be dug`)
  assert.strictEqual(plan.checkCell(r.bot, -1067, 139, 2301, r.engine.geo).ok, true)
  assert.strictEqual(plan.checkCell(r.bot, -1067, 145, 2301, r.engine.geo).ok, true)
  assert.strictEqual(plan.checkCell(r.bot, -1070, 139, 2301, r.engine.geo).why, 'outside-volume')
})

// ---------------------------------------------------------------- state

test('state: first run imports legacy exc-state.json (inactive), then our own file wins; legacy file is never written', () => {
  const r = rig()
  const legacy = JSON.stringify({ active: true, done: ['-1069,2299', '-1069,2302'], dug: 40, skipped: { 'gravity-column': 2 }, startedAt: '2026-10-25T23:27:43.694Z' })
  fs.writeFileSync(r.legacyFile, legacy)
  const s = stateStore.load({ file: r.file, legacyFile: r.legacyFile })
  assert.deepStrictEqual(s.done, ['-1069,2299', '-1069,2302']); assert.strictEqual(s.dug, 40); assert.strictEqual(s.active, false)
  assert.strictEqual(s.importedFrom, r.legacyFile)
  s.done.push('-1066,2299'); stateStore.save(r.file, s)
  const again = stateStore.load({ file: r.file, legacyFile: r.legacyFile })
  assert.strictEqual(again.done.length, 3, 'own file is authoritative once written')
  assert.strictEqual(fs.readFileSync(r.legacyFile, 'utf8'), legacy)
})

test('state: corrupt own file falls back to the legacy import instead of throwing', () => {
  const r = rig()
  fs.writeFileSync(r.file, '{not json'); fs.writeFileSync(r.legacyFile, JSON.stringify({ done: ['a'], dug: 1 }))
  assert.deepStrictEqual(stateStore.load({ file: r.file, legacyFile: r.legacyFile }).done, ['a'])
  assert.doesNotThrow(() => stateStore.load({ file: path.join(r.dir, 'nope.json'), legacyFile: path.join(r.dir, 'nope2.json') }))
})

test('resume skips the sections already done and does not redo them', async () => {
  const r = rig()
  r.state.done = ['-1069,2299', '-1069,2302']
  carve(r.bot, r.state.done)                       // as in the live room: those sections are already cut
  await run(r)
  assert.strictEqual(r.state.finished, true)
  const dug = r.bot.dugAt()
  assert.strictEqual(dug.length, 72, 'only the two remaining sections')
  assert.ok(dug.every(k => Number(k.split(',')[0]) >= -1066))
  assert.ok(r.said.some(t => /Resuming the excavation: 2\/4/.test(t)) || r.said.some(t => /Excavation plan/.test(t)))
})

// ---------------------------------------------------------------- the dig itself

test('full run: carves y138-141 inside the box, leaves roof, walls and the stone-brick hall alone, writes only its own state file', async () => {
  const r = rig()
  fs.writeFileSync(r.legacyFile, JSON.stringify({ done: [], dug: 0 }))
  const legacyBefore = fs.readFileSync(r.legacyFile, 'utf8')
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  for (const k of cells()) assert.ok(airAt(r, k), `${k} should be carved`)
  for (const y of [142, 146, 150]) assert.strictEqual(r.bot.blockAt(new Vec3(-1067, y, 2301)).name, 'stone', `roof y${y}`)
  for (const y of [151, 152, 153]) assert.strictEqual(r.bot.blockAt(new Vec3(-1067, y, 2301)).name, 'stone_bricks', `hall y${y}`)
  assert.strictEqual(r.bot.blockAt(new Vec3(-1070, 139, 2301)).name, 'stone', 'side wall')
  assert.strictEqual(r.bot.blockAt(new Vec3(-1067, 135, 2301)).name, 'stone', 'floor')
  assert.ok(r.bot.dugAt().every(k => { const y = +k.split(',')[1]; return y >= 138 && y <= 141 }))
  assert.strictEqual(r.state.finished, true); assert.strictEqual(r.state.active, false); assert.strictEqual(r.state.done.length, 4)
  assert.ok(r.said.some(t => /Excavation finished: 144 blocks/.test(t)))
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).done.length, 4)
  assert.strictEqual(fs.readFileSync(r.legacyFile, 'utf8'), legacyBefore)
})

test('tampered config cannot reach the hall: digTo 160 still stops at y145, the ceiling y146-149 and the hall stay', async () => {
  const r = rig({ config: { digTo: 160, digFrom: 100, hallMinY: 151 } })
  await run(r)
  assert.ok(r.bot.dugAt().every(k => { const y = +k.split(',')[1]; return y >= 136 && y <= 145 }), 'nothing dug above y145 (pillar blocks are cobblestone at y136-139)')
  for (let y = 146; y <= 153; y++) assert.notStrictEqual(r.bot.blockAt(new Vec3(-1066, y, 2301)).name, 'air', `y${y}`)
  assert.deepStrictEqual(r.bot.losViolations, [])
})

test('only natural stone is dug: bricks, planks, chests, torches and ores of Walter are left and reported', async () => {
  const r = rig()
  r.bot.setBlock(-1067, 139, 2301, 'stone_bricks'); r.bot.setBlock(-1066, 139, 2301, 'oak_planks'); r.bot.setBlock(-1065, 140, 2301, 'chest')
  r.bot.setBlock(-1067, 140, 2302, 'coal_ore'); r.bot.setBlock(-1069, 141, 2299, 'dripstone_block')
  await run(r)
  for (const k of ['-1067,139,2301', '-1066,139,2301', '-1065,140,2301']) assert.ok(!airAt(r, k), `${k} must stay`)
  for (const k of ['-1067,140,2302', '-1069,141,2299']) assert.ok(airAt(r, k), `${k} natural, dug`)
  assert.strictEqual(r.state.skipped['protected:stone_bricks'], 1); assert.strictEqual(r.state.skipped['protected:chest'], 1)
})

test('never digs into lava or water: the liquid and every block touching it stay', async () => {
  const r = rig()
  r.bot.setBlock(-1067, 140, 2301, 'lava'); r.bot.setBlock(-1064, 139, 2304, 'water')
  r.bot.setBlock(-1069, 138, 2304, 'stone', { waterlogged: true })
  await run(r)
  const keep = ['-1067,140,2301', '-1068,140,2301', '-1066,140,2301', '-1067,140,2300', '-1067,140,2302', '-1067,139,2301', '-1067,141,2301',
    '-1064,139,2304', '-1065,139,2304', '-1064,139,2303', '-1064,138,2304', '-1064,140,2304', '-1069,138,2304']
  for (const k of keep) assert.ok(!airAt(r, k), `${k} must not have been dug`)
  assert.strictEqual(r.bot.blockAt(new Vec3(-1067, 140, 2301)).name, 'lava')
  assert.strictEqual(r.bot.blockAt(new Vec3(-1064, 139, 2304)).name, 'water')
  assert.ok(!r.bot.dugAt().some(k => keep.includes(k)))
  assert.ok(r.state.skipped['lava'] >= 1 && r.state.skipped['lava-adjacent'] >= 4 && r.state.skipped['liquid-adjacent'] >= 4 && r.state.skipped['liquid'] >= 1)
  assert.ok(airAt(r, '-1068,139,2302'), 'unrelated blocks next door are still dug')
})

test('lava that appears while digging (checked right before every dig) is respected too', async () => {
  const r = rig()
  r.bot.onDig = (n) => { if (n === 3) r.bot.setBlock(-1065, 139, 2304, 'lava') }
  await run(r)
  const touching = ['-1065,139,2303', '-1066,139,2304', '-1064,139,2304', '-1065,138,2304', '-1065,140,2304']
  for (const k of touching) assert.ok(!airAt(r, k), `${k} touches the new lava`)
  assert.strictEqual(r.bot.blockAt(new Vec3(-1065, 139, 2304)).name, 'lava')
})

test('an unloaded neighbour is treated as unsafe, not as air', () => {
  const r = rig()
  r.bot.unloaded.add('-1068,139,2301')
  assert.strictEqual(plan.checkCell(r.bot, -1067, 139, 2301, r.engine.geo).why, 'unloaded-neighbour')
})

test('sand/gravel columns are skipped whole', async () => {
  const r = rig()
  r.bot.setBlock(-1067, 142, 2301, 'gravel')       // just above the dig range
  r.bot.setBlock(-1068, 139, 2301, 'sand')
  await run(r)
  for (const y of [138, 139, 140, 141]) { assert.ok(!airAt(r, `-1067,${y},2301`)); assert.ok(!airAt(r, `-1068,${y},2301`)) }
  assert.strictEqual(r.state.skipped['gravity-column'], 2)
})

test('a block just out of reach is dug after stepping into its column', async () => {
  const r = rig()
  r.bot.reach = 4.0
  await run(r)
  for (const k of cells()) assert.ok(airAt(r, k), k)
  assert.ok(r.bot.actions.some(a => a[0] === 'goto' && /^column /.test(a[1])))
  assert.ok(!r.state.skipped['out-of-reach'])
})

test('a section that cannot be reached is retried, never marked done, and reported', async () => {
  const r = rig()
  r.bot.gotoFails = (goal, label) => label === 'section -1066,2299'
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.deepStrictEqual(r.state.unreachable, ['-1066,2299'])
  assert.strictEqual(r.state.done.length, 3); assert.strictEqual(r.state.finished, false)
  assert.ok(r.bot.actions.filter(a => a[0] === 'goto-failed').length >= 2, 'tried it twice')
  assert.ok(r.said.some(t => /not finished/.test(t) && /1 section\(s\) I could not walk to/.test(t)), r.said.join(' | '))
  r.bot.gotoFails = null
  await run(r)
  assert.strictEqual(r.state.finished, true); assert.strictEqual(r.state.done.length, 4)
})

// ---------------------------------------------------------------- items on the ground

test('more than 30 items within 24 blocks: stops before digging, tells Walter, stays paused', async () => {
  const r = rig()
  r.bot.noPickup = true
  for (let i = 0; i < 31; i++) r.bot.addItemEntity(-1067 + (i % 5), 137, 2300 + (i % 4), 'cobblestone', 1)
  const res = await run(r)
  assert.strictEqual(res.status, 'park')
  assert.strictEqual(r.bot.dugAt().length, 0)
  assert.ok(r.said.some(t => /31 items are lying on the ground/.test(t) && /resume excavation/.test(t)))
  assert.strictEqual(r.state.active, false)
  assert.ok(/items are lying/.test(r.state.pauseReason))
})

test('exactly 30 items near is still fine to start digging', async () => {
  const r = rig()
  r.bot.noPickup = true
  for (let i = 0; i < 30; i++) r.bot.addItemEntity(-1067, 137, 2300, 'bone', 1)
  await run(r)
  assert.ok(r.bot.dugAt().length > 0, 'started digging at exactly 30')
})

test('items farther than 24 blocks away do not count', async () => {
  const r = rig()
  for (let i = 0; i < 40; i++) r.bot.addItemEntity(-1067 + 30, 137, 2300, 'bone', 1)
  const res = await run(r)
  assert.strictEqual(res.status, 'done'); assert.strictEqual(r.state.finished, true)
})

test('a pile on the floor is picked up first when there is room, then digging goes on', async () => {
  const r = rig()
  for (let i = 0; i < 40; i++) r.bot.addItemEntity(-1067 + (i % 4) * 2, 137.5, 2300.5, 'bone', 1)
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.bot.count('bone'), 40)
})

test('a pile that builds up while digging pauses the job (progress kept)', async () => {
  const r = rig()
  r.bot.onDig = (n) => { if (n === 20) { r.bot.noPickup = true; for (let i = 0; i < 35; i++) r.bot.addItemEntity(-1066, 137, 2301, 'bone', 1) } }
  const res = await run(r)
  assert.strictEqual(res.status, 'park')
  assert.ok(r.bot.dugAt().length < 144 && r.bot.dugAt().length >= 20)
  assert.ok(r.said.some(t => /(3[5-9]|4\d) items are lying/.test(t)))
  r.bot.onDig = null; r.bot.noPickup = false
  await run(r)                                   // "resume excavation": the pile is collected, the rest is dug
  assert.strictEqual(r.state.finished, true)
  for (const k of cells()) assert.ok(airAt(r, k))
})

// ---------------------------------------------------------------- inventory and cobblestone

const fillInventory = (bot, leaveEmpty) => { let i = 0; while (bot.inventory.emptySlotCount() > leaveEmpty) bot.give('bone', 64 * 1 + 0) && i++ }
const INPUTS = [[-1043, 132, 2273], [-1051, 155, 2324], [-1051, 155, 2325]]
const addInputChests = (bot, items = {}) => { for (const p of INPUTS) bot.addChest(p[0], p[1], p[2], 54, items) }

test('inventory nearly full: spare cobblestone goes to the input chests (nearest first), the reserve stays, only those chests are opened', async () => {
  const r = rig({ inputs: INPUTS })
  addInputChests(r.bot)
  r.bot.give('cobblestone', 64 * 4)
  fillInventory(r.bot, 5)
  assert.ok(r.bot.inventory.emptySlotCount() <= 6)
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  const opened = new Set(r.bot.actions.filter(a => a[0] === 'open').map(a => a[1]))
  for (const o of opened) assert.ok(INPUTS.some(p => p.join(',') === o), `${o} is not an input chest`)
  const inChests = INPUTS.reduce((s, p) => s + (r.bot.chestItems(...p).cobblestone || 0), 0)
  assert.ok(inChests >= 64 * 4 - 48, `only ${inChests} cobblestone dumped`)
  assert.ok(r.bot.count('cobblestone') >= 48, 'the crafting reserve stays')
  assert.ok(r.said.some(t => /Put \d+ cobblestone into the station input chests/.test(t)))
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
  assert.ok(!r.bot.actions.some(a => /toss|drop/.test(a[0])), 'never throws things on the ground')
})

test('input chest full or unreachable: falls through to the next one', async () => {
  const r = rig({ inputs: INPUTS })
  addInputChests(r.bot)
  r.bot.addChest(-1051, 155, 2324, 27, { stone: 27 * 64 })                          // full
  r.bot.gotoFails = (goal) => goal.x === -1051 && goal.y === 155 && goal.z === 2325   // no path
  r.bot.give('cobblestone', 64 * 4); fillInventory(r.bot, 4)
  await run(r)
  assert.ok((r.bot.chestItems(-1043, 132, 2273).cobblestone || 0) > 0, 'went on to the third chest')
  assert.strictEqual(r.bot.chestItems(-1051, 155, 2324).cobblestone, undefined)
  assert.ok(r.engine.dumper.failedUntil.size >= 2)
})

test('nothing can take the cobblestone: pauses and tells Walter, nothing is thrown away', async () => {
  const r = rig({ inputs: INPUTS })
  for (const p of INPUTS) r.bot.addChest(p[0], p[1], p[2], 27, { stone: 27 * 64 })
  r.bot.give('cobblestone', 64 * 4); fillInventory(r.bot, 2)
  const res = await run(r)
  assert.strictEqual(res.status, 'park')
  assert.strictEqual(r.bot.dugAt().length, 0)
  assert.ok(r.said.some(t => /inventory is nearly full/.test(t) && /resume excavation/.test(t)))
  assert.ok(!r.bot.actions.some(a => /toss|drop/.test(a[0])))
  const opens = r.bot.actions.filter(a => a[0] === 'open').length
  await run(r)                                       // "resume excavation" a moment later: does not hammer the full chests again
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'open').length, opens)
})

test('full of something that is not cobblestone: no dumping, no tossing, pause', async () => {
  const r = rig({ inputs: INPUTS }); addInputChests(r.bot)
  fillInventory(r.bot, 1)
  const res = await run(r)
  assert.strictEqual(res.status, 'park')
  assert.ok(!r.bot.actions.some(a => a[0] === 'open'))
})

// ---------------------------------------------------------------- line of sight (survival-legit rule)

test('every block is dug with a clear line from the eye (the mock refuses and records any wall-hack), layer by layer from below', async () => {
  const r = rig()
  await run(r)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(!r.state.skipped['no-line-of-sight'] && !r.state.skipped['dig-error'], JSON.stringify(r.state.skipped))
  for (const k of cells()) assert.ok(airAt(r, k), k)
  const first9 = r.bot.dugAt().slice(0, 9).map(k => +k.split(',')[1])
  assert.ok(first9.every(y => y === 138), 'the first section is opened from the bottom layer up')
})

test('real room map: the whole carve never digs anything it cannot see', { skip: !fs.existsSync(MAP) }, async () => {
  const r = rig({ fromMap: MAP, pos: [-1061, 136, 2323], config: { limits: { maxGroundItems: 1000 } } })
  await run(r)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(r.bot.dugAt().length > 1500)
})

test('a block with no clear line is not dug, the rest is (even when the helper is told so from outside)', async () => {
  const r = rig({ config: {} })
  r.bot.enforceLos = false            // the outside helper is the thing under test here; the mock must not second-guess it
  const blocked = '-1067,139,2301'
  const eng = require('../brain/excavation/engine')({ bot: r.bot, say: (t) => r.said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, safehand: r.sh, config: r.cfg, state: r.state, save: r.save,
    canSee: (b) => `${b.position.x},${b.position.y},${b.position.z}` !== blocked })
  await eng.run(fakeCtx())
  assert.ok(!airAt(r, blocked), 'not dug')
  assert.strictEqual(r.state.skipped['no-line-of-sight'], 1)
  assert.strictEqual(r.bot.dugAt().length, 143)
})

test('los helper: a one-block wall, a diagonal corner and a sealed block are not visible; an exposed block is', () => {
  const r = rig({ pos: [-1067, 136, 2301] })
  const makeLos = require('../brain/excavation/los')
  const los = makeLos({ bot: r.bot, goals: r.bot.goals, mover: null })
  assert.strictEqual(los.canSee(r.bot.blockAt(new Vec3(-1067, 138, 2301))), true, 'roof directly above: its underside is exposed')
  assert.strictEqual(los.canSee(r.bot.blockAt(new Vec3(-1067, 139, 2301))), false, 'sealed behind the roof block')
  assert.strictEqual(los.canSee(r.bot.blockAt(new Vec3(-1070, 136, 2301))), true, 'wall block next to the room: its face is exposed')
  assert.strictEqual(los.canSee(r.bot.blockAt(new Vec3(-1071, 136, 2301))), false, 'one block deeper: behind a one-block wall')
  r.bot.entity.position = new Vec3(-1067.5, 136, 2301.5)
  r.bot.setBlock(-1067, 137, 2301, 'stone'); r.bot.setBlock(-1068, 137, 2302, 'stone'); r.bot.setBlock(-1067, 137, 2302, 'chest')
  assert.strictEqual(los.canSee(r.bot.blockAt(new Vec3(-1067, 137, 2302))), false, 'a chest diagonally behind two touching corners')
})

const wallOffChests = (r) => { for (const y of [155, 156, 157]) for (const z of [2323, 2324, 2325, 2326]) r.bot.setBlock(-1052, y, z, 'stone') }

test('a chest behind a wall is not opened from the other side; the next chest is used', async () => {
  const r = rig({ inputs: INPUTS }); addInputChests(r.bot); wallOffChests(r)
  r.bot.arriveAt = (goal) => (goal.y === 155 && goal.x === -1051 ? new Vec3(-1053.5, 155, goal.z + 0.5) : null)   // the walk ends on the wrong side of the wall
  r.bot.give('cobblestone', 64 * 4); fillInventory(r.bot, 4)
  await run(r)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(!r.bot.actions.some(a => a[0] === 'open' && /^-1051,155/.test(a[1])), 'never opened through the wall')
  assert.ok((r.bot.chestItems(-1043, 132, 2273).cobblestone || 0) > 0, 'used the chest that could be seen')
  assert.ok(r.engine.dumper.failedUntil.size >= 2)
})

test('with the pathfinder look-at goal the bot walks round the wall and then opens the chest', async () => {
  const r = rig({ inputs: INPUTS }); addInputChests(r.bot); wallOffChests(r); r.bot.enableLookAt()
  r.bot.arriveAt = (goal) => (goal.y === 155 && goal.x === -1051 ? new Vec3(-1053.5, 155, goal.z + 0.5) : null)
  r.bot.give('cobblestone', 64 * 4); fillInventory(r.bot, 4)
  await run(r)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(r.bot.actions.some(a => a[0] === 'goto' && a[5] === 'lookat'))
  assert.ok((r.bot.chestItems(-1051, 155, 2324).cobblestone || 0) > 0, 'opened from a spot with a clear line')
})

// ---------------------------------------------------------------- "finished" must be true (the 12-section bug)

const unloadColumns = (r, from, to) => { for (let x = SMALL.x1; x <= SMALL.x2; x++) for (let z = from; z <= to; z++) for (const y of [135, 136, 137]) r.bot.unloaded.add(`${x},${y},${z}`) }

test('a partial view of the room (chunks still loading after a restart) is never taken for the whole room', async () => {
  const r = rig({ config: { limits: { loadWaitMs: 20, loadRetries: 2, loadRetryMs: 10 } } })
  unloadColumns(r, 2302, 2304)                    // only the first section row can be seen
  const ctx = fakeCtx()
  let res = await run(r, ctx)
  assert.strictEqual(res.status, 'retry'); assert.strictEqual(r.bot.dugAt().length, 0, 'nothing is carved from a partial picture')
  assert.strictEqual(r.state.finished, false)
  res = await run(r, ctx); assert.strictEqual(res.status, 'retry')
  res = await run(r, ctx)
  assert.strictEqual(res.status, 'park'); assert.ok(/Only part of the room is loaded/.test(res.reason), res.reason)
  assert.strictEqual(r.state.finished, false)
  r.bot.unloaded.clear()                          // the chunks arrived
  res = await run(r, fakeCtx()); assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.state.finished, true); assert.strictEqual(r.state.total, 4, 'total comes from a complete scan')
})

test('chunks that arrive while it waits: the job carries on with the whole room', async () => {
  const r = rig({ config: { limits: { loadWaitMs: 3000 } } })
  unloadColumns(r, 2302, 2304)
  setTimeout(() => r.bot.unloaded.clear(), 40)
  const res = await run(r)
  assert.strictEqual(res.status, 'done'); assert.strictEqual(r.state.done.length, 4); assert.strictEqual(r.state.finished, true)
  for (const k of cells()) assert.ok(airAt(r, k))
})

test('"queue empty" is not "finished": a block missed on the way (dig error, section already marked done) is swept up before finishing', async () => {
  const r = rig()
  let failed = 0
  r.bot.failDig = (b) => { if (`${b.position.x},${b.position.y},${b.position.z}` === '-1067,138,2301' && failed++ < 1) return true; return false }
  await run(r)
  assert.ok(r.bot.actions.some(a => a[0] === 'dig-failed'), 'the first try failed')
  assert.ok(airAt(r, '-1067,138,2301'), 'the sweep dug it')
  assert.strictEqual(r.state.finished, true)
  for (const k of cells()) assert.ok(airAt(r, k))
})

test('a block that cannot be dug keeps the room "not finished" and says which one', async () => {
  const r = rig()
  r.bot.failDig = (b) => `${b.position.x},${b.position.y},${b.position.z}` === '-1067,138,2301'      // always fails
  await run(r)
  assert.strictEqual(r.state.finished, false)
  assert.strictEqual(r.state.leftCells, 1)
  assert.ok(r.said.some(t => /not finished: 1 block\(s\) are still uncut.*-1067,138,2301/.test(t)), r.said.join(' | '))
  assert.ok(!r.said.some(t => /Excavation finished/.test(t)))
})

test('the saved flag lies (finished:true, most sections undone): status checks the world and corrects it, resume finishes the job', async () => {
  const r = rig()
  r.state.finished = true; r.state.done = ['-1069,2299']; r.state.total = 12; r.state.dug = 1191
  const e = r.engine
  const line = e.statusLine()
  assert.ok(/still uncut/.test(line) && !/The room is carved/.test(line), line)
  assert.strictEqual(r.state.finished, false, 'flag corrected')
  assert.strictEqual(e.snapshot().finished, false)
  await run(r)
  assert.strictEqual(r.state.finished, true)
  assert.ok(/The room is carved/.test(e.statusLine()))
  for (const k of cells()) assert.ok(airAt(r, k))
})

test('status trusts the world over a missing flag: a fully carved room reads as carved', async () => {
  const r = rig()
  await run(r)
  r.state.finished = false
  assert.ok(/The room is carved/.test(r.engine.statusLine())); assert.strictEqual(r.state.finished, true)
})

test('status from a partial view says so instead of guessing', () => {
  const r = rig()
  unloadColumns(r, 2302, 2304)
  const line = r.engine.statusLine()
  assert.ok(/cannot see the whole room/.test(line), line)
})

// ---------------------------------------------------------------- 10 blocks tall: layer bands and the temporary pillar

const TALL = { digTo: 145 }
const stoneDigs = (r) => r.bot.actions.filter(a => a[0] === 'dig' && a[1] !== 'cobblestone').map(a => ({ k: `${a[2]},${a[3]},${a[4]}`, y: a[3] }))
const roomCells = (y0, y1) => cells(SMALL, y0, y1)

test('10 blocks tall: y138-145 are carved, y146-149 stay as ceiling, the hall is untouched, every dig and placement had a clear line', async () => {
  const r = rig({ config: TALL })
  await run(r)
  assert.strictEqual(r.state.finished, true)
  for (const k of roomCells(138, 145)) assert.ok(airAt(r, k), k)
  for (const y of [146, 147, 148, 149, 150]) assert.strictEqual(r.bot.blockAt(new Vec3(-1067, y, 2301)).name, 'stone', `ceiling y${y}`)
  for (const y of [151, 152, 153]) assert.strictEqual(r.bot.blockAt(new Vec3(-1067, y, 2301)).name, 'stone_bricks', `hall y${y}`)
  assert.strictEqual(r.bot.blockAt(new Vec3(-1067, 135, 2301)).name, 'stone', 'floor')
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(stoneDigs(r).every(d => d.y >= 138 && d.y <= 145))
  assert.deepStrictEqual(r.state.doneCeiling.slice().sort(), r.state.done.slice().sort()); assert.strictEqual(r.state.doneHigh.length, 4)
  assert.ok(r.said.some(t => /Excavation finished/.test(t)))
})

test('the pillar: 4 cobblestone blocks per section at most, built in an open column under the bot, gone again afterwards, bot back on the floor', async () => {
  const r = rig({ config: TALL })
  r.bot.give('stone_sword', 1)
  await run(r)
  const placed = r.bot.actions.filter(a => a[0] === 'place')
  assert.strictEqual(placed.length, 16, '4 blocks x 4 sections')
  assert.ok(placed.every(a => a[1] === 'cobblestone' && a[3] >= 136 && a[3] <= 139), 'only cobblestone, only y136..139')
  assert.ok(r.bot.maxFeetY <= 140.4, `feet never above y140 (${r.bot.maxFeetY})`)
  for (const [x, z] of [...new Set(placed.map(a => `${a[2]},${a[4]}`))].map(k => k.split(',').map(Number))) for (let y = 136; y <= 139; y++) assert.ok(airAt(r, `${x},${y},${z}`), `pillar cell ${x},${y},${z} removed`)
  assert.strictEqual(r.state.pillar, null)
  assert.ok(r.bot.entity.position.y <= 136.01, 'back on the floor')
  assert.strictEqual(r.bot.blockAt(new Vec3(-1067, 135, 2301)).name, 'stone', 'floor not damaged')
  assert.ok(r.bot.count('cobblestone') >= 48, 'the cobblestone came back')
})

test('resume never redoes the finished y138-141 sections: only the new layers are dug, base progress is kept', async () => {
  const r = rig({ config: TALL })
  const ids = ['-1069,2299', '-1069,2302', '-1066,2302', '-1066,2299']
  carve(r.bot, ids, 138, 141); r.state.done = ids.slice()
  await run(r)
  assert.ok(stoneDigs(r).every(d => d.y >= 142 && d.y <= 145), 'nothing below y142 was touched again')
  assert.strictEqual(stoneDigs(r).length, 6 * 6 * 4)
  assert.strictEqual(r.state.done.length, 4); assert.strictEqual(r.state.doneCeiling.length, 4); assert.strictEqual(r.state.doneHigh.length, 4)
  assert.strictEqual(r.state.finished, true)
  const before = r.bot.actions.length
  await run(r)                                      // once more: nothing left, nothing happens
  assert.strictEqual(r.bot.actions.length, before)
})

test('a section with its own band state: ceiling done, high not yet -> only the high band is built (pillar), nothing else', async () => {
  const r = rig({ config: TALL })
  const ids = ['-1069,2299', '-1069,2302', '-1066,2302', '-1066,2299']
  carve(r.bot, ids, 138, 142); r.state.done = ids.slice(); r.state.doneCeiling = ids.slice()
  r.bot.give('cobblestone', 48)                     // as the live bot has (the 48 reserve)
  await run(r)
  assert.ok(stoneDigs(r).every(d => d.y >= 143)); assert.strictEqual(r.bot.actions.filter(a => a[0] === 'place').length, 16)
})

test('stopped or preempted while standing on the pillar: it comes down first, then the other task runs; resuming finishes without redoing anything', async () => {
  const r = rig({ config: TALL })
  let atStart = null, fired = false
  r.bot.onDig = (n, b) => {
    if (!fired && b.position.y >= 143) { fired = true; r.scheduler.submit({ name: 'safety', priority: PRIORITY.SAFETY, async run(ctx) { atStart = { y: r.bot.entity.position.y, pillar: r.state.pillar }; await ctx.sleep(20) } }) }
  }
  r.submit()
  await waitFor(() => r.state.finished, 20000)
  assert.ok(atStart && atStart.y <= 136.01, `on the floor when the safety task started (${atStart && atStart.y})`)
  assert.strictEqual(atStart.pillar, null)
  const dug = stoneDigs(r).map(d => d.k); assert.strictEqual(new Set(dug).size, dug.length, 'no block dug twice')
  for (const k of roomCells(138, 145)) assert.ok(airAt(r, k))
  assert.strictEqual(r.state.pillar, null)
})

test('a hostile shows up while up on the pillar: pillar down, job retries later and finishes', async () => {
  const r = rig({ config: TALL })
  let fired = false
  r.bot.onDig = (n, b) => { if (!fired && b.position.y >= 143) { fired = true; r.bot.entities.z = { id: 99, name: 'zombie', position: r.bot.entity.position.offset(3, 0, 0) } } }
  const ctx = fakeCtx()
  const res = await run(r, ctx)
  assert.strictEqual(res.status, 'retry')
  assert.ok(r.bot.entity.position.y <= 136.01, 'down before waiting'); assert.strictEqual(r.state.pillar, null)
  delete r.bot.entities.z; r.bot.onDig = null
  assert.strictEqual((await run(r, ctx)).status, 'done'); assert.strictEqual(r.state.finished, true)
})

test('a pillar left behind by a crash or restart is taken down (only the recorded cobblestone) before anything else', async () => {
  const r = rig({ config: TALL })
  carve(r.bot, ['-1069,2299', '-1069,2302', '-1066,2302', '-1066,2299'], 138, 142)          // the sections around it are already cut (as live)
  for (let y = 136; y <= 139; y++) r.bot.setBlock(-1068, y, 2301, 'cobblestone')
  r.bot.setBlock(-1068, 147, 2300, 'cobblestone')          // a cobblestone block above the room that is NOT ours: not recorded, outside the dig range
  r.state.pillar = { x: -1068, z: 2301, cells: [-1068, 136, 2301].length ? [136, 137, 138, 139].map(y => `-1068,${y},2301`) : [] }
  r.bot.arriveAt = (goal, label) => (label === 'the pillar' ? new Vec3(-1069 + 0.5, 136, 2301.5) : null)
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.state.pillar, null)
  assert.deepStrictEqual(r.bot.dugAt().slice(0, 4).sort(), ['-1068,136,2301', '-1068,137,2301', '-1068,138,2301', '-1068,139,2301'], 'the four recorded blocks went first')
  assert.strictEqual(r.bot.blockAt(new Vec3(-1068, 147, 2300)).name, 'cobblestone', 'a cobblestone block that is not on the list stays')
})

test('not enough cobblestone for a pillar: the high band is skipped and reported, nothing is placed, the room is not called finished', async () => {
  const r = rig({ config: { ...TALL, pillar: { minCobble: 9999 } } })
  await run(r)
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'place').length, 0)
  assert.strictEqual(r.state.finished, false)
  assert.ok(r.state.skipped['no-cobble-for-pillar'] >= 4)
  assert.ok(r.said.some(t => /not finished: \d+ block\(s\) are still uncut/.test(t)))
  for (const k of roomCells(138, 142)) assert.ok(airAt(r, k), 'the floor-reachable layers were still done')
})

test('no pillar column to stand in (the middle is not open): the section is skipped, not forced', async () => {
  const r = rig({ config: TALL })
  carve(r.bot, ['-1069,2299'], 138, 142)
  r.bot.setBlock(-1068, 139, 2300, 'dripstone_block')            // not natural-filler: protected, stays; every other column of that section stays open
  for (const x of [-1069, -1068, -1067]) for (const z of [2299, 2300, 2301]) r.bot.setBlock(x, 140, z, 'stone_bricks')   // a protected lid over the whole section at y140
  await run(r)
  assert.ok(r.state.skipped['pillar-blocked'] >= 1)
  assert.strictEqual(r.state.finished, false)
})

test('hostile or low health before the pillar starts: no pillar, nothing placed', async () => {
  const r = rig({ config: TALL }); r.bot.health = 5
  assert.strictEqual((await run(r)).status, 'retry')
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'place').length, 0)
})

// ---------------------------------------------------------------- the shared smeltables helper (api.depositSmeltables)

const engineWith = (r, extra) => require('../brain/excavation/engine')({ bot: r.bot, say: (t) => r.said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, safehand: r.sh, stopNav: () => {}, config: r.cfg, state: r.state, save: r.save, ...extra })

test('inventory nearly full: the shared depositSmeltables helper does the unloading (not our own chest code), then digging goes on', async () => {
  const r = rig({ inputs: INPUTS }); addInputChests(r.bot)
  r.bot.give('cobblestone', 64 * 4); r.bot.give('iron_ore', 20); fillInventory(r.bot, 5)
  const calls = []
  const eng = engineWith(r, { inputs: INPUTS, depositSmeltables: async (o) => {
    calls.push(o)
    const moved = { cobblestone: r.bot.take('cobblestone', r.bot.count('cobblestone') - 48), iron_ore: r.bot.take('iron_ore', 20) }
    return { moved, left: [], full: false, cantReach: [], skipped: false }
  } })
  const res = await eng.run(fakeCtx())
  assert.strictEqual(res.status, 'done'); assert.strictEqual(r.state.finished, true)
  assert.ok(calls.length >= 1 && calls[0].ctx, 'called with the task context')
  assert.ok(!r.bot.actions.some(a => a[0] === 'open'), 'our own chest code was not used')
  assert.ok(r.bot.count('cobblestone') >= 48 && r.bot.count('iron_ore') === 0)
})

test('shared helper not called while there is plenty of room; helper "full" pauses the job and nothing is thrown away', async () => {
  const r = rig({ inputs: INPUTS }); let n = 0
  const eng = engineWith(r, { inputs: INPUTS, depositSmeltables: async () => { n++; return { moved: {}, left: [], full: false } } })
  await eng.run(fakeCtx())
  assert.strictEqual(n, 0, 'plenty of free slots: no trip')
  const f = rig({ inputs: INPUTS }); f.bot.give('cobblestone', 64 * 4); fillInventory(f.bot, 2)
  const full = engineWith(f, { inputs: INPUTS, depositSmeltables: async () => ({ moved: {}, left: [{ name: 'cobblestone', count: 200 }], full: true }) })
  const res = await full.run(fakeCtx())
  assert.strictEqual(res.status, 'park'); assert.strictEqual(f.bot.dugAt().length, 0)
  assert.ok(f.said.some(t => /input chests are full or out of reach/.test(t) && /resume excavation/.test(t)))
  assert.ok(!f.bot.actions.some(a => /toss|drop/.test(a[0])))
})

test('shared helper that cannot free enough room (inventory full of non-smeltables): pause, no tossing', async () => {
  const r = rig({ inputs: INPUTS }); fillInventory(r.bot, 1)
  const eng = engineWith(r, { inputs: INPUTS, depositSmeltables: async () => ({ moved: {}, left: [], full: false }) })
  assert.strictEqual((await eng.run(fakeCtx())).status, 'park')
  assert.ok(!r.bot.actions.some(a => /toss|drop/.test(a[0])))
})

test('module: api.depositSmeltables and api.canSee from the integrator are picked up', async () => {
  const calls = []
  const { api, r } = fakeApi(null, { depositSmeltables: async (o) => { calls.push(o); return { moved: {}, left: [], full: false } } })
  r.bot.give('cobblestone', 64 * 4); fillInventory(r.bot, 3)
  const h = require('../brain/excavation')(api)
  assert.ok(h.engine.dumper.canUnload())
  h.go(); await waitFor(() => calls.length > 0)
  h.stop()
})

// ---------------------------------------------------------------- work-site chest (time-economy rule)

const WSCFG = { worksite: { cell: [-1069, 136, 2301] } }
const craftChestStub = (r, counter) => ({ dispatch: (text) => { if (/chest/.test(text)) { r.bot.give('chest', 1); counter.n++; return true } return false }, busy: () => false })
const bagToStations = (r, calls) => async (o) => {                     // what api.depositSmeltables does, in miniature: cobblestone above the 48 reserve goes
  calls.push(o)
  const n = Math.max(0, r.bot.count('cobblestone') - 48); if (n) r.bot.take('cobblestone', n)
  return { moved: { cobblestone: n }, left: [], full: false, cantReach: [], skipped: false }
}
const WS_CELL = '-1069,136,2301'

test('work site: the bag fills -> a chest is made and put against the wall, the stash goes in there, ONE haul to the furnaces at the end, chest picked up', async () => {
  const r = rig({ inputs: INPUTS, config: WSCFG }); addInputChests(r.bot)
  r.bot.give('cobblestone', 64 * 3); fillInventory(r.bot, 6)
  const crafted = { n: 0 }, calls = []
  const eng = engineWith(r, { inputs: INPUTS, craft: craftChestStub(r, crafted), depositSmeltables: bagToStations(r, calls) })
  const res = await eng.run(fakeCtx())
  assert.strictEqual(res.status, 'done'); assert.strictEqual(r.state.finished, true)
  assert.strictEqual(crafted.n, 1, 'one chest was crafted (through the crafting module)')
  const placedChest = r.bot.actions.filter(a => a[0] === 'place' && a[1] === 'chest')
  assert.strictEqual(placedChest.length, 1); assert.strictEqual(`${placedChest[0][2]},${placedChest[0][3]},${placedChest[0][4]}`, WS_CELL)
  assert.ok(r.bot.actions.some(a => a[0] === 'deposit' && a[1] === 'cobblestone' && a[3] === WS_CELL), 'the stash went into the work-site chest')
  assert.ok(!r.bot.actions.some(a => a[0] === 'open' && INPUTS.some(p => p.join(',') === a[1])), 'the furnace chests were not visited while working')
  assert.ok(calls.length >= 1 && calls.every(c => c.force === true), 'the single haul at the end went to the furnaces (forced)')
  assert.ok(r.bot.actions.some(a => a[0] === 'withdraw' && a[3] === WS_CELL))
  assert.strictEqual(r.state.worksite, null, 'ledger cleared'); assert.ok(airAt(r, WS_CELL), 'chest picked up'); assert.ok(r.bot.count('chest') >= 1, 'chest item back in the bag')
  for (const k of cells()) assert.ok(airAt(r, k), `${k} (also the column the chest stood in)`)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(r.said.some(t => /Set up a work-site chest at -1069, 136, 2301/.test(t)))
})

test('work site: no chest in the bag and nothing can craft one -> the old way (straight to the furnaces), no placement, nothing changes', async () => {
  const r = rig({ inputs: INPUTS, config: WSCFG }); addInputChests(r.bot)
  r.bot.give('cobblestone', 64 * 3); fillInventory(r.bot, 6)
  const calls = []
  const eng = engineWith(r, { inputs: INPUTS, depositSmeltables: bagToStations(r, calls) })
  assert.strictEqual((await eng.run(fakeCtx())).status, 'done')
  assert.ok(calls.length >= 1); assert.ok(!r.bot.actions.some(a => a[0] === 'place')); assert.ok(!r.state.worksite)
})

test('work site: nothing worth stashing -> no chest is made just for that', async () => {
  const r = rig({ inputs: INPUTS, config: WSCFG }); const crafted = { n: 0 }
  const eng = engineWith(r, { inputs: INPUTS, craft: craftChestStub(r, crafted), depositSmeltables: async () => ({ moved: {}, left: [], full: false }) })
  await eng.run(fakeCtx())
  assert.strictEqual(crafted.n, 0); assert.ok(!r.bot.actions.some(a => a[0] === 'place'))
})

test('work site: what the furnaces cannot take (dirt) stays in the chest, the chest stays, Walter is told; a later job reuses it', async () => {
  const r = rig({ inputs: INPUTS, config: WSCFG })
  r.bot.give('dirt', 64 * 2); r.bot.give('cobblestone', 64 * 2); fillInventory(r.bot, 6)
  const crafted = { n: 0 }, calls = []
  const eng = engineWith(r, { inputs: INPUTS, craft: craftChestStub(r, crafted), depositSmeltables: bagToStations(r, calls) })
  await eng.run(fakeCtx())
  assert.strictEqual(r.bot.blockAt(new Vec3(-1069, 136, 2301)).name, 'chest', 'chest stays')
  assert.ok(r.state.worksite && r.state.worksite.items.dirt >= 64, JSON.stringify(r.state.worksite))
  assert.ok(r.said.some(t => /work-site chest at -1069, 136, 2301 still holds .*dirt/.test(t)), r.said.join(' | '))
  const placesBefore = r.bot.actions.filter(a => a[0] === 'place').length
  await eng.run(fakeCtx())                          // a later run: the same chest, no second one
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'place').length, placesBefore); assert.strictEqual(crafted.n, 1)
})

test('work site: a restart in the middle of the job: the ledger and the standing chest let the next run finish the haul', async () => {
  const r = rig({ inputs: INPUTS, config: WSCFG })
  carve(r.bot, ['-1069,2299', '-1069,2302', '-1066,2302', '-1066,2299']); r.state.done = ['-1069,2299', '-1069,2302', '-1066,2302', '-1066,2299']
  r.bot.addChest(-1069, 136, 2301, 27, { cobblestone: 200 })
  r.state.worksite = { pos: [-1069, 136, 2301], items: { cobblestone: 200 }, slots: 27, used: 4, hauledUsed: 0 }
  const calls = []
  const eng = engineWith(r, { inputs: INPUTS, depositSmeltables: bagToStations(r, calls) })
  await eng.run(fakeCtx())
  assert.ok(calls.length >= 1); assert.strictEqual(r.state.worksite, null); assert.ok(airAt(r, WS_CELL))
  assert.ok(r.bot.count('chest') >= 1)
})

test('work site: only our own chest is ever opened or broken; a ledger entry whose chest is gone is dropped, a foreign chest nearby is left alone', async () => {
  const r = rig({ inputs: INPUTS, config: WSCFG })
  r.bot.addChest(-1071, 136, 2301, 27, { diamond: 5 })            // somebody else's chest in the wall behind
  r.state.worksite = { pos: [-1069, 136, 2301], items: { cobblestone: 50 }, slots: 27, used: 1 }     // our chest is not there any more
  r.bot.give('cobblestone', 64 * 3); fillInventory(r.bot, 6)
  const crafted = { n: 0 }, calls = []
  const eng = engineWith(r, { inputs: INPUTS, craft: craftChestStub(r, crafted), depositSmeltables: bagToStations(r, calls) })
  await eng.run(fakeCtx())
  assert.ok(!r.bot.actions.some(a => a[0] === 'open' && a[1] === '-1071,136,2301'))
  assert.ok(!r.bot.dugAt().includes('-1071,136,2301'))
  assert.strictEqual(r.bot.chestItems(-1071, 136, 2301).diamond, 5)
})

test('work site: the chest column is still part of the room: its blocks above are dug, and it is never the standing spot or the pillar column', async () => {
  const r = rig({ inputs: INPUTS, config: { ...WSCFG, digTo: 145 } })
  r.bot.addChest(-1069, 136, 2301, 27, {}); r.state.worksite = { pos: [-1069, 136, 2301], items: {}, slots: 27, used: 0 }
  const eng = engineWith(r, { inputs: INPUTS, depositSmeltables: async () => ({ moved: {}, left: [], full: false }) })
  const s = eng.scan()
  assert.strictEqual(s.cols.length, 36, 'the column with the chest still counts')
  const g = s.groups.find(x => x.id === '-1069,2299')
  assert.notDeepStrictEqual({ x: g.stand.x, z: g.stand.z }, { x: -1069, z: 2301 })
  await eng.run(fakeCtx())
  for (const k of cells(SMALL, 138, 145)) assert.ok(airAt(r, k), k)
  assert.ok(!r.bot.actions.filter(a => a[0] === 'place' && a[1] === 'cobblestone').some(a => a[2] === -1069 && a[4] === 2301), 'no pillar in the chest column')
})

// ---------------------------------------------------------------- pickaxes through the crafting module

test('pickaxes worn out: the crafting module API is used (after checking the bag), with the table radius and no chests', async () => {
  const r = rig({ pickaxe: false }); r.bot.give('cobblestone', 20); r.bot.give('oak_planks', 8)
  const calls = []
  const getCrafting = () => ({ craft: async (ctx, item, count, opts) => { calls.push([item, count, opts]); r.bot.give('stone_pickaxe', 1); return { ok: true, made: count, text: 'Crafted' } } })
  const eng = engineWith(r, { getCrafting })
  assert.strictEqual((await eng.run(fakeCtx())).status, 'done')
  assert.deepStrictEqual(calls[0], ['stone_pickaxe', 6, { chests: false, tableRadius: 96 }])
  for (const k of cells()) assert.ok(airAt(r, k))
})

test('crafting module cannot make them: pause with its reason; module missing or throwing: the old table path still works', async () => {
  const r = rig({ pickaxe: false }); r.bot.give('cobblestone', 20); r.bot.give('oak_planks', 8)
  const eng = engineWith(r, { getCrafting: () => ({ craft: async () => ({ ok: false, made: 0, text: 'No crafting table within 96 blocks.' }) }) })
  const res = await eng.run(fakeCtx())
  assert.strictEqual(res.status, 'park'); assert.ok(/Could not craft pickaxes: No crafting table within 96 blocks/.test(res.reason), res.reason)
  const t = rig({ pickaxe: false }); t.bot.give('cobblestone', 20); t.bot.give('oak_planks', 8); t.bot.setBlock(-1071, 136, 2300, 'crafting_table')
  const eng2 = engineWith(t, { getCrafting: () => ({ craft: async () => { throw new Error('boom') } }) })
  assert.strictEqual((await eng2.run(fakeCtx())).status, 'done')
  const n = rig({ pickaxe: false }); n.bot.give('cobblestone', 20); n.bot.give('oak_planks', 8); n.bot.setBlock(-1071, 136, 2300, 'crafting_table')
  assert.strictEqual((await engineWith(n, { getCrafting: () => undefined }).run(fakeCtx())).status, 'done')
})

test('no materials: the crafting module is not even asked', async () => {
  const r = rig({ pickaxe: false }); let asked = 0
  const eng = engineWith(r, { getCrafting: () => ({ craft: async () => { asked++; return { made: 0, text: '' } } }) })
  const res = await eng.run(fakeCtx())
  assert.strictEqual(res.status, 'park'); assert.strictEqual(asked, 0); assert.ok(/out of materials/.test(res.reason))
})

// ---------------------------------------------------------------- dig speed: grounded, right tool, timed

test('digging down from the pillar: every block is dug with the feet on the ground, with a pickaxe in hand, never while still falling', async () => {
  const r = rig({ config: TALL }); r.bot.fallLagMs = 40
  const held = []
  const baseDig = r.bot.dig
  r.bot.dig = async (b, f) => { held.push([b.name, r.bot.heldItem && r.bot.heldItem.name]); return baseDig(b, f) }
  await run(r)
  assert.strictEqual(r.state.finished, true)
  assert.ok(!r.bot.digsWhileAirborne, `${r.bot.digsWhileAirborne} dig(s) started while airborne`)
  assert.ok(held.length > 0 && held.every(([, tool]) => tool === 'stone_pickaxe'), `tools: ${JSON.stringify([...new Set(held.map(h => h[1]))])}`)
  assert.ok(held.some(([n]) => n === 'cobblestone'), 'the pillar teardown was among them')
})

test('dig times are logged: slow digs (over twice the expected time) and the pillar-down digs, with block, time, expectation, onGround and tool; stats in status', async () => {
  const r = rig({ config: TALL }); const logs = []
  r.bot.digDelayMs = 0
  let slowOnce = false
  const baseDig = r.bot.dig
  r.bot.dig = async (b, f) => { if (!slowOnce && b.name === 'stone') { slowOnce = true; r.bot.digDelayMs = 1500 } else r.bot.digDelayMs = 0; return baseDig(b, f) }
  const eng = engineWith(r, { log: (m) => logs.push(m) })
  await eng.run(fakeCtx())
  assert.ok(logs.some(l => /^SLOW dig stone at .*: 1[5-9]\d\d ms, expected ~500 ms, onGround=true, held=stone_pickaxe/.test(l)), logs.filter(l => /dig/.test(l)).slice(0, 3).join(' | '))
  assert.ok(logs.some(l => /dig cobblestone at .*\(pillar-down\): \d+ ms, expected ~500 ms, onGround=true/.test(l)), 'pillar-down digs are always logged')
  const st = eng.snapshot().digStats
  assert.ok(st.count > 100 && st.slow >= 1 && st.slowest && st.slowest.ms >= 1500 && st.totalMs > 0, JSON.stringify(st))
})

test('digging while airborne is waited out: the bot waits for the ground (up to 1 s) and counts it if it never lands', async () => {
  const r = rig({ config: TALL }); r.bot.entity.onGround = false
  setTimeout(() => { r.bot.entity.onGround = true }, 80)
  const eng = engineWith(r, {})
  const t0 = Date.now()
  assert.strictEqual(await eng.tools.waitGrounded(), true); assert.ok(Date.now() - t0 >= 60)
  r.bot.entity.onGround = false
  assert.strictEqual(await eng.tools.waitGrounded(150), false)
})

test('optional aim offset for the dig straight down: looks at a point beside the block centre, then digs without re-aiming; default is unchanged', async () => {
  const r = rig({ config: { ...TALL, pillar: { aimOffset: 0.2 } } }); const looks = []
  const baseLook = r.bot.lookAt; r.bot.lookAt = async (p, f) => { looks.push(p); return baseLook && baseLook(p, f) }
  await run(r)
  assert.ok(looks.some(p => Math.abs((p.x % 1 + 1) % 1 - 0.7) < 1e-6), 'aimed 0.2 beside the centre of a pillar block')
  assert.strictEqual(r.state.finished, true)
  const d = rig({ config: TALL }); const dl = []
  d.bot.lookAt = async (p) => { dl.push(p) }
  await run(d)
  assert.strictEqual(dl.length, 0, 'default: bot.dig(block, true) aims by itself')
})

// ---------------------------------------------------------------- Walter's rules

test('a lava bucket in hand is put away before the first step (never walks holding lava)', async () => {
  const r = rig(); r.bot.give('lava_bucket', 1)
  await r.bot.equip(r.bot.inventory.items().find(i => i.name === 'lava_bucket'), 'hand')
  await run(r)
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
  assert.notStrictEqual(r.bot.heldItem && r.bot.heldItem.name, 'lava_bucket')
})

test('hostile close by or low health: no digging, retried a few times, then paused for Walter', async () => {
  const r = rig()
  r.bot.entities.z = { id: 99, name: 'zombie', position: r.bot.entity.position.offset(2, 0, 0) }
  const ctx = fakeCtx()
  const res = await run(r, ctx)
  assert.strictEqual(res.status, 'retry'); assert.strictEqual(r.bot.dugAt().length, 0)
  assert.ok(r.said.some(t => /zombie is near/.test(t)))
  let last
  for (let i = 0; i < 8 && !last; i++) { const x = await run(r, ctx); if (x.status === 'park') last = x }
  assert.ok(last, 'gives up after dangerRetries')
  delete r.bot.entities.z
  const ok = await run(r, fakeCtx()); assert.strictEqual(ok.status, 'done')
  const r2 = rig(); r2.bot.health = 5
  assert.strictEqual((await run(r2)).status, 'retry')
})

test('no usable pickaxe and nothing to craft one from: pauses; with materials and a crafting table it crafts and goes on', async () => {
  const r = rig({ pickaxe: false })
  assert.strictEqual((await run(r)).status, 'park')
  assert.ok(r.said.some(t => /out of materials/.test(t)))
  const r2 = rig({ pickaxe: false })
  r2.bot.give('cobblestone', 20); r2.bot.give('oak_planks', 8)
  r2.bot.setBlock(-1071, 136, 2300, 'crafting_table')
  assert.strictEqual((await run(r2)).status, 'done')
  assert.ok(r2.bot.inventory.items().some(i => i.name === 'stone_pickaxe'))
  for (const k of cells()) assert.ok(airAt(r2, k))
})

test('nothing is ever placed or opened except the input chests; no player chat starting with "/"', async () => {
  const r = rig({ inputs: INPUTS }); addInputChests(r.bot)
  await run(r)
  assert.ok(!r.bot.actions.some(a => ['place', 'activate', 'open'].includes(a[0])))
  assert.ok(r.said.every(t => !t.startsWith('/') && t.length <= 235))
})

// ---------------------------------------------------------------- scheduler behaviour

test('yields to a higher priority task between steps and resumes with ctx.resumed, without digging anything twice', async () => {
  const r = rig()
  const order = []
  r.bot.onDig = (n) => {
    if (n === 10) r.scheduler.submit({ name: 'safety', priority: PRIORITY.SAFETY, async run(ctx) { order.push(`hi-start@${r.bot.digs}`); await ctx.sleep(40); order.push(`hi-end@${r.bot.digs}`) } })
  }
  let resumedFlag = false
  r.submit({ run: (ctx) => { if (ctx.resumed) resumedFlag = true; return r.engine.run(ctx) } })
  await waitFor(() => r.state.finished)
  assert.deepStrictEqual(order.map(s => s.split('@')[0]), ['hi-start', 'hi-end'])
  const [, a] = order[0].split('@'), [, b] = order[1].split('@')
  assert.strictEqual(a, b, 'not a single dig while the high priority task ran')
  assert.ok(resumedFlag)
  const dug = r.bot.dugAt()
  assert.strictEqual(new Set(dug).size, dug.length, 'no cell dug twice'); assert.strictEqual(dug.length, 144)
})

test('Walter says stop: the task parks, the dig stops, progress is kept; "resume" continues from there', async () => {
  const r = rig()
  r.bot.onDig = (n) => { if (n === 50) r.scheduler.userStop() }
  r.submit()
  await waitFor(() => r.scheduler.status().parked.length === 1)
  assert.strictEqual(r.state.active, false); assert.ok(/Walter/.test(r.state.pauseReason))
  assert.ok(r.state.done.length >= 1 && r.state.done.length < 4)
  assert.ok(r.bot.actions.some(a => a[0] === 'stopDigging') && r.nav.stops >= 1)
  const before = r.bot.dugAt().length
  assert.ok(before >= 50 && before < 144)
  r.bot.onDig = null
  r.scheduler.resumeParked('excavation')
  await waitFor(() => r.state.finished)
  const dug = r.bot.dugAt()
  assert.strictEqual(new Set(dug).size, dug.length); assert.strictEqual(dug.length, 144)
})

test('abort(preempted) keeps the go in effect, abort(user-stop) clears it', () => {
  const r = rig()
  r.state.active = true
  r.engine.abort('preempted'); assert.strictEqual(r.state.active, true)
  r.engine.abort('user-stop'); assert.strictEqual(r.state.active, false)
})

test('full run on the real room map: legacy progress kept, nothing outside y138-141 or the box is touched', { skip: !fs.existsSync(MAP) }, async () => {
  const r = rig({ fromMap: MAP, pos: [-1061, 136, 2323], config: { limits: { maxGroundItems: 1000 } } })
  r.state.done = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'exc-state.json'), 'utf8')).done
  carve(r.bot, r.state.done)
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  const g = r.engine.geo
  for (const k of r.bot.dugAt()) { const [x, y, z] = k.split(',').map(Number); assert.ok(g.inVolume(x, y, z), k) }
  assert.ok(r.bot.dugAt().length > 1500, `dug ${r.bot.dugAt().length}`)
  assert.strictEqual(r.state.done.length, 90)
})

// ---------------------------------------------------------------- module entry, commands, lifecycle

function fakeApi(dir, over = {}) {
  const r = rig()
  const commands = []
  const logs = []
  const api = {
    bot: r.bot, PRIORITY, scheduler: r.scheduler, say: (t) => r.said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, stopNav: () => {}, safehand: r.sh,
    ownerName: 'OGWO', dir: r.dir, statePath: (f) => path.join(r.dir, f), log: (tag, m) => logs.push(`${tag} ${m}`), now: Date.now, excavationConfig: { digTo: 141 },
    commands: { add: (c) => { commands.push(c); return true }, list: () => commands },
    ...over
  }
  return { api, r, commands, logs }
}
const route = (commands, text) => { for (const c of commands) { const hit = typeof c.match === 'function' ? c.match('OGWO', text) : c.match.test(text); if (hit) { c.run('OGWO', text, text); return c.name } } return null }

test('module: registers without any state files and never starts digging by itself', async () => {
  const { api, r, commands } = fakeApi()
  const register = require('../brain/excavation')
  const h = register(api)
  assert.strictEqual(h.name, 'excavation'); assert.strictEqual(register.meta.name, 'excavation')
  h.start(); await wait(60)
  assert.strictEqual(r.bot.dugAt().length, 0); assert.deepStrictEqual(r.scheduler.status().queue, []); assert.strictEqual(r.scheduler.status().running, null)
  assert.strictEqual(h.status().running, false); assert.strictEqual(h.status().active, false)
  assert.deepStrictEqual(commands.map(c => c.name).sort(), ['excavation-go', 'excavation-pause', 'excavation-plan', 'excavation-status'])
  h.stop()
})

test('module: a legacy exc-state.json with active:true is NOT Walter\'s go', async () => {
  const { api, r } = fakeApi()
  fs.writeFileSync(r.legacyFile, JSON.stringify({ active: true, done: ['-1069,2299'], dug: 9 }))
  const h = require('../brain/excavation')(api)
  h.start(); await wait(60)
  assert.strictEqual(r.bot.dugAt().length, 0); assert.strictEqual(h.state.done.length, 1); assert.ok(fs.existsSync(path.join(r.dir, 'excavation-state.json')))
  h.stop()
})

test('module: restart while Walter\'s go was in effect continues; finished jobs and paused jobs do not', async () => {
  const mk = (stateObj) => { const f = fakeApi(); fs.writeFileSync(path.join(f.r.dir, 'excavation-state.json'), JSON.stringify(stateObj)); return f }
  const a = mk({ active: true, done: ['-1069,2299'] }); const ha = require('../brain/excavation')(a.api); ha.start()
  await waitFor(() => ha.state.finished); assert.ok(a.r.bot.dugAt().length > 0); ha.stop()
  const b = mk({ active: false, done: [] }); require('../brain/excavation')(b.api).start(); await wait(60); assert.strictEqual(b.r.bot.dugAt().length, 0)
  const c = mk({ active: true, finished: true, done: ['x'] }); require('../brain/excavation')(c.api).start(); await wait(60); assert.strictEqual(c.r.bot.dugAt().length, 0)
})

test('module: "excavate" starts from the saved progress, "pause excavation" stops it, "resume excavation" carries on', async () => {
  const { api, r, commands } = fakeApi()
  const h = require('../brain/excavation')(api)
  r.state.done = []
  r.bot.onDig = (n) => { if (n === 30) route(commands, 'pause excavation') }
  assert.strictEqual(route(commands, 'excavate'), 'excavation-go')
  await waitFor(() => r.scheduler.status().parked.length === 1)
  assert.strictEqual(h.state.active, false); assert.ok(r.said.some(t => /pausing the excavation/i.test(t)))
  const n = r.bot.dugAt().length
  r.bot.onDig = null
  assert.strictEqual(route(commands, 'resume excavation'), 'excavation-go')
  await waitFor(() => h.state.finished)
  assert.strictEqual(new Set(r.bot.dugAt()).size, r.bot.dugAt().length); assert.ok(n < 144)
  assert.strictEqual(route(commands, 'excavation status'), 'excavation-status')
  assert.ok(r.said.some(t => /The room is carved: 144 blocks dug/.test(t)))
  h.stop()
})

test('module: chat phrases', () => {
  const { phrases } = require('../brain/excavation')
  const go = ['excavate', 'ok excavate', 'go excavate', 'carve', 'resume excavation', 'continue the excavation', 'start the excavation', 'begin digging out the room', 'keep digging', 'get started with the excavation', 'continue digging', 'do it, start excavating']
  const not = ['excavation status', 'how is the excavation going', 'excavation progress', 'excavation plan', 'pause excavation', 'stop digging', 'stop the excavation', 'how far along is the digging', 'hello', 'start furnace upkeep', 'resume', 'go to bed', 'walk to me']
  for (const t of go) assert.ok(phrases.isGo('OGWO', t), `go: ${t}`)
  for (const t of not) assert.ok(!phrases.isGo('OGWO', t), `not go: ${t}`)
  for (const t of ['excavation status', 'how is the excavation going', 'excavation progress', 'how far along is the digging', 'how\'s the excavation going']) assert.ok(phrases.STATUS.test(t), `status: ${t}`)
  for (const t of ['excavation plan', 'excavation dry run', 'excavation preview']) assert.ok(phrases.PLAN.test(t), `plan: ${t}`)
  for (const t of ['pause excavation', 'stop digging', 'stop the excavation', 'halt the excavation']) assert.ok(phrases.PAUSE.test(t), `pause: ${t}`)
})

test('module: every canonical phrase in help matches its own command', () => {
  const { api, commands } = fakeApi()
  require('../brain/excavation')(api)
  for (const c of commands) {
    const canon = c.help.split('|')[0].trim()
    const hit = typeof c.match === 'function' ? c.match('OGWO', canon) : c.match.test(canon)
    assert.ok(hit, `${c.name}: "${canon}"`)
  }
  assert.strictEqual(commands.find(c => c.name === 'excavation-go').risk, 'high')
})

test('module: plan and status answer without moving or digging', async () => {
  const { api, r, commands } = fakeApi()
  require('../brain/excavation')(api)
  route(commands, 'excavation plan'); route(commands, 'excavation status')
  assert.ok(r.said.some(t => /Excavation plan: 4 of 4 sections left/.test(t)))
  assert.ok(r.said.some(t => /Not running\. 0\/4 sections done/.test(t) && /Waiting for your go/.test(t)))
  assert.strictEqual(r.bot.dugAt().length, 0); assert.ok(!r.bot.actions.some(a => a[0] === 'goto'))
})

test('integration: loads as a brain module next to the integrator, shows up in status and does not start', async () => {
  const attach = require('../brain')
  const { mockBot } = require('./mock-bot')
  const { extend } = require('./excavation.helpers')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-exc-'))
  fs.writeFileSync(path.join(dir, 'exc-state.json'), JSON.stringify({ active: false, done: ['-1069,2299'], dug: 5 }))
  const bot = extend(mockBot({ pos: [-1061, 136, 2323] }))
  const said = []
  const brain = attach({
    bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, navigateRaw() {}, navActive: () => false, handleCommand: () => false,
    farm: { isBusy: () => false, stop() {} }, excavation: { isRunning: () => false, stop() {} }, routines: {}, saveRoutines() {}, jobs: {}, dir, stateDir: path.join(dir, 'state'), idleAfterMs: 50,
    moduleEntries: [{ name: 'excavation', path: path.join(__dirname, '..', 'brain', 'excavation', 'index.js') }]
  })
  await wait(50)
  const st = brain.status()
  assert.ok(st.modules.excavation, 'status.modules.excavation')
  assert.strictEqual(st.modules.excavation.running, false); assert.strictEqual(st.modules.excavation.sectionsDone, 1)
  assert.ok(brain.api.commands.list().some(c => c.name === 'excavation-go'))
  assert.ok(!st.logTail.some(l => /BRAIN_MODULE_ERROR/.test(l)))
  assert.strictEqual(brain.scheduler.status().running, null); assert.strictEqual(bot.dugAt().length, 0)
  brain.stop()
})

test('integration: through the real chat router, "excavate" runs our module (not the legacy adapter), "stop" parks it, "resume excavation" continues', { skip: !fs.existsSync(MAP) }, async () => {
  const attach = require('../brain')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-exc2-'))
  fs.copyFileSync(path.join(__dirname, '..', 'exc-state.json'), path.join(dir, 'exc-state.json'))
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true }); fs.writeFileSync(path.join(dir, 'state', 'excavation-config.json'), JSON.stringify({ digTo: 141 }))   // keep this test on the 6-high room
  const { bot } = rig({ fromMap: MAP, pos: [-1061, 136, 2323] })
  for (const p of INPUTS) bot.addChest(p[0], p[1], p[2], 54, {})      // the furnace input chests the shared helper unloads into
  const said = [], legacyCalls = []
  const brain = attach({
    bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, navigateRaw() {}, navActive: () => false, handleCommand: () => false,
    farm: { isBusy: () => false, stop() {} }, routines: {}, saveRoutines() {}, jobs: {}, dir, stateDir: path.join(dir, 'state'), idleAfterMs: 50,
    excavation: { isRunning: () => false, stop() {}, start() { legacyCalls.push('start') }, resume() { legacyCalls.push('resume') } },
    moduleEntries: [{ name: 'excavation', path: path.join(__dirname, '..', 'brain', 'excavation', 'index.js') }]
  })
  const wasRouted = brain.route('OGWO', 'ok excavate', { handleCommand: () => false })
  assert.strictEqual(wasRouted, true)
  bot.onDig = (n) => { if (n === 100) brain.route('OGWO', 'please stop digging', {}) }
  await waitFor(() => brain.scheduler.status().parked.some(t => t.name === 'excavation'))
  assert.deepStrictEqual(legacyCalls, [])
  assert.ok(said.some(t => /Resuming the excavation \(6 blocks tall\): 13\/90/.test(t)), said.join(' | '))
  assert.ok(bot.dugAt().length >= 100 && bot.dugAt().length < 1800)
  bot.onDig = null
  brain.route('OGWO', 'resume excavation', {})
  await waitFor(() => brain.status().modules.excavation.finished, 8000)
  assert.deepStrictEqual(legacyCalls, [])
  const dug = bot.dugAt(); assert.strictEqual(new Set(dug).size, dug.length)
  assert.ok(said.some(t => /Excavation finished/.test(t)))
  brain.stop()
})
