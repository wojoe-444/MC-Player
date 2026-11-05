const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const perceive = require('../brain/villagers/perceive')
const trades = require('../brain/villagers/trades')
const cfg = require('../brain/villagers/config.json')
const P = require('../brain/villagers').phrases
const { mcData } = require('./mock-bot')
const { rig, T, inv, idle } = require('./villagers.helpers')

const mendingLibrarian = (cost = 22) => ({ id: 7, at: [3.5, 64, 0.5], profession: 'librarian', trades: [T.book('sharpness', 5, 30), T.book('mending', 1, cost), T.buy('lectern', 3)] })
const didNotChangeWorld = (bot) => assert.deepEqual(bot.actions.filter((a) => ['dig', 'place', 'stopDigging', 'attack'].includes(a[0])), [])

// ---------- perception ----------
test('classify: baby, zombie villager, golem, others', () => {
  const r = rig()
  assert.equal(perceive.classify(r.bot.addVillager({ id: 1, at: [5, 64, 0], profession: 'farmer' })), 'villager')
  assert.equal(perceive.classify(r.bot.addVillager({ id: 2, at: [5, 64, 0], baby: true })), 'baby_villager')
  assert.equal(perceive.classify({ name: 'zombie_villager', position: new Vec3(0, 0, 0) }), 'zombie_villager')
  assert.equal(perceive.classify({ name: 'iron_golem' }), 'iron_golem')
  assert.equal(perceive.classify({ name: 'cow' }), null)
})

test('profession read from ids and names; unseen villagers stay unknown', () => {
  const r = rig()
  r.bot.addVillager({ id: 1, at: [4, 64, 0], profession: 'librarian' })
  r.bot.entities[2] = { id: 2, name: 'villager', position: new Vec3(4, 64, 3), height: 1.95, metadata: [{ villagerProfession: 'minecraft:farmer', level: 2 }] }
  assert.equal(perceive.professionOf(r.bot.entities[1]), 'librarian')
  assert.equal(perceive.professionOf(r.bot.entities[2]), 'farmer')
  assert.equal(perceive.levelOf(r.bot.entities[2]), 2)
  const seen = perceive.scan(r.bot, { canSee: (e) => e.id === 1 })
  assert.equal(seen.find((x) => x.id === 1).profession, 'librarian')
  assert.equal(seen.find((x) => x.id === 2).profession, null)
})

// ---------- trade logic ----------
const desc = (t, i = 0) => trades.describeTrade(t, i)
test('resolveWant: books, levels, items, gear, unknown words', () => {
  const w = (q) => trades.resolveWant(q, cfg, mcData)
  assert.equal(w('mending').kind, 'book')
  assert.equal(w('a mending book').maxEmeralds, 64)
  assert.ok(w('efficiency 5').match(desc(T.book('efficiency', 5, 20))))
  assert.ok(!w('efficiency 5').match(desc(T.book('efficiency', 4, 20))))
  assert.ok(!w('efficiency').match(desc(T.book('efficiency', 3, 20))), 'wishlist minLevel 5')
  assert.ok(w('Silk Touch').match(desc(T.book('silk_touch', 1, 20))))
  assert.ok(w('diamond pickaxe').match(desc(T.buy('diamond_pickaxe', 15))))
  assert.ok(w('arrows').match(desc(T.buy('arrow', 1, { count: 16 }))))
  assert.ok(w('diamond gear').match(desc(T.buy('diamond_boots', 10))))
  assert.equal(w('flibbertigibbet'), null)
})

test('evaluateBuy: price cap, missing inputs, budget, sold out', () => {
  const want = trades.resolveWant('mending', cfg, mcData)
  const inv = { emerald: 100, book: 1 }
  assert.ok(trades.evaluateBuy(desc(T.book('mending', 1, 22)), want, inv, 128).ok)
  assert.match(trades.evaluateBuy(desc(T.book('mending', 1, 70)), want, inv, 128).why, /over my limit/)
  assert.match(trades.evaluateBuy(desc(T.book('mending', 1, 22)), want, { emerald: 100 }, 128).why, /need 1 book/)
  assert.match(trades.evaluateBuy(desc(T.book('mending', 1, 22)), want, inv, 10).why, /budget/)
  assert.match(trades.evaluateBuy(desc(T.book('mending', 1, 22, { used: 12 })), want, inv, 128).why, /sold out/)
  assert.equal(trades.evaluateBuy(desc(T.book('sharpness', 5, 22)), want, inv, 128).ok, false)
})

test('evaluateSell: keeps a reserve, respects uses left', () => {
  const ev = trades.evaluateSell(desc(T.sell('carrot', 22)), { carrot: 100 }, cfg.sell)
  assert.deepEqual([ev.ok, ev.times, ev.gets], [true, 3, 3])
  assert.equal(trades.evaluateSell(desc(T.sell('carrot', 22)), { carrot: 40 }, cfg.sell).ok, false)
  assert.equal(trades.evaluateSell(desc(T.sell('carrot', 22, 1, { used: 16 })), { carrot: 100 }, cfg.sell).ok, false)
  assert.equal(trades.evaluateSell(desc(T.sell('diamond', 1)), { diamond: 100 }, cfg.sell).ok, false, 'only listed items')
})

// ---------- commands ----------
test('phrases', () => {
  assert.ok(P.FIND.test('find villagers') && P.FIND.test('are there any villagers around') && P.FIND.test('where are the villagers'))
  assert.equal(P.TRADE.exec('trade for mending book')[1], 'mending book')
  assert.equal(P.TRADE.exec('get me efficiency 5 from a librarian')[2], 'efficiency 5')
  assert.ok(P.SELL.test('sell my extra wheat') && P.SELL.test('sell crops to the farmer'))
  assert.ok(!P.TRADE.test('trade routes are fun') && !P.SELL.test('sell the house'))
  assert.ok(P.APPROVE.test('approve villager plan') && P.UPKEEP_ON.test('villager upkeep on'))
})

test('find villagers: counts what is seen, hides what is behind a wall, says so when none', async () => {
  const r = rig()
  r.say('find villagers')
  assert.match(r.said.at(-1), /do not see any villagers/)
  r.bot.addVillager({ id: 1, at: [4.5, 64, 0.5], profession: 'farmer' })
  r.bot.addVillager({ id: 2, at: [6.5, 64, 4.5], profession: 'librarian', baby: false })
  for (let y = 64; y <= 65; y++) for (const [x, z] of [[6, 3], [7, 3], [5, 3], [5, 4], [5, 5], [7, 5], [6, 5], [7, 4]]) r.bot.setBlock(x, y, z, 'stone')
  r.bot.setBlock(6, 66, 4, 'stone'); r.bot.setBlock(6, 66, 3, 'stone')
  r.bot.addVillager({ id: 3, at: [3.5, 64, 2.5], baby: true })
  assert.equal(r.say('find villagers'), true)
  const line = r.said.at(-1)
  assert.match(line, /2 villager\(s\)/); assert.match(line, /1 farmer/); assert.match(line, /1 out of sight/); assert.match(line, /1 baby/)
  assert.doesNotMatch(line, /librarian/, 'unseen profession must not leak')
  didNotChangeWorld(r.bot)
})

test('trade for mending: buys the cheapest acceptable offer, records the ledger, changes nothing in the world', async () => {
  const r = rig({ inv: { emerald: 64, book: 2 } })
  r.bot.addVillager(mendingLibrarian())
  assert.equal(r.say('trade for mending'), true)
  await idle(r)
  assert.equal(inv(r.bot, 'enchanted_book'), 1); assert.equal(inv(r.bot, 'emerald'), 42); assert.equal(inv(r.bot, 'book'), 1)
  assert.match(r.said.at(-1), /Bought mending book for 22 emeralds \+ 1 book from the librarian/)
  assert.equal(r.handle.state.ledger.length, 1); assert.equal(r.handle.state.totals.spent, 22)
  assert.equal(r.bot._lastWin.closed, true, 'window closed')
  didNotChangeWorld(r.bot)
  const saved = JSON.parse(require('fs').readFileSync(r.file, 'utf8'))
  assert.equal(saved.ledger[0].emeralds, 22)
  assert.ok(saved.villagers[7].offers.length === 3)
  const again = r.reload()
  assert.equal(again.state.totals.spent, 22, 'state survives a restart')
})

test('trade for mending: over the price cap or missing inputs -> no purchase, honest reason', async () => {
  const r = rig({ inv: { emerald: 200, book: 1 } })
  r.bot.addVillager(mendingLibrarian(70))
  r.say('trade for mending'); await idle(r)
  assert.equal(inv(r.bot, 'enchanted_book'), 0); assert.equal(inv(r.bot, 'emerald'), 200)
  assert.match(r.said.at(-1), /70 emeralds is over my limit of 64/)
  const r2 = rig({ inv: { emerald: 10 } })
  r2.bot.addVillager(mendingLibrarian())
  r2.say('trade for mending'); await idle(r2)
  assert.match(r2.said.at(-1), /need 22 emerald and have 10|need 1 book/)
})

test('trade for X: unknown words, no villagers, nitwits ignored', async () => {
  const r = rig({ inv: { emerald: 50 } })
  r.say('trade for flibbertigibbet')
  assert.match(r.said.at(-1), /do not know what/)
  r.say('trade for mending'); await idle(r)
  assert.match(r.said.at(-1), /do not know any villager with a job/)
  r.bot.addVillager({ id: 9, at: [3.5, 64, 0.5], profession: 'nitwit', trades: [T.book('mending', 1, 5)] })
  r.say('trade for mending'); await idle(r)
  assert.equal(r.bot.windowsOpened.length, 0)
})

test('no line of sight: never opens the trade window, says why', async () => {
  const r = rig({ inv: { emerald: 64, book: 1 } })
  r.bot.addVillager(mendingLibrarian())
  r.say('find villagers')                      // seen once, so it is a known villager...
  // ...then walled in (a stone cage two blocks wide around the villager (sides and roof): every spot we can reach is blocked
  for (let x = 1; x <= 6; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 66; y++) {
    const inside = x >= 3 && x <= 4 && z >= 0 && z <= 0 && y <= 65
    if (!inside) r.bot.setBlock(x, y, z, 'stone')
  }
  r.bot.setBlock(2, 64, 0, 'air')
  r.arrive.arrive = (pos) => new Vec3(pos.x - 1.5, pos.y, pos.z)       // standing in the cage's open front... which the roof/sides still block
  r.bot.setBlock(2, 65, 0, 'stone'); r.bot.setBlock(2, 64, 0, 'stone')
  r.say('trade for mending'); await idle(r)
  assert.equal(r.bot.windowsOpened.length, 0)
  assert.equal(r.bot.losBreaches.length, 0, 'never even tried to open it through a wall')
  assert.equal(inv(r.bot, 'enchanted_book'), 0)
  assert.match(r.said.at(-1), /no clear line of sight/)
})

test('sell crops: sells the surplus to a farmer, keeps a reserve, earns emeralds', async () => {
  const r = rig({ inv: { carrot: 100, wheat: 10 } })
  r.bot.addVillager({ id: 4, at: [3.5, 64, 0.5], profession: 'farmer', trades: [T.sell('wheat', 20), T.sell('carrot', 22), T.sell('potato', 26)] })
  r.say('sell my extra carrots'); await idle(r)
  assert.equal(inv(r.bot, 'emerald'), 3); assert.equal(inv(r.bot, 'carrot'), 34); assert.equal(inv(r.bot, 'wheat'), 10)
  assert.match(r.said.at(-1), /Sold 66 carrot for 3 emeralds/)
  assert.equal(r.handle.state.totals.earned, 3)
  didNotChangeWorld(r.bot)
})

test('sell crops: nothing spare -> says so, walks nowhere', async () => {
  const r = rig({ inv: { carrot: 10 } })
  r.bot.addVillager({ id: 4, at: [3.5, 64, 0.5], profession: 'farmer', trades: [T.sell('carrot', 22)] })
  r.say('sell crops'); await idle(r)
  assert.match(r.said.at(-1), /no spare crops/)
  assert.equal(r.bot.windowsOpened.length, 0)
})

test('a hostile nearby stops the shopping trip', async () => {
  const r = rig({ inv: { emerald: 64, book: 1 } })
  r.bot.addVillager(mendingLibrarian())
  r.bot.entities[50] = { id: 50, name: 'zombie', position: new Vec3(4, 64, 3), height: 1.95 }
  r.say('trade for mending'); await idle(r)
  assert.equal(inv(r.bot, 'enchanted_book'), 0)
  assert.match(r.said.at(-1), /zombie is near/)
})

test('plan approval: only Walter, only the design flag; nothing is built', () => {
  const r = rig()
  r.handle.onChat('SomeoneElse', 'approve villager plan')
  assert.equal(r.handle.state.plan.designApproved, false)
  r.handle.onChat('OGWO', 'approve villager plan')
  assert.equal(r.handle.state.plan.designApproved, true); assert.equal(r.handle.state.plan.layoutApproved, false)
  r.say('villager plan'); assert.match(r.said.at(-1), /design OK/)
  didNotChangeWorld(r.bot)
})

test('villager status mentions known deals and emerald totals', async () => {
  const r = rig({ inv: { emerald: 64, book: 1 } })
  r.bot.addVillager(mendingLibrarian())
  r.say('find villagers'); r.say('trade for mending'); await idle(r)
  r.say('villager status')
  assert.match(r.said.at(-1), /Villagers: 1 known, 1 with a job.*spent 22/)
})

test('upkeep routine is off until switched on, and it never buys', async () => {
  const r = rig({ inv: { emerald: 64, book: 1 } })
  r.bot.addVillager(mendingLibrarian())
  assert.equal(r.scheduler.isEnabled('villager-upkeep'), false)
  r.say('villager upkeep on')
  assert.equal(r.scheduler.isEnabled('villager-upkeep'), true)
  await r.handle.trader.refreshOffers({ checkpoint() {}, sleep: async () => {}, onAbort: () => () => {}, progress() {} }, { max: 3 })
  assert.equal(inv(r.bot, 'emerald'), 64)
  assert.equal(r.handle.state.villagers[7].offers.length, 3)
  r.say('villager upkeep off'); assert.equal(r.scheduler.isEnabled('villager-upkeep'), false)
})
