# Verificare automată a preciziei: prognoza de consens pentru ploaie față de ce a măsurat stația meteo,
# pe perioade de 12 ore (06–18 și 18–06 UTC), în ultimele N zile. Rezultatul ajunge în accuracy.json,
# pe care aplicația îl afișează. Rulează săptămânal în GitHub Actions.
import json, sys, time, urllib.request, datetime as dt

STATIONS = [{"id": "33815", "name": "Chișinău", "cc": "MD", "lat": 47.02, "lon": 28.87}]
MODELS = {"ecmwf_ifs025": "ECMWF IFS", "ecmwf_aifs025_single": "ECMWF AIFS", "icon_seamless": "ICON", "gfs_seamless": "GFS",
          "meteofrance_seamless": "ARPEGE", "ukmo_seamless": "UKMO", "gem_seamless": "GEM", "jma_seamless": "JMA", "cma_grapes_global": "CMA"}
THR, DRIZZLE, OBS_WET = 1.0, 0.2, 1.0          # aceleași praguri ca în aplicație
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
END = dt.datetime.utcnow().date()               # perioadele încheiate până azi la 06 UTC
START = END - dt.timedelta(days=DAYS)

def get(url, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "meteo-santier-accuracy (github.com/vitalicmalachi-ops/meteo-santier)"})
            return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        except Exception as e:
            err = e; time.sleep(6 * (k + 1))
    raise err

TR = {"1": 6, "2": 12, "3": 18, "4": 24, "5": 1, "6": 2, "7": 3, "8": 9, "9": 15}
def rrr(v):
    v = int(v)
    return 0.0 if v == 990 else (v - 990) / 10 if v >= 991 else float(v)

def station_obs(st):
    """(data, ora UTC) -> (mm, perioada în ore)"""
    lines, d = [], START - dt.timedelta(days=1)
    while d <= END:
        e = min(d + dt.timedelta(days=9), END)
        txt = get(f"https://www.ogimet.com/cgi-bin/getsynop?block={st['id']}&begin={d:%Y%m%d}0000&end={e:%Y%m%d}2359")
        lines += [l for l in txt.splitlines() if l.startswith(st["id"] + ",")]
        d = e + dt.timedelta(days=1); time.sleep(3)
    obs = {}
    for l in lines:
        p = l.split(","); y, mo, da, hh = map(int, p[1:5]); msg = p[6].replace("=", "").split()
        if st["id"] not in msg: continue
        g = msg[msg.index(st["id"]) + 1:]
        if not g: continue
        rr = None
        for x in g[2:]:
            if x in ("333", "555") or x.startswith("222"): break
            if len(x) == 5 and x[0] == "6" and x[1:4].isdigit() and x[4] in TR:
                rr = (rrr(x[1:4]), TR[x[4]])
        if rr is None and g[0][0] == "3" and hh in (0, 6, 12, 18):
            rr = (0.0, 12 if hh in (6, 18) else 6)   # stația declară explicit „fără precipitații” (la 06/18 UTC raportul acoperă 12 ore)
        if rr: obs[(dt.date(y, mo, da), hh)] = rr
    return obs

def period_obs(obs, end):
    """Precipitații măsurate în cele 12 ore care se încheie la `end` (datetime UTC, ora 06 sau 18)."""
    o = obs.get((end.date(), end.hour))
    if o and o[1] == 12: return o[0]
    mid = end - dt.timedelta(hours=6); a = obs.get((mid.date(), mid.hour))
    if o and o[1] == 6 and a and a[1] == 6: return o[0] + a[0]
    return None

def run(st):
    obs = station_obs(st)
    mod = {}
    for m in MODELS:
        try:
            j = json.loads(get(f"https://historical-forecast-api.open-meteo.com/v1/forecast?latitude={st['lat']}&longitude={st['lon']}"
                               f"&start_date={START - dt.timedelta(days=1)}&end_date={END}&hourly=precipitation&models={m}&timezone=GMT"))
            H = j["hourly"]; k = next(x for x in H if x.startswith("precipitation"))
            mod[m] = {dt.datetime.fromisoformat(t): v for t, v in zip(H["time"], H[k])}
        except Exception as e:
            print("model", m, e)
        time.sleep(1)
    tally = {"n": 0, "hit": 0, "miss": 0, "fa": 0, "cn": 0}
    per = {m: {"n": 0, "ok": 0} for m in mod}
    end = dt.datetime.combine(START, dt.time(18))
    last = dt.datetime.combine(END, dt.time(6))
    while end <= last:
        ob = period_obs(obs, end)
        if ob is not None:
            wet_models, n = [], 0
            for m, ser in mod.items():
                # ora H conține precipitațiile din ora precedentă → ore (end-11 … end)
                vals = [ser.get(end - dt.timedelta(hours=i)) for i in range(12)]
                if any(v is None for v in vals): continue
                s = sum(v for v in vals if v >= DRIZZLE)
                n += 1; w = s >= THR; wet_models.append(w)
                per[m]["n"] += 1; per[m]["ok"] += int(w == (ob >= OBS_WET))
            if n >= 3:
                fc = sum(wet_models) / n >= 0.5; ow = ob >= OBS_WET
                tally["n"] += 1
                tally["hit" if fc and ow else "miss" if ow else "fa" if fc else "cn"] += 1
        end += dt.timedelta(hours=12)
    T = tally
    return {**{k: st[k] for k in ("id", "name", "cc")}, "periods": T["n"], "correct": T["hit"] + T["cn"],
            "pct": round(100 * (T["hit"] + T["cn"]) / T["n"]) if T["n"] else None,
            "rain_periods": T["hit"] + T["miss"], "rain_caught": T["hit"], "false_alarms": T["fa"],
            "models": sorted([{"name": MODELS[m], "pct": round(100 * v["ok"] / v["n"])} for m, v in per.items() if v["n"]], key=lambda x: -x["pct"])}

res = {"updated": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"), "days": DAYS, "from": str(START), "to": str(END),
       "rule": {"thr_mm": THR, "drizzle_mm_h": DRIZZLE, "obs_wet_mm": OBS_WET, "window_h": 12}, "stations": []}
for st in STATIONS:
    try: res["stations"].append(run(st))
    except Exception as e: print("station", st["id"], e)
if not any(s.get("periods") for s in res["stations"]):
    sys.exit("fără date — accuracy.json rămâne neschimbat")
json.dump(res, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False))
