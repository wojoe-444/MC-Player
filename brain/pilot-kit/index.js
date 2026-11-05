// brain/pilot-kit: small helpers for whoever drives the bot (Claude through the ap-cmd.js eval channel, the pilot REPL, a model prompt).
// A service-style module: it never creates scheduler tasks and never moves the bot by itself. Everything is read-only or on request,
// except the dashcam, which only writes clip files under brain/state/clips/.
//
//   bot._kit.observe({ since })        compact snapshot + events newer than the cursor      (observe.js)
//   bot._kit.observeText({ since })    the same as a short text block
//   bot._kit.dashcam.save('manual')    write the last ~30 s to brain/state/clips/           (dashcam.js, runs by itself)
//   bot._kit.result.wrap(name, fn)     one result envelope for any command                  (result.js)
//   bot._kit.placeAnyFace(opts)        place a block from whichever face works              (place.js)
//   bot._kit.slice(opts)               write a vertical cross-section PNG, returns the path (slice.js, line-of-sight only)
const path = require('path')
const fs = require('fs')
const createDashcam = require('./dashcam')
const createObserve = require('./observe')
const result = require('./result')
const { placeAnyFace } = require('./place')
const slice = require('./slice')

function register(api) {
  const { bot } = api
  const dashcam = createDashcam(api)
  const observe = createObserve(api)
  const kit = {
    dashcam, result, slice,
    observe: (o) => observe.observe(o),
    observeText: (o) => observe.observeText(o),
    wrap: result.wrap,
    note: (kind, extra, src) => observe.push(kind, extra, src || 'module'),   // other modules can add events to the cursor stream
    placeAnyFace: (o) => placeAnyFace(bot, Object.assign({ goals: api.goals, approach: true }, o)),
    slice: (o = {}) => {
      const s = slice.capture(bot, o)
      const dir = api.statePath('views')
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      const stamp = new Date(api.now ? api.now() : Date.now()).toISOString().replace(/[:.]/g, '-')
      const file = path.join(dir, `slice-${stamp}.png`)
      fs.writeFileSync(file, slice.render(s, o.scale || 10))
      fs.copyFileSync(file, path.join(dir, 'slice-latest.png'))
      return { file, axis: s.axis, at: s.at, facing: s.facing, mobs: s.mobs.length }
    }
  }
  bot._kit = kit
  api.pilotkit = kit        // the capability the manifest provides ('pilotkit'); callers only need api.pilotkit.wrap(name, fn)
  return {
    name: 'pilot-kit',
    start() { observe.start(); dashcam.start() },
    stop() { try { dashcam.stop() } catch {} try { observe.stop() } catch {} if (bot._kit === kit) delete bot._kit; if (api.pilotkit === kit) delete api.pilotkit },
    status() { return { cursor: observe.cursor(), dashcam: dashcam.status() } }
  }
}
module.exports = register
module.exports.meta = require('./meta.json')
