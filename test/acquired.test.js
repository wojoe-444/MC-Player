// brain/acquired: pickups are logged, chest withdrawals / self-dropped items / the bot's own death drop are not.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const L = require('../brain/acquired/log')
const register = require('../brain/acquired')
const { mockBot } = require('./mock-bot')

const T0 = 1_700_000_000_000, MIN = 60000, HOUR = 3600000

function rig() {
  const bot = mockBot()
  bot.entity.id = 7
  bot._client = new EventEmitter()
  bot.toss = async (type, meta, count) => { bot.take(typeof type === 'string' ? type : 'oak_log', count) }
  bot.tossStack = async (item) => { bot.take(item.name, item.count) }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquired-'))
  let clock = T0
  const api = { bot, now: () => clock, log() {}, statePath: (f) => path.join(dir, f) }
  const h = register(api)
  const file = path.join(dir, 'acquired.jsonl')
  // a dropped item entity on the ground, and the server's collect packet for it
  let eid = 100
  const drop = (name, count) => { const id = ++eid; bot.entities[id] = { id, name: 'item', getDroppedItem: () => ({ name, count }) }; return id }
  const collect = (id, extra = {}) => bot._client.emit('collect', { collectorEntityId: 7, collectedEntityId: id, pickupItemCount: bot.entities[id].getDroppedItem().count, ...extra })
  const lines = () => (fs.existsSync(file) ? L.parse(fs.readFileSync(file, 'utf8')) : [])
  return { bot, h, file, dir, drop, collect, lines, advance: (ms) => { clock += ms } }
}

test('a pickup of a dropped item is logged with the count the server reports', () => {
  const { h, drop, collect, lines } = rig()
  h.start()
  collect(drop('oak_log', 5), { pickupItemCount: 3 })        // the bag was nearly full: only 3 went in
  collect(drop('cobblestone', 1))
  h._tick.flush()
  assert.deepStrictEqual(lines().map(e => [e.item, e.n]), [['oak_log', 3], ['cobblestone', 1]])
  h.stop()
})

test('pickups of one item are coalesced into a single line per flush', () => {
  const { h, drop, collect, lines, advance } = rig()
  h.start()
  for (let i = 0; i < 4; i++) { collect(drop('oak_log', 1)); advance(1000) }
  h._tick.flush()
  assert.deepStrictEqual(lines(), [{ t: T0, item: 'oak_log', n: 4 }])
  h.stop()
})

test("another player's pickup, xp orbs, arrows and unknown entities are ignored", () => {
  const { bot, h, drop, collect, lines } = rig()
  h.start()
  collect(drop('oak_log', 2), { collectorEntityId: 99 })
  bot.entities[500] = { id: 500, name: 'experience_orb', getDroppedItem: () => null }
  bot._client.emit('collect', { collectorEntityId: 7, collectedEntityId: 500, pickupItemCount: 1 })
  bot._client.emit('collect', { collectorEntityId: 7, collectedEntityId: 12345, pickupItemCount: 1 })
  h._tick.flush()
  assert.deepStrictEqual(lines(), [])
  h.stop()
})

test('withdrawing from a chest is not a pickup, so a stack stored hours ago is never counted', () => {
  const { bot, h, lines, advance } = rig()
  h.start()
  advance(9 * HOUR)
  bot.give('oak_log', 40)                                       // the chest window moves it into the bag: no collect packet
  h._tick.flush()
  assert.deepStrictEqual(lines(), [])
  h.stop()
})

test('re-picking what the bot tossed itself is not counted; the rest of the pile still is', async () => {
  const { bot, h, drop, collect, lines, advance } = rig()
  bot.give('cobblestone', 64)
  h.start()
  await bot.toss('cobblestone', null, 30)   // dropped 30 rubble to free the bag
  assert.strictEqual(h.status().selfDropped, 30)
  advance(10000)
  collect(drop('cobblestone', 20))                              // walks over its own pile again: 20 of the 30
  collect(drop('cobblestone', 15))                              // 10 more of its own, 5 from somewhere else
  h._tick.flush()
  assert.deepStrictEqual(lines().map(e => [e.item, e.n]), [['cobblestone', 5]])
  h.stop()
})

test('a toss that fails or drops nothing leaves nothing to subtract, and a self-drop expires after the 5 minutes an item lives', async () => {
  const { bot, h, drop, collect, lines, advance } = rig()
  bot.give('dirt', 10)
  bot.toss = async () => { throw new Error('window closed') }
  h.start()
  await bot.tossStack({ name: 'dirt', count: 10 })
  advance(6 * MIN)                                              // despawned long ago: this dirt is someone else's
  collect(drop('dirt', 10))
  await assert.rejects(() => bot.toss('dirt', null, 1))
  h._tick.flush()
  assert.deepStrictEqual(lines().map(e => [e.item, e.n]), [['dirt', 10]])
  h.stop()
})

test('a nested toss (toss calling tossStack) is counted once', async () => {
  const { bot, h } = rig()
  bot.give('gravel', 20)
  bot.toss = async (type, meta, count) => { await bot.tossStack({ name: 'gravel', count }) }
  h.start()
  await bot.toss('gravel', null, 20)
  assert.strictEqual(h.status().selfDropped, 20)
  h.stop()
})

test('the bag at death is the bot\'s own: picking it back up is recovery, not income', () => {
  const { bot, h, drop, collect, lines } = rig()
  bot.give('iron_ingot', 12)
  h.start()
  bot.emit('death')
  collect(drop('iron_ingot', 12))
  collect(drop('rotten_flesh', 2))                              // the zombie's drop is new
  h._tick.flush()
  assert.deepStrictEqual(lines().map(e => [e.item, e.n]), [['rotten_flesh', 2]])
  h.stop()
})

test('stop flushes what is pending and restores the tossing functions', async () => {
  const { bot, h, drop, collect, lines } = rig()
  const t0 = bot.toss
  h.start(); assert.notStrictEqual(bot.toss, t0)
  collect(drop('oak_log', 2))
  h.stop()
  assert.strictEqual(bot.toss, t0)
  assert.deepStrictEqual(lines().map(e => [e.item, e.n]), [['oak_log', 2]])
})

test('compact merges lines older than 48 h per hour and keeps recent lines exact; sum respects the window', () => {
  const now = T0 + 100 * HOUR
  const text = [
    { t: T0 + 5 * MIN, item: 'oak_log', n: 3 }, { t: T0 + 20 * MIN, item: 'oak_log', n: 4 }, { t: T0 + 20 * MIN, item: 'dirt', n: 1 },
    { t: now - 2 * HOUR, item: 'oak_log', n: 6 },
  ].map(e => JSON.stringify(e)).join('\n') + '\n{"torn'
  const out = L.parse(L.compact(text, now))
  const hour = Math.floor(T0 / HOUR) * HOUR
  assert.deepStrictEqual(out, [{ t: hour, item: 'oak_log', n: 7 }, { t: hour, item: 'dirt', n: 1 }, { t: now - 2 * HOUR, item: 'oak_log', n: 6 }])
  assert.deepStrictEqual(L.sum(out, now - 8 * HOUR), { oak_log: 6 })
  assert.deepStrictEqual(L.sum(out), { oak_log: 13, dirt: 1 })
})

test('the module is registered in the brain and has its meta.json', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'brain', 'index.js'), 'utf8'), /const MODULES = \[[^\]]*'acquired'/)
  assert.strictEqual(register.meta.kind, 'observer')
})
