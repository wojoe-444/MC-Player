// brain/outcome/expect.js: does a build do what it is for? Pure functions, no bot, no I/O.
//
// Walter 2026-11-10/11: the underground mob farm was built, inspected (0 faults: its blocks matched its design, cell for cell) and made nothing for a day,
// because the world was on Peaceful. Everything in the loop compared the build with its DESIGN. Nothing compared it with its PURPOSE: a farm that has been
// able to run for N hours and has produced nothing is broken, whatever its blocks say. This module is that comparison, for any kind of build.
//
// A build is { id, kind, liveMs (time the build could have been working: the bot online and inside the spawn range), got (output counted since the
// module first saw it), shadedFrac? (share of that time the bot stood where it blocks the build, mob farm only) }.
// An env is what the bot can legitimately read about the world: { difficulty: 'peaceful'|'easy'|'normal'|'hard'|null, ... }.
//
// verdict.state:
//   warming    inside its grace period, nothing to say yet
//   producing  output at a believable rate
//   overdue    past the grace period with no or far too little output (nothing in the world explains it: a code or design problem)
//   blocked    a precondition the build needs is false (a human or a setting has to change; no code will make it work)
'use strict'

const HOUR = 3600000

// What each kind of build is for. perHour is the least that counts as working (a low bar: the point is to catch nothing at all, not to grade a rate).
const SPECS = {
  mobfarm: { label: 'mob farm', unit: 'kills', graceH: 3, perHour: 0.5,
    purpose: 'bones, arrows, string and gunpowder from mobs that spawn on its dark platform and fall to the bot' },
  treefarm: { label: 'tree farm', unit: 'logs', graceH: 8, perHour: 1,
    purpose: 'logs from the lit sapling lattice, replanted as they are felled' },
  pen: { label: 'animal pens', unit: 'animals bred, culled or sheared', graceH: 24, perHour: 0.05,
    purpose: 'food and wool from penned animals' },
}

// Preconditions: each returns null when fine or { id, why, who } when not. `who` is 'human' when only a person can change it (the bot has no commands).
const GATES = {
  mobfarm: [
    (env) => (env.difficulty === 'peaceful' ? { id: 'peaceful', who: 'human', why: 'the world is on Peaceful: no hostile mob can spawn anywhere, so no mob farm can produce. Raise the difficulty (Esc, Options, Difficulty on the LAN host).' } : null),
    (env) => (env.mobSpawning === false ? { id: 'no-mob-spawning', who: 'human', why: 'the doMobSpawning game rule is off' } : null),
  ],
  treefarm: [],
  pen: [],
}

function evaluate(build, env = {}, opt = {}) {
  const spec = SPECS[build.kind]
  if (!spec) return { id: build.id, kind: build.kind, state: 'unknown', why: [`no expectation is defined for builds of kind "${build.kind}"`] }
  const graceH = opt.graceH != null ? opt.graceH : spec.graceH
  const liveH = Math.max(0, (build.liveMs || 0) / HOUR)
  const got = build.got || 0
  const failed = (GATES[build.kind] || []).map(g => g(env)).filter(Boolean)
  const v = { id: build.id, kind: build.kind, label: spec.label, unit: spec.unit, purpose: spec.purpose, liveH: Math.round(liveH * 10) / 10, graceH, got, expectedPerHour: spec.perHour,
    ratePerHour: liveH > 0 ? Math.round((got / liveH) * 100) / 100 : null, gates: failed, why: [], state: 'warming' }
  if (failed.length) {
    v.state = 'blocked'
    v.who = failed.some(g => g.who === 'human') ? 'human' : 'code'
    v.why = failed.map(g => g.why)
    return v
  }
  if (build.shadedFrac != null && build.shadedFrac >= 0.5) v.notes = [`the bot stood where it blocks the build (inside 24 blocks of half the spawn pads or more) ${Math.round(build.shadedFrac * 100)}% of the time it was in range`]
  if (liveH < graceH) { v.why = [`${v.liveH} of ${graceH} h of grace used`]; return v }
  const want = spec.perHour * liveH
  if (got <= 0) { v.state = 'overdue'; v.why = [`${spec.label} could have worked for ${v.liveH} h and produced no ${spec.unit} (expected at least ${Math.max(1, Math.round(want))})`] }
  else if (got < want * 0.25) { v.state = 'overdue'; v.why = [`${spec.label} produced ${got} ${spec.unit} in ${v.liveH} h, a quarter of the ${Math.round(want)} the bar asks for`] }
  else { v.state = 'producing'; v.why = [`${got} ${spec.unit} in ${v.liveH} h`] }
  if (v.notes) v.why.push(...v.notes)
  return v
}

module.exports = { SPECS, GATES, evaluate, HOUR }
