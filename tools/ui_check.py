# Deschide site-ul publicat într-un browser real (date reale), pentru un loc dat, și salvează starea internă + o captură.
import json, sys, os
from playwright.sync_api import sync_playwright
LAT, LON = float(os.environ.get("LAT", "47.0014")), float(os.environ.get("LON", "28.8224"))
out = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="en-US", timezone_id="Europe/Chisinau",
                        geolocation={"latitude": LAT, "longitude": LON}, permissions=["geolocation"])
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    offs = []
    pg.on("response", lambda r: ("open-meteo" in r.url and "models=" in r.url) and offs.append(r.url.split("models=")[1].split("&")[0]))
    pg.goto("https://vitalicmalachi-ops.github.io/meteo-santier/")
    pg.wait_for_selector(".day", timeout=60000); pg.wait_for_timeout(8000)
    out["state"] = pg.evaluate("""() => {
      const c = consensus(todayStr());
      return { offset: state.offset, nowHour: nowHour(), today: todayStr(), now: state.now, wet: c.wet, n: c.n, fromHour: c.fromHour, earlier: c.earlier,
        models: state.results.map(r => { const d = r.days[todayStr()]; return { id: r.model.id, p: d ? d.hours.map(x => x.hr + ':' + x.p).join(' ') : null }; }) };
    }""")
    out["radar"] = pg.inner_text("#radar") if pg.locator("#radar").is_visible() else "hidden"
    out["errs"] = errs
    pg.click("#days > .day:nth-child(1) .day-head"); pg.wait_for_timeout(800)
    pg.screenshot(path=os.path.join(os.path.dirname(sys.argv[1]), "ui.png"), full_page=False)
    b.close()
json.dump(out, open(sys.argv[1], "w"), indent=1, default=str)
