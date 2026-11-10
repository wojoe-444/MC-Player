// Model-written detectors (Walter 2026-11-10: the reviewer should turn a pattern it judged bad into a routine flag, "an encoding of knowledge ... from LLM judgement to routine code").
// A custom detector is a small pure function that only FLAGS: it never touches the bot, the world or the filesystem, and it can never stop or change anything.
//
//   function detect(samples, events, now, H) { ... return null | { sev: 'low'|'med', msg: 'short sentence with numbers', data: { ... } } }
//
//   samples: [{ t, x, y, z, g (onGround 0/1), vy, yaw, pit (pitch), h (held item name), mv (trying to move), act (busy: sleeping/eating/container/digging), dg (block being dug), tk (task), hp }]  4 Hz, oldest first, last 5 min
//   events:  [{ k:'jump', t } | { k:'dig', t, block, x,y,z, held, need, have, ok, harvestOk } | { k:'place', t, block, x,y,z, sky, tk } | { k:'fail', t, what, note }]
//   now:     epoch ms.   H: { since(samples, t), evSince(events, t, kind?), extent(samples), hExtent(samples), pathLength(samples), covers(samples, ms), isBlockItem(name) }
//
// Safety, in layers: static screening of the source; execution in a fresh vm context that holds only JS builtins (no require, process, fs, timers), with data passed in as a JSON
// string and the result read back as a JSON string (no host object ever crosses, so the usual constructor-chain escapes have nothing to grab); a hard timeout per call;
// output clamped (severity at most 'med', short message); the bot only loads files whose sha256 matches the manifest the reviewer wrote after validating them; and the loader mutes a
// detector that throws, times out or fires nearly all the time.
const vm = require('vm')
const crypto = require('crypto')
const D = require('./detectors')

const MAX_SOURCE = 6000, TIMEOUT_MS = 150, INPUT_MS = 5 * 60000
const BANNED = /\b(require|import|export|process|global|globalThis|this|constructor|__proto__|prototype|eval|Function|Reflect|Proxy|WebAssembly|setTimeout|setInterval|setImmediate|queueMicrotask|Atomics|SharedArrayBuffer|Buffer|arguments|with|async|await|yield|class|new\s+Array\s*\(\s*\d{5,}|repeat\s*\()\b/
const NAME = /^[a-z][a-z0-9_]{2,40}$/

const PRELUDE = `'use strict';
const NON_BLOCK = new RegExp(${JSON.stringify(D.NON_BLOCK.source)});
const H = Object.freeze({
  since: ${D.since.toString()},
  evSince: ${D.evSince.toString()},
  extent: ${D.extent.toString()},
  hExtent: ${D.hExtent.toString()},
  pathLength: ${D.pathLength.toString()},
  covers: ${D.covers.toString()},
  isBlockItem: ${D.isBlockItem.toString()},
});
`

// -> { ok, error }
function screen(source, name) {
  if (name !== undefined && !NAME.test(name)) return { ok: false, error: `bad name "${name}" (lowercase letters, digits and _, 3-41 chars, starting with a letter)` }
  if (typeof source !== 'string' || !source.trim()) return { ok: false, error: 'empty source' }
  if (source.length > MAX_SOURCE) return { ok: false, error: `source is ${source.length} chars (max ${MAX_SOURCE})` }
  // comments and string contents are not scanned (a message like 'a sword with ...' is fine); code generation from strings is switched off in the context anyway
  const stripped = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '$1$1')
  const hit = BANNED.exec(stripped)
  if (hit) return { ok: false, error: `uses "${hit[1]}", which custom detectors may not use` }
  if (!/function\s+detect\s*\(/.test(stripped)) return { ok: false, error: 'must define function detect(samples, events, now, H)' }
  return { ok: true }
}

const sha = (source) => crypto.createHash('sha256').update(source).digest('hex')

function prepareInput(samples, events, now) {
  const t0 = now - INPUT_MS
  return JSON.stringify({ samples: D.since(samples, t0), events: events.filter(e => e.t >= t0), now })
}

// -> { name, run(inputJson) -> { flag|null, error? } }
function compile(name, source) {
  const s = screen(source, name)
  if (!s.ok) throw new Error(s.error)
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  new vm.Script(PRELUDE + source, { filename: `custom-detector-${name}.js` }).runInContext(ctx, { timeout: TIMEOUT_MS })
  const call = new vm.Script('(function(){var i=JSON.parse(__in);var r=detect(i.samples,i.events,i.now,H);return r==null?"null":JSON.stringify(r)})()')
  return {
    name,
    run(inputJson, now) {
      let out
      try { ctx.__in = inputJson; out = call.runInContext(ctx, { timeout: TIMEOUT_MS }) } catch (e) { return { flag: null, error: String(e && e.message || e).slice(0, 200) } }
      let r
      try { r = JSON.parse(out) } catch { return { flag: null, error: 'result was not JSON' } }
      if (r === null) return { flag: null }
      if (typeof r !== 'object' || typeof r.msg !== 'string' || !r.msg.trim()) return { flag: null, error: 'result needs a msg string' }
      const data = r.data && typeof r.data === 'object' && JSON.stringify(r.data).length <= 600 ? r.data : undefined
      return { flag: { kind: 'custom_' + name, sev: r.sev === 'low' ? 'low' : 'med', t0: now - 60000, t1: now, msg: r.msg.trim().slice(0, 240), data, origin: 'model-written detector' } }
    },
  }
}

// run a detector over a captured window ({ samples, events, t1 }); used by the reviewer to validate and by tests
function runOnWindow(det, w) {
  const now = w.t1 || (w.samples.length ? w.samples[w.samples.length - 1].t : 0)
  const r = det.run(prepareInput(w.samples, w.events || [], now), now)
  return r
}

module.exports = { screen, compile, prepareInput, runOnWindow, sha, NAME, MAX_SOURCE, TIMEOUT_MS }
