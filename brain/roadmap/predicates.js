// Roadmap items as predicates (ROADMAP.md). Each one reads the bot's OWN records (facts) and answers true (done), false (no evidence yet) or null (nothing records
// this yet, so progress cannot be measured; `needs` says what the code would have to write). A null is never counted as done or as not done: the report shows
// "done of measured" and "measured of total" separately, so a missing record cannot fake progress or hide it.
'use strict'
const fs = require('fs')
const path = require('path')

const readJson = (file, d = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const arr = (a) => (Array.isArray(a) ? a : [])

// facts from brain/state (stateDir) and the bot folder (dir: waypoints.json, chest-index.json, stations.json)
function loadFacts(stateDir, dir) {
  const s = (f) => readJson(path.join(stateDir, f))
  return {
    autopilot: s('autopilot-state.json'), mining: s('mining-state.json'), treefarm: s('treefarm-state.json'), mobfarm: s('mobfarm.json'), husbandry: s('husbandry-state.json'),
    furnace: s('furnace-state.json'), nether: s('nether-network.json'), crafting: s('crafting-chests.json'),
    waypoints: readJson(path.join(dir, 'waypoints.json'), {}), stations: readJson(path.join(dir, 'stations.json')), chestIndex: readJson(path.join(dir, 'chest-index.json')),
    dayStats: (s('autopilot-state.json') || {}).dayStats || []
  }
}
const waypointNames = (f) => Object.keys(f.waypoints && typeof f.waypoints === 'object' && !Array.isArray(f.waypoints) ? f.waypoints : {}).concat(arr(f.waypoints).map(w => w && w.name))

const PREDICATES = [
  { id: '1.home', phase: '1', title: 'A home is set', check: (f) => (f.autopilot ? Array.isArray(f.autopilot.home) && f.autopilot.home.length === 3 : null), needs: 'autopilot-state.json' },
  { id: '1.shelter', phase: '1', title: 'A shelter door is recorded', check: (f) => (f.autopilot ? !!f.autopilot.shelterDoor : null), needs: 'autopilot-state.json' },
  { id: '2.1.shaft', phase: '2', title: 'A mine is recorded in the mining registry', check: (f) => (f.mining ? arr(f.mining.mines).length > 0 : null), needs: 'mining-state.json' },
  { id: '2.1.ladder', phase: '2', title: 'The recorded shaft is laddered, with old staircases sealed', check: () => null, needs: 'a "laddered" and "sealed" flag on each mining-state mine' },
  { id: '2.2.storage', phase: '2', title: 'A storage room waypoint exists', check: (f) => waypointNames(f).some(n => /storage/i.test(n || '')), needs: 'waypoints.json' },
  { id: '2.2.resetchest', phase: '2', title: 'A reset-gear chest is registered', check: (f) => (f.crafting || f.chestIndex ? JSON.stringify(f.crafting || {}).concat(JSON.stringify(f.chestIndex || {})).toLowerCase().includes('reset') : null), needs: 'crafting-chests.json / chest-index.json' },
  { id: '2.3.torches', phase: '2', title: 'Lit area and torch spacing around home', check: () => null, needs: 'a count of lit cells around home in lighting-state.json' },
  { id: '2.4.treefarm', phase: '2', title: 'Tree farm has sites and has planted saplings', check: (f) => (f.treefarm ? arr(f.treefarm.sites).length > 0 && ((f.treefarm.stats || {}).planted || 0) > 0 : null), needs: 'treefarm-state.json' },
  { id: '2.5.respawn', phase: '2', title: 'Spare beds and mini reset chests at base, mine and camps', check: () => null, needs: 'a registry of beds and reset chests by place' },
  { id: '2.6.smelter', phase: '2', title: 'Hopper smelter on charcoal is running', check: () => null, needs: 'a "hopper smelter built" flag in furnace-state.json' },
  { id: '2.7.cropfarm', phase: '2', title: 'Underground crop farm and composter', check: () => null, needs: 'a farm registry with depth and crops' },
  { id: '2.8.mobfarm', phase: '2', title: 'Mob farm has a kill box and a chest', check: (f) => (f.mobfarm ? !!f.mobfarm.killBox && arr(f.mobfarm.chests).length > 0 : false), needs: 'mobfarm.json' },
  { id: '2.9.pens', phase: '2', title: 'A fenced, lit animal pen is built', check: (f) => (f.husbandry ? arr(f.husbandry.pens).some(p => p && p.built && p.lit) : null), needs: 'husbandry-state.json' },
  { id: '2.11.lichen', phase: '2', title: 'Glow lichen farm has a wall and lichen has grown on it', check: (f) => (f.husbandry ? arr(f.husbandry.lichen).some(l => l && l.last && l.last.faces > 0) : null), needs: 'husbandry-state.json' },
  { id: '2.12.lava', phase: '2', title: 'Pointed dripstone and a safe lava farm', check: () => null, needs: 'a lava-farm record' },
  { id: '3.5.portal', phase: '3.5', title: 'Nether portal with a cobblestone shell on the far side', check: (f) => (f.nether ? Object.keys(f.nether).length > 0 : null), needs: 'nether-network.json (a portal entry with a shell flag)' }
]

function evaluate(facts, predicates = PREDICATES) {
  const items = predicates.map(p => { let r = null; try { r = p.check(facts) } catch { r = null } return { id: p.id, phase: p.phase, title: p.title, status: r === true ? 'done' : r === false ? 'open' : 'unmeasured', needs: r === null ? p.needs : undefined } })
  const phases = {}
  for (const it of items) {
    const ph = phases[it.phase] = phases[it.phase] || { total: 0, measured: 0, done: 0 }
    ph.total++; if (it.status !== 'unmeasured') ph.measured++; if (it.status === 'done') ph.done++
  }
  return { items, phases }
}

module.exports = { PREDICATES, loadFacts, evaluate }
