# Sondă 7: calibrarea pragului radar. Pentru fiecare oră sinoptică din ultimele ~22 h: reflectivitatea în jurul
# stației Chișinău (33815) față de vremea observată acolo (cod ww, „plouă acum”) din raportul SYNOP.
import json, urllib.request, sys, datetime as dt, re, os, io, time
import numpy as np, tifffile
from pyproj import Transformer
LAT, LON, ST = 47.02, 28.87, "33815"
B = "https://api.meteogate.eu/eu-eumetnet-weather-radar/collections/observations/locations/0-20010-0-OPERA"
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "meteo-santier-probe"}), timeout=120).read()
P = "+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84"
x, y = Transformer.from_crs("EPSG:4326", P, always_xy=True).transform(LON, LAT)
now = dt.datetime.utcnow()
# SYNOP: ww și precipitații
syn = get(f"https://www.ogimet.com/cgi-bin/getsynop?block={ST}&begin={(now - dt.timedelta(hours=26)):%Y%m%d%H}00&end={now:%Y%m%d%H}59").decode()
obs = {}
for l in syn.splitlines():
    if not l.startswith(ST + ","): continue
    p = l.split(","); t = dt.datetime(*map(int, p[1:5])); g = p[6].replace("=", "").split()
    try: g = g[g.index(ST) + 1:]
    except ValueError: continue
    ww = None
    for z in g[2:]:
        if z in ("333", "555") or z.startswith("222"): break
        if len(z) == 5 and z[0] == "7": ww = z[1:3]
    obs[t.isoformat()] = {"ww": ww, "ix": g[0][1] if g else None, "raw": " ".join(g[:12])}
res = []
for k, o in sorted(obs.items()):
    t = dt.datetime.fromisoformat(k)
    if now - t > dt.timedelta(hours=23): continue
    t0 = (t - dt.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%MZ"); t1 = t.strftime("%Y-%m-%dT%H:%MZ")
    try:
        txt = get(f"{B}?datetime={t0}%2F{t1}&f=CoverageJSON&format=GeoTIFF&standard_name=DBZH").decode()
        links = sorted(set(re.findall(r'https://s3[^"]+DBZH\.tiff', txt)))
        if not links: res.append({"t": k, **o, "radar": "none"}); continue
        a = tifffile.imread(io.BytesIO(get(links[-1])))[..., 0]
        c = int((x + 500.0003) / 1000); r = int((499.99991 - y) / 1000)
        w = a[r - 3:r + 4, c - 3:c + 4]; w = np.where(np.isnan(w), -32, w); w = np.where(w < -9e6, np.nan, w)
        W = a[r - 10:r + 11, c - 10:c + 11]; W = np.where(np.isnan(W), -32, W)
        res.append({"t": k, **o, "frame": links[-1].rsplit("@", 2)[1], "c7_max": float(np.nanmax(w)), "c7_med": float(np.nanmedian(w)),
                    "c21_frac_ge10": float((W >= 10).mean()), "c21_frac_ge15": float((W >= 15).mean()), "c21_frac_ge18": float((W >= 18).mean())})
    except Exception as e:
        res.append({"t": k, **o, "err": repr(e)})
    time.sleep(1)
json.dump(res, open(sys.argv[1], "w"), indent=1)
