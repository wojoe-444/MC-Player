// brain/schematic/agentstore.js: the files behind the schematic agent (agent.js): its settings, the daily quota for BOT requests, and the request queue. Pure file I/O.
//
//   <shared>/schematic-agent/config.json         { botDailyCap, botMaxPending, botModel, botEffort }: what the bots may ask for (Walter 2026-11-11: 25 calls a day to start)
//   <shared>/schematic-agent/quota.json          { date, bot: n, byBot: { name: n } }: today's bot requests (local date; a new day starts at 0)
//   <shared>/schematic-agent/requests/<id>.json  one request: who asked, what for, which model, its status and its result
//   <shared>/schematic-agent/history/            the previous version of a schematic the agent replaced
// `shared` is bot-shared/, the folder both bots and the dashboard see. A person asks from the Schematics page; a bot asks through bot._schematic.request. Either way the
// request waits in the queue and the runner (the Bot Dashboard's server) takes it when the app is open: the bots never run a model for this themselves.
'use strict'
const fs = require('fs')
const path = require('path')

// Models and effort levels the Schematics page offers. Walter 2026-11-11: the form defaults to Opus 5.5, Medium.
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_MODEL = 'claude-opus-5-5', DEFAULT_EFFORT = 'medium'
const DEFAULTS = { botDailyCap: 25, botMaxPending: 3, botModel: DEFAULT_MODEL, botEffort: DEFAULT_EFFORT }
const KINDS = ['new', 'edit', 'variant']
const MAX_PROMPT = 4000

const root = (sharedDir) => path.join(sharedDir, 'schematic-agent')
const reqDir = (sharedDir) => path.join(root(sharedDir), 'requests')
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f) }

// a lock that is a directory (mkdir is atomic); one held for more than 10 s is stale
function withLock(sharedDir, fn) {
  const lock = path.join(root(sharedDir), '.lock')
  fs.mkdirSync(root(sharedDir), { recursive: true })
  const until = Date.now() + 5000
  for (;;) {
    try { fs.mkdirSync(lock); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue } } catch { /* it just went away */ }
      if (Date.now() > until) throw new Error('the schematic agent files are locked by another process')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try { return fn() } finally { try { fs.rmdirSync(lock) } catch { /* gone */ } }
}

// ---- settings
const cfgFile = (sharedDir) => path.join(root(sharedDir), 'config.json')
function readConfig(sharedDir) {
  const c = readJson(cfgFile(sharedDir), {}) || {}
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d)
  return {
    botDailyCap: num(c.botDailyCap, DEFAULTS.botDailyCap, 0, 1000), botMaxPending: num(c.botMaxPending, DEFAULTS.botMaxPending, 1, 50),
    botModel: validModel(c.botModel) || DEFAULTS.botModel, botEffort: EFFORTS.includes(c.botEffort) ? c.botEffort : DEFAULTS.botEffort,
  }
}
function writeConfig(sharedDir, patch) {
  return withLock(sharedDir, () => {
    const cur = readConfig(sharedDir), next = { ...cur }
    if (patch.botDailyCap != null && Number.isFinite(Number(patch.botDailyCap))) next.botDailyCap = Math.max(0, Math.min(1000, Math.round(Number(patch.botDailyCap))))
    if (patch.botMaxPending != null && Number.isFinite(Number(patch.botMaxPending))) next.botMaxPending = Math.max(1, Math.min(50, Math.round(Number(patch.botMaxPending))))
    if (validModel(patch.botModel)) next.botModel = validModel(patch.botModel)
    if (EFFORTS.includes(patch.botEffort)) next.botEffort = patch.botEffort
    writeJson(cfgFile(sharedDir), next)
    return next
  })
}
const validModel = (m) => (typeof m === 'string' && /^claude-[a-z0-9.-]{3,60}$/.test(m) ? m : null)

// ---- the daily quota for bot requests
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const quotaFile = (sharedDir) => path.join(root(sharedDir), 'quota.json')
function readQuota(sharedDir, now = Date.now()) {
  const q = readJson(quotaFile(sharedDir), null), date = dayOf(now)
  return q && q.date === date ? { date, bot: q.bot | 0, byBot: q.byBot || {} } : { date, bot: 0, byBot: {} }
}
const quota = (sharedDir, now = Date.now()) => {
  const q = readQuota(sharedDir, now), cap = readConfig(sharedDir).botDailyCap
  return { date: q.date, used: q.bot, cap, remaining: Math.max(0, cap - q.bot), byBot: q.byBot }
}

// ---- requests
const reqFile = (sharedDir, id) => path.join(reqDir(sharedDir), String(id).replace(/[^A-Za-z0-9_-]/g, '') + '.json')
const newId = (now) => `r${new Date(now).toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
const get = (sharedDir, id) => readJson(reqFile(sharedDir, id))
function list(sharedDir, { limit = 40, status } = {}) {
  let names = []; try { names = fs.readdirSync(reqDir(sharedDir)).filter(f => f.endsWith('.json')) } catch { return [] }
  const all = names.map(f => readJson(path.join(reqDir(sharedDir), f))).filter(r => r && r.id && (!status || r.status === status))
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return all.slice(0, limit)
}
function update(sharedDir, id, patch) {
  return withLock(sharedDir, () => {
    const r = get(sharedDir, id); if (!r) return null
    const next = typeof patch === 'function' ? patch(r) : { ...r, ...patch }
    writeJson(reqFile(sharedDir, id), next)
    return next
  })
}
// A new request. source 'user' (the Schematics page) takes the model and effort as given; source 'bot' takes the settings' model and effort, may only make a NEW schematic or add a
// VARIANT to one (never rewrite an existing variant), counts against today's quota and against how many of its requests may wait at once.
// -> { ok, request, quota } | { ok: false, why, quota? }
function create(sharedDir, o = {}, now = Date.now()) {
  const source = o.source === 'bot' ? 'bot' : 'user'
  const prompt = String(o.prompt == null ? '' : o.prompt).replace(/\r/g, '').trim().slice(0, MAX_PROMPT)
  if (prompt.length < 8) return { ok: false, why: 'say what you want built (at least a few words)' }
  const kind = KINDS.includes(o.kind) ? o.kind : 'new'
  if (source === 'bot' && kind === 'edit') return { ok: false, why: 'a bot may ask for a new schematic or a new variant, not for a change to an existing one' }
  const target = kind === 'new' ? null : { id: String(o.target && o.target.id || '').slice(0, 64), variant: o.target && o.target.variant ? String(o.target.variant).slice(0, 40) : null }
  if (kind !== 'new' && !target.id) return { ok: false, why: `${kind === 'edit' ? 'edit' : 'a variant'} needs the schematic it is about` }
  return withLock(sharedDir, () => {
    const cfg = readConfig(sharedDir)
    const model = source === 'bot' ? cfg.botModel : (validModel(o.model) || DEFAULT_MODEL)
    const effort = source === 'bot' ? cfg.botEffort : (EFFORTS.includes(o.effort) ? o.effort : DEFAULT_EFFORT)
    const by = String(o.by || (source === 'bot' ? 'a bot' : 'you')).slice(0, 40)
    if (source === 'bot') {
      const q = readQuota(sharedDir, now)
      if (q.bot >= cfg.botDailyCap) return { ok: false, why: `the bots' schematic requests are used up for today (${q.bot} of ${cfg.botDailyCap}); it resets at midnight`, quota: quota(sharedDir, now) }
      const pending = list(sharedDir, { limit: 500 }).filter(r => r.source === 'bot' && (r.status === 'queued' || r.status === 'running')).length
      if (pending >= cfg.botMaxPending) return { ok: false, why: `${pending} schematic requests from the bots are already waiting; let them finish first`, quota: quota(sharedDir, now) }
      q.bot++; q.byBot[by] = (q.byBot[by] || 0) + 1
      writeJson(quotaFile(sharedDir), q)
    }
    const request = { id: newId(now), createdAt: new Date(now).toISOString(), source, by, prompt, kind, target, model, effort, status: 'queued', calls: [] }
    writeJson(reqFile(sharedDir, request.id), request)
    return { ok: true, request, quota: quota(sharedDir, now) }
  })
}
// give a queued bot request's call back (it was cancelled before it ran)
function refund(sharedDir, request, now = Date.now()) {
  if (!request || request.source !== 'bot') return
  withLock(sharedDir, () => {
    const q = readQuota(sharedDir, now)
    if (dayOf(Date.parse(request.createdAt)) !== q.date) return
    q.bot = Math.max(0, q.bot - 1); q.byBot[request.by] = Math.max(0, (q.byBot[request.by] || 0) - 1)
    writeJson(quotaFile(sharedDir), q)
  })
}
// the oldest queued request becomes running (one runner at a time)
function claimNext(sharedDir, runner = 'runner', now = Date.now()) {
  return withLock(sharedDir, () => {
    const next = list(sharedDir, { limit: 500, status: 'queued' }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0]
    if (!next) return null
    const r = { ...next, status: 'running', startedAt: new Date(now).toISOString(), runner, pid: process.pid }
    writeJson(reqFile(sharedDir, r.id), r)
    return r
  })
}
// a request left `running` by a runner that died (the app was closed) can never finish: mark it so (one that another live process holds is left alone)
function failStale(sharedDir, now = Date.now(), olderThanMs = 0) {
  let n = 0
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  for (const r of list(sharedDir, { limit: 500, status: 'running' })) {
    if (olderThanMs && now - Date.parse(r.startedAt || r.createdAt) < olderThanMs) continue
    if (r.pid && r.pid !== process.pid && alive(r.pid)) continue                 // another dashboard process is running it right now
    update(sharedDir, r.id, { status: 'failed', error: 'interrupted: the app was closed while this was running', finishedAt: new Date(now).toISOString() }); n++
  }
  return n
}

module.exports = { MODELS, EFFORTS, DEFAULT_MODEL, DEFAULT_EFFORT, DEFAULTS, KINDS, MAX_PROMPT, root, reqDir, readConfig, writeConfig, quota, create, refund, get, list, update, claimNext, failStale, withLock, validModel, dayOf, readJson, writeJson }
