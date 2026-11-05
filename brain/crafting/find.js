// "find <thing>": what the bot carries, the chests that hold it (chest-index.json) and matching blocks in the loaded world,
// nearest first. Read only: moves nothing, opens nothing. The full list goes to brain/state/find-last.txt.
//
// Name handling (names.js): "glass" is searched as "glass" (never "glas"); "planks" finds every *_planks; if the exact name turns up
// nothing anywhere the search widens to longer names that contain it ("glass" -> glass_pane, tinted_glass ...).
const fs = require('fs')
const { resolve, pretty } = require('./names')
const { dimOf } = require('../util')

const r1 = (n) => Math.round(n)
const fmtPos = (p) => `${p.x},${p.y},${p.z}`

module.exports = function createFinder({ api, chests, config, outFile }) {
  const { bot } = api
  const reg = bot.registry
  const itemNames = new Set(reg.itemsArray.map(i => i.name))
  const blockNames = new Set(reg.blocksArray.map(b => b.name))
  const clip = (t) => String(t).slice(0, 230)

  // which item and block names does the text stand for? (null when it stands for nothing)
  function names(what) {
    const it = resolve(itemNames, what), bl = resolve(blockNames, what)
    const rank = Math.min(it.rank == null ? 9 : it.rank, bl.rank == null ? 9 : bl.rank)
    if (rank === 9) return null
    // same-tier matches of either kind; a typo match (rank 3) is only used when nothing better exists
    const use = (r) => r.rank != null && (r.rank <= 1 ? rank <= 1 : r.rank === rank) ? r.matches : []
    return { rank, items: use(it), blocks: use(bl), wideItems: it.inside.filter(n => !use(it).includes(n)), wideBlocks: bl.inside.filter(n => !use(bl).includes(n)) }
  }
  const knows = (what) => !!names(what)

  function search(what) {
    const nm = names(what)
    if (!nm) return null
    const me = bot.entity.position
    const run = (itemList, blockList) => {
      const bag = new Map()
      for (const i of bot.inventory.items()) if (itemList.includes(i.name)) bag.set(i.name, (bag.get(i.name) || 0) + i.count)
      const hits = []
      const chestHits = []
      if (itemList.length && dimOf(bot) !== 'nether' && dimOf(bot) !== 'the_end') {
        for (const e of chests.entries()) {
          const found = Object.entries(e.items).filter(([n]) => itemList.includes(n))
          if (!found.length) continue
          const total = found.reduce((s, [, n]) => s + n, 0)
          const d = me.distanceTo(e.pos.offset(0.5, 0.5, 0.5))
          chestHits.push({ kind: 'chest', pos: e.pos, dist: d, counts: Object.fromEntries(found), total })
        }
      }
      const blockHits = []
      let blocksTotal = 0, capped = false
      const ids = blockList.map(n => reg.blocksByName[n] && reg.blocksByName[n].id).filter(x => x != null)
      if (ids.length) {
        const cap = config.findBlockCount || 600
        const pts = bot.findBlocks({ matching: ids, maxDistance: config.findRadius || 128, count: cap }) || []
        capped = pts.length >= cap
        blocksTotal = pts.length
        pts.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
        const groups = []
        for (const p of pts) { const g = groups.find(g => g.pts.some(q => q.distanceTo(p) <= 6)); if (g) g.pts.push(p); else groups.push({ pts: [p], first: p }) }
        for (const g of groups) {
          const b = bot.blockAt(g.first)
          blockHits.push({ kind: 'block', pos: g.first, dist: me.distanceTo(g.first.offset(0.5, 0.5, 0.5)), n: g.pts.length, name: b ? b.name : blockList[0], area: bounds(g.pts) })
        }
      }
      hits.push(...chestHits, ...blockHits)
      hits.sort((a, b) => a.dist - b.dist)
      return { bag, hits, chestHits, blockHits, blocksTotal, capped }
    }
    let r = run(nm.items, nm.blocks), widened = false
    if (!r.bag.size && !r.hits.length && (nm.wideItems.length || nm.wideBlocks.length)) {
      r = run(nm.wideItems, nm.wideBlocks); widened = !!(r.bag.size || r.hits.length)
    }
    return { what, nm, widened, ...r }
  }

  function bounds(pts) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), zs = pts.map(p => p.z)
    return { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)], z: [Math.min(...zs), Math.max(...zs)] }
  }

  function describe(res) {
    const label = pretty(res.nm.items[0] || res.nm.blocks[0] || res.what)
    const parts = []
    const bagTotal = [...res.bag.values()].reduce((s, n) => s + n, 0)
    if (bagTotal) parts.push(`I carry ${bagTotal}${res.bag.size > 1 || res.widened ? ' (' + [...res.bag].slice(0, 2).map(([n, c]) => `${c} ${pretty(n)}`).join(', ') + ')' : ''}`)
    const shown = res.hits.slice(0, 4).map(h => h.kind === 'chest'
      ? `${r1(h.dist)}m chest ${fmtPos(h.pos)} has ${Object.entries(h.counts).slice(0, 2).map(([n, c]) => `${c} ${pretty(n)}`).join(', ')}`
      : `${r1(h.dist)}m ${h.n} ${pretty(h.name)} at ${fmtPos(h.pos)}`)
    parts.push(...shown)
    if (res.hits.length > shown.length) parts.push(`+${res.hits.length - shown.length} more`)
    if (!parts.length) {
      const nChests = chests.entries().length
      return clip(`No ${label} in my bag${nChests ? `, in the ${nChests} indexed chests` : ''} or within ${config.findRadius || 128} blocks.${nChests ? '' : ' (say "index chests" so I can search chests too)'}`)
    }
    return clip(`${res.widened ? 'No exact match; closest names. ' : ''}${label}: ${parts.join('; ')}.`)
  }

  function writeFull(res) {
    if (!outFile) return
    const L = [`find ${res.what} (${new Date(api.now()).toISOString()}), bot at ${fmtPos(bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position)}`]
    L.push(`items: ${res.nm.items.join(', ') || '-'}; blocks: ${res.nm.blocks.join(', ') || '-'}${res.widened ? ' (widened)' : ''}`)
    L.push(`bag: ${[...res.bag].map(([n, c]) => `${c} ${n}`).join(', ') || 'none'}`)
    L.push('', 'nearest first:')
    for (const h of res.hits) L.push(h.kind === 'chest' ? `${r1(h.dist)}m chest ${fmtPos(h.pos)}: ${Object.entries(h.counts).map(([n, c]) => `${c} ${n}`).join(', ')}` : `${r1(h.dist)}m ${h.n}x ${h.name} from ${fmtPos(h.pos)} (x ${h.area.x.join('..')}, y ${h.area.y.join('..')}, z ${h.area.z.join('..')})`)
    if (res.capped) L.push(`(block search stopped at ${config.findBlockCount} blocks; narrower names list everything)`)
    try { fs.writeFileSync(outFile, L.join('\n')) } catch {}
  }

  function run(what) {
    const res = search(what)
    if (!res) return api.say(clip(`I don't know a block or item called "${what}".`))
    writeFull(res)
    api.say(describe(res))
    return res
  }

  return { knows, search, describe, run, names }
}
