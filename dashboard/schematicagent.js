// dashboard/schematicagent.js: the schematic agent as the Bot Dashboard's server runs it. The Schematics page asks for a build here; the bots' requests wait in the same
// queue (brain/schematic/agentstore.js, in bot-shared/). One request runs at a time, on the Claude login of this computer through the Agent SDK (reviewer/lib/claude.js),
// and the result is filed into the catalog (brain/schematic/agent.js). Requests wait while the app is closed and run when it opens.
'use strict'
const path = require('path')
const AS = require('../brain/schematic/agentstore')
const S = require('../brain/schematic/store')
const AG = require('../brain/schematic/agent')

const NOTES_MAX = 60

// opts: { sharedDir, dirs: () => [dirs of the catalog], agent?: runAgent (default: reviewer/lib/claude.js), onChange?: () => void, log?, now?, pollMs?, cwd? }
function createService(opts) {
  const { sharedDir } = opts
  const log = opts.log || (() => {})
  const now = opts.now || Date.now
  let agent = opts.agent || null, unavailable = null
  if (!agent) {
    try { agent = require(path.join(__dirname, '..', 'reviewer', 'lib', 'claude.js')).runAgent } catch (e) { unavailable = `the reviewer package (it holds the Claude Agent SDK) was not found next to the dashboard: ${e.message}` }
  }
  let current = null, ctrl = null, timer = null, stopped = false
  const changed = () => { try { if (opts.onChange) opts.onChange() } catch { /* the page refreshes on its own */ } }

  async function runOne(r) {
    current = r.id; ctrl = new AbortController()
    const calls = []
    let lastWrite = 0
    const flush = () => AS.update(sharedDir, r.id, { calls: calls.slice(-NOTES_MAX) })
    const onCall = (c) => {
      calls.push({ tool: String(c.tool).replace(/^mcp__schem__/, ''), ...(c.denied ? { denied: c.denied } : {}) })
      if (now() - lastWrite > 1500) { lastWrite = now(); try { flush() } catch { /* the next call writes it */ } }
    }
    let out
    try {
      out = await AG.runRequest(r, { sharedDir, dirs: opts.dirs(), agent, signal: ctrl.signal, onCall, log, now, cwd: opts.cwd, claudePath: process.env.REVIEWER_CLAUDE_PATH || undefined, timeoutMs: opts.timeoutMs })
    } catch (e) { out = { ok: false, error: String(e && e.message || e) } }
    const finishedAt = new Date(now()).toISOString()
    const fresh = AS.get(sharedDir, r.id)
    const cancelled = !out.ok && (out.cancelled || out.error === 'cancelled' || (fresh && fresh.status === 'cancelling'))
    AS.update(sharedDir, r.id, (cur) => ({
      ...cur, calls: calls.slice(-NOTES_MAX), finishedAt, costUsd: out.costUsd != null ? out.costUsd : (out.result && out.result.costUsd) != null ? out.result.costUsd : cur.costUsd,
      ...(out.ok ? { status: 'done', result: out.result, error: undefined } : { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : String(out.error || 'failed').slice(0, 500) }),
    }))
    log(`schematic agent ${r.id}: ${out.ok ? `done, ${out.result.schematicId}/${out.result.variantId}` : (cancelled ? 'cancelled' : 'failed: ' + out.error)}`)
    current = null; ctrl = null
    changed()
  }

  // take the next queued request if nothing is running; runs to its end, then looks again
  async function tick() {
    if (current || stopped) return false
    if (unavailable) return false
    const r = AS.claimNext(sharedDir, 'dashboard', now())
    if (!r) return false
    changed()
    await runOne(r)
    setImmediate(() => { tick().catch(() => {}) })
    return true
  }

  function info() {
    const cfg = AS.readConfig(sharedDir)
    return {
      available: !unavailable, unavailableWhy: unavailable, running: current,
      models: AS.MODELS, efforts: AS.EFFORTS, defaults: { model: AS.DEFAULT_MODEL, effort: AS.DEFAULT_EFFORT },
      config: cfg, quota: AS.quota(sharedDir, now()),
      requests: AS.list(sharedDir, { limit: 30 }).map(publicOf),
    }
  }
  // a request as the page shows it (nothing in it is secret; the prompt and the result are what the person or the bot asked for and got)
  const publicOf = (r) => ({ id: r.id, createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, source: r.source, by: r.by, prompt: r.prompt, kind: r.kind, target: r.target, model: r.model, effort: r.effort, status: r.status, error: r.error, result: r.result, costUsd: r.costUsd, calls: (r.calls || []).length, lastCall: (r.calls || []).slice(-1)[0] || null })

  // a request from the page. -> { ok, request } | { ok: false, why }
  function create(body) {
    if (unavailable) return { ok: false, why: unavailable }
    const b = body || {}
    if (b.kind && b.kind !== 'new') {
      const doc = S.loadDoc(opts.dirs(), String(b.target && b.target.id || ''))
      if (!doc) return { ok: false, why: `there is no schematic "${b.target && b.target.id}"` }
      if (b.target.variant && !doc.doc.variants.some(v => v.id === b.target.variant)) return { ok: false, why: `"${doc.doc.name}" has no variant "${b.target.variant}"` }
    }
    const r = AS.create(sharedDir, { source: 'user', by: 'you', prompt: b.prompt, kind: b.kind, target: b.target, model: b.model, effort: b.effort }, now())
    if (r.ok) { changed(); setImmediate(() => { tick().catch(() => {}) }) }
    return r.ok ? { ok: true, request: publicOf(r.request) } : r
  }
  // queued -> cancelled right away (a bot's call is given back); running -> stopped
  function cancel(id) {
    const r = AS.get(sharedDir, id)
    if (!r) return { ok: false, why: 'no such request' }
    if (r.status === 'queued') {
      const u = AS.update(sharedDir, id, (cur) => (cur.status === 'queued' ? { ...cur, status: 'cancelled', finishedAt: new Date(now()).toISOString(), error: 'cancelled' } : cur))
      if (u.status === 'cancelled') { AS.refund(sharedDir, r, now()); changed(); return { ok: true } }
      return { ok: false, why: 'it just started: cancel again to stop it' }
    }
    if (r.status === 'running' && current === id && ctrl) { AS.update(sharedDir, id, { status: 'cancelling' }); ctrl.abort(); return { ok: true } }
    return { ok: false, why: `it is ${r.status}` }
  }
  const setConfig = (patch) => { const c = AS.writeConfig(sharedDir, patch || {}); changed(); return c }

  function start() {
    stopped = false
    try { AS.failStale(sharedDir, now()) } catch { /* nothing to clean */ }          // a request left running by a dashboard that was closed can never finish
    timer = setInterval(() => { tick().catch(() => {}) }, opts.pollMs || 8000)
    if (timer.unref) timer.unref()
    tick().catch(() => {})
  }
  function stop() { stopped = true; clearInterval(timer); if (ctrl) ctrl.abort() }
  return { start, stop, tick, info, create, cancel, setConfig, get: (id) => { const r = AS.get(sharedDir, id); return r ? publicOf(r) : null }, available: () => !unavailable }
}

module.exports = { createService }
