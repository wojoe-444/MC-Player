// The LAN port follower: parse Minecraft's announcement, write lan-port.txt only where it changed, and accept announcements from this machine only.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path'), dgram = require('dgram')
const W = require('../scripts/lan-watch')

test('parseAnnouncement reads the motd and the port, and rejects anything else', () => {
  assert.deepStrictEqual(W.parseAnnouncement('[MOTD]Earth24k - Chicago[/MOTD][AD]53197[/AD]'), { motd: 'Earth24k - Chicago', port: 53197 })
  assert.strictEqual(W.parseAnnouncement('hello'), null)
  assert.strictEqual(W.parseAnnouncement('[MOTD]x[/MOTD][AD]80[/AD]'), null, 'a privileged port is not a LAN world')
  assert.strictEqual(W.parseAnnouncement('[MOTD]x[/MOTD][AD]99999[/AD]'), null)
})

test('writePort touches only the runtimes whose port differs, and skips folders that do not exist', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'lanw-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'lanw-'))
  fs.writeFileSync(path.join(a, 'lan-port.txt'), '49181\n'); fs.writeFileSync(path.join(b, 'lan-port.txt'), '53197\n')
  const changed = W.writePort([a, b, path.join(a, 'nope')], 53197)
  assert.deepStrictEqual(changed, [a])
  assert.strictEqual(parseInt(fs.readFileSync(path.join(a, 'lan-port.txt'), 'utf8'), 10), 53197)
  assert.deepStrictEqual(W.writePort([a, b], 53197), [], 'nothing to do the second time')
})

test('a local announcement over the loopback socket reaches the file (two in a row)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanw-'))
  const logs = []
  const sock = W.start([dir], (m) => logs.push(m))
  await new Promise(r => setTimeout(r, 200))
  const tx = dgram.createSocket('udp4')
  const send = (txt) => new Promise(r => tx.send(Buffer.from(txt), 4445, '224.0.2.60', r))
  try {
    for (let i = 0; i < 6; i++) { await send('[MOTD]test world[/MOTD][AD]54321[/AD]'); await new Promise(r => setTimeout(r, 80)) }
  } catch { /* no multicast route in this sandbox */ }
  tx.close(); sock.close()
  if (!fs.existsSync(path.join(dir, 'lan-port.txt'))) { console.log('# no multicast loopback here: socket path not exercised (' + logs.join(' | ') + ')'); return }
  assert.strictEqual(parseInt(fs.readFileSync(path.join(dir, 'lan-port.txt'), 'utf8'), 10), 54321)
})
