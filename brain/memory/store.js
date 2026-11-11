// brain/memory/store: the bot's own memory folder, with hard size caps (docs/MEMORY-LOOP.md, "Memory on disk").
//
//   brain/state/memory/global.md        what the bot wants to know every morning. At most 60 lines, five fixed sections.
//   brain/state/memory/notes/<topic>.md detail, read on demand. At most 10 files of 150 lines.
//   (the folder is a small local git repo: every accepted write is a commit, so a bad edit can be seen and undone)
//
// The caps are the point (the article: 413 files earned one badge, nine files and a global.md earned four). A write that would pass a cap is refused
// and the writer is told, so it has to cut or move something down first. Nothing here calls a model. Pure text functions first, then the files.
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const CAPS = { globalLines: 60, notes: 10, noteLines: 150, nowLines: 6, projectLines: 12, lineChars: 220, addsPerBrief: 2, rule: 160, evidence: 200, check: 120 }
const S_NOW = 'Now', S_POL = 'Policies', S_TRAPS = 'Traps', S_MINE = 'My own projects and wishes', S_HOW = 'How I use this folder'
const SECTIONS = [S_NOW, S_POL, S_TRAPS, S_MINE, S_HOW]
const HEAD = { [S_POL]: 'Policies (rule | how I know | check)' }
const EMPTY = { [S_NOW]: '(No plan yet. The first dawn brief writes this.)', [S_TRAPS]: '(None recorded yet.)', [S_MINE]: '(Mine to fill in. Nobody else edits this section.)' }

const clean = (s, n = CAPS.lineChars) => { s = String(s == null ? '' : s).replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
// long text -> lines of at most `width`, broken after a sentence when there is one, else at a space (a model writes "Now" as one paragraph)
function wrap(text, max, width = CAPS.lineChars) {
  const out = []
  for (const para of String(text || '').split(/\r?\n/)) {
    let rest = para.replace(/[|\s]+/g, ' ').trim()
    while (rest.length > width) {
      const head = rest.slice(0, width + 1)
      let at = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; ')) + 1
      if (at < width * 0.4) at = head.lastIndexOf(' ')
      if (at <= 0) at = width
      out.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim()
    }
    if (rest) out.push(rest)
  }
  return out.slice(0, max)
}
const bare = (l) => String(l).replace(/^\s*[-*]\s+/, '').trim()
const keyOf = (title) => { const t = String(title).trim().toLowerCase(); return SECTIONS.find(s => t === s.toLowerCase() || t.startsWith(s.toLowerCase() + ' ')) || null }

// global.md text -> { Now: [lines], Policies: [...], ... } (unknown headings are dropped: the five sections are the shape)
function parse(text) {
  const out = Object.fromEntries(SECTIONS.map(s => [s, []]))
  let cur = null
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const h = /^#\s+(.*)$/.exec(raw)
    if (h) { cur = keyOf(h[1]); continue }
    const line = raw.trimEnd()
    if (cur && line.trim() && !Object.values(EMPTY).includes(line.trim())) out[cur].push(line)
  }
  return out
}
function render(sections) {
  const L = []
  for (const s of SECTIONS) { L.push(`# ${HEAD[s] || s}`); const lines = (sections[s] || []).filter(l => String(l).trim()); L.push(...(lines.length ? lines : EMPTY[s] ? [EMPTY[s]] : [])); L.push('') }
  return L.join('\n')
}
const lineCount = (text) => String(text || '').split('\n').filter(l => l.trim()).length

// The first global.md: the parts of the old seed strategy that still hold under today's rules, each marked untested. Standing rules are not copied in:
// they are generated from rules.json and handed to every brief, so they cannot go stale here.
function seed() {
  return render({
    [S_NOW]: [],
    [S_POL]: [
      '- Be home or sealed in before dark | from the first strategy file, untested | deaths at night per day',
      '- Eat before food drops under 14 and keep a stack of food | from the first strategy file, untested | stalls or deaths with food under 6',
      '- Carry torches and blocks underground and light what I walk through | from the first strategy file, untested | deaths in the dark',
      '- One laddered shaft per area with rooms off it, no new staircases | Walter\'s taste rule (2026-11-10) | new stairwells in the journal',
    ],
    [S_TRAPS]: [],
    [S_MINE]: [],
    [S_HOW]: [
      '- This is what I want to know every morning: my plan, rules I have tested, and traps. I read it at every dawn brief.',
      '- A rule goes in with how I know it and how I would check it. A rule I have not tested says so.',
      '- I do not keep what I can see for myself (bag, position, chests) or what the journal already records.',
      '- Detail goes in notes/<topic>.md with a one-line pointer here. This file stays under 60 lines.',
    ],
  })
}

// Apply a brief's edits to global.md text. Pure. edits: { now, projects, addPolicies: [{ rule, evidence, check }], addTraps: [text], remove: [line text] }
// The brief owns Now and My own projects. It may add to Policies and Traps (with evidence) and remove lines from those two. -> { text, refused: [why], changed }
function applyEdits(text, edits = {}) {
  const sec = parse(text), refused = []
  const before = render(sec)
  const lines = (s, max) => wrap(s, max)
  if (typeof edits.now === 'string' && edits.now.trim()) sec[S_NOW] = lines(edits.now, CAPS.nowLines)
  if (typeof edits.projects === 'string') sec[S_MINE] = lines(edits.projects, CAPS.projectLines).map(l => (/^[-*] /.test(l) ? l : `- ${l}`))
  for (const r of (Array.isArray(edits.remove) ? edits.remove : [])) {
    const want = bare(clean(r, 400)).toLowerCase(); if (!want) continue
    let hit = false
    for (const s of [S_POL, S_TRAPS]) { const n = sec[s].length; sec[s] = sec[s].filter(l => { const b = bare(l).toLowerCase(); return !(b === want || b.split(' | ')[0] === want) }); if (sec[s].length !== n) hit = true }
    if (!hit) refused.push(`remove: no policy or trap line reads "${clean(r, 80)}"`)
  }
  const afterRemoves = { ...sec, [S_POL]: sec[S_POL].slice(), [S_TRAPS]: sec[S_TRAPS].slice() }
  let adds = 0
  for (const p of (Array.isArray(edits.addPolicies) ? edits.addPolicies : []).slice(0, CAPS.addsPerBrief)) {
    const rule = clean(p && p.rule, CAPS.rule), ev = clean(p && p.evidence, CAPS.evidence), check = clean(p && p.check, CAPS.check)
    if (!rule) continue
    if (ev.length < 8) { refused.push(`policy "${clean(rule, 60)}": no evidence given (say how you know, or that it is untested)`); continue }
    if (sec[S_POL].some(l => bare(l).split(' | ')[0].toLowerCase() === rule.toLowerCase())) { refused.push(`policy "${clean(rule, 60)}": already there (remove the old line to replace it)`); continue }
    sec[S_POL].push(`- ${rule} | ${ev} | ${check || 'no check yet'}`); adds++
  }
  for (const t of (Array.isArray(edits.addTraps) ? edits.addTraps : []).slice(0, CAPS.addsPerBrief)) {
    const line = clean(t, 200); if (!line) continue
    if (sec[S_TRAPS].some(l => bare(l).toLowerCase() === bare(line).toLowerCase())) continue
    sec[S_TRAPS].push(`- ${bare(line)}`); adds++
  }
  let out = render(sec)
  if (lineCount(out) > CAPS.globalLines && adds) {         // over the cap: the additions are refused, the rest of the edit stands
    refused.push(`${adds} addition${adds === 1 ? '' : 's'} refused: global.md would be ${lineCount(out)} lines, the cap is ${CAPS.globalLines}. Remove or merge lines, or move detail into a note, then add again.`)
    out = render(afterRemoves)
  }
  return { text: out, refused, changed: out !== before, lines: lineCount(out) }
}

function createStore({ dir, git = true, author = 'bot', log = () => {} } = {}) {
  const globalFile = path.join(dir, 'global.md'), notesDir = path.join(dir, 'notes')
  let gitOk = null
  const run = (args) => execFileSync('git', ['-c', `user.name=${author}`, '-c', 'user.email=bot@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  function commit(message) {
    if (!git || gitOk === false) return false
    try {
      if (gitOk === null) { if (!fs.existsSync(path.join(dir, '.git'))) run(['init', '-q']); gitOk = true }
      run(['add', '-A', '--', 'global.md', 'notes'])
      if (!run(['status', '--porcelain', '--', 'global.md', 'notes']).trim()) return false
      run(['commit', '-q', '-m', String(message).slice(0, 300)])
      return true
    } catch (e) { if (gitOk === null) { gitOk = false; log('memory: no git history (' + String(e.message).split('\n')[0].slice(0, 80) + ')') } return false }
  }
  function ensure() {
    fs.mkdirSync(notesDir, { recursive: true })
    if (!fs.existsSync(globalFile)) { fs.writeFileSync(globalFile, seed()); commit('seed global.md from the first strategy file, corrected to today\'s rules'); return true }
    return false
  }
  const readGlobal = () => { try { return fs.readFileSync(globalFile, 'utf8') } catch { return '' } }
  // any writer other than a brief (the dream, later): whole-file write, same caps, and the bot's own section must come back unchanged
  function writeGlobal(text, why, { owner = false } = {}) {
    const next = render(parse(text))
    if (lineCount(next) > CAPS.globalLines) return { ok: false, error: `global.md would be ${lineCount(next)} lines, the cap is ${CAPS.globalLines}` }
    if (!owner && parse(next)[S_MINE].join('\n') !== parse(readGlobal())[S_MINE].join('\n')) return { ok: false, error: `"${S_MINE}" belongs to the bot and was changed` }
    fs.writeFileSync(globalFile, next); commit(why || 'global.md'); return { ok: true, lines: lineCount(next) }
  }
  function applyBrief(edits, why) {
    const r = applyEdits(readGlobal() || seed(), edits)
    if (r.changed) { fs.writeFileSync(globalFile, r.text); commit(why || 'dawn brief') }
    return r
  }
  const notes = () => { try { return fs.readdirSync(notesDir).filter(f => f.endsWith('.md')).sort().map(f => ({ name: f.slice(0, -3), lines: lineCount(fs.readFileSync(path.join(notesDir, f), 'utf8')) })) } catch { return [] } }
  const readNote = (name) => { try { return fs.readFileSync(path.join(notesDir, `${slug(name)}.md`), 'utf8') } catch { return null } }
  function writeNote(name, text, why) {
    const n = slug(name); if (!n) return { ok: false, error: 'a note needs a name' }
    const body = String(text || '').replace(/\r/g, '').trim()
    if (!body) return { ok: false, error: 'an empty note' }
    if (body.split('\n').length > CAPS.noteLines) return { ok: false, error: `note ${n} would be ${body.split('\n').length} lines, the cap is ${CAPS.noteLines}` }
    const have = notes().map(x => x.name)
    if (!have.includes(n) && have.length >= CAPS.notes) return { ok: false, error: `there are already ${CAPS.notes} notes (${have.join(', ')}): merge or delete one first` }
    fs.mkdirSync(notesDir, { recursive: true }); fs.writeFileSync(path.join(notesDir, `${n}.md`), body + '\n'); commit(why || `note ${n}`)
    return { ok: true, name: n }
  }
  function removeNote(name, why) { const f = path.join(notesDir, `${slug(name)}.md`); if (!fs.existsSync(f)) return false; fs.unlinkSync(f); commit(why || `remove note ${slug(name)}`); return true }
  return { dir, globalFile, ensure, readGlobal, writeGlobal, applyBrief, notes, readNote, writeNote, removeNote, commit }
}
const slug = (s) => String(s || '').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

module.exports = { createStore, parse, render, seed, applyEdits, lineCount, slug, wrap, CAPS, SECTIONS, S_NOW, S_POL, S_TRAPS, S_MINE, S_HOW }
