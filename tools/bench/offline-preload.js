// Preload for running join.js against the bench's offline server (NODE_OPTIONS=--require this file, so run.js's child gets it too).
// Forces host, port, name and offline auth on mineflayer.createBot; nothing else changes, so the bot is the real join.js + brain.
// Env: BENCH_PORT, BENCH_NAME
'use strict'
const Module = require('module')
const origLoad = Module._load
const PORT = Number(process.env.BENCH_PORT) || 25599
const NAME = process.env.BENCH_NAME || 'BenchBot'
Module._load = function (request) {
  const m = origLoad.apply(this, arguments)
  if (request !== 'mineflayer' || m.__bench) return m
  const create = m.createBot
  m.createBot = function (opts) { return create.call(this, { ...opts, host: '127.0.0.1', port: PORT, username: NAME, auth: 'offline', checkTimeoutInterval: 120000 }) }
  m.__bench = true
  return m
}
