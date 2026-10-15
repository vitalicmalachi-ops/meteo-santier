// Copiază fișierele site-ului (din rădăcina repository-ului) în www/, ca aplicația să folosească exact același cod.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const www = join(here, "..", "www");
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of ["index.html", "app.js", "i18n.js", "manifest.json", ...["en","ro","ru","uk","de","fr","es","it","pl","tr","pt","cs"].map(l => `manifest-${l}.json`), "favicon.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(www, f));
}
console.log("web copiat în", www);
