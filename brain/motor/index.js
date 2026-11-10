// @ts-check
// brain/motor: one body (docs/HILLCLIMB-INSIGHTS.md, item 7). The verbs the bot physically does, implemented ONCE, each returning a typed Outcome instead of
// true/false/throw, so a refusal can be counted, explained and told apart from "no path". First verbs: equip (mints a Held proof), place, and the
// jump-and-place-under-the-feet step that five copies of pillar code used to carry (nav/reach.js, build, excavation, treefarm, autopilot).
//
// Rules for callers: never call bot.placeBlock / bot.equip to climb or scaffold; call these. Everything here is tick driven (no setTimeout in the happy path).
//
// @typedef {{ ok: true, value: any, note?: string }} Ok
// @typedef {{ ok: false, by: 'server' | 'rule' | 'precondition' | 'body' | 'aborted', reason: string, retry: boolean, detail?: any }} Refused
// @typedef {Ok | Refused} Outcome
// @typedef {{ name: string, slot: number, epoch: number }} Held   a proof that the server-confirmed hand holds `name`; void on any slot change (see heldValid)
const { Vec3 } = require('vec3')

/** @returns {Ok} */
const ok = (value, note) => ({ ok: true, value, ...(note ? { note } : {}) })
/** @returns {Refused} */
const refused = (by, reason, retry = false, detail) => ({ ok: false, by, reason, retry, ...(detail !== undefined ? { detail } : {}) })
const isOutcome = (o) => !!o && typeof o === 'object' && typeof o.ok === 'boolean'

// ---- per-bot motor state: the hand epoch bumps whenever the selected slot or its contents change, which voids every Held minted before ----
function state(bot) {
  if (bot._motor) return bot._motor
  const st = bot._motor = { epoch: 0, refusals: {} }
  const bump = () => { st.epoch++ }
  try { bot.on('heldItemChanged', bump) } catch { /* mock */ }
  try { bot.inventory.on('updateSlot', (/** @type {number} */ slot) => { try { if (slot === 36 + bot.quickBarSlot) bump() } catch { /* ignore */ } }) } catch { /* mock */ }
  return st
}
function count(bot, reason) { const st = state(bot); st.refusals[reason] = (st.refusals[reason] || 0) + 1 }

/** the next physics tick (or after fallbackMs when nothing emits ticks, as in the mock rigs) */
function tick(bot, fallbackMs = 100) {
  return new Promise((resolve) => {
    let done = false
    const fin = () => { if (done) return; done = true; clearTimeout(t); bot.removeListener('physicsTick', fin); resolve(undefined) }
    const t = setTimeout(fin, fallbackMs)
    bot.once('physicsTick', fin)
  })
}

/** @param {any} bot @param {any} held @returns {boolean} */
function heldValid(bot, held) {
  if (!held) return false
  const st = state(bot)
  return st.epoch === held.epoch && !!bot.heldItem && bot.heldItem.name === held.name && bot.quickBarSlot === held.slot
}

/**
 * Put `item` (an Item or a name) in the hand. Returns Ok(Held) only when the bot's hand really shows it afterwards.
 * @param {any} bot @param {any} itemOrName @returns {Promise<Outcome>}
 */
async function equip(bot, itemOrName) {
  const name = typeof itemOrName === 'string' ? itemOrName : itemOrName && itemOrName.name
  if (!name) return refused('precondition', 'no item to hold')
  const item = typeof itemOrName === 'object' ? itemOrName : bot.inventory.items().find((/** @type {any} */ i) => i.name === name)
  if (!item) { count(bot, 'equip:not-in-bag'); return refused('precondition', `no ${name} in the bag`) }
  try { if (!bot.heldItem || bot.heldItem.name !== name) await bot.equip(item, 'hand') } catch (e) { count(bot, 'equip:server'); return refused('server', `equip ${name}: ${(/** @type {any} */ (e)).message}`, true) }
  if (!bot.heldItem || bot.heldItem.name !== name) { count(bot, 'equip:not-held'); return refused('body', `not holding ${name} after equip (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'})`, true) }
  const st = state(bot)
  return ok({ name, slot: bot.quickBarSlot, epoch: st.epoch })
}

/**
 * Place against the face `face` of block `ref` with the head turned at once (mineflayer's own look is not forced and takes up to 21 ticks).
 * With `held`, refuses (before sending anything) when the Held proof no longer matches the hand.
 * @param {any} bot @param {any} ref @param {Vec3} face @param {{ held?: Held, swingArm?: string }} [o] @returns {Promise<Outcome>}
 */
async function place(bot, ref, face, o = {}) {
  if (o.held && !heldValid(bot, o.held)) { count(bot, 'place:hand-changed'); return refused('body', 'the hand changed since it was confirmed', true) }
  try {
    if (typeof bot._placeBlockWithOptions === 'function') await bot._placeBlockWithOptions(ref, face, { forceLook: true, swingArm: o.swingArm || 'right' })
    else await bot.placeBlock(ref, face)
    return ok(true)
  } catch (/** @type {any} */ e) {
    if (e && e.name === 'AbortError') return refused('aborted', 'aborted', false)
    count(bot, 'place:server')
    return refused('server', String(e && e.message || e).slice(0, 120), true)
  }
}

/**
 * Jump and put a block under the feet at the top of the jump: the one implementation of "pillar one block up". The caller has checked headroom, chosen the
 * block and (if needed) cleared the feet cell. Up to `jumps` jumps; a refusal costs one jump, not the whole climb.
 * @param {any} bot
 * @param {{ ref: any, feetY: number, held: Held, reequip?: () => Promise<Outcome>, jumps?: number, minRise?: number, tick?: () => Promise<any>, stopped?: () => boolean, checkpoint?: () => void, log?: (s: string) => void, onGroundWait?: number }} o
 *   ref: the block under the feet (placed against its top face); feetY: the y of the feet cell at the start
 * @returns {Promise<Outcome>}  Ok({ refusals, tries }) when a block went in and the bot is one block higher; Refused otherwise
 */
async function jumpPlaceUnder(bot, o) {
  const log = o.log || (() => {})
  const wait = o.tick || (() => tick(bot))
  const stopped = o.stopped || (() => false)
  const minRise = o.minRise ?? 1.1, jumps = o.jumps ?? 3
  const attempts = []
  let held = o.held, placed = false, refusals = 0, lastWhy = 'no attempt', lastBy = 'server', thrownByCaller = null
  try {
    try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch { /* looking down is best effort; the forced look in place() aims again */ }
    for (let jump = 0; jump < jumps && !placed && !stopped(); jump++) {
      if (jump) { bot.setControlState('jump', false); for (let i = 0; i < 4; i++) await wait(); if (Math.floor(bot.entity.position.y + 1e-6) !== o.feetY) break }
      // from the ground only: a jump started while still dropping onto the last block puts the place on the way down (server a tick behind)
      for (let w = 0; w < 20 && !bot.entity.onGround && !stopped(); w++) await wait()
      bot.setControlState('jump', true)
      for (let i = 0; i < 40 && !placed && !stopped(); i++) {
        await wait()
        if (o.checkpoint) { try { o.checkpoint() } catch (e) { thrownByCaller = e; throw e } }
        const p = bot.entity.position, vy = bot.entity.velocity ? bot.entity.velocity.y : 0
        // near the top of the jump, never on the way down; one more tick first so the server has the position that puts the feet above the cell
        if (p.y >= o.feetY + minRise && vy > -0.05) {
          await wait()
          if (bot.entity.position.y < o.feetY + minRise || (bot.entity.velocity ? bot.entity.velocity.y : 0) < -0.1) continue
          const at = { tick: i, dy: +(bot.entity.position.y - o.feetY).toFixed(3), vy: +(bot.entity.velocity ? bot.entity.velocity.y : 0).toFixed(3), held: bot.heldItem ? bot.heldItem.name : null, slot: bot.quickBarSlot, jump }
          if (!heldValid(bot, held) && o.reequip) { const r = await o.reequip(); if (r.ok) held = r.value }
          const r = await place(bot, o.ref, new Vec3(0, 1, 0), { held })
          if (r.ok) { placed = true; attempts.push({ ...at, ok: true }); log('pillar ok ' + JSON.stringify(at)) } else {
            refusals++; lastWhy = r.reason; lastBy = r.by; attempts.push({ ...at, ok: false, why: r.reason }); count(bot, 'pillar:refused')
            let srv = null
            try { if (typeof bot._syncWindow === 'function') bot._syncWindow(bot.inventory).catch(() => {}); for (let k = 0; k < 6; k++) await wait(); srv = { held: bot.heldItem ? bot.heldItem.name : null, slot: bot.quickBarSlot } } catch { /* ignore */ }
            log('pillar FAIL ' + JSON.stringify(at) + ' -> ' + r.reason.slice(0, 90) + ' | server ' + JSON.stringify(srv))
            break
          }
        }
      }
    }
    if (placed && refusals) log('pillar ok after ' + refusals + ' refusal(s)')
  } catch (/** @type {any} */ e) {
    if (e === thrownByCaller || (e && e.name === 'AbortError')) throw e
    log('pillar: ' + (e && e.message)); return refused('body', String(e && e.message || e), false)
  } finally { bot.setControlState('jump', false) }
  for (let i = 0; i < 6; i++) await wait()                                      // land on the new block
  if (!placed) return refused(stopped() ? 'aborted' : lastBy, lastWhy, !stopped(), { attempts })
  if (bot.entity.position.y < o.feetY + 0.9) return refused('body', 'placed, but did not end up one block higher', true, { attempts })
  return ok({ refusals, attempts })
}

module.exports = { ok, refused, isOutcome, equip, place, heldValid, tick, jumpPlaceUnder, state }
