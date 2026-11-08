#!/usr/bin/env python3
"""Render worldpreview grids (from the mod, or xaero-grid.js) to PNGs.

  python render.py relief   DIR [DIR ...] -o OUT_DIR     per-seed: <name>_relief.png, _height.png, _biomes.png
  python render.py sheet    DIR [DIR ...] -o sheet.png   one contact sheet to compare seeds side by side
  python render.py compare  PREVIEW_DIR XAERO_DIR -o OUT_DIR   check the preview against Xaero (stats + images)

DIR = a folder with meta.json, surface.i16, floor.i16 (optional), biome.u16 (as written by the mod).
"""
import argparse, colorsys, json, os, sys, zlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- loading
def load(d):
    meta = json.load(open(os.path.join(d, 'meta.json')))
    nx, nz = meta['nx'], meta['nz']
    def rd(name, dt):
        p = os.path.join(d, name)
        return np.fromfile(p, dtype=dt).reshape(nz, nx) if os.path.exists(p) else None
    g = dict(meta=meta,
             surface=rd('surface.i16', '<i2').astype(np.int32),
             floor=None, biome=rd('biome.u16', '<u2'))
    f = rd('floor.i16', '<i2')
    g['floor'] = f.astype(np.int32) if f is not None else g['surface'].copy()
    g['known'] = g['surface'] != -32768
    return g

# ---------------------------------------------------------------- biome colours
RULES = [  # (keywords, rgb) first match wins; matched on the biome path
    (('frozen_ocean', 'ice_ocean'), (190, 215, 235)),
    (('ocean',), (50, 90, 160)),
    (('river',), (60, 110, 190)),
    (('ice_spikes', 'glacier', 'glacial', 'snowy_plains', 'snowy_slopes', 'frozen_peaks', 'jagged', 'snowy_peaks', 'ice_cap'), (235, 245, 252)),
    (('snow', 'frozen', 'tundra', 'ice'), (205, 225, 238)),
    (('alpine', 'peaks', 'stony_peaks'), (200, 205, 212)),
    (('badlands', 'mesa', 'canyon', 'terracotta', 'red_', 'orange', 'rocky_jungle'), (205, 120, 70)),
    (('desert', 'dunes', 'sand', 'oasis'), (232, 214, 140)),
    (('savanna', 'steppe', 'arid', 'warm_'), (190, 180, 90)),
    (('beach', 'shore', 'coast'), (240, 230, 175)),
    (('mushroom',), (190, 130, 200)),
    (('volcan', 'basalt', 'ash', 'caldera', 'lava', 'blackstone'), (80, 75, 80)),
    (('jungle', 'rainforest', 'bamboo', 'tropic'), (30, 130, 40)),
    (('swamp', 'mangrove', 'marsh', 'bog', 'wetland', 'fen'), (80, 110, 60)),
    (('taiga', 'spruce', 'pine', 'fir', 'conifer', 'boreal', 'redwood', 'sequoia'), (50, 110, 85)),
    (('cherry', 'sakura'), (240, 170, 200)),
    (('birch', 'aspen'), (130, 170, 90)),
    (('dark_forest', 'dark_oak'), (45, 85, 40)),
    (('forest', 'wood', 'grove', 'shrubland', 'thicket', 'orchard'), (75, 140, 60)),
    (('plains', 'meadow', 'grassland', 'prairie', 'field', 'valley', 'moor', 'heath', 'lavender', 'flower', 'sunflower'), (140, 190, 90)),
    (('mountain', 'cliff', 'highland', 'hills', 'ridge', 'rocky', 'stone', 'gravel', 'peak', 'crag', 'rock', 'tuff'), (140, 140, 145)),
    (('cave', 'dripstone', 'deep_dark'), (100, 90, 90)),
]

def biome_rgb(name):
    path = name.split(':')[-1]
    for kws, rgb in RULES:
        if any(k in path for k in kws):
            base = rgb
            break
    else:
        base = (150, 150, 150)
    # small stable per-biome jitter so Terralith's many variants stay distinguishable
    h = zlib.crc32(name.encode()) & 0xffffffff
    j = lambda s: ((h >> s) & 31) / 31.0 - 0.5
    hh, ss, vv = colorsys.rgb_to_hsv(*(c / 255 for c in base))
    hh = (hh + 0.03 * j(0)) % 1.0
    ss = min(1, max(0, ss * (1 + 0.25 * j(5))))
    vv = min(1, max(0, vv * (1 + 0.18 * j(10))))
    return tuple(int(c * 255) for c in colorsys.hsv_to_rgb(hh, ss, vv))

def is_water_biome(name):
    p = name.split(':')[-1]
    return 'ocean' in p or 'river' in p

def palette(biomes):
    pal = np.zeros((65536, 3), np.uint8)
    pal[:] = (30, 30, 30)
    for i, n in enumerate(biomes):
        pal[i] = biome_rgb(n)
    return pal

# ---------------------------------------------------------------- shading
def hillshade(z, step, azimuth=315, altitude=45, exaggeration=2.0):
    z = z.astype(np.float64)
    dzdy, dzdx = np.gradient(z, step)  # rows = z axis (south is +), cols = x axis (east is +)
    az, alt = np.radians(azimuth), np.radians(altitude)
    slope = np.arctan(exaggeration * np.hypot(dzdx, dzdy))
    aspect = np.arctan2(dzdy, -dzdx)
    sh = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(sh, 0, 1)

HYPSO = [(-64, (10, 20, 70)), (30, (30, 70, 150)), (60, (70, 130, 200)), (63, (150, 200, 120)), (80, (110, 170, 70)),
         (120, (200, 190, 100)), (180, (160, 120, 70)), (260, (140, 140, 140)), (340, (255, 255, 255))]

def hypso(h):
    xs = np.array([a for a, _ in HYPSO], float)
    out = np.zeros(h.shape + (3,))
    for c in range(3):
        out[..., c] = np.interp(h, xs, [b[c] for _, b in HYPSO])
    return out

def render_relief(g, mode='relief'):
    m = g['meta']; step = m['step']; sea = m['seaLevel']
    surf, floor, known = g['surface'], g['floor'], g['known']
    names = m['biomes']
    pal = palette(names)
    bid = g['biome'].astype(np.int32) if g['biome'] is not None else np.zeros_like(surf)
    bid = np.where(bid >= len(names), 65535, bid)
    water = (surf > floor) & (surf <= sea + 1) if g['meta'].get('source') != 'xaero' else np.zeros_like(known)
    if mode == 'biomes':
        img = pal[bid].astype(np.float64)
    elif mode == 'height':
        img = hypso(np.where(water, floor, surf))
    else:
        base = pal[bid].astype(np.float64)
        # water: depth tint over the biome colour, shaded by the sea floor
        depth = np.clip((sea - floor) / 60.0, 0, 1)[..., None]
        shallow, deep = np.array([75, 135, 200.]), np.array([15, 35, 100.])
        wcol = shallow * (1 - depth) + deep * depth
        base = np.where(water[..., None], 0.75 * wcol + 0.25 * base, base)
        z = np.where(water, sea - (sea - floor) * 0.15, surf)
        sh = hillshade(z, step, exaggeration=max(1.0, 8.0 / step * 2.0 + 1.0))
        shade = 0.55 + 0.75 * sh  # ~1.0 on flat ground (sh ~0.7)
        # a touch of elevation brightening so lowlands vs highlands read at a glance
        elev = np.clip((surf - sea) / 220.0, 0, 1)[..., None]
        base = base * (0.92 + 0.22 * elev)
        img = base * shade[..., None]
    img = np.clip(img, 0, 255).astype(np.uint8)
    img[~known] = (24, 24, 28)
    return Image.fromarray(img)

def stats(g):
    m = g['meta']; s = g['surface'][g['known']]; sea = m['seaLevel']
    fl = g['floor'][g['known']]
    land = (s > sea + 1) | (s <= fl)  # not open water
    names = m['biomes']
    b = g['biome'][g['known']] if g['biome'] is not None else np.array([], int)
    cnt = np.bincount(b[b < len(names)], minlength=len(names)) if len(b) else np.zeros(len(names), int)
    top = sorted(((c, n) for c, n in zip(cnt, names) if c), reverse=True)[:8]
    return dict(land_pct=100.0 * float(land.mean()), mean_h=float(s.mean()), p95=float(np.percentile(s, 95)),
                p99=float(np.percentile(s, 99)), max_h=int(s.max()), n_biomes=int((cnt > 0).sum()),
                top=[(n, 100.0 * c / max(1, cnt.sum())) for c, n in top])

# ---------------------------------------------------------------- drawing helpers
def font(size):
    for f in ('arial.ttf', 'segoeui.ttf', 'DejaVuSans.ttf'):
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()

def scalebar(img, g, scale_px_per_block):
    d = ImageDraw.Draw(img)
    blocks = 1000 if g['meta']['nx'] * g['meta']['step'] >= 3000 else 500
    px = int(blocks * scale_px_per_block)
    W, H = img.size
    y = H - 14
    d.rectangle([10, y - 4, 10 + px, y], fill=(255, 255, 255), outline=(0, 0, 0))
    d.text((14 + px, y - 14), f'{blocks} blocks', fill=(255, 255, 255), font=font(13), stroke_width=2, stroke_fill=(0, 0, 0))

def label(img, text, sub=None):
    d = ImageDraw.Draw(img)
    d.text((10, 8), text, fill=(255, 255, 255), font=font(20), stroke_width=3, stroke_fill=(0, 0, 0))
    if sub:
        d.text((10, 34), sub, fill=(255, 255, 255), font=font(13), stroke_width=2, stroke_fill=(0, 0, 0))

def upscale(im, factor):
    return im.resize((im.width * factor, im.height * factor), Image.BILINEAR) if factor != 1 else im

# ---------------------------------------------------------------- commands
def cmd_relief(a):
    os.makedirs(a.o, exist_ok=True)
    for d in a.dirs:
        g = load(d); name = g['meta']['name'].replace(':', '_')
        f = max(1, a.scale // g['meta']['step']) if a.scale else 1
        for mode in ('relief', 'height', 'biomes'):
            im = upscale(render_relief(g, mode), f)
            label(im, f"{g['meta']['name']}  seed {g['meta'].get('seed', '?')}", f"{mode}, 1 px = {g['meta']['step'] / f:g} blocks")
            scalebar(im, g, f / g['meta']['step'])
            im.save(os.path.join(a.o, f'{name}_{mode}.png'))
        print(name, json.dumps(stats(g)['top'][:3]))

def cmd_sheet(a):
    gs = [load(d) for d in a.dirs]
    tile = a.tile
    ims = []
    for g in gs:
        im = render_relief(g, 'relief').resize((tile, tile), Image.LANCZOS)
        s = stats(g)
        label(im, f"seed {g['meta'].get('seed', g['meta']['name'])}", f"land {s['land_pct']:.0f}%  peak {s['max_h']}  p95 {s['p95']:.0f}  biomes {s['n_biomes']}")
        scalebar(im, g, tile / (g['meta']['nx'] * g['meta']['step']))
        ims.append(im)
    cols = min(len(ims), a.cols); rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * tile + (cols + 1) * 6, rows * tile + (rows + 1) * 6), (18, 18, 20))
    for i, im in enumerate(ims):
        sheet.paste(im, (6 + (i % cols) * (tile + 6), 6 + (i // cols) * (tile + 6)))
    sheet.save(a.o); print('wrote', a.o)

def cmd_compare(a):
    os.makedirs(a.o, exist_ok=True)
    p, x = load(a.dirs[0]), load(a.dirs[1])
    pm, xm = p['meta'], x['meta']
    assert (pm['x0'], pm['z0'], pm['step'], pm['nx'], pm['nz']) == (xm['x0'], xm['z0'], xm['step'], xm['nx'], xm['nz']), 'grids differ'
    k = x['known'] & p['known']
    # Xaero records the solid top (sea floor under water), so compare it with the preview's floor grid
    ph, xh = p['floor'][k].astype(float), x['surface'][k].astype(float)
    # trees/leaves make Xaero read up to ~10 higher than the bare terrain: report also the robust numbers
    d = ph - xh
    out = dict(samples=int(k.sum()), explored_pct=100.0 * float(x['known'].mean()),
               corr=float(np.corrcoef(ph, xh)[0, 1]), mean_diff=float(d.mean()), median_diff=float(np.median(d)),
               mae=float(np.abs(d).mean()), within_3=float((np.abs(d) <= 3).mean() * 100), within_8=float((np.abs(d) <= 8).mean() * 100),
               rmse=float(np.sqrt((d ** 2).mean())))
    # biome agreement: map each xaero biome name to the preview biome name
    pb, xb = p['biome'][k], x['biome'][k]
    pn, xn = pm['biomes'], xm['biomes']
    ok = (xb < len(xn)) & (pb < len(pn))
    same = np.array([pn[i] == xn[j] for i, j in zip(pb[ok], xb[ok])])
    out['biome_exact_match_pct'] = 100.0 * float(same.mean()) if len(same) else None
    json.dump(out, open(os.path.join(a.o, 'compare.json'), 'w'), indent=1)
    print(json.dumps(out, indent=1))
    # side-by-side: preview | xaero (same shading) | height difference
    ip, ix_ = render_relief(p, 'relief'), render_relief(x, 'relief')
    diff = np.zeros(p['surface'].shape + (3,), np.uint8) + np.array([24, 24, 28], np.uint8)
    dd = np.clip((p['floor'] - x['surface']) / 20.0, -1, 1)
    r = np.where(dd > 0, 255, 255 * (1 + dd)); b = np.where(dd < 0, 255, 255 * (1 - dd)); gch = 255 * (1 - np.abs(dd))
    col = np.stack([r, gch, b], -1).astype(np.uint8)
    diff[k] = col[k]
    idf = Image.fromarray(diff)
    w, h = ip.size
    f = max(1, a.scale // pm['step']) if a.scale else 1
    sheet = Image.new('RGB', (3 * w * f + 24, h * f + 12), (18, 18, 20))
    for i, (im, t) in enumerate(((ip, 'preview (mod)'), (ix_, 'Xaero (ground truth)'), (idf, 'preview - Xaero height (red = preview higher, blue = lower, +-20)'))):
        im = upscale(im, f); label(im, t); sheet.paste(im, (6 + i * (w * f + 6), 6))
    sheet.save(os.path.join(a.o, 'compare.png'))
    # scatter
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.hexbin(xh, ph, gridsize=90, bins='log', cmap='viridis')
    lim = [min(xh.min(), ph.min()), max(xh.max(), ph.max())]
    ax.plot(lim, lim, 'r--', lw=1); ax.set_xlabel('Xaero surface height'); ax.set_ylabel('preview floor height')
    ax.set_title(f"r = {out['corr']:.3f}, median diff {out['median_diff']:+.1f}, within 8: {out['within_8']:.0f}%")
    fig.tight_layout(); fig.savefig(os.path.join(a.o, 'scatter.png'), dpi=110)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['relief', 'sheet', 'compare'])
    ap.add_argument('dirs', nargs='+')
    ap.add_argument('-o', default='out')
    ap.add_argument('--scale', type=int, default=0, help='target blocks-per-pixel divisor: upscale so 1 px = step/f blocks')
    ap.add_argument('--tile', type=int, default=640)
    ap.add_argument('--cols', type=int, default=3)
    a = ap.parse_args()
    {'relief': cmd_relief, 'sheet': cmd_sheet, 'compare': cmd_compare}[a.cmd](a)
