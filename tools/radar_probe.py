# Sondă 4: structura fișierelor GeoTIFF OPERA (RATE) — sunt pe dale (COG)? ce compresie? cât costă o decupare?
import json, urllib.request, sys, traceback, datetime as dt, re, io, time
out = {}
B = "https://api.meteogate.eu/eu-eumetnet-weather-radar/collections/observations/locations/0-20010-0-OPERA"
def get(url, rng=None):
    h = {"User-Agent": "meteo-santier-probe"}
    if rng: h["Range"] = f"bytes={rng[0]}-{rng[1]}"
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120).read()
try:
    now = dt.datetime.utcnow(); t0 = (now - dt.timedelta(minutes=40)).strftime("%Y-%m-%dT%H:%MZ"); t1 = now.strftime("%Y-%m-%dT%H:%MZ")
    b = get(f"{B}?datetime={t0}%2F{t1}&f=CoverageJSON&format=GeoTIFF&standard_name=RATE").decode()
    links = sorted(set(re.findall(r'https://s3[^"]+RATE\.tiff', b)))
    out["links"] = links
    import tifffile, numpy as np
    from pyproj import Transformer
    u = links[-1]
    head = get(u, (0, 65535)); out["head_len"] = len(head)
    data = get(u); out["size"] = len(data)
    with tifffile.TiffFile(io.BytesIO(data)) as tf:
        out["n_pages"] = len(tf.pages)
        p = tf.pages[0]
        out["tags"] = {t.name: (str(t.value)[:300]) for t in p.tags.values()}
        out["is_tiled"] = p.is_tiled; out["shape"] = p.shape; out["dtype"] = str(p.dtype)
        out["tile"] = [p.tilewidth, p.tilelength] if p.is_tiled else None
        out["rowsperstrip"] = p.rowsperstrip if not p.is_tiled else None
        out["first_offsets"] = list(p.dataoffsets[:3]); out["n_blocks"] = len(p.dataoffsets)
        out["bytecounts_sample"] = [int(x) for x in p.databytecounts[:5]]
        out["geo"] = {k: str(v)[:400] for k, v in (tf.geotiff_metadata or {}).items()} if hasattr(tf, "geotiff_metadata") else None
        a = p.asarray()
        out["stats"] = {"min": float(np.nanmin(a)), "max": float(np.nanmax(a)), "uniq_head": [float(x) for x in np.unique(a)[:8]]}
except Exception:
    out["err"] = traceback.format_exc()[-2000:]
json.dump(out, open(sys.argv[1], "w"), indent=1, default=str)
