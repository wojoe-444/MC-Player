const mineflayer=require('mineflayer');const {pathfinder}=require('mineflayer-pathfinder')
const cb=require('mineflayer-collectblock');const tool=require('mineflayer-tool')
const pvp=require('@nxg-org/mineflayer-custom-pvp')
console.log('exports',Object.keys(cb),typeof tool.plugin,typeof pvp, Object.keys(pvp).slice(0,10))
// fake offline bot object check of plugin injection
const EventEmitter=require('events')
const b=new EventEmitter();b.version='1.21.6';b.registry=require('minecraft-data')('1.21.6')
try{ b.loadPlugin=(p)=>p(b,{});b.loadPlugin(pathfinder);console.log('pathfinder ok')}catch(e){console.log('pf',e.message)}
try{ b.loadPlugin(tool.plugin);console.log('tool ok')}catch(e){console.log('tool',e.message)}
try{ b.loadPlugin(cb.plugin);console.log('collectblock ok',Object.keys(b.collectBlock||{}))}catch(e){console.log('cb',e.message)}
try{ b.util={};b.loadPlugin(pvp.default||pvp);console.log('pvp ok',!!b.swordpvp)}catch(e){console.log('pvp',e.message.split('\n')[0])}
