const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { Vec3 } = require('vec3')
const snapshot = require('../brain/snapshot')
const { capture, buildCommands, decodeCells, boxes } = snapshot

// a fake bot over a block map: "x,y,z" -> block string (default air). Unloaded outside [-40, 40].
function worldBot(map, extra = {}) {
  const bot = {
    username: 'OzoGo444', entity: { position: new Vec3(0.5, 30, 0.5), yaw: Math.PI / 2, pitch: -0.5, onGround: true }, health: 18, food: 15, game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 13000, day: 4 }, quickBarSlot: 2, heldItem: { name: 'cobblestone' }, entities: {}, _ap: { G: { lastStep: 'ladder-up' } },
    inventory: { slots: [] }, ...extra,
    blockAt: (p) => {
      if (Math.abs(p.x) > 40 || Math.abs(p.z) > 40) return null
      const s = map.get(`${p.x},${p.y},${p.z}`) || 'air'
      const m = /^([a-z_]+)(?:\[(.*)\])?$/.exec(s), props = {}
      if (m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); props[k] = v }
      return { name: m[1], getProperties: () => props }
    }
  }
  bot.inventory.slots[36 + 2] = { name: 'cobblestone', count: 40 }; bot.inventory.slots[12] = { name: 'torch', count: 8 }; bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 }
  return bot
}
// the incident: a 1x1 shaft with a ladder up through stone, a torch on the wall, a ledge
function shaftWorld() {
  const m = new Map()
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = 20; y <= 40; y++) m.set(`${x},${y},${z}`, 'stone')
  for (let y = 22; y <= 36; y++) { m.set(`0,${y},0`, 'air'); m.set(`0,${y},1`, 'ladder[facing=north]'.replace('ladder', 'stone')) }
  for (let y = 22; y <= 36; y++) m.set(`0,${y},-1`, 'ladder[facing=south]')
  m.set('1,30,0', 'wall_torch[facing=west]'); m.set('0,21,0', 'dirt'); m.set('0,22,0', 'water[level=0]')
  return m
}

// a tiny server: runs /fill and /setblock against a map, ignores the rest
function applyCommands(cmds) {
  const w = new Map()
  for (const { cmd } of cmds) {
    let m = /^\/setblock (-?\d+) (-?\d+) (-?\d+) minecraft:(\S+)$/.exec(cmd)
    if (m) { w.set(`${m[1]},${m[2]},${m[3]}`, m[4]); continue }
    m = /^\/fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:(\S+)$/.exec(cmd)
    if (!m) continue
    const [x0, y0, z0, x1, y1, z1] = m.slice(1, 7).map(Number), b = m[7]
    assert.ok((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) <= 32768, 'fill limit')
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { if (b === 'air') w.delete(`${x},${y},${z}`); else w.set(`${x},${y},${z}`, b) }
  }
  return w
}

test('capture: position, held slot, bag by window slot, step, mobs and a palette-coded block cube; the file is written and old ones trimmed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
  const bot = worldBot(shaftWorld()); bot.entities[7] = { name: 'zombie', type: 'hostile', position: new Vec3(3, 30, 4) }; bot.entities[1] = bot.entity
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `s${i}-old.json`), '{}')
  const s = capture(bot, { flag: { kind: 'ladder_bobbing', sev: 'high', msg: 'bobbing' }, dir, keep: 3, commit: 'abc123def', now: () => 1700000000000, task: 'autopilot' })
  assert.strictEqual(s.id, 's1700000000-ladder_bobbing'); assert.strictEqual(s.commit, 'abc123def'); assert.strictEqual(s.step, 'ladder-up'); assert.strictEqual(s.quickBarSlot, 2)
  assert.deepStrictEqual(s.bag.map(b => b.slot).sort((a, b) => a - b), [5, 12, 38]); assert.strictEqual(s.mobs.length, 1)
  assert.strictEqual(s.world.size, 25); assert.ok(s.world.palette.includes('ladder[facing=south]') && s.world.palette.includes('wall_torch[facing=west]') && s.world.palette.includes('water[level=0]'))
  assert.ok(JSON.stringify(s.world).length < 8000, 'run-length coded: ' + JSON.stringify(s.world).length)
  assert.ok(fs.existsSync(path.join(dir, s.id + '.json')))
  assert.strictEqual(fs.readdirSync(dir).length, 3, 'only the newest 3 kept')
})

test('decodeCells round-trips the cube; unloaded cells are left out', () => {
  const map = shaftWorld(), bot = worldBot(map)
  bot.entity.position = new Vec3(38.5, 30, 0.5)                                  // east edge: x > 40 is unloaded
  const s = capture(bot, { flag: { kind: 'x', sev: 'high', msg: '' } })
  const cells = decodeCells(s)
  assert.ok(cells.size < 25 * 25 * 25 && cells.size > 0)
  assert.ok(![...cells.keys()].some(k => Number(k.split(',')[0]) > 40))
  const c = worldBot(map); const s2 = capture(c, { flag: { kind: 'x', sev: 'high', msg: '' } }), cells2 = decodeCells(s2)
  assert.strictEqual(cells2.size, 25 * 25 * 25)
  assert.strictEqual(cells2.get('0,30,-1'), 'ladder[facing=south]'); assert.strictEqual(cells2.get('1,30,0'), 'wall_torch[facing=west]'); assert.strictEqual(cells2.get('3,30,3'), 'stone')
})

test('buildCommands rebuilds exactly the snapshot blocks on a blank world (checked by a mini /fill interpreter), in few commands', () => {
  const s = capture(worldBot(shaftWorld()), { flag: { kind: 'ladder_bobbing', sev: 'high', msg: '' } })
  const cmds = buildCommands(s)
  const built = applyCommands(cmds), want = decodeCells(s)
  for (const [k, v] of want) { if (v === 'air') assert.ok(!built.has(k), `${k} should be air`); else assert.ok(built.has(k), `${k} missing (${v})`) }
  for (const [k, v] of want) if (v !== 'air') assert.strictEqual(built.get(k).split('[')[0], v.split('[')[0], k)
  // every non-air snapshot cell is built and nothing else
  assert.strictEqual(built.size, [...want.values()].filter(v => v !== 'air').length)
  assert.ok(cmds.filter(c => c.kind === 'block').length < 40, `block commands: ${cmds.filter(c => c.kind === 'block').length}`)
  assert.ok(cmds.some(c => c.cmd === '/setblock 1 30 0 minecraft:wall_torch[facing=west]'))
  assert.ok(cmds.some(c => c.cmd.includes('minecraft:ladder[facing=south]')))
})

test('shift moves everything; bag slots map to item replace targets; the player is last, with yaw and pitch converted to Minecraft degrees', () => {
  const s = capture(worldBot(shaftWorld()), { flag: { kind: 'k', sev: 'high', msg: '' } })
  const cmds = buildCommands(s, { shift: [100, 0, -50] })
  const bag = cmds.filter(c => c.kind === 'bag').map(c => c.cmd)
  assert.ok(bag.includes('/item replace entity @s hotbar.2 with minecraft:cobblestone 40'))
  assert.ok(bag.includes('/item replace entity @s inventory.3 with minecraft:torch 8'))
  assert.ok(bag.includes('/item replace entity @s armor.head with minecraft:iron_helmet 1'))
  const last = cmds[cmds.length - 1]; assert.strictEqual(last.kind, 'tp')
  // mineflayer yaw PI/2 (facing -x... counter-clockwise from -z) is Minecraft yaw 90 (facing west); pitch -0.5 rad (looking down) is +28.6 degrees
  assert.match(last.cmd, /^\/tp @s 100\.500 30\.000 -49\.500 90\.0 28\.6$/)
  const b = applyCommands(cmds); assert.ok(b.has('100,30,-51') || [...b.keys()].some(k => k.startsWith('99,') || k.startsWith('100,')))
  assert.ok(cmds.some(c => c.cmd === '/time set 13000'))
})

test('boxes: a solid cube is one box, a hollow shaft a handful', () => {
  const m = new Map(); for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 20; y <= 26; y++) m.set(`${x},${y},${z}`, 'stone')
  const s = capture(worldBot(m), { flag: { kind: 'k', sev: 'high', msg: '' } })
  assert.strictEqual(boxes(s).filter(b => !b.air).length, 1)
})

test('ladder lab: a snapshot of a ladder shaft becomes a lab scenario the real pathfinder and physics can run (arrives at the top)', async () => {
  const { scenarioFromSnapshot } = require('../tools/ladderlab/fromSnapshot')
  const { run } = require('../tools/ladderlab/run')
  // shaft: stone mass, the column (0, y, 0) carved from 22 to 36 with ladders on its north wall at z=-1 facing south... the column sits at z=0, ladders ARE in the column facing south against stone at z=-1
  const m = new Map()
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 21; y <= 30; y++) m.set(`${x},${y},${z}`, 'stone')
  for (let y = 22; y <= 30; y++) m.set(`0,${y},0`, 'ladder[facing=south,waterlogged=false]')
  m.set('0,22,1', 'air'); m.set('0,23,1', 'air')                                  // the way in at the bottom; the top surface (y 30) is the exit (the snapshot cube reaches 12 blocks around the bot)
  const bot = worldBot(m, { entity: { position: new Vec3(0.5, 22, 1.5), yaw: 0, pitch: 0, onGround: true } })
  const snap = capture(bot, { flag: { kind: 'ladder_bobbing', sev: 'high', msg: '' } })
  const sc = scenarioFromSnapshot(snap, { goal: [0, 31, 1] })
  assert.deepStrictEqual(sc.start.map(Math.floor), [10, 64, 10]); assert.deepStrictEqual(sc.goal, [10, 73, 10])
  assert.match(sc.note, /ladder_bobbing/)
  const out = await run(sc)
  assert.ok(out.arrived, JSON.stringify(out)); assert.ok(out.pass, JSON.stringify(out))
})
