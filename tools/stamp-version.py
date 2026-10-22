# Pune versiunea curentă (data și ora UTC) în index.html, app.js și version.json înainte de publicare.
import datetime, re, json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
v = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
for f in ("index.html", "app.js"):
    p = root / f; t = p.read_text(encoding="utf-8")
    t = re.sub(r'(\?v=)(__VERSION__|\d{8}-\d{6})', r'\g<1>' + v, t)
    t = re.sub(r'(const APP_VERSION = ")(__VERSION__|\d{8}-\d{6})(")', r'\g<1>' + v + r'\g<3>', t)
    p.write_text(t, encoding="utf-8")
(root / "version.json").write_text(json.dumps({"v": v}) + "\n", encoding="utf-8")
print(v)
