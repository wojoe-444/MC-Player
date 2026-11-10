// The scenario suite (docs/HILLCLIMB-INSIGHTS.md item 6). Each scenario runs the REAL brain code against a vanilla server and reports pass/fail plus metrics;
// tools/scenarios/run.js repeats it N times and reports the rate. Add a scenario for every flagged incident (brain/snapshot builds one from a snapshot).
//
// Status of the doc's twelve seed scenarios:
//   done      dig with every tool tier in the bag (4), the packet gate blocking armor (1), pillar out of a 1x1 shaft from four head yaws and off-centre (5), a 6-block climb (1), pillar with the hand swapped mid-jump (1),
//             and the same pillar with the legacy timing as the before-picture (1)
//   open      pillar with a wall torch in the feet cell (needs nav/reach.js on a real bot), ladder down/up 30 (tools/trial/ladder-lab.js has the measurement),
//             craft after a bag desync, torch a 30-block tunnel,
//             one autopilot minute with armor in the bag, bed on respawn, stash to the storage room, dig beside water and lava
'use strict'
const { Vec3 } = require('vec3')
const motor = require('../../brain/motor')
const { FEET_Y } = require('./harness')

const SH = 14                                                      // shaft height
async function shaft(w) {
  await w.fill(-1, FEET_Y, -1, 1, FEET_Y + SH, 1, 'stone')
  await w.fill(0, FEET_Y, 0, 0, FEET_Y + SH, 0, 'air')
}

// the pillar step as reach.js did it before #206/#208: plain bot.placeBlock (mineflayer's own, non-forced look), place at +1.1 / vy > -0.05, three jumps
async function legacyJumpPlace(bot, ref, feetY) {
  let placed = false, refusals = 0, lastWhy = null
  await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  for (let jump = 0; jump < 3 && !placed; jump++) {
    if (jump) { bot.setControlState('jump', false); await bot.waitForTicks(4) }
    for (let w = 0; w < 20 && !bot.entity.onGround; w++) await bot.waitForTicks(1)
    bot.setControlState('jump', true)
    for (let i = 0; i < 40 && !placed; i++) {
      await bot.waitForTicks(1)
      if (bot.entity.position.y >= feetY + 1.1 && bot.entity.velocity.y > -0.05) {
        await bot.waitForTicks(1)
        if (bot.entity.position.y < feetY + 1.1 || bot.entity.velocity.y < -0.1) continue
        try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); placed = true } catch (e) { refusals++; lastWhy = e.message; break }
      }
    }
  }
  bot.setControlState('jump', false); await bot.waitForTicks(6)
  return { ok: placed && bot.entity.position.y >= feetY + 0.9, refusals, why: lastWhy }
}

function pillarScenario(name, { yawDeg = 0, startX = 0.5, legacy = false, note, blocks = 1, swapHand = false, timeoutMs = 45000 }) {
  const yaw = yawDeg * Math.PI / 180
  return {
    name, note, items: { dirt: 64, ...(swapHand ? { stone_sword: 1 } : {}) }, build: shaft, start: [startX, 0, 0.5], yaw: (yawDeg + 180) % 360, timeoutMs,
    async act({ bot, w }) {
      await bot.look(yaw, 0, true); await bot.waitForTicks(2)
      let refusals = 0
      const dirtItem = () => bot.inventory.items().find(i => i.name === 'dirt')
      let swap = null
      if (swapHand) {                                              // another layer takes the hand during the jump: a sword is selected a few ticks in
        const sword = bot.inventory.items().find(i => i.name === 'stone_sword')
        let n = 0
        swap = () => { if (++n === 5 && sword) { try { bot.setQuickBarSlot(sword.slot - 36) } catch { /* ignore */ } } }
        bot.on('physicsTick', swap)
      }
      try {
        for (let b = 0; b < blocks; b++) {
          const feetY = Math.floor(bot.entity.position.y + 1e-6)
          const ref = bot.blockAt(new Vec3(w.ox, feetY - 1, w.oz))
          if (!ref || ref.boundingBox !== 'block') return { pass: false, refusals, why: `no block under the feet at block ${b}` }
          if (swapHand) { try { bot.setQuickBarSlot(dirtItem().slot - 36) } catch { /* ignore */ } await bot.waitForTicks(2) }
          if (legacy) {
            await motor.equip(bot, 'dirt')
            const r = await legacyJumpPlace(bot, ref, feetY); refusals += r.refusals
            if (!r.ok) return { pass: false, refusals, why: r.why || 'did not rise', blocks: b }
          } else {
            const eq = await motor.equip(bot, 'dirt'); if (!eq.ok) return { pass: false, refusals, why: eq.reason, blocks: b }
            const out = await motor.jumpPlaceUnder(bot, { ref, feetY, held: eq.value, reequip: () => motor.equip(bot, 'dirt') })
            if (out.ok) refusals += out.value.refusals
            else { refusals += (out.detail && out.detail.attempts ? out.detail.attempts.length : 1); return { pass: false, refusals, why: `${out.by}: ${out.reason}`.slice(0, 80), blocks: b } }
          }
        }
        return { pass: Math.floor(bot.entity.position.y + 1e-6) >= FEET_Y + blocks, refusals, blocks }
      } finally { if (swap) bot.removeListener('physicsTick', swap); bot.setControlState('jump', false) }
    }
  }
}

// ---- the packet gate on a real client: an iron chestplate pushed into the torso slot never stays on (noArmor is enforced, the inventory is resynced) ----
function gateArmorScenario() {
  return {
    name: 'gate-armor-blocked', note: 'noArmor enforced: bot.equip(chestplate, torso) leaves the torso empty on the client AND the server', items: { iron_chestplate: 1, iron_helmet: 1 }, timeoutMs: 20000,
    build: async (w) => { await w.fill(-1, FEET_Y, -1, 1, FEET_Y, 1, 'air') }, start: [0.5, 0, 0.5], yaw: 0,
    async act({ bot }) {
      const gate = require('../../brain/gate').install(bot, { logFile: null, armorAllowed: () => false })
      try {
        for (const [name, dest] of [['iron_chestplate', 'torso'], ['iron_helmet', 'head']]) { const it = bot.inventory.items().find(i => i.name === name); try { await bot.equip(it, dest) } catch { /* may throw */ } }
        await bot.waitForTicks(30)                                   // the gate asks the server for the real window after a dropped click
        const worn = [5, 6, 7, 8].map(i => bot.inventory.slots[i]).filter(Boolean).map(i => i.name)
        const sum = gate.summary().rules.noArmor
        return { pass: worn.length === 0 && sum.blocked >= 1, worn: worn.join(',') || undefined, blocked: sum.blocked, why: worn.length ? 'armor on: ' + worn.join(',') : sum.blocked < 1 ? 'nothing was blocked' : undefined }
      } finally { gate.uninstall() }
    }
  }
}

// ---- dig with every tool tier in the bag (brain/motor/tooltier.js on real block data, real digging, real drops) ----
const { minimumTool } = require('../../brain/motor/tooltier')
function digScenario(name, { block, drop, tools, expectTool, note }) {
  return {
    name, note, items: Object.fromEntries(tools.map(t => [t, 1])), timeoutMs: 30000,
    build: async (w) => { await w.fill(-3, FEET_Y, -3, 3, FEET_Y, 3, 'stone'); await w.fill(-2, FEET_Y, -2, 2, FEET_Y, 2, 'air'); await w.set(1, FEET_Y, 0, block) },
    start: [0.5, 0, 0.5], yaw: 0,
    async act({ bot, w }) {
      const b = w.at(1, FEET_Y, 0)
      if (!b || b.name !== block) return { pass: false, why: `block is ${b && b.name}, not ${block}` }
      const tool = minimumTool(b, bot.inventory.items())
      const picked = tool ? tool.name : null
      if (picked !== expectTool) return { pass: false, why: `picked ${picked}, expected ${expectTool}`, tool: picked }
      if (tool) await bot.equip(tool, 'hand')
      await bot.lookAt(w.cell(1, FEET_Y, 0).offset(0.5, 0.5, 0.5), true)
      try { await bot.dig(b, true) } catch (e) { return { pass: false, why: 'dig: ' + e.message.slice(0, 60), tool: picked } }
      await bot.waitForTicks(25)                                    // the drop is an item entity near the cell (or already in the bag); picking it up is the harness's walk, not the tool choice
      const nearby = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(w.cell(1, FEET_Y, 0).offset(0.5, 0.5, 0.5)) < 3.5)
      let got = bot.inventory.items().filter(i => i.name === drop).reduce((n, i) => n + i.count, 0)
      for (const e of nearby) { try { const it = e.getDroppedItem && e.getDroppedItem(); if (it && it.name === drop) got += it.count } catch { /* metadata not ready */ } }
      return { pass: expectTool === null ? got === 0 : got >= 1, tool: picked, got, why: got ? undefined : 'no ' + drop + ' dropped' }
    }
  }
}

module.exports = [
  digScenario('dig-stone-minimum-tier', { block: 'stone', drop: 'cobblestone', tools: ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe'], expectTool: 'stone_pickaxe', note: 'stone with all three tiers in the bag: the stone pickaxe digs it and cobblestone drops' }),
  digScenario('dig-diamond-ore-iron', { block: 'diamond_ore', drop: 'diamond', tools: ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe'], expectTool: 'iron_pickaxe', note: 'diamond ore needs iron: the iron pickaxe, not the diamond one, and the diamond drops' }),
  digScenario('dig-diamond-ore-stone-only', { block: 'diamond_ore', drop: 'diamond', tools: ['stone_pickaxe'], expectTool: null, note: 'only a stone pickaxe: no tool offered, nothing drops (the picker must not hand over a tool that wastes the ore)' }),
  digScenario('dig-dirt-shovel', { block: 'coarse_dirt', drop: 'coarse_dirt', tools: ['diamond_shovel', 'stone_shovel', 'iron_pickaxe'], expectTool: 'stone_shovel', note: 'coarse dirt (plain dirt turns into grass in daylight next to the floor): the stone shovel' }),

  pillarScenario('pillar-yaw0', { yawDeg: 0, note: 'one block out of a 1x1 shaft, head turned north' }),
  pillarScenario('pillar-yaw90', { yawDeg: 90, note: 'head turned west' }),
  pillarScenario('pillar-yaw180', { yawDeg: 180, note: 'head turned south' }),
  pillarScenario('pillar-yaw270', { yawDeg: 270, note: 'head turned east' }),
  pillarScenario('pillar-offcenter', { yawDeg: 45, startX: 0.69, note: 'feet 0.19 off the cell centre (as far as a 0.6-wide body fits in the shaft), head at a diagonal' }),
  pillarScenario('pillar-climb6', { yawDeg: 135, blocks: 6, timeoutMs: 90000, note: 'six blocks in a row (a real climb: first block plus five more)' }),
  pillarScenario('pillar-hand-swap', { yawDeg: 90, swapHand: true, note: 'a sword is selected 5 ticks into the jump: the Held proof must notice and take the block back' }),
  pillarScenario('pillar-legacy-yaw0', { yawDeg: 0, legacy: true, note: 'BEFORE picture: reach.js timing with plain placeBlock (the non-forced look)' }),
  pillarScenario('pillar-legacy-yaw90', { yawDeg: 90, legacy: true, note: 'BEFORE picture, head turned west' }),
  pillarScenario('pillar-legacy-yaw180', { yawDeg: 180, legacy: true, note: 'BEFORE picture, head turned south' }),
  gateArmorScenario()
]
