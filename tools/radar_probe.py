# Verifică ora locală raportată de Open-Meteo în jurul schimbării la ora de iarnă.
import urllib.request, sys, json
out = {}
base = "https://api.open-meteo.com/v1/forecast?latitude=47.0014&longitude=28.8224&timezone=auto"
for name, q in [("current", "&current=temperature_2m"), ("fc", "&hourly=precipitation&forecast_days=14&past_days=2&models=ecmwf_ifs025"),
                ("fc_nopast", "&hourly=precipitation&forecast_days=14&models=gfs_seamless"), ("fc_short", "&hourly=precipitation&forecast_days=1&models=gfs_seamless")]:
    j = json.loads(urllib.request.urlopen(base + q, timeout=60).read())
    out[name] = {k: j.get(k) for k in ("utc_offset_seconds", "timezone", "timezone_abbreviation")}
    if "current" in j: out[name]["current_time"] = j["current"]["time"]
    if "hourly" in j:
        T = j["hourly"]["time"]; P = j["hourly"][next(k for k in j["hourly"] if k != "time")]
        out[name]["first"] = T[0]; out[name]["n"] = len(T)
        out[name]["around_dst"] = [t for t in T if t.startswith("2026-10-25T0")][:6]
        out[name]["today"] = [(t[11:16], p) for t, p in zip(T, P) if t.startswith("2026-10-24")]
import datetime as dt
out["utc_now"] = dt.datetime.utcnow().isoformat()
json.dump(out, open(sys.argv[1], "w"), indent=1)
