# Verifică resursele hărții radar pe tot ecranul (bibliotecă, stil, dale).
import urllib.request, sys, json
out = {}
for u in ["https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js", "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css",
          "https://tiles.openfreemap.org/styles/positron"]:
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "meteo-santier-probe", "Origin": "https://vitalicmalachi-ops.github.io"}), timeout=60)
        b = r.read(); out[u] = {"status": r.status, "len": len(b), "cors": r.headers.get("Access-Control-Allow-Origin")}
        if u.endswith("positron"): out["sources"] = json.loads(b).get("sources")
    except Exception as e: out[u] = repr(e)
json.dump(out, open(sys.argv[1], "w"), indent=1)
