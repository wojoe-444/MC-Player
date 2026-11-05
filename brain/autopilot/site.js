// brain/autopilot/site.js: routine work at a fixed site (Walter 2026-11-04, Smeo444's first routine: his birch tree farm at 142 69 415).
// The site is described in brain/state/site.json (per bot):
//   { "name", "box": {x0,x1,y0,y1,z0,z1} (inside the fence), "gate": [x,y,z], "chests": [[x,y,z]...], "log": "birch_log",
//     "leaves": "birch_leaves", "sapling": "birch_sapling", "pillar": "cobblestone" }
// Walter's rules for it: enter and leave only through the gate; never break the fence or a torch; fell every tree completely, punch the leaves
// by hand and pick up everything that drops; replant each stump with a sapling; put the output in the chests by the farm, adding chests
// when they fill up; work with a stone axe (more made from cobblestone in the nearby chests and sticks from the harvest).
// Fences and torches are established blocks (plan.js), so neither the bot nor the pathfinder breaks them; zone.json "allow" opens the box
// for logs, leaves and the bot's own pillar block only. Tops out of reach: a one-block pillar in the stump's cell, taken down afterwards.
const fs = require('fs')

module.exports = function site(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v
  const st = G.state
  const note = (m) => { try { G.note(m) } catch { log('SITE', m) } }
  const read = () => { try { return JSON.parse(fs.readFileSync(api.statePath('site.json'), 'utf8')) } catch { return null } }
  const inBox = (p, b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && p.z >= b.z0 && p.z <= b.z1
  const ids = (re) => bot.registry.blocksArray.filter(b => re.test(b.name)).map(b => b.id)
  const eyeDist = (p) => S.eye().distanceTo(v(p.x + 0.5, p.y + 0.5, p.z + 0.5))
  const wait = (ms) => S.wait(ms)

  function trees(cfg) {
    const c = v((cfg.box.x0 + cfg.box.x1) >> 1, cfg.box.y0 + 2, (cfg.box.z0 + cfg.box.z1) >> 1)
    const logs = bot.findBlocks({ matching: ids(new RegExp('^' + cfg.log + '$')), point: c, maxDistance: 48, count: 1000 }).filter(p => inBox(p, cfg.box))
    // every column that still holds wood is a tree to fell, standing at ground level (counting only logs on soil missed trunks whose
    // bottom log was already cut: Walter's screenshot, 01:45)
    const cols = new Map()
    for (const p of logs) { const k = p.x + ',' + p.z; if (!cols.has(k)) cols.set(k, v(p.x, cfg.box.y0, p.z)) }
    return [...cols.values()]
  }
  const inside = (cfg) => inBox(S.flo(bot.entity.position), { ...cfg.box, y0: cfg.box.y0 - 2, y1: cfg.box.y1 })
  // in through the gate: the gate cell first (the pathfinder may not path through fence gates on its own), then the target
  async function enter(cfg) {
    if (inside(cfg)) return true
    const g = v(...cfg.gate)
    const gb = S.block(g); if (gb && /fence_gate/.test(gb.name) && gb.getProperties && !gb.getProperties().open) { try { await S.goto(new goals.GoalNear(g.x, g.y, g.z, 2), { dig: false, ms: 40000 }); await bot.activateBlock(gb) } catch {} }
    await S.goto(new goals.GoalNear(g.x, g.y, g.z, 0), { dig: false, ms: 60000 })
    const inner = v(g.x, g.y, cfg.box.z0 + 1)
    await S.goto(new goals.GoalNear(inner.x, inner.y, inner.z, 1), { dig: false, ms: 30000 })
    return inside(cfg)
  }
  async function leave(cfg) {
    if (!inside(cfg)) return true
    const g = v(...cfg.gate)
    await S.goto(new goals.GoalNear(g.x, g.y, cfg.box.z0 + 1, 1), { dig: false, ms: 60000 })
    await S.goto(new goals.GoalNear(g.x, g.y, g.z, 0), { dig: false, ms: 30000 })
    return !inside(cfg)
  }
  async function dig(b, hand = false) {
    if (!b || S.isAir(b)) return true
    if (eyeDist(b.position) > 4.4) return false
    if (hand) { if (bot.heldItem && /_(axe|pickaxe|sword|shovel|hoe)$/.test(bot.heldItem.name)) await bot.unequip('hand').catch(() => {}) }
    else { const axe = S.items().find(i => /_axe$/.test(i.name)); if (axe && (!bot.heldItem || bot.heldItem.name !== axe.name)) await bot.equip(axe, 'hand').catch(() => {}) }
    if (await S.digBlock(b)) return true
    // leaves between the eye and an upper log block the view (01:51: logs in reach left standing): punch them away and try again
    for (let i = 0; i < 3; i++) {
      const hit = S.firstHit(b.position); if (!hit || !hit.position || hit.position.equals(b.position) || !/leaves/.test(hit.name)) break
      if (bot.heldItem && /_(axe|pickaxe|sword|shovel|hoe)$/.test(bot.heldItem.name)) await bot.unequip('hand').catch(() => {})
      if (!(await S.digBlock(hit))) break
      if (!hand) { const axe = S.items().find(i => /_axe$/.test(i.name)); if (axe) await bot.equip(axe, 'hand').catch(() => {}) }
      if (await S.digBlock(S.block(b.position))) return true
    }
    return false
  }
  // stand one block higher in the stump's (now empty) cell, on a block of our own
  async function pillar(cfg, at) {
    const item = S.items().find(i => i.name === cfg.pillar) || S.items().find(i => /^(cobblestone|dirt)$/.test(i.name)); if (!item) return null
    await S.goto(new goals.GoalBlock(at.x, at.y, at.z), { dig: false, ms: 15000 })
    const me = S.flo(bot.entity.position); if (me.x !== at.x || me.z !== at.z) return null
    const ref = S.block(me.offset(0, -1, 0)); if (!ref || ref.boundingBox !== 'block') return null
    await bot.equip(item, 'hand').catch(() => {}); bot._placingUntil = Date.now() + 4000
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.setControlState('jump', true)
    let placed = false
    for (let i = 0; i < 30 && !placed; i++) { await wait(50); if (bot.entity.position.y >= me.y + 1) { try { await bot.placeBlock(ref, v(0, 1, 0)); placed = true } catch {} } }
    bot.setControlState('jump', false); await wait(400)
    return placed ? me : null
  }

  async function fell(cfg, trunk) {
    const L = new RegExp('^' + cfg.log + '$'), LV = new RegExp('^' + cfg.leaves + '$')
    const column = () => { const out = []; for (let y = trunk.y; y <= trunk.y + 12; y++) { const b = S.block(v(trunk.x, y, trunk.z)); if (b && L.test(b.name)) out.push(b) } return out }
    // stand next to the trunk, inside the farm
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => trunk.offset(dx, 0, dz)).filter(p => { const b = S.block(p), a = S.block(p.offset(0, 1, 0)); return b && a && b.boundingBox === 'empty' && a.boundingBox === 'empty' && inBox(p, cfg.box) })
    let r = { ok: false }
    for (const p of side) { r = await S.goto(new goals.GoalBlock(p.x, p.y, p.z), { dig: false, ms: 30000 }); if (r.ok) break }
    if (!r.ok) r = await S.goto(new goals.GoalNear(trunk.x, trunk.y, trunk.z, 2), { dig: false, ms: 30000 })
    const before = column().length
    if (!r.ok) log('SITE', `no stand by the tree at ${trunk} (${r.err || r.why || 'no path'}), at ${S.flo(bot.entity.position)}`)
    for (const b of column()) if (!(await dig(b))) { log('SITE', `could not cut ${b.name} at ${b.position} (eye ${eyeDist(b.position).toFixed(1)})`); break }
    let stand = null
    // tops out of reach: a one-block pillar in the stump cell, or (a sapling already growing there) in a free cell beside it
    if (column().length) {
      const cells = [trunk, ...side].filter(p => { const c = S.block(p), g = S.block(p.offset(0, -1, 0)); return c && S.isAir(c) && g && g.boundingBox === 'block' })
      for (const at of cells) { stand = await pillar(cfg, at); if (stand) break }
      if (stand) for (const b of column()) await dig(b)
    }
    const logs = before - column().length
    // leaves in reach, by hand (no shears, so they drop saplings and sticks the way Walter wants)
    let leaves = 0
    for (let pass = 0; pass < 2; pass++) {
      const lv = bot.findBlocks({ matching: ids(LV), point: bot.entity.position, maxDistance: 5, count: 80 }).filter(p => inBox(p, { ...cfg.box, y1: cfg.box.y1 + 4 }) && eyeDist(p) <= 4.4)
      for (const p of lv) { const b = S.block(p); if (b && LV.test(b.name) && await dig(b, true)) { const a = S.block(p); if (a && S.isAir(a)) leaves++ } }
    }
    // down again: the pillar block goes, and the stump cell is soil again for the sapling
    if (stand) { const pb = S.block(stand); if (pb && pb.name === (cfg.pillar || 'cobblestone')) { bot.setControlState('sneak', false); await dig(pb) } await wait(500) }
    return { logs, leaves, left: column().length }
  }

  async function replant(cfg, trunk) {
    const soil = S.block(trunk.offset(0, -1, 0)), cell = S.block(trunk)
    if (!soil || !/dirt|grass|podzol/.test(soil.name) || !cell || !S.isAir(cell)) return false
    if (!S.items().some(i => i.name === cfg.sapling)) return false
    if (eyeDist(soil.position) > 4.4) await S.goto(new goals.GoalNear(trunk.x, trunk.y, trunk.z, 2), { dig: false, ms: 20000 })
    return S.placeAgainst(soil, v(0, 1, 0), cfg.sapling)
  }

  // the chests by the farm; a new one next to them when they are full
  async function deposit(cfg) {
    // keep what the job itself needs: saplings, the pillar block, and a few logs for sticks and planks (a new axe, a chest)
    const KEEP = { [cfg.sapling]: 24, [cfg.pillar || 'cobblestone']: 16, [cfg.log]: 8, stick: 8 }
    const wanted = (it) => /_log$|_sapling$|^stick$|^apple$/.test(it.name)
    let moved = 0
    for (const c of cfg.chests || []) {
      if (!S.items().some(wanted)) break
      const cb = S.block(v(...c)); if (!cb || !/chest|barrel/.test(cb.name)) continue
      if (eyeDist(cb.position) > 4.2) await S.goto(new goals.GoalNear(c[0], c[1], c[2], 2), { dig: false, ms: 40000 })
      let box; S.closeWindows(); try { box = await bot.openContainer(cb) } catch { continue }
      try {
        for (const it of S.items().filter(wanted)) {
          const keep = KEEP[it.name] || 0, have = S.count(it.name), n = Math.min(it.count, have - keep); if (n <= 0) continue
          try { await box.deposit(it.type, null, n); moved += n } catch { break }
        }
      } finally { try { box.close() } catch {} }
    }
    if (S.items().some(it => wanted(it) && S.count(it.name) > (KEEP[it.name] || 0) + 8) && (cfg.chests || []).length) {
      // still holding plenty: the chests are full, so a new chest beside the last one
      if (!S.has('chest') && S.planks() + S.logs() * 4 >= 8) await S.craft('chest', 1)
      if (S.has('chest')) {
        const last = v(...cfg.chests[cfg.chests.length - 1])
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0]]) {
          const p = last.offset(dx, 0, dz), b = S.block(p), g = S.block(p.offset(0, -1, 0))
          if (!b || !S.isAir(b) || !g || g.boundingBox !== 'block' || inBox(p, cfg.box)) continue
          if (await S.placeAgainst(g, v(0, 1, 0), 'chest')) { cfg.chests.push([p.x, p.y, p.z]); fs.writeFileSync(api.statePath('site.json'), JSON.stringify(cfg, null, 1)); note(`${cfg.name}: chests full, added one at ${p}`); return moved + await deposit(cfg) }
        }
      }
    }
    return moved
  }

  // a stone axe in hand: cobblestone from the nearby chests and sticks from the harvest
  // cobblestone from the nearby chests (Walter: for stone axes; also the pillar block for tall tree tops)
  async function cobble(cfg, want) {
    for (const c of cfg.stores || cfg.chests || []) {
      if (S.count('cobblestone') >= want) break
      const cb = S.block(v(...c)); if (!cb || !/chest|barrel/.test(cb.name)) continue
      if (eyeDist(cb.position) > 4.2) await S.goto(new goals.GoalNear(c[0], c[1], c[2], 2), { dig: false, ms: 40000 })
      let box; S.closeWindows(); try { box = await bot.openContainer(cb) } catch { continue }
      try { const cob = box.containerItems().find(i => i.name === 'cobblestone'); if (cob) await box.withdraw(cob.type, null, Math.min(cob.count, want - S.count('cobblestone'))) } catch {} finally { try { box.close() } catch {} }
    }
  }
  // food from the nearby chests when the bag has none (common crop food from shared chests is fine by the house rules; Smeo444 starved twice
  // between berry harvests)
  async function food(cfg) {
    if (S.foodPoints() >= 8) return
    for (const c of cfg.stores || cfg.chests || []) {
      if (S.foodPoints() >= 16) break
      const cb = S.block(v(...c)); if (!cb || !/chest|barrel/.test(cb.name)) continue
      if (eyeDist(cb.position) > 4.2) await S.goto(new goals.GoalNear(c[0], c[1], c[2], 2), { dig: false, ms: 40000 })
      let box; S.closeWindows(); try { box = await bot.openContainer(cb) } catch { continue }
      try { for (const it of box.containerItems().filter(i => /^(bread|baked_potato|carrot|potato|sweet_berries|apple|beetroot)$/.test(i.name))) { await box.withdraw(it.type, null, Math.min(it.count, 16)); if (S.foodPoints() >= 16) break } } catch {} finally { try { box.close() } catch {} }
    }
  }
  async function axe(cfg) {
    if (S.count(cfg.pillar || 'cobblestone') < 4) await cobble(cfg, 16)
    if (S.items().some(i => /_axe$/.test(i.name))) return true
    if (S.count('cobblestone') < 3) await cobble(cfg, 8)
    if (S.count('stick') < 2 && S.planks() < 2 && S.logs()) await S.craft(S.items().find(i => /_log$/.test(i.name)).name.replace('_log', '_planks'), 4)
    if (S.count('stick') < 2) await S.craft('stick', 4)
    await S.craft('stone_axe', 1)
    return S.items().some(i => /_axe$/.test(i.name))
  }

  // anything of ours left in the farm: a pillar block in a stump cell, a crafting table set down while crafting (Walter's screenshot, 00:57)
  async function cleanup(cfg) {
    const strays = bot.findBlocks({ matching: ids(new RegExp('^(' + (cfg.pillar || 'cobblestone') + '|crafting_table)$')), point: v((cfg.box.x0 + cfg.box.x1) >> 1, cfg.box.y0, (cfg.box.z0 + cfg.box.z1) >> 1), maxDistance: 24, count: 50 })
      .filter(p => inBox(p, { ...cfg.box, y1: cfg.box.y0 + 1 }))
    let n = 0
    for (const p of strays) {
      if (eyeDist(p) > 4.2) await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, ms: 20000 })
      const b = S.block(p); if (!b || S.isAir(b)) continue
      if (S.flo(bot.entity.position).offset(0, -1, 0).equals(p)) {
        const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => p.offset(dx, 0, dz)).find(q => { const c = S.block(q), d = S.block(q.offset(0, -1, 0)); return c && S.isAir(c) && d && d.boundingBox === 'block' })
        if (side) await S.goto(new goals.GoalBlock(side.x, side.y, side.z), { dig: false, ms: 8000 })
      }
      if (/crafting_table/.test(b.name)) { const axe = S.items().find(i => /_axe$/.test(i.name)); if (axe) await bot.equip(axe, 'hand').catch(() => {}) }
      if (await S.digBlock(b, { force: true })) n++
    }
    if (n) { await wait(600); await S.pickup(6, 5000) }
    return n
  }
  // saplings for every bare stump spot, from the farm chests (Walter: plenty of saplings sat in the chest while spots stayed bare)
  async function saplings(cfg, want) {
    for (const c of cfg.chests || []) {
      if (S.count(cfg.sapling) >= want) break
      const cb = S.block(v(...c)); if (!cb || !/chest|barrel/.test(cb.name)) continue
      if (eyeDist(cb.position) > 4.2) await S.goto(new goals.GoalNear(c[0], c[1], c[2], 2), { dig: false, ms: 40000 })
      let box; S.closeWindows(); try { box = await bot.openContainer(cb) } catch { continue }
      try { const sp = box.containerItems().find(i => i.name === cfg.sapling); if (sp) await box.withdraw(sp.type, null, Math.min(sp.count, want - S.count(cfg.sapling))) } catch {} finally { try { box.close() } catch {} }
    }
  }
  const bareSpots = (cfg) => (cfg.spots || []).map(q => v(...q)).filter(q => { const c = S.block(q), s = S.block(q.offset(0, -1, 0)); return c && S.isAir(c) && s && /dirt|grass|podzol/.test(s.name) })

  return {
    id: 'site-work', budget: 900000, cool: 180000,
    // hungry with nothing to eat: food first (Smeo444 starved mid-shift at 00:42 with berries ripe next to the bed)
    need: () => { const cfg = read(); if (!cfg || S.isNight()) return false
      if (bot.food < 16 && S.foodPoints() < 4 && st._siteNoFoodAt && Date.now() - st._siteNoFoodAt < 600000) return false
      if (Date.now() - (st._siteAt || 0) > 30000) { st._siteAt = Date.now(); st._siteTrees = trees(cfg).length; st._siteSaplingSpots = bareSpots(cfg).length }
      return st._siteTrees >= 3 || st._siteSaplingSpots > 0 || S.items().some(i => /_log$/.test(i.name) && S.count(i.name) >= 32) },
    run: async () => {
      const cfg = read(); if (!cfg) return false
      G.sitePhase = 'stock'   // phases for the behavior view (brain/behavior)
      await food(cfg); if (S.foodPoints() < 4) st._siteNoFoodAt = Date.now()
      if (!(await axe(cfg))) note(`${cfg.name}: no axe yet (cobblestone ${S.count('cobblestone')}), chopping by hand`)
      if (S.count(cfg.pillar || 'cobblestone') < 4) note(`${cfg.name}: few ${cfg.pillar} for reaching tree tops`)
      await saplings(cfg, Math.max(8, (cfg.spots || []).length + 8))
      G.sitePhase = 'enter'
      if (!(await enter(cfg))) { G.sitePhase = null; note(`${cfg.name}: could not get in through the gate at ${cfg.gate}`); return false }
      G.sitePhase = 'cleanup'
      let cleaned = await cleanup(cfg)
      const spots = new Set((cfg.spots || []).map(q => q.join(',')))
      let felled = 0, logs = 0, leaves = 0, planted = 0
      const failed = new Set()
      const t0 = Date.now()
      for (let i = 0; i < 6 && Date.now() - t0 < 600000; i++) {
        const ts = trees(cfg).filter(t => !failed.has(t.x + ',' + t.z)).sort((a, b) => S.dist(a) - S.dist(b)); if (!ts.length) break
        if (S.freeSlots() <= 3) break
        if (bot.food < 10 && S.foodPoints() < 4) { note(`${cfg.name}: hungry, stopping for food`); break }
        const t = ts[0]; spots.add([t.x, t.y, t.z].join(','))
        G.sitePhase = 'fell'
        const r = await fell(cfg, t); logs += r.logs; leaves += r.leaves; if (!r.left) felled++; else if (!r.logs) failed.add(t.x + ',' + t.z)   // no retry of the same tree this round
        await wait(1500); await S.pickup(7, 8000)
        G.sitePhase = 'replant'
        if (await replant(cfg, t)) planted++
      }
      // stumps from earlier passes that are still bare
      G.sitePhase = 'cleanup'
      cleaned += await cleanup(cfg)
      for (const k of spots) { const q = k.split(',').map(Number); if (await replant(cfg, v(...q))) planted++ }
      await S.pickup(10, 15000)
      cfg.spots = [...spots].map(k => k.split(',').map(Number)); fs.writeFileSync(api.statePath('site.json'), JSON.stringify(cfg, null, 1))
      G.sitePhase = 'leave'
      await leave(cfg)
      G.sitePhase = 'store'
      const moved = await deposit(cfg)
      G.sitePhase = null
      note(`${cfg.name}: felled ${felled} trees (${logs} logs, ${leaves} leaves punched), replanted ${planted}, cleared ${cleaned} stray blocks, stored ${moved} items; ${trees(cfg).length} trees left, ${bareSpots(cfg).length} bare spots`)
      return felled + planted + moved > 0
    }
  }
}
