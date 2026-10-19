# Calibrare: precipitațiile măsurate la stația Chișinău (SYNOP 33815, prin Ogimet) față de ce au prezis
# modelele (Open-Meteo Historical Forecast API), pe perioade de 12 ore (06–18 și 18–06 UTC). Rulează în GitHub Actions.
import json, sys, time, re, urllib.request, datetime as dt
LAT, LON, STATION = 47.02, 28.87, "33815"
END = dt.date.today() - dt.timedelta(days=0 if len(sys.argv) > 3 and sys.argv[3] == "today" else 1)
START = END - dt.timedelta(days=int(sys.argv[2]) if len(sys.argv) > 2 else 90)
def get(url, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "meteo-santier-calibration (github.com/vitalicmalachi-ops/meteo-santier)"})
            return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        except Exception as e:
            err = e; time.sleep(5 * (k + 1))
    raise err

# 1) observații SYNOP
synops = []
d = START
while d <= END:
    e = min(d + dt.timedelta(days=9), END)
    txt = get(f"https://www.ogimet.com/cgi-bin/getsynop?block={STATION}&begin={d:%Y%m%d}0000&end={e:%Y%m%d}2359")
    synops += [l for l in txt.splitlines() if l.startswith(STATION + ",")]
    d = e + dt.timedelta(days=1); time.sleep(3)
TR = {"1": 6, "2": 12, "3": 18, "4": 24, "5": 1, "6": 2, "7": 3, "8": 9, "9": 15}
def rrr(v):
    v = int(v)
    if v == 990: return 0.0
    if v >= 991: return (v - 990) / 10
    return float(v)
obs = {}   # (data, ora UTC) -> {"rr": mm, "h": perioada, "ww": cod}
for l in synops:
    p = l.split(","); y, mo, da, hh = map(int, p[1:5]); msg = p[6].replace("=", "").split()
    try:
        i = msg.index(STATION)
    except ValueError:
        continue
    g = msg[i + 1:]
    if not g: continue
    ir = g[0][0]
    sec1 = []
    for x in g[2:]:
        if x in ("333", "555", "222") or x.startswith("222"): break
        sec1.append(x)
    rec = {"ir": ir}
    for x in sec1:
        if len(x) == 5 and x[0] == "6" and x[1:4].isdigit() and x[4] in TR:
            rec["rr"] = rrr(x[1:4]); rec["h"] = TR[x[4]]
        if len(x) == 5 and x[0] == "7" and x[1:3].isdigit():
            rec["ww"] = int(x[1:3])
    if "rr" not in rec and ir == "3":
        rec["rr"] = 0.0; rec["h"] = 6 if hh in (0, 6, 12, 18) else None
    obs[(f"{y:04d}-{mo:02d}-{da:02d}", hh)] = rec

# 2) modelele, pe ore UTC
models = ["ecmwf_ifs025", "icon_seamless", "gfs_seamless", "meteofrance_seamless", "ukmo_seamless", "gem_seamless", "jma_seamless", "cma_grapes_global", "ecmwf_aifs025_single"]
mod = {}
for m in models:
    try:
        j = json.loads(get(f"https://historical-forecast-api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}&start_date={START - dt.timedelta(days=1)}&end_date={END}&hourly=precipitation&models={m}&timezone=GMT"))
        k = next(x for x in j["hourly"] if x.startswith("precipitation"))
        mod[m] = dict(zip(j["hourly"]["time"], j["hourly"][k]))
    except Exception as e:
        mod[m] = {"error": str(e)}
    time.sleep(1)
json.dump({"start": str(START), "end": str(END), "station": STATION, "n_synop": len(synops),
           "obs": {f"{a}T{b:02d}": v for (a, b), v in obs.items()}, "models": mod}, open(sys.argv[1], "w"))
print("synop", len(synops), "obs", len(obs), "models", {m: (len(v) if "error" not in v else v["error"][:40]) for m, v in mod.items()})
