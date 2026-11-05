// The capability ladder, read from the code so it cannot drift (P5 of the architecture taxonomy):
//   primitive  one bot action or sense with a result   S.<name> in autopilot/skills.js
//   skill      a named sequence the planner can pick   def('<name>', ...) in autopilot/think.js (its action menu)
//   job        a scheduler task that can pause/resume  modules of kind "job" (meta.json)
//   goal       a standing aim with a success test       { id: '<name>', need, run } steps in autopilot/goals.js and plan.js
//   planner    the chooser                              think.js (model) and the routine step list (fallback)
// catalog(brainDir) reads those files as text (no bot, no requires), so the dashboard process and the tests can call it too.
const fs = require('fs')
const path = require('path')
const { readMeta } = require('./meta')

const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const uniq = (a) => [...new Set(a)]

function catalog(brainDir = __dirname) {
  const ap = path.join(brainDir, 'autopilot')
  const skills = read(path.join(ap, 'skills.js'))
  const think = read(path.join(ap, 'think.js'))
  const primitive = uniq([...skills.matchAll(/^\s*S\.([a-zA-Z]+)\s*=\s*(?:async\s*)?(?:function|\()/gm)].map(m => m[1]))
  const skill = uniq([...think.matchAll(/\bdef\('([a-z_]+)'/g)].map(m => m[1]))
  const goal = uniq(['goals.js', 'plan.js'].flatMap(f => [...read(path.join(ap, f)).matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map(m => m[1])))
  const modules = (/const MODULES = \[([^\]]*)\]/.exec(read(path.join(brainDir, 'index.js'))) || [0, ''])[1].match(/'([^']+)'/g) || []
  const job = modules.map(s => s.slice(1, -1)).filter(n => (readMeta(brainDir, n) || {}).kind === 'job')
  const planner = ['think', 'routine']
  return { primitive, skill, job, goal, planner }
}

module.exports = { catalog }
