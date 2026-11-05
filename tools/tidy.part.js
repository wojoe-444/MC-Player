  // ---- scaffolding is incidental, not established (Walter's screenshots: cobble pillars, holes and stray blocks around the house) ----
  // every block the bot places (its own placing, the pathfinder's scaffolding, nav pillars) is remembered; plain scaffold blocks that are
  // still there after 10 minutes, on the surface and outside the home/farm, are taken down again, top first.
  if (!bot._placeLogPatched) {
    bot._placeLogPatched = true
    const orig = bot.placeBlock.bind(bot)
    bot.placeBlock = async function (ref, face, ...rest) {
      const held = bot.heldItem && bot.heldItem.name
      const r = await orig(ref, face, ...rest)
      try { const p = ref.position.plus(face); const sx = bot._ap && bot._ap.G && bot._ap.G.state; if (sx && held) { sx.placed = (sx.placed || []).concat([[p.x, p.y, p.z, held, Date.now()]]).slice(-600) } } catch {}
      return r
    }
  }
  const SCAFFOLD = /^(cobblestone|cobbled_deepslate|dirt|andesite|diorite|granite|tuff|netherrack|stone)$/
  const tidyList = () => {
    const hb = homeBox(), now = Date.now()
    return (st.placed || []).filter(q => now - q[4] > 10 * 60000 && SCAFFOLD.test(q[3])).map(q => v(q[0], q[1], q[2])).filter(p => {
      const b = S.block(p); if (!b || !SCAFFOLD.test(b.name)) return false
      if (inBox(p, hb) || nearList(p, st.farm, 1) || nearList(p, st.grove, 1)) return false
      if (st.mine && st.mine.entry && Math.abs(p.x - st.mine.entry[0]) <= 3 && Math.abs(p.z - st.mine.entry[2]) <= 3) return false
      const below = S.block(p.offset(0, -1, 0)), above = S.block(p.offset(0, 1, 0))
      if (below && below.name === 'water') return false                         // sea paths: taking them apart from on top of them means swimming
      if (above && !S.isAir(above)) return false                                // something stands on it (a torch, a block, a plant)
      return S.skyVisible ? true : true
    }).sort((p, q) => q.y - p.y)
  }
  steps.push({ id: 'tidy', budget: 150000, cool: 300000, need: () => !S.isNight() && !!home() && tier('pickaxe') >= 1 && tidyList().length > 0, run: async () => {
    let n = 0
    for (const p of tidyList().slice(0, 24)) {
      const b = S.block(p); if (!b) continue
      if (S.flo(bot.entity.position).offset(0, -1, 0).equals(p)) continue       // never the block it stands on
      if (await S.mine(b, { dig: false })) n++
    }
    st.placed = (st.placed || []).filter(q => { const b = S.block(v(q[0], q[1], q[2])); return !b || !S.isAir(b) })
    G.save(); note('tidy: took down ' + n + ' scaffold blocks'); return n > 0 } })

