# Verificarea verdictelor pe lucrări: ce ar fi arătat aplicația (aceleași reguli ca în app.js, cu prognozele
# modelelor din ziua respectivă) față de ce a măsurat stația Chișinău (33815). Ieșire: JSON cu fiecare zi.
import json, sys, time, urllib.request, datetime as dt
from zoneinfo import ZoneInfo
ST, LAT, LON = "33815", 47.02, 28.87
TZ = ZoneInfo("Europe/Chisinau")
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 45
END = dt.date.today() - dt.timedelta(days=1); START = END - dt.timedelta(days=DAYS - 1)
MODELS = ["ecmwf_ifs025", "ecmwf_aifs025_single", "icon_seamless", "gfs_seamless", "meteofrance_seamless", "ukmo_seamless", "gem_seamless", "jma_seamless", "cma_grapes_global"]
VARS = "precipitation,snowfall,temperature_2m,wind_gusts_10m,relative_humidity_2m,visibility,weather_code,wind_speed_10m"
def get(u, tries=4):
    for k in range(tries):
        try: return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "meteo-santier-verify"}), timeout=90).read().decode()
        except Exception as e: err = e; time.sleep(5 * (k + 1))
    raise err
# ---------- stația ----------
TR = {"1": 6, "2": 12, "3": 18, "4": 24, "5": 1, "6": 2, "7": 3, "8": 9, "9": 15}
def temp(g): return None if "/" in g[2:5] else (-1 if g[1] == "1" else 1) * int(g[2:5]) / 10
obs = {}
d = START - dt.timedelta(days=4)
while d <= END + dt.timedelta(days=1):
    e = min(d + dt.timedelta(days=9), END + dt.timedelta(days=1))
    for l in get(f"https://www.ogimet.com/cgi-bin/getsynop?block={ST}&begin={d:%Y%m%d}0000&end={e:%Y%m%d}2359").splitlines():
        if not l.startswith(ST + ","): continue
        p = l.split(","); t = dt.datetime(*map(int, p[1:5]), tzinfo=dt.timezone.utc); g = p[6].replace("=", "").split()
        try: i0 = g.index(ST)
        except ValueError: continue
        iw = g[i0 - 1][-1] if i0 >= 1 else "1"; kmh = 1.852 if iw in "34" else 3.6
        s1 = g[i0 + 1:]; o = {}
        sec = 1
        for k, x in enumerate(s1):
            if x == "333": sec = 3; continue
            if x == "555": sec = 5; continue
            if len(x) != 5: continue
            if sec == 1:
                if k == 0: o["ix"] = x[1]; vv = x[3:5]; o["vis"] = (None if "/" in vv else (int(vv) / 10 if int(vv) <= 50 else int(vv) - 50 if int(vv) <= 80 else None))
                elif k == 1: ff = x[3:5]; o["wind"] = None if "/" in ff else int(ff) * kmh
                elif x[0] == "1" and k >= 2 and "T" not in o: o["T"] = temp(x)
                elif x[0] == "2" and k >= 2 and "Td" not in o and x[1] in "01": o["Td"] = temp(x)
                elif x[0] == "6" and x[1:4].isdigit() and x[4] in TR: v = int(x[1:4]); o["rr"] = (0.0 if v == 990 else (v - 990) / 10 if v > 990 else float(v), TR[x[4]])
                elif x[0] == "7" and k >= 2: o["ww"] = None if "/" in x[1:3] else int(x[1:3])
            elif sec == 3:
                if x[0] == "1" and x[1] in "01": o["Tmax"] = temp(x)
                elif x[0] == "2" and x[1] in "01": o["Tmin"] = temp(x)
                elif x[:3] in ("910", "911") and "/" not in x[3:]: o["gust"] = max(o.get("gust", 0), int(x[3:]) * kmh)
                elif x[0] == "6" and x[1:4].isdigit() and x[4] in TR: v = int(x[1:4]); o.setdefault("rr", (0.0 if v == 990 else (v - 990) / 10 if v > 990 else float(v), TR[x[4]]))
        if "rr" not in o and o.get("ix") == "3": o["rr"] = (0.0, 12 if t.hour in (6, 18) else 6)
        obs[t] = o
    d = e + dt.timedelta(days=1); time.sleep(2)
def rh(T, Td):
    import math
    if T is None or Td is None: return None
    a, b = 17.625, 243.04
    return 100 * math.exp(a * Td / (b + Td) - a * T / (b + T))
def rr12(end):
    o = obs.get(end)
    if o and o.get("rr") and o["rr"][1] == 12: return o["rr"][0]
    m = obs.get(end - dt.timedelta(hours=6))
    if o and m and o.get("rr") and m.get("rr") and o["rr"][1] == 6 and m["rr"][1] == 6: return o["rr"][0] + m["rr"][0]
    return None
# ---------- modele ----------
mod = {}
for m in MODELS:
    try:
        j = json.loads(get(f"https://historical-forecast-api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}&start_date={START - dt.timedelta(days=3)}&end_date={END + dt.timedelta(days=1)}&hourly={VARS}&models={m}&timezone=GMT"))
        H = j["hourly"]; ser = {}
        for i, tm in enumerate(H["time"]):
            ser[dt.datetime.fromisoformat(tm).replace(tzinfo=dt.timezone.utc)] = {v: (H.get(v) or H.get(f"{v}_{m}") or [None] * len(H["time"]))[i] for v in VARS.split(",")}
        mod[m] = ser
    except Exception as e: print("model", m, e)
    time.sleep(1)
med = lambda a: (sorted(x for x in a if x is not None)[len([x for x in a if x is not None]) // 2] if any(x is not None for x in a) else None)
# ---------- regulile aplicației (copie fidelă din judgeWorks) ----------
L = {"beton": {"tminWarn": 5, "tminStop": 0}, "asfalt": {"tmaxOk": 10, "tmaxStop": 5}, "hidro": {"tmin": 5}, "fatada": {"tmin": 5, "rh": 85, "gustWarn": 40, "gustStop": 54},
     "acoperis": {"gustWarn": 36, "gustStop": 50}, "macara": {"gustWarn": 36, "gustStop": 54}, "sapaturi": {"rain3Warn": 10, "rain3Stop": 25}}
def judge(c):
    N = lambda x: x is not None
    f, g = c["frac"], c["gust"]; res = {}
    def pick(w, rules):
        for cond, lv, why in rules:
            if cond: res[w] = (lv, why); return
        res[w] = ("ok", "")
    pick("beton", [(N(c["tmin"]) and c["tmin"] < 0, "stop", "îngheț"), (f >= 0.6, "stop", "ploaie"), (N(c["tmin"]) and c["tmin"] < 5, "warn", "rece"), (f >= 0.3, "warn", "ploaie?")])
    pick("asfalt", [(N(c["wtmax"]) and c["wtmax"] < 5, "stop", "prea rece"), (f >= 0.6, "stop", "ploaie"), (N(c["wtmax"]) and c["wtmax"] < 10, "warn", "rece"), (N(c["tmin"]) and c["tmin"] < 0, "warn", "îngheț dimineața"), (f >= 0.25, "warn", "ploaie?")])
    pick("hidro", [(N(c["tmax"]) and c["tmax"] < 0, "stop", "ger"), (c["snow"], "stop", "zăpadă"), (f >= 0.6, "stop", "ploaie"), (f >= 0.25, "warn", "ploaie?"), (N(c["prev"]) and c["prev"] >= 1, "warn", "ud de ieri"), (c["fog"], "warn", "ceață"), (N(c["tmin"]) and c["tmin"] < 5, "warn", "rece")])
    pick("fatada", [(N(c["tmin"]) and c["tmin"] < 0, "stop", "îngheț"), (f >= 0.6, "stop", "ploaie"), (N(g) and g >= 54, "stop", "rafale"), (N(c["tmin"]) and c["tmin"] < 5, "warn", "rece"), (f >= 0.25, "warn", "ploaie?"), (N(c["rh"]) and c["rh"] >= 85, "warn", "umed"), (c["fog"], "warn", "ceață"), (N(g) and g >= 40, "warn", "rafale")])
    pick("acoperis", [(N(g) and g >= 50, "stop", "rafale"), (c["snow"], "stop", "zăpadă"), (N(g) and g >= 36, "warn", "rafale"), (N(c["tmin"]) and c["tmin"] < 0, "warn", "polei"), (f >= 0.5, "warn", "alunecos"), (c["fog"], "warn", "ceață")])
    pick("macara", [(N(g) and g >= 54, "stop", "rafale"), (N(g) and g >= 36, "warn", "rafale"), (c["fog"], "warn", "ceață")])
    pick("sapaturi", [(N(c["rain3"]) and c["rain3"] >= 25, "stop", "apă"), (N(c["rain3"]) and c["rain3"] >= 10, "warn", "noroi"), (f >= 0.6, "warn", "ploaie")])
    return res
def model_inputs(day):
    t0 = dt.datetime.combine(day, dt.time(0), TZ).astimezone(dt.timezone.utc)
    hrs = [t0 + dt.timedelta(hours=h) for h in range(24)]                 # intervalele [h, h+1) locale
    per = []
    for m, S in mod.items():
        P = [S.get(h + dt.timedelta(hours=1), {}).get("precipitation") for h in hrs]
        if sum(x is not None for x in P) < 6: continue
        Tt = [S.get(h, {}).get("temperature_2m") for h in hrs]
        G = [S.get(h + dt.timedelta(hours=1), {}).get("wind_gusts_10m") for h in hrs]
        R = [S.get(h, {}).get("relative_humidity_2m") for h in hrs]
        Sn = [S.get(h + dt.timedelta(hours=1), {}).get("snowfall") for h in hrs]
        def daysum(dd):
            a = dt.datetime.combine(dd, dt.time(0), TZ).astimezone(dt.timezone.utc)
            v = [S.get(a + dt.timedelta(hours=k), {}).get("precipitation") for k in range(1, 25)]
            return sum(x for x in v if x is not None) if sum(x is not None for x in v) >= 18 else None
        per.append({"p": sum(x for x in P if x is not None and x >= 0.2), "s": sum(x or 0 for x in Sn), "tmin": min([x for x in Tt if x is not None], default=None),
                    "tmax": max([x for x in Tt if x is not None], default=None), "g": max([x for x in G if x is not None], default=None), "rh": med(R),
                    "prev": daysum(day - dt.timedelta(days=1)), "r3": (lambda a: None if None in a else sum(a))([daysum(day - dt.timedelta(days=k)) for k in range(3)]),
                    "fog": [ (lambda x: x is not None and ((x.get("visibility") is not None and x["visibility"] < 1000) or x.get("weather_code") in (45, 48) or ((x.get("relative_humidity_2m") or 0) >= 99 and (x.get("wind_speed_10m") or 99) <= 12)) and not ((S.get(h + dt.timedelta(hours=1), {}).get("precipitation") or 0) >= 0.2))(S.get(h)) for h in hrs]})
    n = len(per)
    if n < 3: return None
    wet = sum(1 for x in per if x["s"] >= 0.5 or x["p"] >= 1.0); snowy = sum(1 for x in per if x["s"] >= 0.5)
    ff = [sum(x["fog"][h] for x in per) / n >= 1 / 3 for h in range(24)]
    fog = any(ff[h] and ff[h + 1] for h in range(23))
    return {"n": n, "wet": wet, "frac": wet / n, "snow": snowy / n >= 0.5, "tmin": med([x["tmin"] for x in per]), "tmax": med([x["tmax"] for x in per]), "wtmax": med([x["tmax"] for x in per]),
            "gust": med([x["g"] for x in per]), "rh": med([x["rh"] for x in per]), "prev": med([x["prev"] for x in per]), "rain3": med([x["r3"] for x in per]), "fog": fog,
            "p_med": med([x["p"] for x in per])}
def obs_inputs(day, window):
    # window: "day" = 06–18 UTC (ziua de lucru, ~08–20 local); "full" = 18 UTC ziua precedentă – 18 UTC (aprox. ziua întreagă)
    e = dt.datetime.combine(day, dt.time(18), dt.timezone.utc)
    if window == "day": rr = rr12(e); a = e - dt.timedelta(hours=12)
    else:
        r1, r2 = rr12(e - dt.timedelta(hours=12)), rr12(e); rr = None if r1 is None or r2 is None else r1 + r2; a = e - dt.timedelta(hours=24)
    O = [(t, o) for t, o in obs.items() if a <= t <= e]
    if not O or rr is None: return None
    Ts = [o["T"] for _, o in O if o.get("T") is not None] + [o["Tmin"] for t, o in O if o.get("Tmin") is not None and t.hour in (6, 18)]
    Tx = [o["T"] for _, o in O if o.get("T") is not None] + [o["Tmax"] for t, o in O if o.get("Tmax") is not None and t.hour == 18]
    gust = max([o.get("gust", 0) for _, o in O] + [0]) or None
    rhs = [rh(o.get("T"), o.get("Td")) for _, o in O]; rhs = [x for x in rhs if x is not None]
    fog = sum(1 for _, o in O if (o.get("vis") is not None and o["vis"] < 1) or (o.get("ww") is not None and 40 <= o["ww"] <= 49)) >= 1
    snow = any(o.get("ww") is not None and (70 <= o["ww"] <= 79 or 85 <= o["ww"] <= 86) for _, o in O)
    def dsum(dd): x, y = rr12(dt.datetime.combine(dd, dt.time(6), dt.timezone.utc)), rr12(dt.datetime.combine(dd, dt.time(18), dt.timezone.utc)); return None if x is None or y is None else x + y
    r3 = [dsum(day - dt.timedelta(days=k)) for k in range(3)]
    return {"rr": rr, "frac": 1.0 if rr >= 1.0 else 0.0, "snow": snow, "tmin": min(Ts) if Ts else None, "tmax": max(Tx) if Tx else None, "wtmax": max(Tx) if Tx else None,
            "gust": gust, "rh": sorted(rhs)[len(rhs) // 2] if rhs else None, "prev": dsum(day - dt.timedelta(days=1)), "rain3": None if None in r3 else sum(r3), "fog": fog}
out = {"from": str(START), "to": str(END), "models": list(mod), "days": []}
day = START
while day <= END:
    mi = model_inputs(day)
    row = {"date": str(day), "model": mi, "obs_full": obs_inputs(day, "full"), "obs_day": obs_inputs(day, "day")}
    if mi: row["app"] = judge(mi)
    for k in ("obs_full", "obs_day"):
        if row[k]: row["v_" + k] = judge(row[k])
    out["days"].append(row); day += dt.timedelta(days=1)
json.dump(out, open(sys.argv[1], "w"), ensure_ascii=False, indent=1, default=str)
print("ok", len(out["days"]))
