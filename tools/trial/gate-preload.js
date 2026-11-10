// Preload for running join.js against the offline trial server (node -r ./gate-preload.js join.js), plus a LOG-ONLY packet gate.
// Nothing is blocked. Every outgoing packet that would break the agreed rules is written to $GATE_LOG as one JSON line with the
// JS call stack, so the list of stray code paths comes from the run, not from reading code:
//   armor       window_click that would leave an armor item in slots 5-8 (click on an armor slot with an armor item on the cursor,
//               a shift-click of an armor item from the bag), and use_item with armor in hand
//   tool_tier   block_dig start with a pick/axe/shovel/sword/hoe held whose tier is above max(stone, tier the block needs)
//   lava        any move packet while the held slot is a lava bucket
// Env: TRIAL_PORT (default 25599), TRIAL_NAME (default TrialA), GATE_LOG (default ./gate.jsonl)
'use strict'
const Module = require('module')
const fs = require('fs')
const origLoad = Module._load
const PORT = Number(process.env.TRIAL_PORT) || 25599
const NAME = process.env.TRIAL_NAME || 'TrialA'
const LOG = process.env.GATE_LOG || 'gate.jsonl'
const TIER = { wooden: 1, stone: 2, golden: 2.5, iron: 3, diamond: 4, netherite: 5 }
const TOOL = /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|shovel|sword|hoe)$/
const ARMOR = /_(helmet|chestplate|leggings|boots)$|^(turtle_helmet|elytra)$/
const out = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n') } catch {} }
const stack = () => (new Error().stack || '').split('\n').slice(3, 9).map(s => s.trim().replace(/^at /, '').replace(process.cwd(), '.')).filter(s => !/gate-preload|node:internal|node_modules\/(minecraft-protocol|mineflayer\/lib\/loader)/.test(s))

Module._load = function (request, parent, isMain) {
  const m = origLoad.apply(this, arguments)
  if (request !== 'mineflayer' || m.__gated) return m
  const create = m.createBot
  m.createBot = function (opts) {
    const bot = create.call(this, { ...opts, host: 'localhost', port: PORT, username: NAME, auth: 'offline' })
    const c = bot._client
    const w = c.write.bind(c)
    let held = 0
    c.write = (name, data) => {
      try {
        if (name === 'held_item_slot') held = data.slotId
        const heldItem = () => bot.inventory && bot.inventory.slots[36 + (bot.quickBarSlot || 0)]
        if (name === 'window_click' && data.windowId === 0) {
          const it = (bot.inventory.slots[data.slot]) || null
          const cursor = data.cursorItem && data.cursorItem.itemId != null ? bot.registry.items[data.cursorItem.itemId] : null
          if (data.slot >= 5 && data.slot <= 8 && cursor && ARMOR.test(cursor.name)) out({ t: Date.now(), rule: 'armor', how: 'click armor slot ' + data.slot + ' with ' + cursor.name, stack: stack() })
          else if (data.mode === 1 && it && ARMOR.test(it.name) && data.slot >= 9) out({ t: Date.now(), rule: 'armor', how: 'shift-click ' + it.name + ' from slot ' + data.slot, stack: stack() })
        }
        if (name === 'use_item') { const h = heldItem(); if (h && ARMOR.test(h.name)) out({ t: Date.now(), rule: 'armor', how: 'use_item with ' + h.name, stack: stack() }) }
        if (name === 'block_dig' && data.status === 0) {
          const h = heldItem(); const tm = h && TOOL.exec(h.name)
          if (tm) {
            const b = bot.blockAt(data.location)
            let need = 0
            if (b && b.harvestTools) need = Math.min(...Object.keys(b.harvestTools).map(id => { const n = bot.registry.items[id] && bot.registry.items[id].name; const t = n && TOOL.exec(n); return t ? TIER[t[1]] : 9 }))
            if (!isFinite(need)) need = 0
            const allowed = Math.max(2, need)
            if (TIER[tm[1]] > allowed) out({ t: Date.now(), rule: 'tool_tier', how: `${h.name} on ${b ? b.name : '?'} (block needs ${need || 'no'} tier)`, stack: stack() })
          }
        }
        if ((name === 'position' || name === 'position_look') && held != null) {
          const h = heldItem(); if (h && h.name === 'lava_bucket') out({ t: Date.now(), rule: 'lava', how: 'move with lava bucket held', stack: stack() })
        }
      } catch (e) { out({ t: Date.now(), rule: 'gate_error', how: String(e && e.message) }) }
      return w(name, data)
    }
    return bot
  }
  m.__gated = true
  return m
}
