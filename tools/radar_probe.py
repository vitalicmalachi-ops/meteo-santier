# Sondă: ce modele Open-Meteo răspund pentru Chișinău și cu ce variabile.
import urllib.request, urllib.error, json, sys
HOURLY = "temperature_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,wind_direction_10m,sunshine_duration,relative_humidity_2m,visibility,weather_code"
C = ["kma_seamless", "kma_gdps", "bom_access_global", "gfs_graphcast025", "ecmwf_ifs", "icon_eu", "icon_global", "meteofrance_arpege_europe", "meteofrance_arpege_world",
     "ukmo_global_deterministic_10km", "ncep_aigfs025", "ncep_hgefs025_ensemble_mean", "knmi_harmonie_arome_europe", "dmi_harmonie_arome_europe", "italia_meteo_arpae_icon_2i",
     "gem_global", "jma_gsm", "cma_grapes_global", "ecmwf_aifs025_single", "meteoswiss_icon_ch2", "metno_seamless", "gfs_global"]
out = {}
for m in C:
    for hv in (HOURLY, "precipitation,temperature_2m,wind_gusts_10m"):
        u = f"https://api.open-meteo.com/v1/forecast?latitude=47.02&longitude=28.87&timezone=auto&forecast_days=7&past_days=2&hourly={hv}&models={m}"
        try:
            j = json.loads(urllib.request.urlopen(u, timeout=60).read())
            H = j["hourly"]; P = H.get("precipitation") or []
            out[m + (" [app vars]" if hv == HOURLY else " [basic]")] = {"n": len(P), "nonnull_precip": sum(v is not None for v in P), "null_vars": [k for k, v in H.items() if k != "time" and all(x is None for x in v)]}
        except urllib.error.HTTPError as e:
            out[m + (" [app vars]" if hv == HOURLY else " [basic]")] = "HTTP %s %s" % (e.code, e.read()[:200].decode())
        except Exception as e:
            out[m] = repr(e)
json.dump(out, open(sys.argv[1], "w"), indent=1)
