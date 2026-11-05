// Module meta: what a brain/<name>/ folder is, in the shared vocabulary (brain/taxonomy.json, brain/INTERFACE.md section 0).
// Each module folder has a meta.json { name, version, kind, summary, requires, provides, claims } and exports it as module.exports.meta.
//   kind      one of taxonomy.kinds
//   requires  other modules it calls into at run time (soft: a missing one is logged, never fatal)
//   provides  capabilities it offers (api.<name> handles, or built-ins it replaces: excavation, nav, routines, farm, sleep)
//   claims    taxonomy.claims resources it takes outside the scheduler lane (reflexes lease them through brain/reflexes.js)
// Descriptive only: nothing in the loader changes behavior because of it.
const fs = require('fs')
const path = require('path')

const TAXONOMY = JSON.parse(fs.readFileSync(path.join(__dirname, 'taxonomy.json'), 'utf8'))
const KINDS = Object.keys(TAXONOMY.kinds)
const CLAIMS = Object.keys(TAXONOMY.claims)

function readMeta(brainDir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(brainDir, name, 'meta.json'), 'utf8')) } catch { return null }
}

// Problems with one meta object ([] when fine). known = names of all modules, for the requires check.
function validate(meta, known = null) {
  const bad = []
  if (!meta || typeof meta !== 'object') return ['no meta']
  if (!meta.name) bad.push('no name')
  if (!KINDS.includes(meta.kind)) bad.push(`kind "${meta.kind}" is not one of ${KINDS.join(', ')}`)
  if (!meta.summary) bad.push('no summary')
  for (const f of ['requires', 'provides', 'claims']) if (!Array.isArray(meta[f])) bad.push(`${f} must be a list`)
  for (const c of meta.claims || []) if (!CLAIMS.includes(c)) bad.push(`unknown claim "${c}"`)
  if (known) for (const r of meta.requires || []) if (!known.includes(r)) bad.push(`requires unknown module "${r}"`)
  return bad
}

// Compact form for status / dashboard.
const brief = (m) => m ? { kind: m.kind, summary: m.summary, requires: m.requires || [], provides: m.provides || [], claims: m.claims || [] } : null

module.exports = { TAXONOMY, KINDS, CLAIMS, readMeta, validate, brief }
