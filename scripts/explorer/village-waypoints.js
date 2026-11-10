// Keeps Walter's Xaero minimap waypoint file for "New World (3)" holding a "Villages" set with one waypoint per village Smeo444 found.
// Names are Greek and Roman places, given in the order villages are found and kept in villages.json. Other waypoints and sets in
// the file are left as they are; the village lines are rewritten whenever they are missing or out of date (Xaero rewrites the file from
// memory on its own saves). Run: node village-waypoints.js  (loops every 10 s)
const fs = require('fs'), path = require('path')
const VFILE = path.join(__dirname, 'villages.json')
const WFILE = path.join(process.env.APPDATA, '.minecraft', 'xaero', 'minimap', 'New World (3)', 'dim%0', 'waypoints.txt')
const NAMES = ['Athenae', 'Sparta', 'Corinthus', 'Delphi', 'Olympia', 'Argos', 'Thebae', 'Ithaca', 'Roma', 'Pompeii', 'Capua', 'Ostia',
  'Neapolis', 'Syracusae', 'Mycenae', 'Rhodos', 'Ephesus', 'Pergamon', 'Knossos', 'Thermopylae', 'Herculaneum', 'Ravenna', 'Brundisium',
  'Massilia', 'Smyrna', 'Byzantium', 'Antium', 'Tarentum', 'Megara', 'Eleusis', 'Marathon', 'Troia', 'Tiryns', 'Pylos', 'Aquileia', 'Verona',
  'Mediolanum', 'Florentia', 'Arretium', 'Tusculum', 'Praeneste', 'Tibur', 'Paestum', 'Cumae', 'Rhegium', 'Messana', 'Akragas', 'Gela',
  'Naxos', 'Delos', 'Samos', 'Chios', 'Lesbos', 'Miletus', 'Halicarnassus', 'Sardis', 'Nicaea', 'Antiochia', 'Alexandria', 'Cyrene',
  'Leptis Magna', 'Utica', 'Gades', 'Tarraco', 'Emerita', 'Lugdunum', 'Arelate', 'Nemausus', 'Londinium', 'Eboracum', 'Colonia', 'Treveri']
const COLORS = [6, 14, 10, 2, 11, 13, 5, 3, 12, 9]
function tick() {
  let V = []; try { V = JSON.parse(fs.readFileSync(VFILE, 'utf8')) } catch { return }
  let named = false
  V.forEach((v, i) => { if (!v.name) { v.name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ' ' + (Math.floor(i / NAMES.length) + 1) : ''); named = true } })
  if (named) fs.writeFileSync(VFILE, JSON.stringify(V, null, 1))
  const lines = V.map((v, i) => `waypoint:${v.name}:${v.name[0]}:${v.x}:${v.y}:${v.z}:${COLORS[i % COLORS.length]}:false:0:Villages:false:0:0:false`)
  let txt = ''; try { txt = fs.readFileSync(WFILE, 'utf8') } catch {}
  const all = txt.split(/\r?\n/).filter(l => l.length)
  const others = all.filter(l => !/^waypoint:/.test(l) || l.split(':')[9] !== 'Villages')
  const header = others.filter(l => l.startsWith('#'))
  let sets = others.find(l => l.startsWith('sets:'))
  const rest = others.filter(l => !l.startsWith('#') && !l.startsWith('sets:'))
  if (!sets) sets = 'sets:gui.xaero_default:Villages'
  else if (!sets.split(':').includes('Villages')) sets += ':Villages'
  const head = header.length ? header : ['#', '#waypoint:name:initials:x:y:z:color:disabled:type:set:rotate_on_tp:tp_yaw:visibility_type:destination', '#']
  const out = [...head, sets, ...rest, ...lines].join('\n') + '\n'
  if (out !== txt) { fs.mkdirSync(path.dirname(WFILE), { recursive: true }); fs.writeFileSync(WFILE, out); console.log(new Date().toISOString(), 'wrote', lines.length, 'village waypoints') }
}
tick(); setInterval(tick, 10000)
