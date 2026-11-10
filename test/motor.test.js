// brain/motor: Outcome, the Held proof, place with a forced look, and the one jump-and-place step on the REAL prismarine-physics (ladder-lab world).
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const motor = require('../brain/motor')
const { makeLab } = require('../tools/ladderlab/world')
const H = require('./nav.helpers')

function fakeBot(items = [{ name: 'dirt', count: 10 }]) {
  const bot = new EventEmitter()
  bot.heldItem = null; bot.quickBarSlot = 0
  bot.inventory = Object.assign(new EventEmitter(), { items: () => items })
  bot.equip = async (it) => { bot.heldItem = it; bot.emit('heldItemChanged', it) }
  bot.placed = []
  bot.placeBlock = async (ref, face) => { bot.placed.push(['placeBlock', ref, face]) }
  return bot
}

test('Outcome helpers: ok and refused have distinct shapes; isOutcome tells them from plain values', () => {
  const a = motor.ok(3, 'n'), b = motor.refused('server', 'no', true, { x: 1 })
  assert.deepStrictEqual(a, { ok: true, value: 3, note: 'n' }); assert.deepStrictEqual(b, { ok: false, by: 'server', reason: 'no', retry: true, detail: { x: 1 } })
  assert.ok(motor.isOutcome(a) && motor.isOutcome(b)); assert.ok(!motor.isOutcome(true) && !motor.isOutcome(null) && !motor.isOutcome('ok'))
})

test('equip mints a Held proof only when the hand really shows the item; a missing item is a precondition refusal, a hand that stays empty is a body refusal', async () => {
  const bot = fakeBot()
  const r = await motor.equip(bot, 'dirt'); assert.ok(r.ok); assert.strictEqual(r.value.name, 'dirt')
  assert.ok(motor.heldValid(bot, r.value))
  const none = await motor.equip(bot, 'cobblestone'); assert.strictEqual(none.ok, false); assert.strictEqual(none.by, 'precondition')
  const stuck = fakeBot(); stuck.equip = async () => {}                              // the server never changed the hand
  const s = await motor.equip(stuck, 'dirt'); assert.strictEqual(s.ok, false); assert.strictEqual(s.by, 'body'); assert.match(s.reason, /holding nothing/)
  const thrown = fakeBot(); thrown.equip = async () => { throw new Error('boom') }
  const t = await motor.equip(thrown, 'dirt'); assert.strictEqual(t.by, 'server'); assert.ok(t.retry)
  assert.ok(bot._motor.refusals['equip:not-in-bag'] === 1)
})

test('the Held proof is void after any change of the hand: another item, another slot, the same slot refilled', async () => {
  const bot = fakeBot([{ name: 'dirt', count: 10 }, { name: 'stone_sword', count: 1 }])
  const r = await motor.equip(bot, 'dirt'); assert.ok(r.ok)
  await bot.equip({ name: 'stone_sword' }); await bot.equip({ name: 'dirt' })       // sword and back: the same name is held again, but the proof is void
  assert.strictEqual(motor.heldValid(bot, r.value), false)
  const r2 = await motor.equip(bot, 'dirt'); assert.ok(motor.heldValid(bot, r2.value))
  bot.quickBarSlot = 3; assert.strictEqual(motor.heldValid(bot, r2.value), false)
  bot.quickBarSlot = 0; bot.inventory.emit('updateSlot', 36); assert.strictEqual(motor.heldValid(bot, r2.value), false, 'the held slot changed')
  assert.strictEqual(motor.heldValid(bot, null), false)
})

test('place: forced look through _placeBlockWithOptions; a Held proof that no longer matches refuses before anything is sent; server errors become refusals', async () => {
  const bot = fakeBot(); const calls = []
  bot._placeBlockWithOptions = async (ref, face, o) => { calls.push(o) }
  const h = await motor.equip(bot, 'dirt')
  assert.ok((await motor.place(bot, {}, new Vec3(0, 1, 0), { held: h.value })).ok)
  assert.deepStrictEqual(calls, [{ forceLook: true, swingArm: 'right' }])
  await bot.equip({ name: 'stone_sword' })
  const bad = await motor.place(bot, {}, new Vec3(0, 1, 0), { held: h.value }); assert.strictEqual(bad.by, 'body'); assert.strictEqual(calls.length, 1, 'nothing sent')
  bot._placeBlockWithOptions = async () => { throw new Error('Server rejected transaction') }
  const rej = await motor.place(bot, {}, new Vec3(0, 1, 0)); assert.strictEqual(rej.by, 'server'); assert.ok(rej.retry)
  bot._placeBlockWithOptions = async () => { const e = new Error('x'); e.name = 'AbortError'; throw e }
  assert.strictEqual((await motor.place(bot, {}, new Vec3(0, 1, 0))).by, 'aborted')
  const plain = fakeBot(); assert.ok((await motor.place(plain, {}, new Vec3(0, 1, 0))).ok); assert.strictEqual(plain.placed.length, 1)
})

// ---- jump and place on real physics: a 1x1 shaft with plenty of headroom, floor at y=63 ----
async function pillarRig({ refuseFirst = 0, changeHand = false } = {}) {
  const sim = makeLab({ bounds: { x0: -10, x1: 20, y0: 0, y1: 100, z0: -10, z1: 20 } })
  sim.floor(-5, -5, 15, 15, 63)
  sim.fill(3, 64, 3, 7, 80, 7, 'stone'); sim.fill(5, 64, 5, 5, 80, 5, 'air')
  const bot = sim.bot
  bot.entity.position.set(5.5, 64, 5.5)
  sim.give('dirt', 10)
  let pump = true; const loop = async () => { while (pump) { sim.tick(); await new Promise(r => setImmediate(r)) } }; loop()
  await new Promise(r => setTimeout(r, 30))
  let refused = 0
  const real = bot.placeBlock
  bot.placeBlock = async (ref, face) => { if (refused < refuseFirst) { refused++; throw new Error('Server rejected transaction') } return real(ref, face) }
  return { sim, bot, stop: () => { pump = false; sim.dispose && sim.dispose() }, refusedCount: () => refused }
}

test('jumpPlaceUnder on real physics: the block goes under the feet at the top of the jump and the bot ends one block higher', async () => {
  const r = await pillarRig(); const { bot, sim } = r
  try {
    const eq = await motor.equip(bot, 'dirt'); assert.ok(eq.ok, JSON.stringify(eq))
    const ref = bot.blockAt(new Vec3(5, 63, 5)); assert.ok(ref && ref.boundingBox === 'block')
    const logs = []
    const out = await motor.jumpPlaceUnder(bot, { ref, feetY: 64, held: eq.value, reequip: () => motor.equip(bot, 'dirt'), log: (s) => logs.push(s) })
    assert.ok(out.ok, JSON.stringify(out)); assert.strictEqual(out.value.refusals, 0)
    assert.strictEqual(bot.blockAt(new Vec3(5, 64, 5)).name, 'dirt'); assert.ok(bot.entity.position.y >= 64.9, 'y=' + bot.entity.position.y)
    assert.ok(logs.some(l => /pillar ok/.test(l)))
    assert.strictEqual(sim.count('dirt'), 9)
  } finally { r.stop() }
})

test('jumpPlaceUnder: a refused placement costs one jump, not the climb (two refusals, then the block goes in on the third jump)', async () => {
  const r = await pillarRig({ refuseFirst: 2 }); const { bot } = r
  try {
    const eq = await motor.equip(bot, 'dirt')
    const out = await motor.jumpPlaceUnder(bot, { ref: bot.blockAt(new Vec3(5, 63, 5)), feetY: 64, held: eq.value, reequip: () => motor.equip(bot, 'dirt') })
    assert.ok(out.ok, JSON.stringify(out)); assert.strictEqual(out.value.refusals, 2); assert.deepStrictEqual(out.value.attempts.map(a => a.ok), [false, false, true])
    assert.strictEqual(bot.blockAt(new Vec3(5, 64, 5)).name, 'dirt')
    assert.strictEqual(bot._motor.refusals['pillar:refused'], 2)
  } finally { r.stop() }
})

test('jumpPlaceUnder: three refusals give a typed refusal with every attempt in it; the jump key is released', async () => {
  const r = await pillarRig({ refuseFirst: 99 }); const { bot } = r
  try {
    const eq = await motor.equip(bot, 'dirt')
    const out = await motor.jumpPlaceUnder(bot, { ref: bot.blockAt(new Vec3(5, 63, 5)), feetY: 64, held: eq.value, reequip: () => motor.equip(bot, 'dirt') })
    assert.strictEqual(out.ok, false); assert.strictEqual(out.by, 'server'); assert.ok(out.retry); assert.strictEqual(out.detail.attempts.length, 3)
    assert.match(out.reason, /Server rejected/); assert.ok(!bot.controlState.jump)
  } finally { r.stop() }
})

test('jumpPlaceUnder: a hand that changed mid-climb is re-equipped; without a way to re-equip it refuses instead of jumping with the wrong item', async () => {
  const r = await pillarRig(); const { bot, sim } = r
  try {
    sim.give('stone_sword', 1)
    const eq = await motor.equip(bot, 'dirt')
    await motor.equip(bot, 'stone_sword')                                              // something else took the hand after the proof was minted
    const out = await motor.jumpPlaceUnder(bot, { ref: bot.blockAt(new Vec3(5, 63, 5)), feetY: 64, held: eq.value, reequip: () => motor.equip(bot, 'dirt') })
    assert.ok(out.ok, JSON.stringify(out)); assert.strictEqual(bot.blockAt(new Vec3(5, 64, 5)).name, 'dirt')
  } finally { r.stop() }
  const r2 = await pillarRig(); const b2 = r2.bot
  try {
    r2.sim.give('stone_sword', 1)
    const eq = await motor.equip(b2, 'dirt'); await motor.equip(b2, 'stone_sword')
    const out = await motor.jumpPlaceUnder(b2, { ref: b2.blockAt(new Vec3(5, 63, 5)), feetY: 64, held: eq.value })
    assert.strictEqual(out.ok, false); assert.strictEqual(out.by, 'body'); assert.match(out.reason, /hand changed/)
    assert.strictEqual(b2.blockAt(new Vec3(5, 64, 5)).name, 'air', 'nothing was placed with the sword in hand')
  } finally { r2.stop() }
})
