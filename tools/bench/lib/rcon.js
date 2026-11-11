// Minimal RCON client (Source RCON protocol, which vanilla Minecraft speaks). Used by the bench to run server commands and read state
// without a second player in the world. Enable with enable-rcon=true, rcon.port, rcon.password in server.properties.
'use strict'
const net = require('net')

function connect({ host = '127.0.0.1', port, password, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port })
    let buf = Buffer.alloc(0), nextId = 1
    const waiting = new Map()
    const fail = (e) => { for (const w of waiting.values()) w.reject(e); waiting.clear() }
    sock.on('error', (e) => { fail(e); reject(e) })
    sock.on('close', () => fail(new Error('rcon closed')))
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0)
        if (buf.length < 4 + len) break
        const id = buf.readInt32LE(4), type = buf.readInt32LE(8), body = buf.toString('utf8', 12, 4 + len - 2)
        buf = buf.subarray(4 + len)
        const w = waiting.get(id)
        if (w && (type === 0 || type === 2)) { waiting.delete(id); w.resolve(body) }
        else if (id === -1) { const first = [...waiting.values()][0]; waiting.clear(); if (first) first.reject(new Error('rcon: wrong password')) }
      }
    })
    const send = (type, body) => new Promise((res, rej) => {
      const id = nextId++
      const payload = Buffer.from(body, 'utf8'), pkt = Buffer.alloc(14 + payload.length)
      pkt.writeInt32LE(10 + payload.length, 0); pkt.writeInt32LE(id, 4); pkt.writeInt32LE(type, 8); payload.copy(pkt, 12)
      const timer = setTimeout(() => { waiting.delete(id); rej(new Error('rcon timeout: ' + body)) }, timeoutMs)
      waiting.set(id, { resolve: (v) => { clearTimeout(timer); res(v) }, reject: (e) => { clearTimeout(timer); rej(e) } })
      sock.write(pkt)
    })
    sock.once('connect', async () => {
      try {
        await send(3, password)
        resolve({ cmd: (c) => send(2, c), close: () => sock.destroy() })
      } catch (e) { sock.destroy(); reject(e) }
    })
  })
}
module.exports = { connect }
