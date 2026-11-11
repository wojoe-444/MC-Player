// brain/schematic: the bot's ability to SAVE a schematic of something that stands in the world, and to check a build against one. An observer: it reads blocks the
// bot has loaded (the same blocks it sees), never moves, never touches a block.
//   bot._schematic.capture({ id, name?, kind?, purpose?, box | room, seeds?, masks? })  -> { ok, file, schematic } | { ok:false, why }
//        box   { x0,y0,z0,x1,y1,z1 } world cells; every chunk column of it must be loaded
//        room  a registry room id: its box (plus a margin) is captured and the room record gets `schematic: id`, so brain/inspect diffs it cell by cell from then on
//        seeds cells inside the build: only open space connected to them is the build (a farm in the open is not the forest around it)
//   bot._schematic.diff(id, at?)  -> brain/schematic/format.js diff against the loaded world
//   bot._schematic.list()
// What is stored is roles, not block names, wherever the name does not matter (see blocks.js): "a solid, light-blocking, non-flammable block" instead of cobblestone.
// Walter 2026-11-11: the improvement loop needs to be able to save a schematic of a working build, and to check the next one against it.
'use strict'
const fs = require('fs')
const path = require('path')
const F = require('./format')
const S = require('./store')
const grid = require('../inspect/grid')

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const stateDir = path.dirname(api.statePath('x'))
  const sharedDir = process.env.BOT_SHARED || path.join(__dirname, '..', '..', '..', 'bot-shared')
  const registryFile = api.registryFile || process.env.BOT_REGISTRY || path.join(sharedDir, 'registry.json')
  const dirs = () => S.dirsFor({ sharedDir, stateDir })
  const MAX_CELLS = 400000

  const readReg = () => { try { return JSON.parse(fs.readFileSync(registryFile, 'utf8')) } catch { return null } }
  const roomBox = (id) => { const reg = readReg(); if (reg && reg.worlds) for (const w of Object.values(reg.worlds)) for (const r of (w.rooms || [])) if (r.id === id && r.box) return { room: r, box: r.box, reg } ; return null }
  const liveGet = () => { const at = grid.liveBlockAt(bot); return (x, y, z) => { const b = at(x, y, z); return b ? { name: b.name, props: b.props || {} } : null } }

  function capture(o = {}) {
    if (!o.id) return { ok: false, why: 'give the schematic an id' }
    let box = o.box, room = null
    if (!box && o.room) { const r = roomBox(o.room); if (!r) return { ok: false, why: `no registered room "${o.room}"` }; room = r; const b = r.box; box = { x0: b.x0 - 1, y0: b.y0 - 1, z0: b.z0 - 1, x1: b.x1 + 1, y1: b.y1 + 1, z1: b.z1 + 1 } }
    if (!box) return { ok: false, why: 'give a box or a registered room' }
    const cells = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) * (box.z1 - box.z0 + 1)
    if (!(cells > 0) || cells > MAX_CELLS) return { ok: false, why: `the box has ${cells} cells (the limit is ${MAX_CELLS})` }
    if (!grid.columnsLoaded(bot, box, 0)) return { ok: false, why: 'the chunks around the box are not loaded: go there first' }
    const s = F.capture(liveGet(), box, { id: o.id, name: o.name, kind: o.kind || (room && room.room.type) || 'build', purpose: o.purpose, seeds: o.seeds, masks: o.masks,
      source: { world: o.world || 'live world', save: null, capturedAt: new Date(now()).toISOString(), by: (bot.username || 'bot') + ' (in game)' } })
    if (s.unknownCells > s.size[0] * s.size[1] * s.size[2] * 0.02) return { ok: false, why: `${s.unknownCells} cells could not be read (chunks missing)` }
    const dir = path.join(sharedDir, 'schematics')
    let file; try { file = S.save(dir, s) } catch { file = S.save(path.join(stateDir, 'schematics'), s) }
    if (room) tagRoom(o.room, s.id)
    try { if (bot._journal) bot._journal.add('schematic', { id: s.id, kindOf: s.kind, cells: cells, file: path.basename(file) }, { sal: true }) } catch { /* observer */ }
    return { ok: true, file, schematic: s }
  }
  // the room record names its blueprint, so brain/inspect compares it with that from now on (the registry is shared: re-read, change one field, write whole)
  function tagRoom(roomId, schematicId) {
    try {
      const reg = readReg(); if (!reg) return
      for (const w of Object.values(reg.worlds || {})) for (const r of (w.rooms || [])) if (r.id === roomId) r.schematic = schematicId
      fs.writeFileSync(registryFile + '.tmp', JSON.stringify(reg, null, 1)); fs.renameSync(registryFile + '.tmp', registryFile)
    } catch { /* the schematic is saved either way */ }
  }
  function diff(id, at) {
    const s = S.load(dirs(), id); if (!s) return { ok: false, why: `no schematic "${id}"` }
    const box = { x0: (at || s.origin)[0], y0: (at || s.origin)[1], z0: (at || s.origin)[2], x1: (at || s.origin)[0] + s.size[0] - 1, y1: (at || s.origin)[1] + s.size[1] - 1, z1: (at || s.origin)[2] + s.size[2] - 1 }
    if (!grid.columnsLoaded(bot, box, 0)) return { ok: false, why: 'the chunks are not loaded' }
    return { ok: true, ...F.diff(s, liveGet(), at || s.origin) }
  }
  const list = () => S.list(dirs()).map(e => ({ id: e.schematic.id, name: e.schematic.name, kind: e.schematic.kind, size: e.schematic.size, origin: e.schematic.origin, file: e.file }))

  bot._schematic = { v: 1, capture, diff, list, dirs }
  return {
    name: 'schematic',
    start() {},
    stop() { if (bot._schematic && bot._schematic.v === 1) delete bot._schematic },
    status() { return { schematics: list().length } },
    _capture: capture, _diff: diff,
  }
}
module.exports.meta = require('./meta.json')
