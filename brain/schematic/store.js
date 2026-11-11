// brain/schematic/store.js: where schematics live. Pure file I/O, no bot.
//   brain/schematic/library/<id>.json   ships with the code (captured from worlds Walter reopened, authored designs): every bot and the dashboard see them
//   <shared>/schematics/<id>.json       bot-shared/, written by whichever bot captured it, seen by both bots and the dashboard
//   <state>/schematics/<id>.json        one bot's own captures
// A later directory wins over an earlier one for the same id.
// A file is a schematic of one or more VARIANTS (variants.js): a flat format 1/2 file is the single variant Main, a format 3 file lists them. `list` and `load` give readers
// the flat format 2 schematic of one variant (the default, or the one asked for); `listDocs` / `loadDoc` give the whole collection.
'use strict'
const fs = require('fs')
const path = require('path')
const V = require('./variants')

const LIBRARY = path.join(__dirname, 'library')
const safeId = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return null } }

function dirsFor({ sharedDir, stateDir } = {}) { return [LIBRARY, sharedDir && path.join(sharedDir, 'schematics'), stateDir && path.join(stateDir, 'schematics')].filter(Boolean) }

const docOf = (file) => V.normalize(readJson(file))
// every schematic as its whole collection of variants: [{ file, doc }]
function listDocs(dirs) {
  const byId = new Map()
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(d).filter(f => f.endsWith('.json')) } catch { continue }
    for (const f of files) { const doc = docOf(path.join(d, f)); if (doc) byId.set(doc.id, { file: path.join(d, f), doc }) }
  }
  return [...byId.values()]
}
// [{ file, schematic }]: the flat format 2 schematic of each one's default variant (with `variants` listing all of them)
function list(dirs) { return listDocs(dirs).map(({ file, doc }) => ({ file, schematic: V.project(doc) })) }
// a later directory wins; the file is normally named after the id, so only that one is read (list() parses every file, which is megabytes with the big imports)
function loadDoc(dirs, id) {
  const name = safeId(id) + '.json'
  let found = null
  for (const d of dirs) { const doc = docOf(path.join(d, name)); if (doc && doc.id === id) found = { file: path.join(d, name), doc } }
  if (found) return found
  return listDocs(dirs).find(x => x.doc.id === id) || null
}
function load(dirs, id, variant) { const e = loadDoc(dirs, id); return e ? V.project(e.doc, variant) : null }
function save(dir, s) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, safeId(s.id) + '.json'), tmp = f + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, f)
  return f
}
// a whole format 3 document (all variants)
function saveDoc(dir, doc) { return save(dir, doc) }
module.exports = { LIBRARY, dirsFor, list, listDocs, load, loadDoc, save, saveDoc, safeId }
