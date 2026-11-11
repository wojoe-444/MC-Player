// brain/schematic/store.js: where schematics live. Pure file I/O, no bot.
//   brain/schematic/library/<id>.json   ships with the code (captured from worlds Walter reopened, authored designs): every bot and the dashboard see them
//   <shared>/schematics/<id>.json       bot-shared/, written by whichever bot captured it, seen by both bots and the dashboard
//   <state>/schematics/<id>.json        one bot's own captures
// A later directory wins over an earlier one for the same id.
'use strict'
const fs = require('fs')
const path = require('path')

const LIBRARY = path.join(__dirname, 'library')
const safeId = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return null } }

function dirsFor({ sharedDir, stateDir } = {}) { return [LIBRARY, sharedDir && path.join(sharedDir, 'schematics'), stateDir && path.join(stateDir, 'schematics')].filter(Boolean) }

function list(dirs) {
  const byId = new Map()
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(d).filter(f => f.endsWith('.json')) } catch { continue }
    for (const f of files) { const s = readJson(path.join(d, f)); if (s && s.v === 1 && s.id && Array.isArray(s.rle)) byId.set(s.id, { file: path.join(d, f), schematic: s }) }
  }
  return [...byId.values()]
}
function load(dirs, id) { const e = list(dirs).find(x => x.schematic.id === id); return e ? e.schematic : null }
function save(dir, s) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, safeId(s.id) + '.json'), tmp = f + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, f)
  return f
}
module.exports = { LIBRARY, dirsFor, list, load, save, safeId }
