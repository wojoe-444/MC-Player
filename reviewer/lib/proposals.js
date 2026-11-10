// Model-written detectors: turn a pattern the reviewer judged bad into a routine flag in the bot (Walter 2026-11-10).
// The reviewer proposes { name, why, source, badWindows }. Nothing is enabled until the source passes the sandbox screen and a replay over real captured
// telemetry windows (brain/state/telemetry/windows/*.json): it must fire on the nominated bad window(s) and stay quiet on normal play. Then it is written to
// <bot>/brain/state/detectors/ with a manifest (sha256, origin) and a log line holding the full source; the bot's telemetry module hot-loads it in its vm sandbox.
// Detectors only flag. They cannot stop or change anything.
const fs = require('fs')
const path = require('path')

const MAX_DETECTORS = 12, MIN_NORMAL_WINDOWS = 3, MAX_FALSE_RATE = 0.1
const WIN_ID = /^w\d+-(normal|flagged)$/

const detDir = (bot) => path.join(bot.dir, 'brain', 'state', 'detectors')
const winDir = (bot) => path.join(bot.dir, 'brain', 'state', 'telemetry', 'windows')

// use the bot's own sandbox so validation runs exactly the code the bot will run; fall back to this repo's copy
function loadSandbox(bot) {
  for (const f of [path.join(bot.dir, 'brain', 'telemetry', 'sandbox.js'), path.join(__dirname, '..', '..', 'brain', 'telemetry', 'sandbox.js')]) {
    try { if (fs.existsSync(f)) return require(f) } catch {}
  }
  return null
}

function loadWindows(bot) {
  const out = []
  let files = []; try { files = fs.readdirSync(winDir(bot)).filter(f => f.endsWith('.json')).sort() } catch {}
  for (const f of files) { try { const w = JSON.parse(fs.readFileSync(path.join(winDir(bot), f), 'utf8')); if (WIN_ID.test(w.id) && Array.isArray(w.samples)) out.push(w) } catch {} }
  return out
}
// small digests for the prompt: no raw samples
function windowDigests(bot, max = 8) {
  return loadWindows(bot).slice(-max).map(w => ({ id: w.id, kind: w.kind, at: w.at, activeFlags: w.flags, ...w.digest }))
}

function readManifest(bot) { try { const m = JSON.parse(fs.readFileSync(path.join(detDir(bot), 'manifest.json'), 'utf8')); return Array.isArray(m.detectors) ? m : { detectors: [] } } catch { return { detectors: [] } } }
const customList = (bot) => readManifest(bot).detectors.map(d => ({ name: d.name, kind: 'custom_' + d.name, enabled: d.enabled, why: d.origin && d.origin.why, version: d.version }))

// -> { ok, name, reason, detail }
function validate(bot, p, { windows = loadWindows(bot), sandbox = loadSandbox(bot) } = {}) {
  const name = String(p && p.name || '').trim()
  if (!sandbox) return { ok: false, name, reason: 'this bot has no brain/telemetry/sandbox.js yet, so a detector cannot be validated or run' }
  const scr = sandbox.screen(p.source, name)
  if (!scr.ok) return { ok: false, name, reason: scr.error }
  let det
  try { det = sandbox.compile(name, p.source) } catch (e) { return { ok: false, name, reason: 'does not compile: ' + e.message } }
  const badIds = new Set((p.badWindows || []).filter(id => WIN_ID.test(id)))
  const bad = windows.filter(w => badIds.has(w.id)), normal = windows.filter(w => w.kind === 'normal' && !badIds.has(w.id))
  if (!bad.length) return { ok: false, name, reason: 'none of the nominated bad windows exist (ids must come from the "windows" list)' }
  if (normal.length < MIN_NORMAL_WINDOWS) return { ok: false, name, reason: `only ${normal.length} normal windows captured so far, need ${MIN_NORMAL_WINDOWS} to prove it stays quiet; propose it again later` }
  const fired = (w) => { const r = sandbox.runOnWindow(det, w); if (r.error) throw new Error(`${w.id}: ${r.error}`); return !!r.flag }
  let firedBad, firedNormal
  try { firedBad = bad.filter(fired).map(w => w.id); firedNormal = normal.filter(fired).map(w => w.id) } catch (e) { return { ok: false, name, reason: 'failed while replaying: ' + e.message } }
  const needBad = Math.ceil(bad.length / 2), allowedFalse = Math.floor(normal.length * MAX_FALSE_RATE)
  const detail = { badWindows: bad.map(w => w.id), firedOnBad: firedBad, normalWindows: normal.length, firedOnNormal: firedNormal }
  if (firedBad.length < needBad) return { ok: false, name, detail, reason: `silent on the bad window(s): fired on ${firedBad.length} of ${bad.length}` }
  if (firedNormal.length > allowedFalse) return { ok: false, name, detail, reason: `fires on normal play: ${firedNormal.length} of ${normal.length} normal windows (allowed ${allowedFalse})` }
  return { ok: true, name, detail }
}

function install(bot, p, v, { now = Date.now(), model, sandbox = loadSandbox(bot) } = {}) {
  const m = readManifest(bot)
  const old = m.detectors.find(d => d.name === p.name)
  if (!old && m.detectors.length >= MAX_DETECTORS) return { ok: false, reason: `already ${MAX_DETECTORS} custom detectors; remove one first` }
  const at = new Date(now).toISOString()
  const header = `// custom detector "${p.name}" v${(old ? old.version : 0) + 1}. Written by ${model || 'the reviewer'} at ${at}.\n// why: ${String(p.why || '').replace(/\s+/g, ' ').slice(0, 300)}\n// validated on telemetry windows: fired on ${v.detail.firedOnBad.length}/${v.detail.badWindows.length} bad, ${v.detail.firedOnNormal.length}/${v.detail.normalWindows} normal.\n// It only flags. It cannot stop or change the bot.\n`
  const file = header + p.source.trim() + '\n'
  fs.mkdirSync(detDir(bot), { recursive: true })
  fs.writeFileSync(path.join(detDir(bot), p.name + '.js'), file)
  const entry = { name: p.name, enabled: true, version: (old ? old.version : 0) + 1, sha: sandbox.sha(file), severity: p.severity === 'low' ? 'low' : 'med',
    origin: { by: model || 'reviewer', at, why: p.why, title: p.title, validated: v.detail } }
  const next = { detectors: [...m.detectors.filter(d => d.name !== p.name), entry] }
  const tmp = path.join(detDir(bot), 'manifest.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1)); fs.renameSync(tmp, path.join(detDir(bot), 'manifest.json'))
  return { ok: true, entry, source: file }
}

function logEvent(bot, ev) {
  try { fs.mkdirSync(detDir(bot), { recursive: true }); fs.appendFileSync(path.join(detDir(bot), 'log.jsonl'), JSON.stringify(ev) + '\n') } catch {}
}

// -> [{ at, name, action: 'enabled'|'rejected', reason?, title }]  (also logged with the full source)
function process_(bot, proposals, { now = Date.now(), model } = {}) {
  const out = []
  for (const p of (proposals || []).slice(0, 2)) {
    const at = new Date(now).toISOString()
    let v = validate(bot, p), res
    if (v.ok) { res = install(bot, p, v, { now, model }); if (!res.ok) v = { ok: false, name: p.name, reason: res.reason, detail: v.detail } }
    const ev = v.ok ? { at, name: p.name, action: 'enabled', title: p.title, why: p.why, validated: v.detail }
      : { at, name: v.name || p.name, action: 'rejected', title: p.title, why: p.why, reason: v.reason, validated: v.detail }
    logEvent(bot, { ...ev, by: model, source: p.source })
    out.push(ev)
  }
  return out
}

module.exports = { validate, install, process: process_, windowDigests, customList, loadWindows, MAX_DETECTORS, MIN_NORMAL_WINDOWS }
