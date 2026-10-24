# Sondă 6: compară, pentru un punct, cadrul GeoTIFF (ambele benzi) cu fișierul HDF5 (nodata/undetect explicite).
import json, urllib.request, sys, datetime as dt, re, os, io
import numpy as np, h5py, tifffile
from pyproj import Transformer
LAT, LON = float(os.environ.get("LAT", "47.0358")), float(os.environ.get("LON", "28.8489"))
B = "https://api.meteogate.eu/eu-eumetnet-weather-radar/collections/observations/locations/0-20010-0-OPERA"
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "meteo-santier-probe"}), timeout=120).read()
od = os.path.dirname(sys.argv[1]); out = {}
now = dt.datetime.utcnow(); t0 = (now - dt.timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%MZ"); t1 = now.strftime("%Y-%m-%dT%H:%MZ")
P = "+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84"
x, y = Transformer.from_crs("EPSG:4326", P, always_xy=True).transform(LON, LAT)
for fmt in ("GeoTIFF", "ODIM"):
    for q in ("DBZH", "RATE"):
        txt = get(f"{B}?datetime={t0}%2F{t1}&f=CoverageJSON&format={fmt}&standard_name={q}").decode()
        ext = "tiff" if fmt == "GeoTIFF" else "h5"
        links = sorted(set(re.findall(r'https://s3[^"]+' + q + r'\.' + ext, txt)))
        if not links: out[f"{q}.{ext}"] = "none"; continue
        u = links[-1]; b = get(u); name = u.rsplit("/", 1)[1]
        if ext == "tiff":
            tf = tifffile.TiffFile(io.BytesIO(b)); pg = tf.pages[0]; a = pg.asarray()
            sx = pg.tags["ModelPixelScaleTag"].value[0]; tp = pg.tags["ModelTiepointTag"].value
            c = int((x - tp[3]) / sx); r = int((tp[4] - y) / sx); k = int(10000 / sx)
            w0 = a[r - k:r + k + 1, c - k:c + k + 1, 0]; w1 = a[r - k:r + k + 1, c - k:c + k + 1, 1]
            out[name] = {"rc": [r, c], "px_m": sx, "band0_center": float(a[r, c, 0]), "band1_center": float(a[r, c, 1]),
                         "band0_nan": int(np.isnan(w0).sum()), "band0_nodata": int((w0 < -9e6).sum()), "n": int(w0.size),
                         "band0_max": float(np.nanmax(np.where(w0 < -1e6, np.nan, w0))) if np.isfinite(np.where(w0 < -1e6, np.nan, w0)).any() else None,
                         "band0_p50": float(np.nanmedian(np.where(w0 < -1e6, np.nan, w0))) if np.isfinite(np.where(w0 < -1e6, np.nan, w0)).any() else None,
                         "band1_uniq": [float(v) for v in np.unique(w1)[:10]], "center_5x5_b0": np.round(a[r-2:r+3, c-2:c+3, 0], 1).tolist()}
        else:
            open("/tmp/x.h5", "wb").write(b); f = h5py.File("/tmp/x.h5")
            wh = f["where"].attrs; wt = dict(f["dataset1/data1/what"].attrs); arr = f["dataset1/data1/data"]
            sx = float(wh["xscale"]); ulx, uly = Transformer.from_crs("EPSG:4326", P, always_xy=True).transform(float(wh["UL_lon"]), float(wh["UL_lat"]))
            c = int((x - ulx) / sx); r = int((uly - y) / sx); k = int(10000 / sx)
            w = arr[r - k:r + k + 1, c - k:c + k + 1].astype(float)
            nod, und = float(wt["nodata"]), float(wt["undetect"])
            valid = w[(w != nod) & (w != und)]
            out[name] = {"rc": [r, c], "nodata": int((w == nod).sum()), "undetect": int((w == und).sum()), "valid": int(valid.size),
                         "valid_max": float(valid.max()) if valid.size else None, "valid_p50": float(np.median(valid)) if valid.size else None,
                         "center": float(arr[r, c]), "what": {k2: str(v) for k2, v in wt.items()}, "groups": list(f["dataset1"].keys())}
json.dump(out, open(sys.argv[1], "w"), indent=1, default=str)
