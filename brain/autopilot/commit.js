// Step commitment (docs/HILLCLIMB-INSIGHTS.md, "Steps that commit"). The picker starts from the top of the step list after every step. When one step needs the
// bot at the bottom of the shaft and another needs it at the top, each one's work re-arms the other: A, B, A, B, ... (ladder bobbing; the planner's own loop
// detector only sees A, A, A, A). Once A,B,A,B is seen inside the window, the bot COMMITS to B: A is skipped by the picker for as long as B still wants to run
// (its need() holds and it is not cooling down after a failure), at most holdMs. B finishing or failing hands the turn back to A, so nothing starves.
// Survival steps are never held back (they are not skipped) and never start a commitment as the "other" step.
'use strict'

function createCommit({ urgent = new Set(), windowMs = 10 * 60000, holdMs = 10 * 60000, now = Date.now } = {}) {
  const recent = []                      // the last four distinct picks { id, t }
  let c = null                           // { id, over, until, since }
  const stats = { started: 0, skipped: 0, byPair: {} }
  return {
    stats,
    get active() { return c && c.until > now() ? { ...c } : null },
    // every pick; returns the new commitment when this pick completes an A,B,A,B inside the window
    note(id) {
      const t = now()
      if (recent.length && recent[recent.length - 1].id === id) return null
      recent.push({ id, t }); if (recent.length > 4) recent.shift()
      if (recent.length < 4) return null
      const [a, b, a2, b2] = recent
      if (a.id !== a2.id || b.id !== b2.id || a.id === b.id || b2.t - a.t > windowMs) return null
      if (urgent.has(a.id) || urgent.has(b.id)) return null            // a survival step ping-ponging with a job is the survival step doing its job
      const key = [a.id, b.id].sort().join('|'); stats.byPair[key] = (stats.byPair[key] || 0) + 1
      c = { id: b.id, over: a.id, since: t, until: t + holdMs }; stats.started++
      recent.length = 0
      return { ...c }
    },
    // should the picker pass over this candidate? wanted(id) says whether the committed step still wants to run (need() true, not cooling, allowed now)
    skips(candidateId, wanted) {
      if (!c) return false
      if (c.until <= now()) { c = null; return false }
      if (candidateId !== c.over) return false
      let w = false; try { w = !!wanted(c.id) } catch { /* treat as not wanted */ }
      if (!w) { c = null; return false }
      stats.skipped++
      return true
    },
    clear() { c = null; recent.length = 0 }
  }
}

module.exports = { createCommit }
