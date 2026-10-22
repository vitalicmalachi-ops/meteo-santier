# Sondă 5: descarcă ultimele 3 cadre RATE (GeoTIFF) și lista lor, pentru testele locale ale nowcast-ului.
import json, urllib.request, sys, datetime as dt, re, os
B = "https://api.meteogate.eu/eu-eumetnet-weather-radar/collections/observations/locations/0-20010-0-OPERA"
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "meteo-santier-probe"}), timeout=120).read()
od = os.path.dirname(sys.argv[1])
now = dt.datetime.utcnow(); t0 = (now - dt.timedelta(minutes=75)).strftime("%Y-%m-%dT%H:%MZ"); t1 = now.strftime("%Y-%m-%dT%H:%MZ")
lst = get(f"{B}?datetime={t0}%2F{t1}&f=CoverageJSON&format=GeoTIFF&standard_name=RATE")
open(os.path.join(od, "list.json"), "wb").write(lst)
links = sorted(set(re.findall(r'https://s3[^"]+RATE\.tiff', lst.decode())))
for u in links[-3:]:
    open(os.path.join(od, u.rsplit("/", 1)[1].replace("@", "_")), "wb").write(get(u))
json.dump({"t0": t0, "t1": t1, "links": links}, open(sys.argv[1], "w"), indent=1)
