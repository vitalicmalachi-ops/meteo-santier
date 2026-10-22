# Sondă 2: acoperirea radar pentru Moldova — OPERA (EUMETNET) și RainViewer. Salvează imagini și valori.
import json, urllib.request, math, io, sys, traceback, datetime as dt, os
from PIL import Image
PTS = {"Chisinau": (47.02, 28.87), "Balti": (47.76, 27.93), "Cahul": (45.90, 28.19), "Iasi": (47.16, 27.59), "Bucuresti": (44.43, 26.10), "Odesa": (46.48, 30.72)}
out = {}
OUT = sys.argv[1]
def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "meteo-santier-probe"})
    r = urllib.request.urlopen(req, timeout=120); return r, r.read()
# ---- OPERA ----
try:
    import h5py, numpy as np
    from pyproj import Transformer
    base = "https://api.meteogate.eu/eu-eumetnet-weather-radar/collections/observations/locations/0-20010-0-OPERA"
    now = dt.datetime.utcnow()
    t0 = (now - dt.timedelta(minutes=40)).strftime("%Y-%m-%dT%H:%MZ"); t1 = now.strftime("%Y-%m-%dT%H:%MZ")
    _, b = get(f"{base}?datetime={t0}%2F{t1}&f=CoverageJSON")
    j = json.loads(b)
    covs = j.get("coverages", [j])
    links = []
    for c in covs:
        links += [l["href"] for l in c.get("links", []) if l.get("rel") == "items"]
    out["opera_links"] = links[-12:]
    want = [l for l in links if "DBZH" in l][-1:] + [l for l in links if "RATE" in l][-1:] + [l for l in links if "ACRR" in l][-1:]
    for url in want:
        name = url.rsplit("/", 1)[1]
        _, b = get(url); open("/tmp/x.h5", "wb").write(b)
        f = h5py.File("/tmp/x.h5")
        where = dict(f["where"].attrs); what = dict(f["dataset1/data1/what"].attrs)
        proj = where["projdef"].decode() if isinstance(where["projdef"], bytes) else where["projdef"]
        arr = f["dataset1/data1/data"][:]
        info = {"shape": arr.shape, "where": {k: (v.decode() if isinstance(v, bytes) else float(v) if hasattr(v, "__float__") else str(v)) for k, v in where.items()},
                "what": {k: (v.decode() if isinstance(v, bytes) else float(v) if hasattr(v, "__float__") else str(v)) for k, v in what.items()}}
        tr = Transformer.from_crs("EPSG:4326", proj, always_xy=True)
        ulx, uly = tr.transform(float(where["UL_lon"]), float(where["UL_lat"]))
        xs, ys = float(where["xscale"]), float(where["yscale"])
        nod, und = what.get("nodata"), what.get("undetect")
        pts = {}
        for k, (la, lo) in PTS.items():
            x, y = tr.transform(lo, la); col = int((x - ulx) / xs); row = int((uly - y) / ys)
            win = arr[max(0, row - 10):row + 11, max(0, col - 10):col + 11]
            pts[k] = {"rc": [row, col], "center": float(arr[row, col]), "n_nodata": int((win == nod).sum()), "n_undetect": int((win == und).sum()), "n_valid": int(((win != nod) & (win != und)).sum()), "max": float(win.max())}
        info["points"] = pts
        out["opera " + name] = info
        # imagine a zonei Moldova (±250 px)
        x, y = tr.transform(28.87, 47.02); col = int((x - ulx) / xs); row = int((uly - y) / ys)
        crop = arr[row - 250:row + 250, col - 250:col + 250].astype(float)
        img = np.zeros(crop.shape + (3,), dtype=np.uint8)
        img[crop == nod] = (60, 60, 60); img[crop == und] = (230, 230, 230)
        val = (crop != nod) & (crop != und)
        img[val] = (40, 90, 220)
        img[245:255, 245:255] = (255, 0, 0)
        Image.fromarray(img).save(os.path.join(os.path.dirname(OUT), name.replace("@", "_") + ".png"))
    # fișiere COG?
    try:
        _, b = get("https://s3.waw3-1.cloudferro.com/openradar-24h?list-type=2&prefix=" + now.strftime("%Y/%m/%d") + "/OPERA/COMP/&max-keys=60")
        out["s3_list"] = b[:6000].decode("utf-8", "replace")
    except Exception as e:
        out["s3_list_err"] = repr(e)
except Exception:
    out["opera_err"] = traceback.format_exc()[-1500:]
# ---- RainViewer ----
try:
    _, b = get("https://api.rainviewer.com/public/weather-maps.json"); j = json.loads(b)
    path = j["radar"]["past"][-1]["path"]
    def tile(z, lat, lon):
        n = 2 ** z; x = (lon + 180) / 360 * n; y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        return int(x), int(y), int((x % 1) * 256), int((y % 1) * 256)
    z = 6
    for k in ("Chisinau", "Bucuresti"):
        la, lo = PTS[k]; x, y, px, py = tile(z, la, lo)
        for nm, url in [("radar", f"{j['host']}{path}/256/{z}/{x}/{y}/2/0_0.png"), ("coverage", f"{j['host']}/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png")]:
            _, bb = get(url); im = Image.open(io.BytesIO(bb)).convert("RGBA")
            im.save(os.path.join(os.path.dirname(OUT), f"rv_{nm}_{k}.png"))
            out[f"rv_{nm}_{k}"] = {"px": im.getpixel((px, py)), "xy": [px, py]}
except Exception:
    out["rv_err"] = traceback.format_exc()[-1500:]
json.dump(out, open(OUT, "w"), indent=1, default=str)
