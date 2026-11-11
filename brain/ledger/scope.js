// brain/ledger/scope.js: "what am I building right now". A job declares the named space it is working on (a shaft, a room, a farm, a pen) around its work, and
// every block the bot digs or places inside the call is filed under that space by the ledger (brain/ledger). Zero dependencies and a no-op when nothing listens,
// so any module can call it without knowing whether the ledger is loaded.
//
//   const { within } = require('../ledger/scope')
//   await within({ id: 'tree-3', kind: 'farm', label: 'Tree farm 3' }, () => engine.run())
//
// The id is the same one the registry, the state files and the dashboard use: a shaft id, a room id, `tree-<farm id>`, `pen-<pen id>`, `crops`. Scopes nest: the
// innermost one wins. It uses AsyncLocalStorage, so it follows awaits (the ledger reads it at the moment the bot sends the dig or place packet, which is inside
// the job's own call chain, not when the server's answer arrives).
'use strict'
const { AsyncLocalStorage } = require('async_hooks')
const als = new AsyncLocalStorage()

// space: { id, kind?, label? } or a bare id string. Returns whatever fn returns (a promise stays a promise).
function within(space, fn) {
  const s = typeof space === 'string' ? { id: space } : space
  if (!s || !s.id) return fn()
  return als.run({ id: String(s.id), kind: s.kind || null, label: s.label || null }, fn)
}
const current = () => als.getStore() || null

module.exports = { within, current }
