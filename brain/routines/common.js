// Small helpers shared by the farm and sleep routines.
const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|phantom|slime|silverfish|enderman|zombie_villager|stray|bogged|breeze)$/
const isItem = (e) => !!e && (e.name === 'item' || e.displayName === 'Item')
const { dimOf } = require('../util')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 'health is 5/20' / 'a zombie is near' / null
function danger(bot, { minHealth = 8, radius = 6 } = {}) {
  if (bot.health < minHealth) return `my health is ${Math.round(bot.health)}/20`
  const m = bot.nearestEntity && bot.nearestEntity(e => HOSTILE.test(e.name || '') && e.position.distanceTo(bot.entity.position) < radius)
  return m ? `a ${m.name} is near` : null
}

const counts = (bot) => { const o = {}; for (const i of bot.inventory.items()) o[i.name] = (o[i.name] || 0) + i.count; return o }
const readJson = (fs, file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }

module.exports = { dimOf, HOSTILE, isItem, sleep, danger, counts, readJson }
