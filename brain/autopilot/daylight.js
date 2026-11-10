// "Is it dark outside" for safety decisions: the night clock OR a thunderstorm (docs/BUG-HUNT-2026-11-10.md, finding 12). Hostile mobs spawn on the surface during a
// thunderstorm at noon, and a bed can be slept in; nothing used to read bot.thunderState, so a storm counted as a safe day.
'use strict'
const NIGHT_FROM = 12700, NIGHT_TO = 23300, STORM = 0.5

const clockNight = (bot) => { const t = bot.time && bot.time.timeOfDay; return t != null && t >= NIGHT_FROM && t <= NIGHT_TO }
// thunderState is 0..1 and fades in and out; above half the sky is dark enough that mobs spawn
const thundering = (bot) => !!bot.isRaining && (bot.thunderState || 0) > STORM
const darkOutside = (bot) => clockNight(bot) || thundering(bot)

module.exports = { darkOutside, clockNight, thundering }
