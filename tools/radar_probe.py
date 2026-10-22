# Sondă: ce surse de radar acoperă Moldova și cum pot fi citite (RainViewer, EUMETNET OPERA).
import json, urllib.request, math, io, sys, traceback
LAT, LON = 47.02, 28.87
out = {}
def get(url, raw=False, head=False):
    req = urllib.request.Request(url, headers={"User-Agent": "meteo-santier-probe", "Origin": "https://vitalicmalachi-ops.github.io"}, method="HEAD" if head else "GET")
    r = urllib.request.urlopen(req, timeout=60)
    return r, (r.read() if not head else b"")
def tile(z, lat, lon):
    n = 2 ** z; x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(x), int(y), int((x % 1) * 256), int((y % 1) * 256)
try:
    from PIL import Image
except ImportError:
    Image = None
# RainViewer
try:
    r, b = get("https://api.rainviewer.com/public/weather-maps.json")
    j = json.loads(b); out["rv_host"] = j.get("host"); out["rv_past"] = [p["time"] for p in j["radar"]["past"]]
    out["rv_nowcast"] = len(j["radar"].get("nowcast", []))
    out["rv_cors_api"] = r.headers.get("Access-Control-Allow-Origin")
    z = 7; x, y, px, py = tile(z, LAT, LON)
    path = j["radar"]["past"][-1]["path"]
    for name, url in [("radar", f"{j['host']}{path}/256/{z}/{x}/{y}/2/1_1.png"),
                      ("coverage", f"{j['host']}/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png")]:
        try:
            r, b = get(url); out[f"rv_{name}_url"] = url; out[f"rv_{name}_cors"] = r.headers.get("Access-Control-Allow-Origin")
            if Image:
                im = Image.open(io.BytesIO(b)).convert("RGBA")
                out[f"rv_{name}_px"] = im.getpixel((px, py))
                # cât din dala 256x256 e acoperită (alpha>0)
                a = [im.getpixel((i, k))[3] for i in range(0, 256, 8) for k in range(0, 256, 8)]
                out[f"rv_{name}_nonzero_frac"] = sum(1 for v in a if v > 0) / len(a)
        except Exception as e:
            out[f"rv_{name}_err"] = repr(e)
except Exception as e:
    out["rv_err"] = traceback.format_exc()[-800:]
# OPERA prin MeteoGate
base = "https://api.meteogate.eu/eu-eumetnet-weather-radar"
import datetime as dt
now = dt.datetime.utcnow().replace(second=0, microsecond=0)
t0 = (now - dt.timedelta(minutes=40)).strftime("%Y-%m-%dT%H:%MZ"); t1 = now.strftime("%Y-%m-%dT%H:%MZ")
for q in [f"/collections/observations/locations/0-20010-0-OPERA?datetime={t0}%2F{t1}&f=CoverageJSON&standard_name=ACRR&format=ODIM",
          f"/collections/observations/locations/0-20010-0-OPERA?datetime={t0}%2F{t1}&f=CoverageJSON&standard_name=DBZH",
          f"/collections/observations/locations/0-20010-0-OPERA?datetime={t0}%2F{t1}&f=CoverageJSON",
          "/collections/observations",
          f"/collections/observations/items?datetime={t0}%2F{t1}&bbox=26,45,31,49&f=GeoJSON"]:
    try:
        r, b = get(base + q); out["opera " + q] = {"cors": r.headers.get("Access-Control-Allow-Origin"), "body": b[:3000].decode("utf-8", "replace")}
    except Exception as e:
        out["opera " + q] = repr(e)
json.dump(out, open(sys.argv[1], "w"), indent=1, default=str)
