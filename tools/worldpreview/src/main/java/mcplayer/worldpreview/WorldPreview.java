package mcplayer.worldpreview;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderGetter;
import net.minecraft.core.QuartPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.BiomeSource;
import net.minecraft.world.level.chunk.ChunkGenerator;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.NoiseBasedChunkGenerator;
import net.minecraft.world.level.levelgen.NoiseGeneratorSettings;
import net.minecraft.world.level.levelgen.RandomState;
import net.minecraft.world.level.levelgen.synth.NormalNoise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Server-side world previewer. Drop a job file into worldpreview-jobs/ (in the server working directory); the
 * mod samples the real noise router and biome source of whatever worldgen mods are loaded, for any seed, on a coarse
 * grid. No chunks are generated or loaded. Raw grids are written to worldpreview-out/NAME/; a Python script
 * (tools/worldpreview/render.py) turns them into PNGs.
 *
 * Job file (JSON): {"name":"s1","seed":123,"x0":-2048,"z0":-2048,"x1":2048,"z1":2048,"step":8}
 * (seed may be a number or a string; "jobs":[...] is also accepted; optional "exitWhenDone":true stops the server
 * afterwards). Finished files are renamed to .done (or .failed).
 */
public class WorldPreview implements ModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("worldpreview");
    private static final Gson GSON = new Gson();
    private static final Path JOBS = Path.of("worldpreview-jobs");
    private static final Path OUT = Path.of("worldpreview-out");

    private volatile boolean busy = false;
    private ExecutorService pool;

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            try { Files.createDirectories(JOBS); Files.createDirectories(OUT); } catch (IOException e) { throw new RuntimeException(e); }
            int threads = Integer.getInteger("worldpreview.threads", Math.max(1, Runtime.getRuntime().availableProcessors() - 1));
            pool = Executors.newFixedThreadPool(threads, r -> { Thread t = new Thread(r, "worldpreview-worker"); t.setDaemon(true); return t; });
            LOG.info("worldpreview ready: drop job files into {} ({} worker threads)", JOBS.toAbsolutePath(), threads);
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> { if (pool != null) pool.shutdownNow(); });
        // Poll from our own thread: an empty dedicated server pauses ticking, so a tick hook would never fire.
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            Thread watcher = new Thread(() -> {
                while (!server.isStopped()) {
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                    if (busy || pool == null) continue;
                    Path next = nextJob();
                    if (next == null) continue;
                    busy = true;
                    try { runFile(server, next); } finally { busy = false; }
                }
            }, "worldpreview-watcher");
            watcher.setDaemon(true);
            watcher.start();
        });
    }

    private Path nextJob() {
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(JOBS, "*.json")) {
            List<Path> l = new ArrayList<>();
            for (Path p : ds) l.add(p);
            l.sort(null);
            return l.isEmpty() ? null : l.get(0);
        } catch (IOException e) { return null; }
    }

    private void runFile(MinecraftServer server, Path file) {
        boolean exit = false;
        Path running = Path.of(file + ".running");
        try {
            JsonObject root = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            Files.move(file, running, StandardCopyOption.REPLACE_EXISTING);
            exit = root.has("exitWhenDone") && root.get("exitWhenDone").getAsBoolean();
            JsonArray jobs = root.has("jobs") ? root.getAsJsonArray("jobs") : new JsonArray();
            if (!root.has("jobs")) jobs.add(root);
            for (var e : jobs) runJob(server, e.getAsJsonObject());
            Files.move(running, Path.of(file + ".done"), StandardCopyOption.REPLACE_EXISTING);
        } catch (Throwable t) {
            LOG.error("job file {} failed", file, t);
            try { Files.move(Files.exists(running) ? running : file, Path.of(file + ".failed"), StandardCopyOption.REPLACE_EXISTING); } catch (IOException ignored) { }
        }
        if (exit) server.halt(false);
    }

    private static long parseSeed(com.google.gson.JsonElement e) {
        String s = e.getAsString().trim();
        try { return Long.parseLong(s); } catch (NumberFormatException ex) { return s.hashCode(); }
    }

    private void runJob(MinecraftServer server, JsonObject job) throws Exception {
        long t0 = System.currentTimeMillis();
        long seed = parseSeed(job.get("seed"));
        String name = job.has("name") ? job.get("name").getAsString() : "seed_" + seed;
        int step = job.has("step") ? job.get("step").getAsInt() : 8;
        int x0 = job.get("x0").getAsInt(), z0 = job.get("z0").getAsInt();
        int x1 = job.get("x1").getAsInt(), z1 = job.get("z1").getAsInt();
        int nx = Math.max(1, (x1 - x0) / step), nz = Math.max(1, (z1 - z0) / step);

        ServerLevel level = server.overworld();
        ChunkGenerator gen = level.getChunkSource().getGenerator();
        if (!(gen instanceof NoiseBasedChunkGenerator nbg)) throw new IllegalStateException("overworld generator is " + gen.getClass());
        NoiseGeneratorSettings settings = nbg.generatorSettings().value();
        HolderGetter<NormalNoise.NoiseParameters> noises = server.registryAccess().lookupOrThrow(Registries.NOISE);
        RandomState rs = RandomState.create(settings, noises, seed);
        BiomeSource bs = gen.getBiomeSource();

        short[] surface = new short[nx * nz];
        short[] floor = new short[nx * nz];
        short[] biome = new short[nx * nz];
        Map<String, Integer> ids = new ConcurrentHashMap<>();
        List<String> names = java.util.Collections.synchronizedList(new ArrayList<>());
        AtomicInteger doneRows = new AtomicInteger();
        int minY = level.getMinY();
        final int seaLevel = settings.seaLevel();

        List<Future<?>> fs = new ArrayList<>();
        for (int iz = 0; iz < nz; iz++) {
            final int row = iz;
            fs.add(pool.submit(() -> {
                int z = z0 + row * step;
                for (int ix = 0; ix < nx; ix++) {
                    int x = x0 + ix * step;
                    // Column sampling has no aquifers: everything below sea level is water, so the surface is simply the
                    // higher of the solid floor and the water line. One noise-column evaluation per sample instead of two.
                    int f = gen.getBaseHeight(x, z, Heightmap.Types.OCEAN_FLOOR_WG, level, rs);
                    int h = Math.max(f, seaLevel + 1);
                    int by = Math.max(minY, h - 1);
                    Holder<Biome> b = bs.getNoiseBiome(QuartPos.fromBlock(x), QuartPos.fromBlock(by), QuartPos.fromBlock(z), rs.sampler());
                    String key = b.unwrapKey().map(k -> k.location().toString()).orElse("unknown");
                    Integer id = ids.get(key);
                    if (id == null) {
                        synchronized (names) {
                            id = ids.get(key);
                            if (id == null) { id = names.size(); names.add(key); ids.put(key, id); }
                        }
                    }
                    int idx = row * nx + ix;
                    surface[idx] = (short) h; floor[idx] = (short) f; biome[idx] = id.shortValue();
                }
                int d = doneRows.incrementAndGet();
                if (d % Math.max(1, nz / 10) == 0) LOG.info("[{}] {}%", name, d * 100 / nz);
                return null;
            }));
        }
        for (Future<?> f : fs) f.get();

        Path dir = OUT.resolve(name);
        Files.createDirectories(dir);
        write(dir.resolve("surface.i16"), surface);
        write(dir.resolve("floor.i16"), floor);
        write(dir.resolve("biome.u16"), biome);
        JsonObject meta = new JsonObject();
        meta.addProperty("name", name); meta.addProperty("seed", seed);
        meta.addProperty("x0", x0); meta.addProperty("z0", z0); meta.addProperty("step", step);
        meta.addProperty("nx", nx); meta.addProperty("nz", nz);
        meta.addProperty("minY", minY); meta.addProperty("seaLevel", settings.seaLevel());
        meta.addProperty("height", level.getHeight());
        JsonArray bn = new JsonArray();
        for (String n : names) bn.add(n);
        meta.add("biomes", bn);
        meta.addProperty("millis", System.currentTimeMillis() - t0);
        Files.writeString(dir.resolve("meta.json"), GSON.toJson(meta));
        LOG.info("[{}] done: {}x{} samples in {} ms -> {}", name, nx, nz, System.currentTimeMillis() - t0, dir.toAbsolutePath());
    }

    private static void write(Path p, short[] a) throws IOException {
        ByteBuffer bb = ByteBuffer.allocate(a.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (short s : a) bb.putShort(s);
        Files.write(p, bb.array());
    }
}
