const fs = require('fs')
const LOG = require('path').join(require('path').dirname(api.statePath('x')), 'reach-test.log')
const L = (m) => { const line = new Date().toISOString().slice(11, 19) + ' ' + m; try { fs.appendFileSync(LOG, line + '\n') } catch {} }
if (globalThis.__reachTest && globalThis.__reachTest.running) return 'a test is already running'
const T = globalThis.__reachTest = { running: true }
const PRIO = (api.PRIORITY && api.PRIORITY.EAT - 5) || 60
const goals = api.goals, v = (x, y, z) => new Vec3(x, y, z)
const flo = (p) => v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
const names = (cells) => cells.map(c => { const b = bot.blockAt(c); return b ? b.name : '?' })
const startPos = bot.entity.position.toString()
api.scheduler.submit({ name: 'reach-test', key: 'reach-test', priority: PRIO, ignoreHold: true, onUserStop: 'cancel', abort: () => { try { S.stopMoving() } catch {} }, async run(ctx) {
  S.ctx = ctx
  try {
    L('START reach hut test; pos ' + bot.entity.position.toString() + ' hp ' + bot.health)
    // planks read as built anywhere, so the rebuild applies even outside the base
    if (S.count('spruce_planks') < 14) { try { await S.craft('spruce_planks', 14) } catch (e) { L('craft: ' + e.message) } S.ctx = ctx }
    const HUTB = S.count('spruce_planks') >= 12 ? 'spruce_planks' : 'cobblestone'
    L('hut material ' + HUTB + ' x' + S.count(HUTB))
    // 2. a flat 3x3 spot on the surface close by (open sky, room for a hut)
    const clear = (c) => { const b = bot.blockAt(c); return b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
    const findSpot = () => {
      const me = flo(bot.entity.position); let best = null
      for (let dy = -3; dy <= 8; dy++) for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
        const c = me.offset(dx, dy, dz)
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2
        if (best && d >= best.d) continue
        let ok = true
        for (let ax = -2; ax <= 2 && ok; ax++) for (let az = -2; az <= 2 && ok; az++) {
          const f = bot.blockAt(c.offset(ax, -1, az))
          if (!f || f.boundingBox !== 'block' || /leaves|ice|water|lava|fence|wall|stairs|slab/.test(f.name)) { ok = false; break }
          for (let h = 0; h <= 7 && ok; h++) if (!clear(c.offset(ax, h, az))) ok = false
        }
        if (ok) best = { d, c }
      }
      return best
    }
    let best = findSpot()
    if (!best) {
      L('no open flat spot here; walking to the east side of the base first')
      for (let k = 0; k < 6; k++) {
        const w = await api.nav.goto(new goals.GoalNear(-1009, 136, 2401, 3), { label: 'reach-test site', ms: 30000, maxMs: 240000 })
        L('site walk ' + k + ': ' + JSON.stringify(w) + ' at ' + bot.entity.position.toString())
        if (w.ok || w.err !== 'goal changed') break
        await ctx.sleep(1000)
      }
      S.ctx = ctx; best = findSpot()
    }
    if (!best) { L('no open flat 5x5 spot; abort'); return }
    const C = best.c
    L('hut centre ' + C.toString())
    S.setMoves(false)
    const g = await S.goto(new goals.GoalBlock(C.x, C.y, C.z), { dig: false, ms: 20000, escalate: false })
    L('walked to centre: ' + JSON.stringify(g) + ' at ' + bot.entity.position.toString())
    const P = flo(bot.entity.position)
    // 3. cobble hut around the bot: 4 sides x 2 high, then the roof
    if (S.count(HUTB) < 10) { L('not enough ' + HUTB + ': ' + S.count(HUTB)); return }
    const roofItem = HUTB
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const hut = []
    for (const dy of [0, 1]) for (const [dx, dz] of side) {
      const cell = P.offset(dx, dy, dz); hut.push(cell)
      if (!S.isAir(S.block(cell))) continue
      const ref = S.block(cell.offset(0, -1, 0))
      await S.placeAgainst(ref, v(0, 1, 0), HUTB); await ctx.sleep(250)
    }
    for (const dz of [0]) { // roof: the side column at dx=1 first, then the centre against it
      const top = P.offset(1, 2, 0); hut.push(top)
      await S.placeAgainst(S.block(P.offset(1, 1, 0)), v(0, 1, 0), roofItem); await ctx.sleep(250)
      const mid = P.offset(0, 2, 0); hut.push(mid)
      await S.placeAgainst(S.block(top), v(-1, 0, 0), roofItem); await ctx.sleep(250)
    }
    L('hut: ' + names(hut).join(','))
    const sealed = hut.slice(0, 8).every(c => { const b = bot.blockAt(c); return b && b.boundingBox === 'block' }) && (bot.blockAt(P.offset(0, 2, 0)).boundingBox === 'block')
    L('hut closed around the bot: ' + sealed + ' (feet ' + bot.entity.position.toString() + ')')
    if (!sealed) { L('could not close the hut; abort'); return }
    // 4. out: a target 10 blocks east of the hut
    const out = api.nav.reach.stats.dug
    const t1 = await api.nav.goto(new goals.GoalNearXZ(P.x + 10, P.z, 1), { label: 'reach-test out', ms: 15000, maxMs: 200000 })
    L('OUT: ' + JSON.stringify(t1) + ' at ' + bot.entity.position.toString() + ' dug+' + (api.nav.reach.stats.dug - out) + ' pending ' + api.nav.reach.status().pendingBreaches)
    await ctx.sleep(4000)
    L('hut after leaving: ' + names(hut).join(',') + ' | pendingBreaches ' + api.nav.reach.status().pendingBreaches)
    // 5. back in: the interior of the sealed hut is the walled-off target
    const d0 = api.nav.reach.stats.dug
    const t2 = await api.nav.goto(new goals.GoalBlock(P.x, P.y, P.z), { label: 'reach-test back in', ms: 15000, maxMs: 200000 })
    L('IN: ' + JSON.stringify(t2) + ' at ' + bot.entity.position.toString() + ' dug+' + (api.nav.reach.stats.dug - d0))
    await ctx.sleep(2500)
    L('hut after returning: ' + names(hut).join(',') + ' | pendingBreaches ' + api.nav.reach.status().pendingBreaches)
    L('reach status: ' + JSON.stringify(api.nav.reach.status().stats))
    // 6. take the hut down again (from the inside, top first), pick the cobble up
    S.setMoves(false)
    for (const c of hut.slice().reverse()) { const b = bot.blockAt(c); if (b && b.boundingBox === 'block') { try { const tool = bot.inventory.items().find(i => /_axe$|_pickaxe$/.test(i.name) && (HUTB === 'cobblestone' ? /pickaxe/ : /_axe$/).test(i.name)); if (tool) await bot.equip(tool, 'hand'); await bot.dig(b) } catch (e) { L('dismantle ' + e.message) } } }
    await S.pickup(8, 5000)
    L('hut dismantled: ' + names(hut).join(',') + ' cobble now ' + S.count('cobblestone'))
  } catch (e) {
    L('ERROR ' + (e && e.stack || e))
  } finally {
    L('DONE; pos ' + bot.entity.position.toString() + ' hp ' + bot.health + '; autopilot resumes by itself (enabled ' + ap.enabled + ')')
    T.running = false
  }
} })
return 'hut test queued from ' + startPos + '; log in brain/state/reach-test.log'
