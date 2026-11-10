// brain/gate: the packet boundary. A fake client records what really leaves; the gate must log violations with their call site, pass packets through in
// log mode, drop them in enforce mode, and never throw into the caller.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.6')
const { install, callSites } = require('../brain/gate')

const id = (n) => mcData.itemsByName[n].id
const item = (name, count = 1) => ({ name, count, type: id(name) })
const slotItem = (name) => ({ itemCount: 1, itemId: id(name) })

function rig({ mode = 'log', held = null, inv = [], blocks = {}, armorAllowed = false, rules = null } = {}) {
  const sent = []
  const bot = { registry: mcData, heldItem: held ? item(held) : null, _client: { write: (name, params) => { sent.push([name, params]); return 'ok' } } }
  bot.inventory = { slots: [], items: () => inv.map(n => item(n)) }
  for (const n of inv) bot.inventory.slots.push(item(n))
  bot.blockAt = (p) => { const n = blocks[`${p.x},${p.y},${p.z}`]; return n ? { name: n, position: new Vec3(p.x, p.y, p.z), harvestTools: mcData.blocksByName[n].harvestTools } : { name: 'air', position: new Vec3(p.x, p.y, p.z) } }
  const logs = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'))
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brain', 'gate', 'rules.json'), 'utf8')).rules
  for (const r of Object.values(all)) r.mode = mode
  const gate = install(bot, { rules: rules || all, stateDir: dir, log: (l) => logs.push(l), armorAllowed: () => armorAllowed, now: (() => { let t = 1000; return () => (t += 5000) })() })
  return { bot, gate, sent, logs, dir }
}

test('rules.json parses and every rule names the packets it watches', () => {
  const r = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brain', 'gate', 'rules.json'), 'utf8'))
  assert.ok(r.rules.noArmor && r.rules.minToolTier && r.rules.lavaWalk && r.rules.torchSpacing && r.rules.chatRate)
  for (const [k, v] of Object.entries(r.rules)) assert.ok(['off', 'log', 'enforce'].includes(v.mode) && Array.isArray(v.packets) && v.packets.length, k)
})

test('log mode: an armor click goes out unchanged and is recorded with the call site that wrote it', () => {
  const r = rig({ inv: ['iron_chestplate'] })
  function strayArmorClick() { return r.bot._client.write('window_click', { windowId: 0, stateId: 1, slot: 6, mouseButton: 0, mode: 0, changedSlots: [{ location: 6, item: slotItem('iron_chestplate') }], cursorItem: {} }) }
  assert.strictEqual(strayArmorClick(), 'ok')
  assert.strictEqual(r.sent.length, 1)
  const s = r.gate.summary().rules.noArmor
  assert.strictEqual(s.violations, 1); assert.strictEqual(s.blocked, 0)
  assert.ok(Object.keys(s.sites)[0].startsWith('test/gate.test.js:'), JSON.stringify(s.sites))
  assert.match(r.logs[0], /noArmor.*iron_chestplate placed into armor slot 6/)
  r.gate.flush()
  const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'gate-log.json'), 'utf8'))
  assert.strictEqual(saved.rules.noArmor.violations, 1); assert.strictEqual(saved.recent[0].rule, 'noArmor')
})

test('enforce mode: the armor packet is dropped (not written), flagged blocked; ALLOW_ARMOR lifts the rule', () => {
  const r = rig({ mode: 'enforce', inv: ['iron_boots'] })
  assert.strictEqual(r.bot._client.write('window_click', { windowId: 0, slot: 8, mode: 0, changedSlots: [{ location: 8, item: slotItem('iron_boots') }] }), undefined)
  assert.strictEqual(r.sent.length, 0); assert.strictEqual(r.gate.summary().rules.noArmor.blocked, 1)
  const ok = rig({ mode: 'enforce', inv: ['iron_boots'], armorAllowed: true })
  ok.bot._client.write('window_click', { windowId: 0, slot: 8, mode: 0, changedSlots: [{ location: 8, item: slotItem('iron_boots') }] })
  assert.strictEqual(ok.sent.length, 1); assert.strictEqual(ok.gate.summary().rules.noArmor.violations, 0)
})

test('armor by shift-click, hotbar swap and right-click in hand is caught; ordinary clicks and items are not', () => {
  const r = rig({ held: 'iron_helmet', inv: ['iron_leggings', 'stone_pickaxe'] })
  r.bot.inventory.slots.length = 0; r.bot.inventory.slots[9] = item('iron_leggings'); r.bot.inventory.slots[10] = item('stone_pickaxe')
  r.bot._client.write('window_click', { windowId: 0, slot: 9, mode: 1, mouseButton: 0, changedSlots: [] })            // shift-click of the leggings (slot 9)
  r.bot._client.write('use_item', { hand: 0, sequence: 1 })                                                         // helmet in the main hand
  const n = r.gate.summary().rules.noArmor.violations
  assert.strictEqual(n, 2, JSON.stringify(r.gate.recent().map(e => e.why)))
  r.bot._client.write('window_click', { windowId: 0, slot: 10, mode: 1, mouseButton: 0, changedSlots: [] })           // the pickaxe: fine
  r.bot._client.write('window_click', { windowId: 0, slot: 20, mode: 0, mouseButton: 0, changedSlots: [{ location: 20, item: slotItem('cobblestone') }] })
  r.bot._client.write('window_click', { windowId: 3, slot: 6, mode: 0, mouseButton: 0, changedSlots: [{ location: 6, item: slotItem('iron_helmet') }] })   // another window: not the player inventory
  assert.strictEqual(r.gate.summary().rules.noArmor.violations, 2)
})

test('minToolTier: an iron pickaxe on stone with a stone pickaxe in the bag is flagged; iron ore with only iron is fine; diamond needs iron', () => {
  const r = rig({ held: 'iron_pickaxe', inv: ['iron_pickaxe', 'stone_pickaxe'], blocks: { '0,60,0': 'stone', '1,60,0': 'diamond_ore', '2,60,0': 'iron_ore' } })
  const dig = (x) => r.bot._client.write('block_dig', { status: 0, location: { x, y: 60, z: 0 }, face: 1, sequence: 1 })
  dig(0); assert.strictEqual(r.gate.summary().rules.minToolTier.violations, 1)
  dig(1); assert.strictEqual(r.gate.summary().rules.minToolTier.violations, 1, 'diamond needs iron')
  dig(2); assert.strictEqual(r.gate.summary().rules.minToolTier.violations, 2, 'iron ore only needs stone')
  const only = rig({ held: 'iron_pickaxe', inv: ['iron_pickaxe'], blocks: { '0,60,0': 'stone' } })
  only.bot._client.write('block_dig', { status: 0, location: { x: 0, y: 60, z: 0 }, face: 1 })
  assert.strictEqual(only.gate.summary().rules.minToolTier.violations, 0, 'no smaller tool to use')
  const stone = rig({ held: 'stone_pickaxe', inv: ['stone_pickaxe'], blocks: { '0,60,0': 'stone' } })
  stone.bot._client.write('block_dig', { status: 0, location: { x: 0, y: 60, z: 0 }, face: 1 })
  assert.strictEqual(stone.gate.summary().rules.minToolTier.violations, 0)
  r.bot._client.write('block_dig', { status: 2, location: { x: 0, y: 60, z: 0 }, face: 1 })                          // finish packets are not counted twice
  assert.strictEqual(r.gate.summary().rules.minToolTier.violations, 2)
})

test('lavaWalk: position packets with a lava bucket selected', () => {
  const r = rig({ held: 'lava_bucket' })
  r.bot._client.write('position', { x: 1, y: 64, z: 1, onGround: true })
  assert.strictEqual(r.gate.summary().rules.lavaWalk.violations, 1)
  const ok = rig({ held: 'stone_sword' }); ok.bot._client.write('position', { x: 1, y: 64, z: 1, onGround: true })
  assert.strictEqual(ok.gate.summary().rules.lavaWalk.violations, 0)
})

test('torchSpacing: a torch placed within 2 cells of another is flagged, 3 apart is fine', () => {
  // place against the top face (direction 1) of the block at (0,59,0): the torch cell is (0,60,0)
  const r = rig({ held: 'torch', blocks: { '2,60,0': 'torch', '5,60,0': 'torch' } })
  r.bot._client.write('block_place', { hand: 0, location: { x: 0, y: 59, z: 0 }, direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5 })
  assert.strictEqual(r.gate.summary().rules.torchSpacing.violations, 1)
  const far = rig({ held: 'torch', blocks: { '3,60,0': 'torch' } })
  far.bot._client.write('block_place', { hand: 0, location: { x: 0, y: 59, z: 0 }, direction: 1 })
  assert.strictEqual(far.gate.summary().rules.torchSpacing.violations, 0)
  const notTorch = rig({ held: 'cobblestone', blocks: { '1,60,0': 'torch' } })
  notTorch.bot._client.write('block_place', { hand: 0, location: { x: 0, y: 59, z: 0 }, direction: 1 })
  assert.strictEqual(notTorch.gate.summary().rules.torchSpacing.violations, 0)
})

test('chatRate: lines under a second apart and an immediate repeat are flagged (the fake clock moves 5 s per call, so build the gap by hand)', () => {
  let t = 0
  const bot = { registry: mcData, heldItem: null, inventory: { slots: [], items: () => [] }, blockAt: () => null, _client: { write: () => 'ok' } }
  const gate = install(bot, { rules: { chatRate: { mode: 'log', minGapMs: 1000, repeatWindowMs: 60000, packets: ['chat_message'] } }, logFile: null, now: () => t, log: () => {} })
  t = 5000; bot._client.write('chat_message', { message: 'hello' })
  t = 5400; bot._client.write('chat_message', { message: 'again' })                    // 400 ms after the last
  t = 9000; bot._client.write('chat_message', { message: 'hello' })                    // repeat within a minute
  t = 20000; bot._client.write('chat_message', { message: 'something new' })           // fine
  assert.strictEqual(gate.summary().rules.chatRate.violations, 2)
})

test('a throwing check never reaches the caller and the packet still goes out; uninstall restores write', () => {
  const r = rig({ rules: { lavaWalk: { mode: 'enforce', packets: ['position'] } } })
  Object.defineProperty(r.bot, 'heldItem', { get() { throw new Error('boom') } })     // the check throws
  assert.strictEqual(r.bot._client.write('position', { x: 1, y: 2, z: 3 }), 'ok')
  assert.ok(r.logs.some(l => /lavaWalk failed once/.test(l)))
  const orig = r.sent.length
  r.gate.uninstall(); r.bot._client.write('position', { x: 1, y: 2, z: 3 })
  assert.strictEqual(r.sent.length, orig + 1)
})

test('setMode switches a rule at runtime; callSites keeps repo frames only', () => {
  const r = rig({ inv: ['iron_boots'] })
  assert.ok(r.gate.setMode('noArmor', 'enforce'))
  assert.strictEqual(r.bot._client.write('window_click', { windowId: 0, slot: 8, changedSlots: [{ location: 8, item: slotItem('iron_boots') }] }), undefined)
  assert.strictEqual(r.gate.setMode('nope', 'log'), false)
  const sites = callSites('Error\n    at x (/repo/node_modules/mineflayer/a.js:1:1)\n    at y (/repo/brain/safety/loadout.js:61:20)\n    at node:internal/foo:1:1\n    at /repo/join.js:15:3', '/repo')
  assert.deepStrictEqual(sites, ['brain/safety/loadout.js:61', 'join.js:15'])
})

test('permit: a dig or place with no job running is flagged with its owner; a running job, an explicit permit, torches and dig-finish packets are not', () => {
  const r = rig({ held: 'stone' })
  let owner = null; r.gate.setOwner(() => owner)
  const dig = () => r.bot._client.write('block_dig', { status: 0, location: { x: 1, y: 2, z: 3 }, face: 1 })
  const place = () => r.bot._client.write('block_place', { hand: 0, location: { x: 1, y: 2, z: 3 }, direction: 1 })
  dig(); place()
  assert.strictEqual(r.gate.summary().rules.permit.violations, 2)
  assert.strictEqual(r.gate.recent()[0].owner, null); assert.match(r.logs[0], /permit.*dig with no job/)
  owner = 'mining'; dig(); place()                                    // a job holds the body
  assert.strictEqual(r.gate.summary().rules.permit.violations, 2)
  owner = 'nav'; dig()                                                // walking is not a job that may dig
  assert.strictEqual(r.gate.summary().rules.permit.violations, 3); assert.strictEqual(r.gate.recent().pop().owner, 'nav')
  const p = r.gate.permit('dig', 'out of a buried head', 5000)
  dig(); assert.strictEqual(r.gate.summary().rules.permit.violations, 3)
  place(); assert.strictEqual(r.gate.summary().rules.permit.violations, 4)   // a dig permit does not cover placing
  p.release(); dig(); assert.strictEqual(r.gate.summary().rules.permit.violations, 5)
  r.bot._client.write('block_dig', { status: 2, location: { x: 1, y: 2, z: 3 }, face: 1 })   // finishing the dig is not a new one
  assert.strictEqual(r.gate.summary().rules.permit.violations, 5)
  r.bot.heldItem = item('torch'); place(); assert.strictEqual(r.gate.summary().rules.permit.violations, 5)
  assert.strictEqual(r.sent.length, 10)                                // log mode drops nothing
})

test('permit expires by itself; enforce mode drops an unpermitted dig', () => {
  const r = rig({ mode: 'enforce', held: 'stone' })
  const p = r.gate.permit('any', 'test', 100)                         // the fake clock moves 5 s per call: it is gone by the next packet
  assert.strictEqual(r.bot._client.write('block_dig', { status: 0, location: { x: 0, y: 0, z: 0 }, face: 1 }), undefined)
  assert.strictEqual(r.sent.length, 0); assert.strictEqual(r.gate.summary().rules.permit.blocked, 1); p.release()
})

test('chatRate in enforce mode: a dropped line does not reset the gap, so the next line one second later gets through', () => {
  let t = 100000
  const sent = []
  const bot = { registry: mcData, heldItem: null, _client: { write: (n, p) => { sent.push(p.message); return 'ok' } }, inventory: { slots: [], items: () => [] }, blockAt: () => null }
  install(bot, { rules: { chatRate: { mode: 'enforce', minGapMs: 1000, repeatWindowMs: 60000, packets: ['chat_message'] } }, logFile: null, now: () => t })
  const say = (m, dt) => { t += dt; bot._client.write('chat_message', { message: m }) }
  say('a', 0); say('b', 400); say('c', 400); say('d', 400)           // b and c are under a second after the last LET THROUGH line; d is 1200 ms after a
  assert.deepStrictEqual(sent, ['a', 'd'])
})

test('GATE=log turns an enforced rule into log mode', () => {
  process.env.GATE = 'log'
  try {
    const r = rig({ mode: 'enforce', inv: ['iron_boots'] })
    assert.strictEqual(r.bot._client.write('window_click', { windowId: 0, slot: 8, mode: 0, changedSlots: [{ location: 8, item: slotItem('iron_boots') }] }), 'ok')
    assert.strictEqual(r.gate.summary().rules.noArmor.mode, 'log')
  } finally { delete process.env.GATE }
})

test('a dropped inventory click makes the gate ask the server for the real window (the client had already moved the item locally)', async () => {
  const r = rig({ mode: 'enforce', inv: ['iron_boots'] })
  let synced = 0; r.bot._syncWindow = async () => { synced++ }
  r.bot._client.write('window_click', { windowId: 0, slot: 8, mode: 0, changedSlots: [{ location: 8, item: slotItem('iron_boots') }] })
  await new Promise(res => setTimeout(res, 200))
  assert.strictEqual(synced, 1)
})
