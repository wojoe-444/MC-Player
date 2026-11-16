// Work order step-discard: the discard step places and opens the junk chest from wherever the bot happens to stand. A chest farther off than the
// server's reach is refused, and an open that never gets an answer is waited on with nothing to stop it, so the step idles. This file runs the
// step (brain/autopilot/discard.js) against a small fake room: the fake bot reaches 4.5 blocks, and a farther place or open is refused.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const makeDiscard = require('../brain/autopilot/discard')

const REACH = 4.5
const HUNG = Symbol('still waiting')
const key = (c) => `${c.x},${c.y},${c.z}`
const within = (p, ms) => { let t; return Promise.race([p, new Promise(res => { t = setTimeout(() => res(HUNG), ms) })]).finally(() => clearTimeout(t)) }

// a storage room as storage.js plans it: slices k = 3..9 along x from the entrance at (3, 40, 0), cells j = -2..2 across z, two air cells high,
// a stone floor under each cell from slice floorFrom on
function world({ bag = {}, junkAt = null, floorFrom = 3, neverOpens = false } = {}) {
  const typeOf = (n) => n.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100000
  const inv = Object.entries(bag).map(([name, count]) => ({ name, count, type: typeOf(name) }))
  // the bag hands out copies, as a read of the inventory does: the step reads an item's count after its deposit, so a deposit must not change that object
  const bot = { entity: { position: new Vec3(3, 40, 0) }, inventory: { items: () => inv.map(i => ({ ...i })) } }
  const dist = (p) => bot.entity.position.distanceTo(p)
  const s = new Vec3(0, 40, 0), at = (k, j, h = 0) => s.offset(k, h, j)
  const blocks = new Map(), store = new Map(), gotos = [], opened = [], notes = []
  const put = (c, name, bb) => blocks.set(key(c), { name, boundingBox: bb, position: c })
  const putChest = (c) => { put(c, 'chest', 'block'); store.set(key(c), []) }
  for (let k = 3; k < 10; k++) for (let j = -2; j <= 2; j++) { if (k >= floorFrom) put(at(k, j, -1), 'stone', 'block'); put(at(k, j, 0), 'air', 'empty'); put(at(k, j, 1), 'air', 'empty') }
  const P = { at, chestSpots: [[at(4, 2), at(5, 2)], [at(4, -2), at(5, -2)], [at(7, 2), at(8, 2)], [at(7, -2), at(8, -2)]], torches: [at(3, 0), at(6, 0), at(9, 0)] }
  const room = { id: 'storage-1', type: 'storage', shaft: 's1', chests: [], reset: null, junk: junkAt ? [...junkAt] : null }
  if (junkAt) putChest(new Vec3(...junkAt))
  const countOf = (n) => inv.filter(i => i.name === n).reduce((a, i) => a + i.count, 0)
  const take = (name, n) => { const e = inv.find(i => i.name === name); e.count -= n; if (e.count <= 0) inv.splice(inv.indexOf(e), 1) }
  bot.openContainer = async (b) => {
    if (neverOpens) return new Promise(() => {})      // the server answers nothing
    const d = dist(b.position)
    if (d > REACH) throw new Error('too far to open ' + key(b.position))
    const list = store.get(key(b.position)); if (!list) throw new Error('no container')
    opened.push(d)
    return {
      containerItems: () => list.map(i => ({ ...i })), close() {},
      deposit: async (type, _m, n) => {
        const it = inv.find(i => i.type === type); if (!it) throw new Error('nothing to deposit')
        take(it.name, n); const e = list.find(i => i.name === it.name); if (e) e.count += n; else list.push({ name: it.name, count: n, type })
      }
    }
  }
  const S = {
    bot,
    goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    v: (x, y, z) => new Vec3(x, y, z),
    block: (c) => blocks.get(key(c)) || null,
    isLiquid: () => false, isNight: () => false,
    has: (n) => countOf(n) > 0, count: countOf,
    craft: async () => false,
    dist,
    // a walk ends where the goal says, two blocks short of a GoalNear(x, y, z, 2)
    goto: async (goal) => { gotos.push([goal.x, goal.y, goal.z]); bot.entity.position = new Vec3(goal.x, goal.y, goal.z - (goal.r || 0)); return { ok: true } },
    placeAgainst: async (g, dir, name) => {
      if (!g || !g.position || name !== 'chest' || countOf('chest') < 1) return false
      const c = g.position.plus(dir); if (dist(c) > REACH) return false
      take('chest', 1); putChest(c); return true
    },
  }
  const G = { state: {}, note: (m) => notes.push(m), storageRoom: () => room, storagePlan: () => P, storageGo: async () => true, storageClearAbove: async () => true }
  const M = { LD: { putRoom: () => {} } }
  const step = makeDiscard(G, S, M, {}, () => {})
  return { step, room, bot, gotos, opened, notes, inv, countOf, chestAt: (c) => store.get(key(c)) || null }
}

const BAG = { chest: 1, wooden_pickaxe: 1, stone_pickaxe: 1 }

test('discard: an existing junk chest six blocks off is walked to before it is opened (the open was refused from the entrance, and the spot struck)', async () => {
  const w = world({ bag: BAG, junkAt: [8, 40, 1] })
  assert.strictEqual(await w.step.run(), true, 'the wooden pickaxe went into the junk chest: ' + w.notes.join(' | '))
  assert.strictEqual(w.countOf('wooden_pickaxe'), 0)
  assert.strictEqual(w.chestAt(new Vec3(8, 40, 1)).find(i => i.name === 'wooden_pickaxe').count, 1)
  assert.ok(w.opened.length === 1 && w.opened[0] <= REACH, 'opened from within reach: ' + w.opened.join(','))
  assert.strictEqual(w.room.junk && w.room.junk.join(), '8,40,1', 'the junk chest stays on the record, not struck out')
})

test('discard: the junk chest is placed within reach too (the near cells taken, the first open spot is six blocks in)', async () => {
  const w = world({ bag: BAG, floorFrom: 8 })
  assert.strictEqual(await w.step.run(), true, w.notes.join(' | '))
  assert.strictEqual(w.room.junk && w.room.junk.join(), '8,40,1', 'the first open spot of the room: ' + JSON.stringify(w.room.junk))
  assert.strictEqual(w.countOf('wooden_pickaxe'), 0)
})

test('discard: a chest that never answers the open ends the run as a failure in a few seconds, not a stall', async () => {
  const w = world({ bag: BAG, junkAt: [3, 40, 2], neverOpens: true })
  const r = await within(w.step.run(), 15000)
  assert.notStrictEqual(r, HUNG, 'the run was still waiting on the open after 15 s: the step idles and never reaches its time budget')
  assert.strictEqual(r, false)
  assert.ok(w.notes.some(m => /would not open/.test(m)), w.notes.join(' | '))
})
