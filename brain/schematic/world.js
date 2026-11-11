// brain/schematic/world.js: read blocks (name + properties) from a world save's region files, for capturing a schematic from a save and for diffing a build
// against one. A tool for people and agents, not a sense of the bot (the bot captures from the chunks it has loaded, brain/schematic/index.js).
// A save is as fresh as Minecraft's last write: it flushes chunks on autosave and when they unload.
'use strict'
const fs = require('fs')
const path = require('path')
const { readChunk } = require('../../dashboard/worldcast')

function unpack(sec) {
  const bs = sec.block_states
  if (!bs || !Array.isArray(bs.palette) || !bs.palette.length) return null
  const pal = bs.palette
  if (pal.length === 1 || !bs.data) return { pal, ids: null }
  const bits = Math.max(4, Math.ceil(Math.log2(pal.length))), per = Math.floor(64 / bits), mask = (1n << BigInt(bits)) - 1n
  const ids = new Uint16Array(4096)
  for (let i = 0; i < 4096; i++) ids[i] = Number((BigInt.asUintN(64, bs.data[Math.floor(i / per)]) >> BigInt((i % per) * bits)) & mask)
  return { pal, ids }
}

function openSave(saveDir) {
  const fds = new Map(), chunks = new Map()
  const fd = (rx, rz) => { const k = rx + ',' + rz; if (!fds.has(k)) { let f = null; try { f = fs.openSync(path.join(saveDir, 'region', `r.${rx}.${rz}.mca`), 'r') } catch { /* not generated */ } fds.set(k, f) } return fds.get(k) }
  const chunk = (cx, cz) => {
    const k = cx + ',' + cz
    if (chunks.has(k)) return chunks.get(k)
    let out = null
    const f = fd(cx >> 5, cz >> 5)
    if (f != null) { let ch = null; try { ch = readChunk(f, cx, cz) } catch { ch = null }; if (ch && Array.isArray(ch.sections)) { const secs = new Map(); for (const s of ch.sections) secs.set(s.Y, unpack(s)); out = { secs, be: ch.block_entities || [], raw: ch } } }
    chunks.set(k, out)
    return out
  }
  // -> { name, props } | null when the chunk is not in the save
  const get = (x, y, z) => {
    const c = chunk(x >> 4, z >> 4); if (!c) return null
    const s = c.secs.get(y >> 4)
    if (!s) return { name: 'minecraft:air', props: {} }
    const p = s.ids ? s.pal[s.ids[(x & 15) + 16 * (z & 15) + 256 * (y & 15)]] : s.pal[0]
    return { name: p.Name, props: p.Properties || {} }
  }
  const blockEntities = (cx, cz) => { const c = chunk(cx, cz); return c ? c.be : [] }
  return { get, chunk, blockEntities, close() { for (const f of fds.values()) if (f != null) fs.closeSync(f) } }
}
module.exports = { openSave, unpack }
