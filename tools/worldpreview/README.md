# worldpreview: preview a seed's terrain without generating chunks

A small **server-side Fabric mod** (1.21.6) plus a Python renderer. The mod loads inside a throwaway headless server that has
your worldgen mods (Terralith, Tectonic, Lithostitched, CTOV, ...), so it samples the **real** noise router and biome source,
including each mod's data and configs. It never loads or generates chunks. For any seed you give it, it writes a coarse grid
of terrain height, sea-floor height and biome; `render.py` turns that into a shaded relief map, a height map and a biome map,
or a side-by-side sheet to compare seeds. Unlike Genesis (biomes only), this shows height and terrain shape.

Checked against Walter's Xaero map for "New World (3)" (seed -3721362522880769102): see "Accuracy" below.

## One-time setup (nothing here touches your .minecraft or saves)
1. Build the mod: `cd tools/worldpreview && ./gradlew build` (needs a JDK 21+; Gradle wrapper downloads Loom and Minecraft).
   Output: `build/libs/worldpreview-0.1.0.jar`.
2. Make a scratch server folder outside OneDrive, e.g. `C:\Users\you\mc-worldpreview\server`:
   - `fabric-server-launch.jar` from `https://meta.fabricmc.net/v2/versions/loader/1.21.6/0.18.1/1.1.2/server/jar`
   - `mods/`: fabric-api, lithostitched, tectonic, Terralith, CTOV (your worldgen mods; the same jars as in .minecraft/mods) and `worldpreview-0.1.0.jar`
   - `config/`: copy `tectonic.json` and `lithostitched.json` from `.minecraft/config` (terrain settings live there)
   - `server.properties`: `server-ip=127.0.0.1`, `online-mode=false`, `server-port=25599`, `view-distance=2`
   - run it once, then set `eula=true` in `eula.txt` (this is Mojang's server EULA, your decision) and run it again.
   Use the Java 21 runtime Minecraft ships with (`...\runtime\java-runtime-delta\windows-x64\java-runtime-delta\bin\java.exe`).
3. `java -Xmx3G -jar fabric-server-launch.jar nogui` and leave it running (startup is ~2 min with Terralith).

## Use
Drop a job file into `server/worldpreview-jobs/`; the mod picks it up within a second, writes
`server/worldpreview-out/<name>/{meta.json,surface.i16,floor.i16,biome.u16}`, and renames the job to `.done`.

```json
{"jobs":[
  {"name":"seedA","seed":"-3721362522880769102","x0":-2048,"z0":-2048,"x1":2048,"z1":2048,"step":32},
  {"name":"seedB","seed":"my cool seed","x0":-2048,"z0":-2048,"x1":2048,"z1":2048,"step":32}
]}
```
`seed` is a number or text; text is hashed the way the world creation screen does it (a numeric string is used as-is).
`step` = blocks between samples. Add `"exitWhenDone":true` to stop the server afterwards.

Render:
```
python render.py relief  server/worldpreview-out/seedA -o img            # _relief.png, _height.png, _biomes.png
python render.py sheet   server/worldpreview-out/seed* -o sheet.png      # compare seeds side by side
python render.py compare server/worldpreview-out/nw3 xaero_nw3 -o cmp    # vs Xaero (see below)
```

## Speed
Sampling is the vanilla column search (`getBaseHeight`) and costs roughly 80 CPU-ms per sample on Tectonic's big density
graph. With 7 threads that is ~90 samples/s: a 4096x4096 area at step 32 (16k samples) takes ~3 min per seed; step 16 is 4x that.
Start at step 32 to screen seeds, then re-run the winner at step 8-16.

## Checking against Xaero (read-only)
```
node xaero-grid.js "New World (3)" -2560 -1024 2560 1536 16 xaero_nw3     # same grid layout as the mod output
python render.py compare <preview dir with the same x0/z0/step/nx/nz> xaero_nw3 -o cmp
```
Xaero stores the top solid block (sea floor under water; trees/leaves count). The preview's `floor` grid is the bare-terrain
equivalent, so trees show up as small blue dots (Xaero higher) in the difference map.

## Accuracy (New World (3), 11,873 explored 16-block columns)
- Height: 87% of columns within 3 blocks, 93% within 8, median difference 0, correlation 0.87. Outliers are trees, player
  builds and spots Xaero drew oddly.
- Biome: 47% exact match. Most misses are the neighbouring class at boundaries (forest vs plains, river vs plains). Minecraft
  fuzzes biome edges per block and the biome also depends on y, which a coarse grid cannot reproduce.
- Not modelled: surface blocks (the colour is by biome, not block), trees, structures, caves, rivers narrower than the step.
