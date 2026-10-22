# Sondă 3: formate disponibile (COG?), produse (RATE/ACRR), CORS și Range pe S3, interogări EDR.
import json, urllib.request, sys, traceback, datetime as dt, re
out = {}
B = "https://api.meteogate.eu/eu-eumetnet-weather-radar"
def get(url, method="GET", headers=None, n=4000):
    h = {"User-Agent": "meteo-santier-probe", "Origin": "https://vitalicmalachi-ops.github.io"}; h.update(headers or {})
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=h, method=method), timeout=90)
        body = r.read() if method != "HEAD" else b""
        return {"status": r.status, "headers": {k: v for k, v in r.headers.items() if k.lower().startswith(("access-control", "content-", "accept-ranges"))}, "body": body[:n].decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "headers": {k: v for k, v in e.headers.items() if k.lower().startswith("access-control")}, "body": e.read()[:1500].decode("utf-8", "replace")}
    except Exception as e:
        return {"err": repr(e)}
oa = get(B + "/openapi", n=200000)
if oa.get("status") != 200: oa = get(B + "/openapi.json", n=200000)
body = oa.get("body", "")
out["openapi_paths"] = re.findall(r'"(/[a-zA-Z0-9_/{}\-.]+)"\s*:\s*\{\s*"(?:get|post)"', body)[:80]
out["openapi_enums"] = sorted(set(re.findall(r'"enum"\s*:\s*\[([^\]]{0,400})\]', body)))[:40]
out["openapi_head"] = body[:3000]
now = dt.datetime.utcnow()
t0 = (now - dt.timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%MZ"); t1 = now.strftime("%Y-%m-%dT%H:%MZ")
loc = B + "/collections/observations/locations/0-20010-0-OPERA"
for q in ["format=COG", "format=GeoTIFF", "format=cog", "standard_name=RATE", "standard_name=ACRR", "standard_name=DBZH&format=COG"]:
    r = get(f"{loc}?datetime={t0}%2F{t1}&f=CoverageJSON&{q}", n=100000)
    b = r.get("body", "")
    out["loc " + q] = {"status": r.get("status"), "links": re.findall(r'https://s3[^"]+', b)[-6:], "len": len(b)}
for q in [f"/collections/observations/position?coords=POINT(28.87%2047.02)&datetime={t0}%2F{t1}",
          f"/collections/observations/area?coords=POLYGON((28.5%2046.8,29.2%2046.8,29.2%2047.3,28.5%2047.3,28.5%2046.8))&datetime={t0}%2F{t1}",
          "/collections/observations/locations?f=GeoJSON&bbox=20,40,32,50", "/collections"]:
    out["edr " + q] = get(B + q, n=3000)
S3 = "https://s3.waw3-1.cloudferro.com/openradar-24h"
out["s3_list"] = get(f"{S3}/?list-type=2&prefix={now:%Y/%m/%d}/OPERA/COMP/&max-keys=40", n=8000)
out["s3_list_root"] = get(f"{S3}/?list-type=2&delimiter=/&prefix={now:%Y/%m/%d}/OPERA/", n=4000)
# CORS preflight + Range pe un fișier
r = get(f"{loc}?datetime={t0}%2F{t1}&f=CoverageJSON&standard_name=DBZH", n=100000)
links = re.findall(r'https://s3[^"]+\.h5', r.get("body", ""))
if links:
    u = links[-1]
    out["s3_options"] = get(u, method="OPTIONS", headers={"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range"})
    out["s3_range"] = get(u, headers={"Range": "bytes=0-99"}, n=10)
    for alt in (u.replace(".h5", ".tif"), u.replace(".h5", ".tiff"), u.replace("@DBZH.h5", "@DBZH.tif"), u.replace(".h5", "_cog.tif")):
        out["alt " + alt] = get(alt, method="HEAD")
json.dump(out, open(sys.argv[1], "w"), indent=1, default=str)
