'use strict'
// tools/bench/lib/score.js and rcon.js: the parsing and the scoring maths. No server needed.
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const Sc = require('../tools/bench/lib/score')
const rcon = require('../tools/bench/lib/rcon')

test('parseInventory reads 1.21.6 SNBT in any key order and sums stacks', () => {
  const inv = Sc.parseInventory('OzoBench has the following entity data: [{Slot: 0b, id: "minecraft:oak_log", count: 5}, {count: 3, id: "minecraft:oak_log", Slot: 1b}, {Slot: 2b, id: "minecraft:wooden_pickaxe", count: 1, components: {"minecraft:damage": 4}}]')
  assert.deepEqual(inv, { oak_log: 8, wooden_pickaxe: 1 })
  assert.deepEqual(Sc.parseInventory('OzoBench has the following entity data: []'), {})
})

test('parseNums reads a Pos list', () => {
  assert.deepEqual(Sc.parseNums('[34.5d, 109.0d, -30.5d]'), [34.5, 109, -30.5])
})

const row = (t, inv, pos = [0, 70, 0], extra = {}) => ({ t, inv, pos, hp: 20, deaths: 0, day: 1000 + t * 20, ...extra })

test('analyze: milestone times from the bag, points, per-hour scaling', () => {
  const samples = [row(3, {}), row(60, { oak_log: 4 }, [5, 70, 5]), row(120, { oak_log: 2, wooden_pickaxe: 1 }, [9, 70, 5]), row(1800, { cobblestone: 9, stone_pickaxe: 1 }, [30, 64, 5])]
  const r = Sc.analyze({ samples, seconds: 1800, stats: {}, placedDelta: { 'minecraft:crafting_table': 1 }, deathLog: [] })
  assert.equal(r.milestones.log.t, 60)
  assert.equal(r.milestones.wooden_pickaxe.t, 120)
  assert.equal(r.milestones.stone_pickaxe.t, 1800)
  assert.equal(r.milestones.crafting_table.done, true, 'placed table counts although never seen in the bag')
  assert.equal(r.milestones.crafting_table.t, null)
  assert.equal(r.points, 1 + 1 + 1 + 1 + 2)            // log, table, wooden pickaxe, cobblestone, stone pickaxe
  assert.equal(r.perHour.points, 12)                    // 6 points in half an hour
  assert.equal(r.pointsAt[30], 5, 'the placed table has no time, so it is not in the curve')
})

test('analyze: stall counts a still bot with an unchanging bag, not a moving one, and splits the night out', () => {
  const still = []
  for (let t = 0; t <= 120; t += 3) still.push(row(t, { oak_log: 1 }, [0, 70, 0]))
  const r = Sc.analyze({ samples: still, seconds: 120, stats: {}, placedDelta: {}, deathLog: [] })
  assert.ok(r.totals.stallSeconds >= 110 && r.totals.stallSeconds <= 120, 'stall ' + r.totals.stallSeconds)
  assert.equal(r.totals.stallSeconds, r.totals.stallDaySeconds)
  const night = still.map(s => ({ ...s, day: 15000 }))
  const rn = Sc.analyze({ samples: night, seconds: 120, stats: {}, placedDelta: {}, deathLog: [] })
  assert.equal(rn.totals.stallDaySeconds, 0)
  const walking = []
  for (let t = 0; t <= 120; t += 3) walking.push(row(t, { oak_log: 1 }, [t, 70, 0]))
  assert.equal(Sc.analyze({ samples: walking, seconds: 120, stats: {}, placedDelta: {}, deathLog: [] }).totals.stallSeconds, 0)
})

test('analyze: deaths come from the scoreboard or the log, whichever is larger; stats feed the totals', () => {
  const samples = [row(3, {}), row(60, {}, [1, 70, 1], { deaths: 2 })]
  const r = Sc.analyze({ samples, seconds: 3600, stats: { 'minecraft:mined': { 'minecraft:stone': 10 }, 'minecraft:picked_up': { 'minecraft:cobblestone': 7 }, 'minecraft:crafted': { 'minecraft:furnace': 1 } }, placedDelta: {}, deathLog: ['OzoBench was slain by Zombie'] })
  assert.equal(r.totals.deaths, 2)
  assert.equal(r.perHour.deaths, 2)
  assert.equal(r.perHour.blocksMined, 10)
  assert.equal(r.milestones.furnace.done, true, 'crafted per the stats')
})

test('rcon client: login, command, reply (against a fake server)', async () => {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8), body = buf.toString('utf8', 12, 4 + len - 2)
        buf = buf.subarray(4 + len)
        const reply = (rid, rtype, text) => { const p = Buffer.from(text), pk = Buffer.alloc(14 + p.length); pk.writeInt32LE(10 + p.length, 0); pk.writeInt32LE(rid, 4); pk.writeInt32LE(rtype, 8); p.copy(pk, 12); sock.write(pk) }
        if (type === 3) reply(body === 'pw' ? id : -1, 2, '')
        else if (type === 2) reply(id, 0, 'ran: ' + body)
      }
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const c = await rcon.connect({ port, password: 'pw' })
  assert.equal(await c.cmd('time query gametime'), 'ran: time query gametime')
  c.close()
  await assert.rejects(rcon.connect({ port, password: 'bad' }), /wrong password/)
  srv.close()
})
