// brain/schematic/anvil.js: the WRITE side of a world save (brain/schematic/world.js is the read side). Anvil region files, chunk NBT and a level.dat for Minecraft 1.21.6
// (DataVersion 4435). Pure apart from the `write*` functions, which create files. No game and no server needed.
//
// A chunk is a stack of 24 sections (y -64..319), each 16x16x16 cells given as a palette of block states and bit-packed indices (min 4 bits, entries never span two longs).
// We write every chunk as Status "full" without light data (isLightOn 0): Minecraft lights it when the world loads.
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

const DATA_VERSION = 4435
const MIN_Y = -64, HEIGHT = 384, SECTIONS = HEIGHT >> 4

const stateKey = (name, props) => name + (props && Object.keys(props).length ? '[' + Object.keys(props).sort().map(k => k + '=' + props[k]).join(',') + ']' : '')

// grid: the cells of a box of whole chunks. { cx0, cz0, nx, nz (in chunks), cells: Uint16Array indexed (y+64) * (X*Z) + z * X + x with X = nx*16, Z = nz*16, states: [{ name, props }] (index 0 is air) }
function sectionNbt(grid, sy, cxl, czl, biome) {
  const X = grid.nx * 16, Z = grid.nz * 16, local = new Map(), pal = [], idxs = new Uint16Array(4096)
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
    const row = ((sy * 16 + y) * Z + czl * 16 + z) * X + cxl * 16
    for (let x = 0; x < 16; x++) {
      const g = grid.cells[row + x]
      let l = local.get(g)
      if (l === undefined) { l = pal.length; local.set(g, l); pal.push(g) }
      idxs[x + 16 * z + 256 * y] = l
    }
  }
  const palette = pal.map(g => { const s = grid.states[g]; return nbt.comp({ Name: nbt.string('minecraft:' + s.name.replace(/^minecraft:/, '')), ...(s.props && Object.keys(s.props).length ? { Properties: nbt.comp(Object.fromEntries(Object.entries(s.props).map(([k, v]) => [k, nbt.string(String(v))]))) } : {}) }) })
  const block_states = { palette: nbt.list(nbt.comp(palette.map(p => p.value))) }
  if (pal.length > 1) {
    const bits = Math.max(4, Math.ceil(Math.log2(pal.length))), per = Math.floor(64 / bits), longs = new Array(Math.ceil(4096 / per))
    for (let l = 0; l < longs.length; l++) {
      let v = 0n
      for (let j = 0; j < per; j++) { const i = l * per + j; if (i >= 4096) break; v |= BigInt(idxs[i]) << BigInt(j * bits) }
      longs[l] = BigInt.asIntN(64, v)
    }
    block_states.data = nbt.longArray(longs)
  }
  return nbt.comp({ Y: nbt.byte(sy - 4), block_states: nbt.comp(block_states), biomes: nbt.comp({ palette: nbt.list(nbt.string([biome])) }) })
}

function chunkNbt(grid, cxl, czl, opt) {
  const secs = []
  for (let sy = 0; sy < SECTIONS; sy++) secs.push(sectionNbt(grid, sy, cxl, czl, opt.biome).value)
  return nbt.comp({
    DataVersion: nbt.int(DATA_VERSION), xPos: nbt.int(grid.cx0 + cxl), zPos: nbt.int(grid.cz0 + czl), yPos: nbt.int(-4), Status: nbt.string('minecraft:full'),
    LastUpdate: nbt.long(0n), InhabitedTime: nbt.long(0n), isLightOn: nbt.byte(0),
    sections: nbt.list(nbt.comp(secs)), block_entities: nbt.list(nbt.comp([])),
    structures: nbt.comp({ starts: nbt.comp({}), References: nbt.comp({}) }),
  }, '')
}

// one Anvil region file (32x32 chunks): header of 1024 offsets + 1024 timestamps, then each chunk zlib-compressed and padded to 4 KiB sectors
function regionFile(chunks) {   // chunks: Map "lx,lz" (0..31) -> compressed-NBT Buffer
  const parts = [Buffer.alloc(8192)], head = parts[0]
  let sector = 2
  const now = Math.floor(Date.now() / 1000)
  for (const [k, data] of chunks) {
    const [lx, lz] = k.split(',').map(Number), i = lx + lz * 32
    const body = Buffer.concat([Buffer.alloc(5), data]); body.writeUInt32BE(data.length + 1, 0); body[4] = 2   // 2 = zlib
    const n = Math.ceil(body.length / 4096), padded = Buffer.alloc(n * 4096); body.copy(padded)
    head.writeUIntBE(sector, i * 4, 3); head[i * 4 + 3] = n; head.writeUInt32BE(now, 4096 + i * 4)
    parts.push(padded); sector += n
  }
  return Buffer.concat(parts)
}

// grid -> region/r.X.Z.mca files in saveDir. -> number of chunks written
function writeChunks(saveDir, grid, opt = {}) {
  const regions = new Map()
  for (let czl = 0; czl < grid.nz; czl++) for (let cxl = 0; cxl < grid.nx; cxl++) {
    const cx = grid.cx0 + cxl, cz = grid.cz0 + czl, rk = (cx >> 5) + ',' + (cz >> 5)
    if (!regions.has(rk)) regions.set(rk, new Map())
    const raw = nbt.writeUncompressed(chunkNbt(grid, cxl, czl, { biome: opt.biome || 'minecraft:plains' }), 'big')
    regions.get(rk).set((cx & 31) + ',' + (cz & 31), zlib.deflateSync(raw))
  }
  fs.mkdirSync(path.join(saveDir, 'region'), { recursive: true })
  let n = 0
  for (const [rk, chunks] of regions) { const [rx, rz] = rk.split(',').map(Number); fs.writeFileSync(path.join(saveDir, 'region', `r.${rx}.${rz}.mca`), regionFile(chunks)); n += chunks.size }
  return n
}

const str = nbt.string, int = nbt.int, byte = nbt.byte
const rules = (o) => nbt.comp(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, str(String(v))])))

// level.dat for a creative test world. kind 'grass' = superflat bedrock/dirt/grass in plains, 'void' = superflat nothing in the_void.
// Only the vanilla data pack is enabled, so world-generation mods (Terralith, Tectonic ...) stay out of it; the flat generator ignores them anyway.
function levelDat({ name, kind = 'grass', groundTop = -61, spawn = [0, -60, 0], time = 6000, seed = 0n }) {
  const flat = kind === 'void'
    ? { biome: str('minecraft:the_void'), features: byte(0), lakes: byte(0), structure_overrides: nbt.list(str([])), layers: nbt.list(nbt.comp([{ block: str('minecraft:air'), height: int(1) }])) }
    : { biome: str('minecraft:plains'), features: byte(0), lakes: byte(0), structure_overrides: nbt.list(str([])), layers: nbt.list(nbt.comp([{ block: str('minecraft:bedrock'), height: int(1) }, ...(groundTop > -61 ? [{ block: str('minecraft:stone'), height: int(groundTop + 61) }] : []), { block: str('minecraft:dirt'), height: int(2) }, { block: str('minecraft:grass_block'), height: int(1) }])) }
  const dims = nbt.comp({
    'minecraft:overworld': nbt.comp({ type: str('minecraft:overworld'), generator: nbt.comp({ type: str('minecraft:flat'), settings: nbt.comp(flat) }) }),
    'minecraft:the_nether': nbt.comp({ type: str('minecraft:the_nether'), generator: nbt.comp({ type: str('minecraft:noise'), settings: str('minecraft:nether'), biome_source: nbt.comp({ type: str('minecraft:multi_noise'), preset: str('minecraft:nether') }) }) }),
    'minecraft:the_end': nbt.comp({ type: str('minecraft:the_end'), generator: nbt.comp({ type: str('minecraft:noise'), settings: str('minecraft:end'), biome_source: nbt.comp({ type: str('minecraft:the_end') }) }) }),
  }).value
  const Data = nbt.comp({
    DataVersion: int(DATA_VERSION), version: int(19133), LevelName: str(name), Version: nbt.comp({ Id: int(DATA_VERSION), Name: str('1.21.6'), Series: str('main'), Snapshot: byte(0) }),
    GameType: int(1), Difficulty: byte(0), DifficultyLocked: byte(0), hardcore: byte(0), allowCommands: byte(1), initialized: byte(1),
    SpawnX: int(spawn[0]), SpawnY: int(spawn[1]), SpawnZ: int(spawn[2]), SpawnAngle: nbt.float(0),
    Time: nbt.long(BigInt(time)), DayTime: nbt.long(BigInt(time)), LastPlayed: nbt.long(BigInt(Date.now())),
    raining: byte(0), thundering: byte(0), rainTime: int(0), thunderTime: int(0), clearWeatherTime: int(1000000),
    BorderCenterX: nbt.double(0), BorderCenterZ: nbt.double(0), BorderSize: nbt.double(59999968), BorderSizeLerpTarget: nbt.double(59999968), BorderSizeLerpTime: nbt.long(0n), BorderSafeZone: nbt.double(5), BorderDamagePerBlock: nbt.double(0.2), BorderWarningBlocks: nbt.double(5), BorderWarningTime: nbt.double(15),
    WanderingTraderSpawnChance: int(25), WanderingTraderSpawnDelay: int(24000), CustomBossEvents: nbt.comp({}), DragonFight: nbt.comp({ NeedsStateScanning: byte(1), DragonKilled: byte(0), PreviouslyKilled: byte(0) }), ScheduledEvents: nbt.list(nbt.comp([])),
    GameRules: rules({ doDaylightCycle: 'false', doWeatherCycle: 'false', doMobSpawning: 'false', doInsomnia: 'false', doPatrolSpawning: 'false', doTraderSpawning: 'false', keepInventory: 'true', mobGriefing: 'false', announceAdvancements: 'false', spawnRadius: '0', doFireTick: 'false', randomTickSpeed: '0' }),
    DataPacks: nbt.comp({ Enabled: nbt.list(str(['vanilla'])), Disabled: nbt.list(str([])) }),
    WorldGenSettings: nbt.comp({ seed: nbt.long(BigInt.asIntN(64, BigInt(seed))), generate_features: byte(0), bonus_chest: byte(0), dimensions: nbt.comp(dims) }),
  })
  return nbt.comp({ Data }, '')
}
const writeLevelDat = (saveDir, opt) => fs.writeFileSync(path.join(saveDir, 'level.dat'), zlib.gzipSync(nbt.writeUncompressed(levelDat(opt), 'big')))

module.exports = { DATA_VERSION, MIN_Y, HEIGHT, stateKey, chunkNbt, regionFile, writeChunks, levelDat, writeLevelDat }
