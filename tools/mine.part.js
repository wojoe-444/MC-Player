    { id: 'iron', budget: 600000, need:() => tier('pickaxe') >= 2 && spareTools() && cnt('torch') >= 12 && S.foodPoints() + S.rawFood() * 2 >= 6 && ironUnits() < 32 && S.freeSlots() > 6 && !!home(), cool: 60000, run: async () => {
      // ONE established mine (Walter: a player builds one staircase and routes to it, instead of breaching the surface again and again).
      // st.mine = { entry: surface cell where the staircase starts, bottom: where it ends, path: cells walked on the way down }.
      // Going down = walk to the entry and down the existing stairs; only the very first trip (or a lost shaft) digs a new one.
      // Underground everything is free: tunnels branch from the bottom in turn.
      const h = home(), y = Math.floor(bot.entity.position.y)
      if (y > 56) {
        if (st.mine && st.mine.bottom) {
          const e = v(...st.mine.entry), b = v(...st.mine.bottom)
          await S.goto(new goals.GoalNear(e.x, e.y, e.z, 2), { dig: false, ms: 120000 })
          const r = await S.goto(new goals.GoalNear(b.x, b.y, b.z, 2), { dig: false, ms: 150000 })
          note(`mine: walked down the shaft to y${Math.floor(bot.entity.position.y)} (${r.ok ? 'ok' : r.err || r.why})`)
          if (!r.ok && Math.floor(bot.entity.position.y) > 56) { st.mine.fails = (st.mine.fails || 0) + 1; if (st.mine.fails >= 3) { note('mine: the shaft is lost, a new one will be dug'); st.mine = null } G.save(); return false }
        } else {
          // the first shaft: next to home (not inside the house), away from places where the bot died
          const OFF = [[6, 6], [-10, 6], [10, -10], [-10, -10], [0, 16], [16, 0], [-16, 0], [0, -16]], near = (x, z) => (st.avoid || []).some(q => Math.hypot(q[0] - x, q[2] - z) < 12)
          let k = 0; while (k < OFF.length && near(h.x + OFF[(st.mineSpot || 0) % OFF.length][0], h.z + OFF[(st.mineSpot || 0) % OFF.length][1])) { st.mineSpot = (st.mineSpot || 0) + 1; k++ }
          const o = OFF[(st.mineSpot || 0) % OFF.length]
          await S.goto(new goals.GoalNear(h.x + o[0], h.y, h.z + o[1], 3), { dig: false, ms: 90000 })
          const entry = bot.entity.position.floored(), dir0 = st.mineDir == null ? 0 : st.mineDir
          const r = await M.descend(20, { maxSteps: 120, dir0 })
          const bottom = bot.entity.position.floored()
          note('mine: dug the shaft from ' + entry + ' down to y' + bottom.y + ' ' + JSON.stringify(r))
          if (bottom.y > 56) return false
          st.mine = { entry: [entry.x, entry.y, entry.z], bottom: [bottom.x, bottom.y, bottom.z], dir0, since: Date.now() }
          G.save()
        }
      }
      st.mineDir = ((st.mineDir || 0) + 1) % 4
      const before = ironUnits()
      const t = await M.tunnel(st.mineDir, 40, { targets: /^(deepslate_)?(iron|coal|copper|gold|diamond|redstone|lapis)_ore$/, torchEvery: 6, stop: () => S.freeSlots() <= 4 || cnt('torch') < 4 || bot.food <= 8 })
      note(`mine: tunnel ${t.len} blocks, mined ${t.mined}, iron +${ironUnits() - before} (${t.reason})`)
      // blocked tunnels (water, lava): just branch another way next time, from the same shaft bottom; no new surface breach
      if (t.len === 0 && /water|lava|hazard|clear-fail|blocked/.test(String(t.reason))) { st.mineBlocked = (st.mineBlocked || 0) + 1; G.save() } else st.mineBlocked = 0
      if (S.freeSlots() <= 4 || cnt('torch') < 4 || bot.food <= 8 || ironUnits() >= 24) { const up = await M.goSurface(); note('mine: back up ' + up) }
      return true } }
