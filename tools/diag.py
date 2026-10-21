# Diagnostic: ce prezice fiecare model, oră cu oră, pentru un loc (azi și ieri). Rulează în GitHub Actions.
import json, os, sys, urllib.request, urllib.parse
name = os.environ.get("PLACE", "Ciorescu")
geo = json.load(urllib.request.urlopen("https://geocoding-api.open-meteo.com/v1/search?count=1&language=ro&name=" + urllib.parse.quote(name)))
r = geo["results"][0]; lat, lon = r["latitude"], r["longitude"]
out = {"place": r["name"], "admin": r.get("admin1"), "lat": lat, "lon": lon, "models": {}}
models = ["ecmwf_ifs025","ecmwf_aifs025_single","icon_seamless","gfs_seamless","meteofrance_seamless","ukmo_seamless","gem_seamless","jma_seamless","kma_seamless","cma_grapes_global","bom_access_global","knmi_harmonie_arome_europe","dmi_harmonie_arome_europe"]
for m in models:
    url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&timezone=auto&past_days=1&forecast_days=2&models={m}&hourly=precipitation,weather_code,cloud_cover,visibility,relative_humidity_2m,wind_speed_10m,cloud_cover_low"
    try:
        j = json.load(urllib.request.urlopen(url, timeout=30))
        h = j["hourly"]; key = lambda k: next((x for x in h if x.startswith(k)), None)
        out["models"][m] = {"time": h["time"], **{v: h.get(key(v)) for v in ("precipitation", "weather_code", "cloud_cover_low", "visibility", "relative_humidity_2m", "wind_speed_10m")}}
        out["tz"] = j.get("timezone")
    except Exception as e:
        out["models"][m] = {"error": str(e)}
cur = json.load(urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&timezone=auto&current=temperature_2m,precipitation,rain,weather_code,cloud_cover", timeout=30))
out["current"] = cur.get("current")
json.dump(out, open(sys.argv[1], "w"))
print("ok", out["place"], lat, lon)
