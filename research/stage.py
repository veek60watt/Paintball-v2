# Research fetcher run by .github/workflows/house-research.yml. Everything written to out/ is
# encrypted with research/pub.pem before publishing; public/ holds only non-sensitive probe results.
import json, time, math, pathlib, urllib.request, urllib.parse, xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

CFG = json.load(open('research/config.json'))
OUT = pathlib.Path('out'); OUT.mkdir(exist_ok=True)
PUB = pathlib.Path('public'); PUB.mkdir(exist_ok=True)
UA = 'Paperball-research/1.0 (+https://paintball-v2.netlify.app)'
MIRRORS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter',
           'https://overpass.kumi.systems/api/interpreter',
           'https://overpass.private.coffee/api/interpreter']
log = []
def L(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True); log.append(s)
    with open(PUB / 'log.txt', 'a') as f: f.write(s + '\n')   # incremental: survives a killed job

def http(url, data=None, headers=None, timeout=60, method=None):
    h = {'User-Agent': UA}; h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()

def overpass(q, tries=4):
    body = urllib.parse.urlencode({'data': q}).encode()
    plan = [MIRRORS[0]] * tries + MIRRORS[1:]
    for i, m in enumerate(plan):
        if 0 < i < tries: time.sleep(12 * i)
        t0 = time.time()
        try:
            _, _, b = http(m, data=body, headers={'Content-Type': 'application/x-www-form-urlencoded'}, timeout=90)
            j = json.loads(b)
            if j.get('remark'): raise Exception('remark ' + j['remark'][:80])
            L(f'overpass ok {m.split("/")[2]} {time.time()-t0:.1f}s {len(j.get("elements", []))} elements')
            return j
        except Exception as e:
            L(f'overpass fail {m.split("/")[2]} try {i+1} {time.time()-t0:.1f}s {str(e)[:120]}')
    raise Exception('overpass failed')

def quads(s, w, n, e, k):
    ls = [s + (n - s) * i / k for i in range(k + 1)]; ws = [w + (e - w) * i / k for i in range(k + 1)]
    return [(ls[i], ws[j], ls[i + 1], ws[j + 1]) for i in range(k) for j in range(k)]

def tile_xy(lat, lon, z):
    n = 2 ** z; x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

TILES = {
    'usgs': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    'esri': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
}

def probe(name, url, headers=None, method=None):
    try:
        st, h, b = http(url, headers=dict({'Origin': 'https://paintball-v2.netlify.app'}, **(headers or {})), timeout=30, method=method)
        keep = {k: h.get(k) for k in ('content-type', 'access-control-allow-origin', 'accept-ranges', 'content-length', 'content-range', 'last-modified')}
        L(f'PROBE {name}: HTTP {st} {keep} bytes={len(b)}'); return b
    except Exception as e:
        L(f'PROBE {name}: FAIL {str(e)[:200]}'); return None

def s3_prefixes(bucket, prefix=''):
    b = probe(f's3 list {bucket}/{prefix}', f'https://{bucket}.s3.amazonaws.com/?list-type=2&delimiter=/&prefix={prefix}')
    if not b: return [], []
    root = ET.fromstring(b); ns = {'s': root.tag.split('}')[0].strip('{')}
    pre = [p.find('s:Prefix', ns).text for p in root.findall('s:CommonPrefixes', ns)]
    keys = [c.find('s:Key', ns).text for c in root.findall('s:Contents', ns)]
    return pre, keys

def overture_release():
    pre, _ = s3_prefixes('overturemaps-us-west-2', 'release/')
    L('overture releases (last 3):', pre[-3:]); return pre[-1].rstrip('/').split('/')[-1] if pre else None

def duck():
    import duckdb
    con = duckdb.connect()
    for stmt in ["INSTALL spatial", "LOAD spatial", "INSTALL httpfs", "LOAD httpfs", "SET s3_region='us-west-2'"]: con.execute(stmt)
    return con

def stage1():
    S, W, N, E = CFG['city_bbox']
    rel = overture_release()
    con = duck()
    where = f'bbox.xmin > {W} AND bbox.xmax < {E} AND bbox.ymin > {S} AND bbox.ymax < {N}'
    t0 = time.time()
    rows = con.execute(f"SELECT number, street, unit, ST_Y(geometry) AS lat, ST_X(geometry) AS lon FROM read_parquet('s3://overturemaps-us-west-2/release/{rel}/theme=addresses/type=address/*', hive_partitioning=1) WHERE {where}").fetchall()
    json.dump([{'num': r[0], 'street': r[1], 'unit': r[2], 'lat': r[3], 'lon': r[4]} for r in rows], open(OUT / 'addresses.json', 'w'))
    L(f'overture addresses={len(rows)} in {time.time()-t0:.0f}s')
    t0 = time.time()
    rows = con.execute(f"SELECT names.primary AS name, class, ST_AsGeoJSON(geometry) AS g FROM read_parquet('s3://overturemaps-us-west-2/release/{rel}/theme=transportation/type=segment/*', hive_partitioning=1) WHERE {where} AND names.primary IS NOT NULL").fetchall()
    json.dump([{'name': r[0], 'cls': r[1], 'g': json.loads(r[2])['coordinates']} for r in rows], open(OUT / 'streets.json', 'w'))
    L(f'overture named segments={len(rows)} in {time.time()-t0:.0f}s')
    # --- non-sensitive probes for the style/data decision ---
    x, y = tile_xy(36.3956, -97.8784, 18)
    for k, u in TILES.items(): probe(f'tile {k}', u.format(z=18, x=int(x), y=int(y)))
    rel = overture_release()
    tpre, _ = s3_prefixes('overturemaps-tiles-us-west-2-beta')
    L('overture pmtiles releases (last 3):', tpre[-3:])
    if tpre:
        _, keys = s3_prefixes('overturemaps-tiles-us-west-2-beta', tpre[-1])
        L('pmtiles files:', keys)
        for kname in keys:
            if kname.endswith('buildings.pmtiles'):
                probe('pmtiles range', f'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/{kname}', headers={'Range': 'bytes=0-16383'})

def stage2():
    s, w, n, e = CFG['bbox']; z = CFG.get('zoom', 18)
    bb = f'{s:.5f},{w:.5f},{n:.5f},{e:.5f}'
    q = f'[out:json][timeout:25];(way["building"]({bb});relation["building"]({bb});way["highway"]({bb});node["natural"="tree"]({bb}););out body;>;out skel qt;'
    try:
        osm = overpass(q)
    except Exception:
        els = {}
        for (a, b2, c, d) in quads(s, w, n, e, 2):
            sub = f'{a:.5f},{b2:.5f},{c:.5f},{d:.5f}'
            j = overpass(q.replace(bb, sub))
            for el in j['elements']:
                key = (el['type'], el['id'])
                if key not in els or 'tags' in el: els[key] = el
        osm = {'version': 0.6, 'elements': list(els.values())}
    json.dump(osm, open(OUT / 'osm.json', 'w'))
    x0, y0 = tile_xy(n, w, z); x1, y1 = tile_xy(s, e, z)
    jobs = [(src, tx, ty) for src in TILES for tx in range(int(x0), int(x1) + 1) for ty in range(int(y0), int(y1) + 1)]
    def get(job):
        src, tx, ty = job
        d = OUT / 'tiles' / src; d.mkdir(parents=True, exist_ok=True)
        for t in range(3):
            try:
                _, h, b = http(TILES[src].format(z=z, x=tx, y=ty), timeout=30)
                (d / f'{z}_{tx}_{ty}.{"png" if "png" in h.get("content-type","") else "jpg"}').write_bytes(b); return 1
            except Exception:
                time.sleep(2)
        return 0
    jobs = [j for j in jobs if j[0] == 'esri']   # USGS tiles 404 at z18 (stage 1 probe)
    with ThreadPoolExecutor(8) as ex: ok = sum(ex.map(get, jobs))
    L(f'esri tiles ok {ok}/{len(jobs)} zoom {z}')
    # USGS tile zoom levels that exist
    cx, cy = tile_xy((s + n) / 2, (w + e) / 2, 16)
    for zz in (15, 16, 17, 18):
        f = 2 ** (zz - 16); probe(f'usgs tile z{zz}', TILES['usgs'].format(z=zz, x=int(cx * f), y=int(cy * f)))
    # Public-domain NAIP via ImageServer export: ONE request, lat/lon-linear output (maps linearly onto game x/z)
    lat0 = (s + n) / 2
    W_px = 4096; H_px = int(round(W_px * (n - s) / ((e - w) * math.cos(math.radians(lat0)))))
    naip = f'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox={w},{s},{e},{n}&bboxSR=4326&imageSR=4326&size={W_px},{H_px}&format=jpg&f=image'
    t0 = time.time(); b = probe('naip export 2.4km', naip)
    if b: (OUT / 'naip.jpg').write_bytes(b); L(f'naip {len(b)//1024} KB in {time.time()-t0:.1f}s size {W_px}x{H_px}')
    # game-sized request timing/CORS (520 m box at ~0.5 m/px), center of this box
    gs, gw = lat0 - 260/111320, (w + e) / 2 - 260/(111320*math.cos(math.radians(lat0)))
    gn, ge = lat0 + 260/111320, (w + e) / 2 + 260/(111320*math.cos(math.radians(lat0)))
    t0 = time.time(); b = probe('naip export game-size', f'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox={gw},{gs},{ge},{gn}&bboxSR=4326&imageSR=4326&size=1024,1024&format=jpg&f=image')
    if b: L(f'naip game-size {len(b)//1024} KB in {time.time()-t0:.1f}s')
    b = probe('naip service info', 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer?f=json')
    if b:
        try:
            info = json.loads(b); L('naip info:', {k: info.get(k) for k in ('maxImageWidth', 'maxImageHeight', 'pixelSizeX', 'copyrightText', 'description')})
        except Exception as ex: L('naip info parse fail', ex)
    rel = overture_release()
    if rel:
        con = duck()
        path = f's3://overturemaps-us-west-2/release/{rel}/theme=buildings/type=building/*'
        where = f'bbox.xmin > {w} AND bbox.xmax < {e} AND bbox.ymin > {s} AND bbox.ymax < {n}'
        t0 = time.time(); rows = None
        for geom in ['ST_AsGeoJSON(geometry)', 'ST_AsGeoJSON(ST_GeomFromWKB(geometry))']:
            try:
                rows = con.execute(f"SELECT id, height, num_floors, class, subtype, roof_shape, roof_color, facade_color, sources[1].dataset AS src, {geom} AS g FROM read_parquet('{path}', hive_partitioning=1) WHERE {where}").fetchall()
                break
            except Exception as ex:
                L('duckdb attempt failed:', str(ex)[:200])
        if rows is not None:
            feats = [{'type': 'Feature', 'properties': dict(zip(['id', 'height', 'num_floors', 'class', 'subtype', 'roof_shape', 'roof_color', 'facade_color', 'src'], r[:9])), 'geometry': json.loads(r[9])} for r in rows]
            json.dump({'type': 'FeatureCollection', 'release': rel, 'features': feats}, open(OUT / 'overture.geojson', 'w'), default=str)
            from collections import Counter
            L(f'overture buildings={len(feats)} in {time.time()-t0:.0f}s sources={dict(Counter(f["properties"]["src"] for f in feats))}')

import traceback
try:
    stage1() if CFG['stage'] == 1 else stage2()
except Exception:
    L('CRASH', traceback.format_exc()[-1500:])
finally:
    L('done')
