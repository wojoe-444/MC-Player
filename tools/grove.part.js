    // tree farm (Walter: birch, saplings with 3 blocks between them, well lit): a 4-block lattice around home, a torch in the middle of each
    // lattice square, every sapling spot needs open sky above for the tree; spots are remembered and replanted when a tree is felled
    { id: 'grove', budget: 180000, need: () => !!home() && S.items().some(i => /_sapling$/.test(i.name)) && (st.grove || []).filter(q => { const b = S.block(v(q[0], q[1], q[2])); return b && (/_sapling$|_log$/.test(b.name)) }).length < 24 && !S.isNight(), cool: 90000, run: async () => {
      const h = home(); st.grove = (st.grove || [])
      const live = (q) => { const b = S.block(v(q[0], q[1], q[2])); return b && /_sapling$|_log$/.test(b.name) }
      const spots = []
      for (let dx = -20; dx <= 20; dx++) for (let dz = -20; dz <= 20; dz++) {
        if (((dx % 4) + 4) % 4 || ((dz % 4) + 4) % 4) continue
        const d = Math.hypot(dx, dz); if (d < 8 || d > 20) continue
        for (let dy = 8; dy >= -10; dy--) {
          const p = v(h.x + dx, h.y + dy, h.z + dz), g = S.block(p.offset(0, -1, 0)), c = S.block(p)
          if (!g || !c) continue
          if (S.isAir(c) && /^(grass_block|dirt|podzol|coarse_dirt)$/.test(g.name)) {
            let open = true; for (let k = 1; k <= 6 && open; k++) { const a = S.block(p.offset(0, k, 0)); if (a && !S.isAir(a) && !/leaves/.test(a.name)) open = false }
            if (open && !(st.farm || []).some(q => Math.abs(q[0] - p.x) <= 2 && Math.abs(q[2] - p.z) <= 2)) spots.push(p)
            break
          }
          if (!S.isAir(c)) break
        }
      }
      spots.sort((p, q) => S.dist(p) - S.dist(q))
      let planted = 0
      for (const p of spots) {
        if (planted >= 6) break
        if (live([p.x, p.y, p.z])) continue
        const sap = S.items().filter(i => /_sapling$/.test(i.name)).sort((a, b) => (/birch/.test(b.name) ? 1 : 0) - (/birch/.test(a.name) ? 1 : 0))[0]; if (!sap) break
        const r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, ms: 30000 }); if (!r.ok) continue
        if (await S.placeAgainst(S.block(p.offset(0, -1, 0)), v(0, 1, 0), sap.name)) {
          if (!st.grove.some(q => q[0] === p.x && q[2] === p.z)) st.grove.push([p.x, p.y, p.z])
          planted++
          // light the square: a torch two blocks off the sapling, on the diagonal (between four lattice spots)
          const tp = p.offset(2, 0, 2), tg = S.block(tp.offset(0, -1, 0)), tc = S.block(tp)
          if (cnt('torch') > 2 && tg && S.solid(tg) && tc && S.isAir(tc) && !bot.findBlock({ matching: ids(/^(torch|wall_torch)$/), maxDistance: 3, point: tp })) await S.placeAgainst(tg, v(0, 1, 0), 'torch')
        }
      }
      G.save(); note(`grove: planted ${planted}, ${st.grove.filter(live).length} live trees/saplings on the lattice`)
      return planted > 0 } },
