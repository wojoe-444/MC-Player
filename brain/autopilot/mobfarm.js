// brain/autopilot/mobfarm.js: Smeo444's second routine (Walter 2026-11-06): his mob farm north of the birch farm. Mobs drop from the
// spawning platform (about y88) into a 2x2 shaft and land on slabs over hoppers; the hoppers feed a double chest. From the kill spot
// (south of the chest) the bot hits them through the one-block gap over the chest with a stone sword, and only that: it never breaks,
// opens or places a block of the farm. When the double chest fills, its loot goes into overflow chests a few blocks south, so the
// hoppers keep running. Between passes it waits away from the farm (its bed is 24+ blocks from the platform): a player within 24 blocks
// of the platform stops mobs spawning there.
// Config: brain/state/mobfarm.json
//   { "killSpot": [x,y,z], "killBox": {x0,x1,y0,y1,z0,z1} (the cells the mobs stand in), "chests": [[x,y,z],...] (the farm's chest),
//     "overflow": [[x,y,z],...] (chests the loot is moved to), "overflowSpots": [[x,y,z],...] (where new overflow chests may go) }
const fs = require('fs')

module.exports = function mobfarm(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v
  const st = G.state
  const note = (m) => { try { G.note(m) } catch { log('MOBFARM', m) } }
  const read = () => { try { return JSON.parse(fs.readFileSync(api.statePath('mobfarm.json'), 'utf8')) } catch { return null } }
  const HOSTILE = /^(zombie|husk|drowned|skeleton|stray|spider|cave_spider|creeper|witch|enderman|zombie_villager|slime|phantom|bogged|silverfish)$/
  const inKill = (p, b) => p.x >= b.x0 && p.x < b.x1 + 1 && p.z >= b.z0 && p.z < b.z1 + 1 && p.y >= b.y0 - 0.5 && p.y < b.y1 + 2
  const victims = (c) => Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && HOSTILE.test(e.name || '') && inKill(e.position, c.killBox))
  // a stone sword (Walter); a wooden one only until there is cobblestone for the stone one (its chests and stores had none, 02:55)
  const sword = () => S.items().find(i => i.name === 'stone_sword') || S.items().find(i => i.name === 'wooden_sword')
  const chestFull = () => !!st.mobChestFull

  async function getSword(c) {
    if (S.items().some(i => i.name === 'stone_sword')) return true
    if (sword() && S.count('cobblestone') < 2) return true
    if (S.count('cobblestone') < 2 || !S.has('stick')) {
      // cobblestone from the birch farm's stores (the same chests Walter said to take it from for axes)
      try {
        const site = JSON.parse(fs.readFileSync(api.statePath('site.json'), 'utf8'))
        for (const q of site.stores || site.chests || []) {
          if (S.count('cobblestone') >= 2) break
          const cb = S.block(v(...q)); if (!cb || !/chest|barrel/.test(cb.name)) continue
          await S.goto(new goals.GoalNear(q[0], q[1], q[2], 2), { dig: false, ms: 40000, escalate: false })
          let box; S.closeWindows(); try { box = await bot.openContainer(cb) } catch { continue }
          try { const cob = box.containerItems().find(i => i.name === 'cobblestone'); if (cob) await box.withdraw(cob.type, null, Math.min(cob.count, 8)) } catch {} finally { try { box.close() } catch {} }
        }
      } catch {}
    }
    if (!S.has('stick') && S.planks() + S.logs() * 4 >= 2) await S.craft('stick', 4).catch(() => false)
    if (S.count('cobblestone') >= 2) await S.craft('stone_sword', 1).catch(() => false)
    if (!sword() && S.planks() + S.logs() * 4 >= 2) await S.craft('wooden_sword', 1).catch(() => false)
    return !!sword()
  }

  // hit every mob in the shaft from the kill spot, through the gap; never move off the spot meanwhile
  async function killPass(c) {
    const k = v(...c.killSpot)
    if (S.dist(k.offset(0.5, 0, 0.5)) > 0.8) {
      const r = await S.goto(new goals.GoalBlock(k.x, k.y, k.z), { dig: false, ms: 60000, escalate: false })
      if (!r.ok && S.dist(k.offset(0.5, 0, 0.5)) > 1.2) { note('mob farm: could not reach the kill spot'); return 0 }
    }
    const sw = sword(); if (sw) { try { await bot.equip(sw, 'hand') } catch {} }
    let hits = 0, kills = 0, idle = 0
    const t0 = Date.now()
    const before = new Set(victims(c).map(e => e.id))
    while (Date.now() - t0 < 60000) {
      S.check()
      const vs = victims(c).filter(e => S.eye().distanceTo(e.position.offset(0, (e.height || 1.8) * 0.4, 0)) <= 3.2)
      if (!vs.length) { if (++idle > 6) break; await S.wait(500); continue }
      idle = 0
      const e = vs.sort((a, b) => (a.health || 20) - (b.health || 20))[0]
      try { await bot.lookAt(e.position.offset(0, Math.min(0.6, (e.height || 1.8) * 0.3), 0), true); bot.attack(e); hits++ } catch {}
      await S.wait(700)                                            // a full-strength stone sword swing every 0.65 s
    }
    kills = [...before].filter(id => !bot.entities[id]).length
    return { hits, kills }
  }

  // the farm's chest: is it (nearly) full? Then move its loot into the overflow chests
  async function emptyFarmChest(c) {
    const cp = v(...c.chests[0]); const cb = S.block(cp); if (!cb || !/chest/.test(cb.name)) return 0
    let box; S.closeWindows(); try { box = await bot.openContainer(cb) } catch { return 0 }
    let moved = 0, free = 0
    try {
      const slots = box.inventoryStart != null ? box.inventoryStart : 54
      free = slots - box.containerItems().length
      st.mobChestFull = free <= 4
      if (st.mobChestFull) {
        for (const it of box.containerItems()) { if (S.freeSlots() <= 2) break; try { await box.withdraw(it.type, null, it.count); moved += it.count } catch { break } }
      }
    } catch {} finally { try { box.close() } catch {} }
    if (!moved) return 0
    let stored = 0
    const dump = async (q) => {
      const ob = S.block(v(...q)); if (!ob || !/chest|barrel/.test(ob.name)) return false
      await S.goto(new goals.GoalNear(q[0], q[1], q[2], 2), { dig: false, ms: 40000, escalate: false })
      let b2; S.closeWindows(); try { b2 = await bot.openContainer(ob) } catch { return false }
      try { for (const it of S.items().filter(i => !/sword|_axe|pickaxe|shovel|hoe|crafting_table|^bread$|sweet_berries|_sapling$|^stick$|_log$|cobblestone|stone$|charcoal/.test(i.name))) { try { await b2.deposit(it.type, null, it.count); stored += it.count } catch { break } } } catch {} finally { try { b2.close() } catch {} }
      return true
    }
    for (const q of c.overflow || []) await dump(q)
    // still holding loot: a new overflow chest at the next listed spot (never anywhere else, never by the farm itself)
    if (S.items().some(i => /rotten_flesh|bone|arrow|string|spider_eye|gunpowder|ender_pearl|glass_bottle|redstone|glowstone|sugar|stick|potato|carrot|iron_ingot|_helmet|_chestplate|_leggings|_boots|bow|_sword/.test(i.name) && !/stone_sword|^stick$/.test(i.name))) {
      if (!S.has('chest') && S.planks() + S.logs() * 4 >= 8) { if (S.planks() < 8) await S.craft((S.items().find(i => /_log$/.test(i.name)) || { name: 'birch_log' }).name.replace(/_log$/, '_planks'), 2).catch(() => false); await S.craft('chest', 1).catch(() => false) }
      if (S.has('chest')) for (const q of c.overflowSpots || []) {
        if ((c.overflow || []).some(o => o[0] === q[0] && o[1] === q[1] && o[2] === q[2])) continue
        const p = v(...q), b = S.block(p), g = S.block(p.offset(0, -1, 0))
        if (!b || !S.isAir(b) || !g || g.boundingBox !== 'block') continue
        await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, ms: 30000, escalate: false })
        if (await S.placeAgainst(g, v(0, 1, 0), 'chest')) { c.overflow = (c.overflow || []).concat([q]); fs.writeFileSync(api.statePath('mobfarm.json'), JSON.stringify(c, null, 1)); note(`mob farm: new overflow chest at ${p}`); await dump(q); break }
      }
    }
    return stored
  }

  return { id: 'mob-farm', budget: 150000, cool: 15000, need: () => {
      const c = read(); if (!c || bot.isSleeping) return false
      return victims(c).length > 0 || (chestFull() && Date.now() - (st.mobChestAt || 0) > 120000)
    }, run: async () => {
      const c = read(); if (!c) return false
      await getSword(c)
      bot._mobFarmWork = true                                      // the reflexes leave the shaft's mobs to this step meanwhile
      let r = { hits: 0, kills: 0 }
      try { if (victims(c).length) r = await killPass(c) } finally { bot._mobFarmWork = false }
      st.mobChestAt = Date.now()
      const moved = await emptyFarmChest(c)
      st.mobFarm = { at: Date.now(), hits: (st.mobFarm && st.mobFarm.hits || 0) + r.hits, kills: (st.mobFarm && st.mobFarm.kills || 0) + r.kills }
      note(`mob farm: ${r.kills} mobs finished (${r.hits} hits)${moved ? ', moved ' + moved + ' items to the overflow chests' : ''}${st.mobChestFull ? ', farm chest full' : ''}`)
      G.save()
      return r.hits > 0 || moved > 0 } }
}
