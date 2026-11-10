// brain/roadmap: an observer. Every 10 minutes it evaluates the roadmap predicates (predicates.js) against the bot's own records and writes brain/state/roadmap.json.
// It never moves the bot, never writes anything but that file.
'use strict'
const fs = require('fs')
const path = require('path')
const { loadFacts, evaluate } = require('./predicates')

module.exports = function register(api) {
  const now = () => (api.now ? api.now() : Date.now())
  const file = api.statePath('roadmap.json'), stateDir = path.dirname(file), dir = api.dir || process.cwd()
  let timer = null, last = null
  function run() {
    try {
      const r = evaluate(loadFacts(stateDir, dir))
      last = { at: new Date(now()).toISOString(), ...r }
      fs.writeFileSync(file, JSON.stringify(last, null, 1))
    } catch (e) { if (api.log) api.log('roadmap', 'evaluation failed: ' + e.message) }
    return last
  }
  return {
    name: 'roadmap',
    start() { run(); timer = setInterval(run, 10 * 60000); if (timer.unref) timer.unref() },
    stop() { clearInterval(timer) },
    status() { return last ? last.phases : {} },
    _run: run
  }
}
module.exports.meta = require('./meta.json')
