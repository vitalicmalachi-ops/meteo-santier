"use strict";
/* Meteo Șantier / Site Weather — logica aplicației.
   Prognoză din mai multe modele Open-Meteo, consens zilnic, verdicte pentru lucrări.
   Totul rulează pe telefon: fără cont, fără server propriu. */

const API = "https://api.open-meteo.com/v1/forecast";
const ENS_API = "https://ensemble-api.open-meteo.com/v1/ensemble";
const GEO_API = "https://geocoding-api.open-meteo.com/v1/search";
const HOURLY = "temperature_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,wind_direction_10m,sunshine_duration,relative_humidity_2m,visibility,weather_code";
const CURRENT = "temperature_2m,relative_humidity_2m,apparent_temperature";
const CACHE_MIN = 30;

// Temperatura solului: ICON și GFS dau suprafața și 6 cm, ECMWF stratul 0–7 cm.
const SOIL_SOURCES = [
  { id: "icon_seamless", vars: "soil_temperature_0cm,soil_temperature_6cm" },
  { id: "gfs_seamless", vars: "soil_temperature_0cm,soil_temperature_6cm" },
  { id: "ecmwf_ifs025", vars: "soil_temperature_0_to_7cm" }
];

const MODELS = [
  { id: "ecmwf_ifs025", name: "ECMWF IFS", org: "ECMWF" },
  { id: "ecmwf_aifs025_single", name: "ECMWF AIFS", org: "ECMWF · AI" },
  { id: "icon_seamless", name: "ICON", org: "DWD · DE" },
  { id: "gfs_seamless", name: "GFS", org: "NOAA · US" },
  { id: "meteofrance_seamless", name: "ARPEGE", org: "Météo-France · FR" },
  { id: "ukmo_seamless", name: "UKMO", org: "Met Office · UK" },
  { id: "gem_seamless", name: "GEM", org: "ECCC · CA" },
  { id: "jma_seamless", name: "JMA", org: "JMA · JP" },
  { id: "kma_seamless", name: "KMA", org: "KMA · KR" },
  { id: "cma_grapes_global", name: "GRAPES", org: "CMA · CN" },
  { id: "bom_access_global", name: "ACCESS", org: "BoM · AU" },
  { id: "knmi_harmonie_arome_europe", name: "HARMONIE-NL", org: "KNMI · NL · 2–3 d" },
  { id: "dmi_harmonie_arome_europe", name: "HARMONIE-DK", org: "DMI · DK · 2–3 d" }
];
const ENS_MODELS = ["ecmwf_ifs025", "gfs025", "icon_seamless"];

const WORK_IDS = ["beton", "asfalt", "hidro", "fatada", "acoperis", "macara", "sapaturi"];

// Praguri standard, păstrate intern în unități metrice (°C, km/h, mm, %).
const LIMITS = {
  beton: [{ k: "tminWarn", u: "temp", d: 5 }, { k: "tminStop", u: "temp", d: 0 }],
  asfalt: [{ k: "tmaxOk", u: "temp", d: 10 }, { k: "tmaxStop", u: "temp", d: 5 }],
  hidro: [{ k: "tmin", u: "temp", d: 5 }],
  fatada: [{ k: "tmin", u: "temp", d: 5 }, { k: "rh", u: "pct", d: 85 }, { k: "gustWarn", u: "wind", d: 40 }, { k: "gustStop", u: "wind", d: 54 }],
  acoperis: [{ k: "gustWarn", u: "wind", d: 36 }, { k: "gustStop", u: "wind", d: 50 }],
  macara: [{ k: "gustWarn", u: "wind", d: 36 }, { k: "gustStop", u: "wind", d: 54 }],
  sapaturi: [{ k: "rain3Warn", u: "precip", d: 10 }, { k: "rain3Stop", u: "precip", d: 25 }]
};
const limitLabelKey = (w, k) => (k === "gustWarn" || k === "gustStop") ? "lim_" + k : `lim_${w}_${k}`;

/* ---------- stocare locală ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

/* ---------- limbă și unități implicite ---------- */
function navLangs() { return (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]).map(String); }
function detectLang() {
  for (const l of navLangs()) {
    let b = l.toLowerCase().split("-")[0];
    if (b === "mo") b = "ro";
    if (LANGS.some(x => x[0] === b)) return b;
  }
  return "en";
}
function detectRegion() {
  for (const l of navLangs()) { const p = l.split("-"); if (p[1] && p[1].length === 2) return p[1].toUpperCase(); }
  return "";
}
// Unitățile implicite urmează țara în care se află locul; metric peste tot, cu excepțiile de mai jos.
// Ce alege utilizatorul în Setări are mereu prioritate.
function defaultUnits(cc) {
  cc = String(cc || "").toUpperCase();
  if (["US", "LR", "MM", "PR", "GU", "VI", "AS", "MP"].includes(cc)) return { temp: "F", wind: "mph", precip: "in" };
  if (cc === "GB") return { temp: "C", wind: "mph", precip: "mm" };
  return { temp: "C", wind: "kmh", precip: "mm" };
}
function defaultLimits() {
  const o = {};
  for (const w in LIMITS) { o[w] = {}; LIMITS[w].forEach(x => { o[w][x.k] = x.d; }); }
  return o;
}
function loadLimits() {
  const saved = store.get("ms.limits", {}), o = defaultLimits();
  for (const w in o) for (const k in o[w]) if (saved[w] && isFinite(saved[w][k])) o[w][k] = Number(saved[w][k]);
  return o;
}

const state = {
  langChoice: store.get("ms.lang", null),   // null = automat, după limba telefonului
  lang: null,
  userUnits: store.get("ms.units", {}),   // doar ce a ales utilizatorul
  units: null,
  limits: loadLimits(),
  loc: null, mode: null, results: [], ens: [], soil: [], status: {}, offset: 0, fetchedAt: 0,
  thr: Number(store.get("ms.thr", 1)) || 1, open: null, reqId: 0,
  works: (() => { const w = store.get("ms.works", null); return Array.isArray(w) ? w.filter(id => WORK_IDS.includes(id)) : WORK_IDS.slice(); })()
};
state.lang = (state.langChoice && LANGS.some(x => x[0] === state.langChoice)) ? state.langChoice : detectLang();
function applyUnits() { state.units = Object.assign(defaultUnits(state.loc && state.loc.cc), state.userUnits); }
applyUnits();
function locale() {
  return navLangs().find(l => l.toLowerCase().split("-")[0] === state.lang) || state.lang;
}

/* ---------- utilitare ---------- */
const isNum = v => typeof v === "number" && isFinite(v);
function median(arr) {
  const a = arr.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const minOf = arr => { const a = arr.filter(isNum); return a.length ? Math.min(...a) : null; };
const maxOf = arr => { const a = arr.filter(isNum); return a.length ? Math.max(...a) : null; };
const sumOf = arr => { const a = arr.filter(isNum); return a.length ? a.reduce((s, v) => s + v, 0) : null; };
function t(key, vars) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) ?? I18N.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}
function fmt(x, dec = 0) {
  if (!isNum(x)) return "–";
  return x.toLocaleString(locale(), { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function stripKeys(obj, id) {
  const o = {}; const suf = "_" + id;
  for (const k in obj) o[k.endsWith(suf) ? k.slice(0, -suf.length) : k] = obj[k];
  return o;
}
function addDays(d, n) {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd) + n * 864e5).toISOString().slice(0, 10);
}
function circMean(degs, weights) {
  let x = 0, y = 0, n = 0;
  degs.forEach((d, i) => {
    if (!isNum(d)) return;
    const w = weights && isNum(weights[i]) ? Math.max(weights[i], 0.1) : 1;
    x += Math.cos(d * Math.PI / 180) * w; y += Math.sin(d * Math.PI / 180) * w; n++;
  });
  if (!n) return null;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function covers(hours, key) {
  const hs = hours.filter(h => isNum(h[key])).map(h => h.hr);
  return hs.length >= 4 && Math.min(...hs) <= 3 && Math.max(...hs) >= 21;
}
function dirLabel(deg) {
  if (!isNum(deg)) return "";
  return t("dirs").split(",")[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/* ---------- unități ---------- */
const WIND_LABEL = { kmh: "km/h", ms: "m/s", mph: "mph" };
const toUser = {
  temp: c => state.units.temp === "F" ? c * 9 / 5 + 32 : c,
  wind: k => state.units.wind === "ms" ? k / 3.6 : state.units.wind === "mph" ? k / 1.609344 : k,
  precip: mm => state.units.precip === "in" ? mm / 25.4 : mm,
  snow: cm => state.units.precip === "in" ? cm / 2.54 : cm,
  pct: v => v
};
const fromUser = {
  temp: v => state.units.temp === "F" ? (v - 32) * 5 / 9 : v,
  wind: v => state.units.wind === "ms" ? v * 3.6 : state.units.wind === "mph" ? v * 1.609344 : v,
  precip: v => state.units.precip === "in" ? v * 25.4 : v,
  pct: v => v
};
const unitLabel = {
  temp: () => "°" + state.units.temp, wind: () => WIND_LABEL[state.units.wind],
  precip: () => state.units.precip === "in" ? "in" : "mm", snow: () => state.units.precip === "in" ? "in" : "cm", pct: () => "%"
};
function fmtT(c) { if (!isNum(c)) return "–"; const r = Math.round(toUser.temp(c)); return (r === 0 ? 0 : r) + "°"; }
function fmtW(k) { return isNum(k) ? `${fmt(toUser.wind(k))} ${unitLabel.wind()}` : "–"; }
function precipDec(mm) { return state.units.precip === "in" ? 2 : (mm < 10 ? 1 : 0); }
function fmtP(mm) { return isNum(mm) ? `${fmt(toUser.precip(mm), precipDec(mm))} ${unitLabel.precip()}` : "–"; }
function fmtPn(mm) { return isNum(mm) ? fmt(toUser.precip(mm), state.units.precip === "in" ? 2 : 1) : "–"; }
function fmtS(cm) { return isNum(cm) ? `${fmt(toUser.snow(cm), state.units.precip === "in" ? 1 : 0)} ${unitLabel.snow()}` : "–"; }

/* ---------- agregare pe zile (din datele orare ale fiecărui model) ---------- */
function aggregate(h) {
  const days = new Map();
  (h.time || []).forEach((tm, i) => {
    const d = tm.slice(0, 10), hr = +tm.slice(11, 13);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push({
      hr, t: h.temperature_2m?.[i], p: h.precipitation?.[i], s: h.snowfall?.[i],
      w: h.wind_speed_10m?.[i], g: h.wind_gusts_10m?.[i], dir: h.wind_direction_10m?.[i], sun: h.sunshine_duration?.[i],
      rh: h.relative_humidity_2m?.[i], vis: h.visibility?.[i], wc: h.weather_code?.[i]
    });
  });
  const out = {};
  for (const [d, H] of days) {
    const ok = covers(H, "p");
    out[d] = {
      date: d, ok, hours: H,
      tmin: covers(H, "t") ? minOf(H.map(x => x.t)) : null,
      tmax: covers(H, "t") ? maxOf(H.map(x => x.t)) : null,
      precip: ok ? sumOf(H.map(x => x.p)) : null,
      snow: ok ? sumOf(H.map(x => x.s)) : null,
      gust: covers(H, "g") ? maxOf(H.map(x => x.g)) : null,
      wind: covers(H, "w") ? maxOf(H.map(x => x.w)) : null,
      dir: circMean(H.map(x => x.dir), H.map(x => x.w)),
      sun: covers(H, "sun") ? sumOf(H.map(x => x.sun)) / 3600 : null,
      rh: median(H.filter(x => x.hr >= 8 && x.hr <= 18).map(x => x.rh))
    };
  }
  return out;
}

function aggregateEns(h) {
  // { "YYYY-MM-DD": { hrs: [ore], m: [[valori orare] pentru fiecare membru] } }
  const keys = Object.keys(h).filter(k => /^precipitation(_member\d+)?$/.test(k));
  const out = {};
  (h.time || []).forEach((tm, i) => {
    const d = tm.slice(0, 10), hr = +tm.slice(11, 13);
    const o = out[d] || (out[d] = { hrs: [], m: keys.map(() => []) });
    o.hrs.push(hr);
    keys.forEach((k, j) => { const v = h[k][i]; o.m[j].push(isNum(v) ? v : null); });
  });
  return out;
}

/* ---------- intervalul de calcul: ziua întreagă, 00–24 ---------- */
// Pentru azi contează doar orele care au rămas: ploaia de noapte nu face „ploioasă” restul zilei.
const DRIZZLE = 0.2;   // mm/h: sub acest prag modelele dau des „burniță” care nu cade; nu o numărăm ca ploaie
const WET_HOUR = 0.5;  // mm/h: ploaie în vederea oră cu oră; între DRIZZLE și WET_HOUR apare ca burniță posibilă
// Ceață într-o oră, pentru un model: vizibilitate sub 1 km, cod de ceață, sau aer saturat (≥99%) cu vânt slab.
// Calibrat pe observațiile de ceață ale stației Chișinău; o oră e „cu ceață” dacă o dă cel puțin o treime din modele.
const FOG_FRAC = 1 / 3;
function fogHour(x) {
  if (!x || (isNum(x.p) && x.p >= DRIZZLE)) return false;
  if (isNum(x.vis) && x.vis < 1000) return true;
  if (x.wc === 45 || x.wc === 48) return true;
  return isNum(x.rh) && x.rh >= 99 && isNum(x.w) && x.w <= 12;
}
function fogByHour(date) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    let n = 0, f = 0;
    state.results.forEach(r => { const d = r.days[date]; const x = d && d.hours.find(y => y.hr === h); if (!x || !isNum(x.rh) && !isNum(x.vis)) return; n++; if (fogHour(x)) f++; });
    out.push({ h, n, f, frac: n ? f / n : 0 });
  }
  return out;
}
function nowHour() { return new Date(Date.now() + state.offset * 1000).getUTCHours(); }
// Precipitațiile Open-Meteo de la ora H sunt suma orei precedente (H-1 → H),
// deci intervalul [h, h+1) se citește din înregistrarea h+1 (23–24 = ora 00 a zilei următoare).
function slotsFor(date) {
  const from = date === todayStr() ? nowHour() : 0;
  const out = [];
  for (let h = from + 1; h <= 24; h++) out.push({ off: h === 24 ? 1 : 0, hr: h % 24 });
  return out;
}
function winAgg(days, date, slots) {
  const H = [];
  slots.forEach(sl => {
    const d = days[sl.off ? addDays(date, 1) : date]; if (!d) return;
    const x = d.hours.find(y => y.hr === sl.hr); if (x) H.push(x);
  });
  const P = H.filter(x => isNum(x.p));
  const ok = P.length >= Math.max(1, Math.ceil(slots.length / 4));
  return {
    ok, p: ok ? (sumOf(P.map(x => x.p >= DRIZZLE ? x.p : 0)) || 0) : null, s: ok ? (sumOf(H.map(x => x.s)) || 0) : null,
    g: maxOf(H.map(x => x.g)), tmin: minOf(H.map(x => x.t)), tmax: maxOf(H.map(x => x.t)), rh: median(H.map(x => x.rh))
  };
}
function ensWindow(date, slots, thr) {
  const sums = [], need = Math.max(1, Math.ceil(slots.length / 4));
  state.ens.forEach(e => {
    const d0 = e.days[date], d1 = e.days[addDays(date, 1)];
    if (!d0 || !d0.m) return;
    d0.m.forEach((_, j) => {
      let sum = 0, c = 0;
      slots.forEach(sl => {
        const D = sl.off ? d1 : d0; if (!D || !D.m || !D.m[j]) return;
        const i = D.hrs.indexOf(sl.hr); if (i < 0) return;
        const v = D.m[j][i]; if (isNum(v)) { sum += v >= DRIZZLE ? v : 0; c++; }
      });
      if (c >= need) sums.push(sum);
    });
  });
  return sums.length >= 20 ? { p: sums.filter(v => v >= thr).length / sums.length, n: sums.length } : null;
}

function aggregateSoil(h) {
  const s0k = h.soil_temperature_0cm ? "soil_temperature_0cm" : "soil_temperature_0_to_7cm";
  const s6k = h.soil_temperature_6cm ? "soil_temperature_6cm" : "soil_temperature_0_to_7cm";
  const byDay = {};
  (h.time || []).forEach((tm, i) => {
    const d = tm.slice(0, 10), hr = +tm.slice(11, 13);
    (byDay[d] = byDay[d] || []).push({ hr, s0: h[s0k]?.[i], s6: h[s6k]?.[i] });
  });
  const out = {};
  for (const d in byDay) {
    const H = byDay[d];
    out[d] = { s0: covers(H, "s0") ? minOf(H.map(x => x.s0)) : null, s6: covers(H, "s6") ? minOf(H.map(x => x.s6)) : null };
  }
  return out;
}

/* ---------- consens pe o zi ---------- */
function consensus(date) {
  const thr = state.thr, slots = slotsFor(date);
  const isToday = date === todayStr(), nowH = nowHour();
  // ploaia de azi dinainte de ora curentă (după modele), afișată separat
  const earlier = isToday && nowH > 0 ? median(state.results.map(r => {
    const d = r.days[date]; if (!d) return null;
    const H = d.hours.filter(x => x.hr < nowH && isNum(x.p));
    return H.length ? H.reduce((a, x) => a + (x.p >= DRIZZLE ? x.p : 0), 0) : null;
  })) : null;
  const Wall = state.results.map(r => winAgg(r.days, date, slots));
  const W = Wall.filter(w => w.ok);
  const n = W.length;
  const kinds = W.map(w => (isNum(w.s) && w.s >= 0.5) ? "s" : (w.p >= thr ? "r" : ""));
  const wet = kinds.filter(k => k).length;
  const snowy = kinds.filter(k => k === "s").length;
  const tRows = state.results.map(r => r.days[date]).filter(Boolean);
  const ens = ensWindow(date, slots, thr);
  return {
    date, isToday, fromHour: isToday ? nowH : 0, earlier, n, wet, snowy, kinds: kinds.slice().sort((a, b) => (b === "s") - (a === "s") || (b === "r") - (a === "r")),
    frac: n ? wet / n : 0, snowFrac: n ? snowy / n : 0,
    // temperaturile zilei întregi: înghețul de noapte contează pentru beton și fațade
    tmin: median(tRows.map(r => r.tmin)), tmax: median(tRows.map(r => r.tmax)),
    wtmax: median(Wall.map(w => w.tmax)),
    precipWet: median(W.filter(w => w.p >= thr).map(w => w.p)),
    snow: median(W.filter(w => w.s >= 0.5).map(w => w.s)),
    gust: median(Wall.map(w => w.g)), dayGust: median(tRows.map(r => r.gust)), wind: median(tRows.map(r => r.wind)),
    dir: circMean(tRows.map(r => r.dir)), sun: median(tRows.map(r => r.sun)),
    rh: median(Wall.map(w => w.rh)),
    soil0: median(state.soil.map(s => s.days[date]?.s0)),
    soil6: median(state.soil.map(s => s.days[date]?.s6)),
    prevPrecip: median(state.results.map(r => { const p = r.days[addDays(date, -1)]; return p && p.ok ? p.precip : null; })),
    rain3: median(state.results.map(r => {
      const ds = [0, -1, -2].map(k => r.days[addDays(date, k)]);
      return ds.every(x => x && x.ok) ? ds.reduce((s, x) => s + x.precip, 0) : null;
    })),
    ensProb: ens ? ens.p : null, ensN: ens ? ens.n : 0,
    ...(() => {
      const fh = fogByHour(date).filter(x => x.h >= (isToday ? nowH : 0) && x.n && x.frac >= FOG_FRAC);
      if (!fh.length) return { fog: null };
      const a = fh[0].h, b = fh[fh.length - 1].h + 1;
      return { fog: { from: a, to: b, hours: fh.length, frac: Math.max(...fh.map(x => x.frac)), label: `${String(a).padStart(2, "0")}–${String(b % 24 === 0 && b === 24 ? 24 : b).padStart(2, "0")}` } };
    })()
  };
}

function rainText(c) {
  if (!c.n) return t("rt_nodata");
  if (c.snowFrac >= 0.5) return t("rt_snow");
  if (c.frac >= 0.75) return t("rt_certain");
  if (c.frac >= 0.5) return t("rt_likely");
  if (c.frac >= 0.25) return t("rt_unsure");
  if (c.wet > 0) return t("rt_unlikely");
  return t("rt_dry");
}

/* ---------- verdicte pentru lucrări ---------- */
function judgeWorks(c) {
  const N = isNum, f = c.frac, g = c.gust, L = state.limits;
  const res = {};
  const pr = t("r_rainModels", { wet: c.wet, n: c.n });
  const pick = (id, rules, okText) => {
    for (const [cond, level, reason] of rules) if (cond) { res[id] = { level, reason }; return; }
    res[id] = { level: "ok", reason: okText };
  };
  const T = x => fmtT(x);
  pick("beton", [
    [N(c.tmin) && c.tmin < L.beton.tminStop, "stop", t("r_frostNight", { t: T(c.tmin) })],
    [N(c.soil6) && c.soil6 < 0, "stop", t("r_soil6Frozen", { t: T(c.soil6) })],
    [f >= 0.6, "stop", pr],
    [N(c.tmin) && c.tmin < L.beton.tminWarn, "warn", t("r_lowCold", { t: T(c.tmin) })],
    [N(c.soil0) && c.soil0 < 0, "warn", t("r_soil0Frozen", { t: T(c.soil0) })],
    [f >= 0.3, "warn", pr]
  ], t("r_betonOk", { t: T(c.tmin) }));
  const tw = N(c.wtmax) ? c.wtmax : c.tmax;   // maxima în orele de lucru
  pick("asfalt", [
    [N(tw) && tw < L.asfalt.tmaxStop, "stop", t("r_highBelow", { t: T(tw), lim: T(L.asfalt.tmaxStop) })],
    [f >= 0.6, "stop", pr],
    [N(tw) && tw < L.asfalt.tmaxOk, "warn", t("r_asfaltThick", { t: T(tw), lim: T(L.asfalt.tmaxOk) })],
    [N(c.soil0) && c.soil0 < 0, "warn", t("r_baseFrozen", { t: T(c.soil0) })],
    [N(c.tmin) && c.tmin < 0, "warn", t("r_frostColdMorning")],
    [f >= 0.25, "warn", pr]
  ], t("r_asfaltOk", { t: T(tw) }));
  pick("hidro", [
    [N(c.tmax) && c.tmax < 0, "stop", t("r_hardFrost", { t: T(c.tmax) })],
    [c.snowFrac >= 0.5, "stop", t("r_snow")],
    [f >= 0.6, "stop", pr],
    [f >= 0.25, "warn", pr],
    [N(c.prevPrecip) && c.prevPrecip >= state.thr, "warn", t("r_wetYesterday", { v: fmtP(c.prevPrecip) })],
    [!!c.fog, "warn", c.fog ? t("r_fogDamp", { h: c.fog.label }) : ""],
    [N(c.tmin) && c.tmin < L.hidro.tmin, "warn", t("r_coldAdhesion", { t: T(c.tmin) })]
  ], t("r_hidroOk"));
  pick("fatada", [
    [N(c.tmin) && c.tmin < 0, "stop", t("r_frostNight", { t: T(c.tmin) })],
    [f >= 0.6, "stop", pr],
    [N(g) && g >= L.fatada.gustStop, "stop", t("r_gusts", { v: fmtW(g) })],
    [N(c.tmin) && c.tmin < L.fatada.tmin, "warn", t("r_lowBelow", { t: T(c.tmin), lim: T(L.fatada.tmin) })],
    [f >= 0.25, "warn", pr],
    [N(c.rh) && c.rh >= L.fatada.rh, "warn", t("r_humid", { v: fmt(c.rh) })],
    [!!c.fog, "warn", c.fog ? t("r_fogDamp", { h: c.fog.label }) : ""],
    [N(g) && g >= L.fatada.gustWarn, "warn", t("r_gusts", { v: fmtW(g) })]
  ], t("r_fatadaOk", { lim: T(L.fatada.tmin) }));
  pick("acoperis", [
    [N(g) && g >= L.acoperis.gustStop, "stop", t("r_gusts", { v: fmtW(g) })],
    [c.snowFrac >= 0.5, "stop", t("r_snowRoof")],
    [N(g) && g >= L.acoperis.gustWarn, "warn", t("r_gusts", { v: fmtW(g) })],
    [N(c.tmin) && c.tmin < 0, "warn", t("r_ice")],
    [f >= 0.5, "warn", t("r_slippery")],
    [!!c.fog, "warn", c.fog ? t("r_fogVis", { h: c.fog.label }) : ""]
  ], N(g) ? t("r_gusts", { v: fmtW(g) }) : t("r_calmWind"));
  if (N(g)) pick("macara", [
    [g >= L.macara.gustStop, "stop", t("r_craneStop", { v: fmtW(g) })],
    [g >= L.macara.gustWarn, "warn", t("r_craneWarn", { v: fmtW(g) })],
    [!!c.fog, "warn", c.fog ? t("r_fogVis", { h: c.fog.label }) : ""]
  ], t("r_gusts", { v: fmtW(g) }));
  else res.macara = { level: "na", reason: t("r_noGustData") };
  pick("sapaturi", [
    [N(c.rain3) && c.rain3 >= L.sapaturi.rain3Stop, "stop", t("r_waterlogged", { v: fmtP(c.rain3) })],
    [N(c.rain3) && c.rain3 >= L.sapaturi.rain3Warn, "warn", t("r_mud", { v: fmtP(c.rain3) })],
    [N(c.soil6) && c.soil6 < 0, "warn", t("r_groundFrozen", { t: T(c.soil6) })],
    [f >= 0.6, "warn", pr]
  ], N(c.rain3) ? t("r_rain3", { v: fmtP(c.rain3) }) : t("r_noRain"));
  return res;
}
const LEVEL_SYM = { ok: "✓", warn: "!", stop: "✕", na: "–" };
const lvl = l => t("lvl_" + l);
const activeWorks = () => WORK_IDS.filter(id => state.works.includes(id));

/* ---------- oră cu oră ---------- */
function hourly(date) {
  const res = [];
  for (let h = 0; h < 24; h++) {
    let n = 0, wet = 0, snow = 0, drz = 0; const temps = [], gusts = [], amts = [];
    state.results.forEach(r => {
      const d = r.days[date]; if (!d) return;
      const t0 = d.hours.find(y => y.hr === h);                     // temperatura: valoarea de la începutul orei
      const nd = h === 23 ? r.days[addDays(date, 1)] : d;           // ploaia și rafalele: înregistrarea de la sfârșitul orei
      const x = nd && nd.hours.find(y => y.hr === (h + 1) % 24);
      if (!x || !isNum(x.p)) return;
      n++;
      if (isNum(x.s) && x.s >= 0.1) { wet++; snow++; } else if (x.p >= WET_HOUR) wet++; else if (x.p >= DRIZZLE) drz++;
      amts.push(x.p);
      if (t0 && isNum(t0.t)) temps.push(t0.t);
      if (isNum(x.g)) gusts.push(x.g);
    });
    // șansa de ploaie pentru linie: modele cu ploaie, plus jumătate din cele cu burniță
    res.push({ h, n, wet, snow, drz, frac: n ? wet / n : 0, dfrac: n ? drz / n : 0, chance: n ? (wet + drz / 2) / n : 0, amt: median(amts), t: median(temps), g: median(gusts) });
  }
  return res;
}

/* ---------- pictograme ---------- */
const ICON = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  cloud: '<path d="M7 18.5h10.2a4 4 0 0 0 .4-7.98A6 6 0 0 0 6 11.3a3.6 3.6 0 0 0 1 7.2z"/>',
  part: '<path d="M8.5 3v1.6M3 8.5h1.6M4.6 4.6l1.1 1.1M12.4 4.6l-1.1 1.1"/><path d="M5.6 10.6a3.4 3.4 0 0 1 5.9-3"/><path d="M9 20h8.6a3.4 3.4 0 0 0 .3-6.8 5.1 5.1 0 0 0-9.8.8A3 3 0 0 0 9 20z"/>',
  rain: '<path d="M7 15h10.2a4 4 0 0 0 .4-7.98A6 6 0 0 0 6 7.8a3.6 3.6 0 0 0 1 7.2z"/><path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"/>',
  shower: '<path d="M7 15h10.2a4 4 0 0 0 .4-7.98A6 6 0 0 0 6 7.8a3.6 3.6 0 0 0 1 7.2z"/><path d="M12.5 18l-1 2.5"/>',
  snow: '<path d="M7 14.5h10.2a4 4 0 0 0 .4-7.98A6 6 0 0 0 6 7.3a3.6 3.6 0 0 0 1 7.2z"/><path d="M8 18.5h.01M12 18.5h.01M16 18.5h.01M10 21h.01M14 21h.01" stroke-width="2.6"/>',
  wind: '<path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3"/>',
  sunS: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/>',
  drops: '<path d="M12 3.5s5.5 6 5.5 10a5.5 5.5 0 0 1-11 0c0-4 5.5-10 5.5-10z"/>',
  flake: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>',
  fog: '<path d="M4 8h16M3 12h18M5 16h14M8 20h8"/>',
  chev: '<path d="M6 9l6 6 6-6"/>'
};
function svg(name, cls, color) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ""}${color ? ` style="color:var(${color})"` : ""} aria-hidden="true">${ICON[name]}</svg>`;
}
function glyph(c) {
  if (c.snowFrac >= 0.5) return svg("snow", "", "--snow");
  if (c.frac >= 0.5) return svg("rain", "", "--rain");
  if (c.frac >= 0.25) return svg("shower", "", "--rain");
  if (isNum(c.sun) && c.sun >= 6) return svg("sun", "", "--sun");
  if (isNum(c.sun) && c.sun >= 2) return svg("part", "", "--muted");
  return svg("cloud", "", "--muted");
}

/* ---------- date ---------- */
function todayStr() { return new Date(Date.now() + state.offset * 1000).toISOString().slice(0, 10); }
function cap(s) { return s ? s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1) : s; }
function dayLabel(d) {
  const loc = locale(), dt = new Date(d + "T12:00:00Z");
  const fmtD = o => new Intl.DateTimeFormat(loc, Object.assign({ timeZone: "UTC" }, o)).format(dt);
  const wd = cap(fmtD({ weekday: "long" })), wds = cap(fmtD({ weekday: "short" }).replace(/\.$/, ""));
  const dm = fmtD({ day: "numeric", month: "short" });
  const t0 = todayStr(), t1 = addDays(t0, 1);
  let rel = null;
  try { const rf = new Intl.RelativeTimeFormat(loc, { numeric: "auto" }); if (d === t0) rel = cap(rf.format(0, "day")); else if (d === t1) rel = cap(rf.format(1, "day")); } catch (e) {}
  return {
    big: rel || wd,
    small: (rel ? wds + ", " : "") + dm,
    short: rel || `${wds} ${dt.getUTCDate()}`,
    col: [wds, String(dt.getUTCDate())],
    isToday: d === t0
  };
}

/* ---------- încărcare ---------- */
async function fetchJson(url) {
  const r = await fetch(url);
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || j.error) throw new Error((j && j.reason) || ("HTTP " + r.status));
  return j;
}
function coordQS(loc, pastDays = 0) {
  return `latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}&timezone=auto&forecast_days=14${pastDays ? `&past_days=${pastDays}` : ""}`;
}
const near = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.02 && Math.abs(a.lon - b.lon) < 0.02;

function fromCache(loc) {
  const c = store.get("ms.cache4", null);
  if (!c || !near(c, loc) || Date.now() - c.ts > CACHE_MIN * 60000) return false;
  Object.assign(state, { results: c.results, ens: c.ens, soil: c.soil, status: c.status, offset: c.offset, fetchedAt: c.ts });
  state.results.forEach(r => { r.model = MODELS.find(m => m.id === r.id) || r.model; });
  return true;
}
function saveCache() {
  const c = { lat: state.loc.lat, lon: state.loc.lon, ts: state.fetchedAt, offset: state.offset, status: state.status,
    results: state.results.map(r => ({ id: r.model.id, model: r.model, days: r.days })), ens: state.ens, soil: state.soil };
  if (!store.set("ms.cache4", c)) store.del("ms.cache4");
}

async function loadNow(loc) {
  try {
    const j = await fetchJson(`${API}?latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}&current=${CURRENT}&timezone=auto`);
    if (!near(loc, state.loc)) return;
    state.now = j.current || null;
  } catch (e) { state.now = null; }
  renderNow();
}

async function load(force) {
  const loc = state.loc; if (!loc) return;
  $("#noLoc").hidden = true;
  loadNow(loc);
  if (!force && fromCache(loc)) { finishLoad(); return; }
  const id = ++state.reqId;
  state.results = []; state.ens = []; state.soil = []; state.status = {}; state.open = null;
  setStatus("loading", t("loadingModels", { n: MODELS.length }));
  $("#errBox").innerHTML = "";
  $("#days").innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  $("#summary").hidden = true; $("#planner").hidden = true;
  renderModels();
  let done = 0;
  // 2 zile din urmă: ploaia căzută deja contează pentru săpături și hidroizolații
  const jobs = MODELS.map(m => fetchJson(`${API}?${coordQS(loc, 2)}&models=${m.id}&hourly=${HOURLY}`)
    .then(j => {
      if (id !== state.reqId) return;
      if (isNum(j.utc_offset_seconds)) state.offset = j.utc_offset_seconds;
      const days = aggregate(stripKeys(j.hourly || {}, m.id));
      const any = Object.values(days).some(d => d.ok);
      state.status[m.id] = any ? "ok" : "off";
      if (any) state.results.push({ model: m, days });
    })
    .catch(() => { if (id === state.reqId) state.status[m.id] = "off"; })
    .finally(() => {
      if (id !== state.reqId) return;
      done++;
      setStatus("loading", t("gotModels", { done, n: MODELS.length }));
      renderModels();
    }));
  const ensJobs = ENS_MODELS.map(e => fetchJson(`${ENS_API}?${coordQS(loc)}&models=${e}&hourly=precipitation`)
    .then(j => { if (id === state.reqId) state.ens.push({ id: e, days: aggregateEns(stripKeys(j.hourly || {}, e)) }); })
    .catch(() => {}));
  const soilJobs = SOIL_SOURCES.map(s => fetchJson(`${API}?${coordQS(loc)}&models=${s.id}&hourly=${s.vars}`)
    .then(j => {
      if (id !== state.reqId) return;
      const days = aggregateSoil(stripKeys(j.hourly || {}, s.id));
      if (Object.values(days).some(d => isNum(d.s0) || isNum(d.s6))) state.soil.push({ id: s.id, days });
    })
    .catch(() => {}));
  await Promise.allSettled(jobs.concat(ensJobs, soilJobs));
  if (id !== state.reqId) return;
  state.results.sort((a, b) => MODELS.indexOf(a.model) - MODELS.indexOf(b.model));
  if (!state.results.length) {
    setStatus("err", t("loadFail"));
    $("#days").innerHTML = "";
    $("#errBox").innerHTML = `<div class="err-box">${esc(t("loadFailBox"))}<button type="button" id="retry">${esc(t("retry"))}</button></div>`;
    $("#retry").onclick = () => load(true);
    return;
  }
  state.fetchedAt = Date.now();
  saveCache();
  finishLoad();
}
function finishLoad() {
  renderModels();
  renderUpdated();
  setStatus("ok", t(state.ens.length ? "statusOkEns" : "statusOk", { n: state.results.length }));
  render();
}

/* ---------- desenare ---------- */
function $(s) { return document.querySelector(s); }
function setStatus(kind, text) {
  const el = $("#status"); el.hidden = false; el.className = "status " + kind; $("#statusText").textContent = text;
}
function renderUpdated() {
  $("#updated").textContent = state.fetchedAt
    ? t("updated", { time: new Date(state.fetchedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) }) : "";
}
function renderNow() {
  const n = state.now, el = $("#now");
  if (!n || !isNum(n.temperature_2m)) { el.hidden = true; return; }
  el.hidden = false;
  $("#nowT").textContent = fmtT(n.temperature_2m);
  const lines = [];
  if (isNum(n.relative_humidity_2m)) lines.push(t("nowHum", { v: fmt(n.relative_humidity_2m) }));
  if (isNum(n.apparent_temperature) && Math.abs(toUser.temp(n.apparent_temperature) - toUser.temp(n.temperature_2m)) >= 2)
    lines.push(t("nowFeels", { t: fmtT(n.apparent_temperature) }));
  $("#nowH").innerHTML = lines.map(esc).join("<br>");
  el.setAttribute("aria-label", `${t("nowTitle")}: ${fmtT(n.temperature_2m)}. ${lines.join(". ")}`);
}
function allDates() {
  const s = new Set(); state.results.forEach(r => Object.keys(r.days).forEach(d => s.add(d)));
  const t0 = todayStr();
  return [...s].sort().filter(d => d >= t0).slice(0, 14);
}

function render() {
  if (!state.results.length) return;
  const cs = allDates().map(consensus);
  const w1 = cs.slice(0, 7), w2 = cs.slice(7, 14);
  const sum1 = summaryHtml(w1), pl1 = plannerHtml(w1);
  $("#summary").innerHTML = sum1; $("#summary").hidden = !sum1;
  $("#planner").innerHTML = pl1; $("#planner").hidden = !pl1;
  let week2 = "";
  if (w2.length) {
    const ns = w2.map(c => c.n).filter(n => n > 0);
    const a = Math.min(...ns), b = Math.max(...ns);
    const dry = w2.filter(c => c.n && c.frac < 0.25 && c.snowFrac < 0.25).length;
    const sum2 = summaryHtml(w2, true), pl2 = plannerHtml(w2);
    week2 = `<details class="week2" id="week2"${state.week2Open ? " open" : ""}>
      <summary><span class="w2-t">${esc(t("week2Title"))}</span><span class="w2-r">${esc(rangeLabel(w2[0].date, w2[w2.length - 1].date))} · ${esc(t("week2Dry", { n: dry }))}</span></summary>
      <div class="w2-body">
        <p class="w2-note">${esc(t("week2Note", { r: a === b ? a : `${a}–${b}`, n: MODELS.length }))}</p>
        ${sum2 ? `<section class="summary">${sum2}</section>` : ""}
        ${pl2 ? `<section class="planner">${pl2}</section>` : ""}
        <div class="days">${w2.map(dayCard).join("")}</div>
      </div>
    </details>`;
  }
  $("#days").innerHTML = w1.map(dayCard).join("") + week2;
  const wk = $("#week2"); if (wk) wk.addEventListener("toggle", () => { state.week2Open = wk.open; });
  document.querySelectorAll(".day-head").forEach(b => b.addEventListener("click", () => toggle(b.closest(".day"))));
  document.querySelectorAll(".planner button.cell").forEach(b => b.onclick = () => {
    const day = document.querySelector(`.day[data-date="${b.dataset.date}"]`);
    if (!day) return;
    toggle(day, true);
    day.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  });
  if (state.open) { const el = document.querySelector(`.day[data-date="${state.open}"]`); if (el) toggle(el, true); }
}

function rangeLabel(d1, d2) {
  const f = d => new Intl.DateTimeFormat(locale(), { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
  return `${f(d1)} – ${f(d2)}`;
}

function dayCard(c) {
  const L = dayLabel(c.date);
  const votes = c.kinds.map(k => `<i class="${k}"></i>`).join("");
  const amt = c.wet ? (c.snowFrac >= 0.5 && isNum(c.snow) ? ` · ~${fmtS(c.snow)}` : isNum(c.precipWet) ? ` · ~${fmtP(c.precipWet)}` : "") : "";
  const chips = [];
  if (isNum(c.dayGust)) chips.push(`<span class="chip" title="${esc(t("chipWindTitle"))}">${svg("wind")}<span class="num">${fmtW(c.dayGust)}</span><span style="color:var(--muted)">${dirLabel(c.dir)}</span></span>`);
  if (isNum(c.sun)) chips.push(`<span class="chip">${svg("sunS")}${esc(t("chipSun", { h: fmt(c.sun, c.sun < 1 && c.sun > 0 ? 1 : 0) }))}</span>`);
  if (c.fog) chips.push(`<span class="chip fogc" title="${esc(t("fogTitle"))}">${svg("fog")}${esc(t("chipFog", { h: c.fog.label }))}</span>`);
  if (c.snowy) chips.push(`<span class="chip" style="color:var(--snow)">${svg("flake")}${esc(t("chipSnow", { a: c.snowy, b: c.n }))}</span>`);
  if (c.isToday && isNum(c.earlier) && c.earlier >= state.thr) chips.push(`<span class="chip" style="color:var(--rain)" title="${esc(t("earlierTitle"))}">${svg("drops")}${esc(t("earlierToday", { v: fmtP(c.earlier) }))}</span>`);
  if (c.ensProb != null) chips.push(`<span class="chip" title="${esc(t("chipEnsTitle", { n: c.ensN }))}">${svg("drops")}${esc(t("chipEns", { p: Math.round(c.ensProb * 100) }))}</span>`);
  if (isNum(c.soil0) && c.soil0 <= 2) {
    const frozen = c.soil0 < 0;
    chips.push(`<span class="chip" style="color:var(${frozen ? "--snow" : "--muted"})" title="${esc(t("chipSoilTitle"))}">${svg("flake")}${esc(t(frozen ? "chipSoilFrost" : "chipSoil", { t: fmtT(c.soil0) }))}</span>`);
  }
  const J = judgeWorks(c);
  activeWorks().forEach(w => { const j = J[w]; if (j && j.level !== "na") chips.push(`<span class="chip flag ${j.level}" title="${esc(t("w_" + w))}: ${esc(j.reason)}">${esc(t("ws_" + w))}</span>`); });
  return `<article class="day${L.isToday ? " today" : ""}" data-date="${c.date}" data-open="false">
    <button class="day-head" type="button" aria-expanded="false" aria-controls="det-${c.date}">
      <div class="d-date"><b>${esc(L.big)}</b><span>${esc(L.small)}</span></div>
      <div class="d-glyph">${glyph(c)}</div>
      <div class="d-temp"><span class="tmax">${fmtT(c.tmax)}</span><span class="tmin">${fmtT(c.tmin)}</span></div>
      <div class="d-rain"><div class="votes" aria-hidden="true">${votes}</div>
        <div class="votes-lbl"><b>${esc(rainText(c))}</b><br><span class="num">${esc(t("modelsCount", { wet: c.wet, n: c.n }))}</span>${c.isToday && c.fromHour > 0 ? ` · ${esc(t("fromHour", { h: String(c.fromHour).padStart(2, "0") + ":00" }))}` : ""}${esc(amt)}</div></div>
      ${svg("chev", "chev")}
    </button>
    <div class="d-meta">${chips.join("")}</div>
    <div class="d-detail" id="det-${c.date}" hidden></div>
  </article>`;
}

function summaryHtml(cs, noTitle) {
  const good = [], rain = [], unsure = [], snow = [], wind = [], frost = [], soilFrost = [], fog = [];
  const strong = Math.min(state.limits.macara.gustStop, state.limits.acoperis.gustStop);
  cs.forEach(c => {
    if (!c.n) return;
    const s = dayLabel(c.date).short;
    if (c.snowFrac >= 0.5) snow.push(s);
    else if (c.frac >= 0.5) rain.push(s);
    else if (c.frac >= 0.25) unsure.push(s);
    if (isNum(c.gust) && c.gust >= strong) wind.push(s);
    if (isNum(c.tmin) && c.tmin < 0) frost.push(s);
    if (isNum(c.soil0) && c.soil0 < 0) soilFrost.push(s);
    if (c.fog) fog.push(`${s} ${c.fog.label}`);
    if (c.frac < 0.25 && c.snowFrac < 0.25 && !(isNum(c.gust) && c.gust >= strong)) good.push(s);
  });
  const row = (key, color, arr) => arr.length ? `<div class="sum-row"><div class="k"><i style="background:var(${color})"></i>${esc(t(key))}</div><div class="v">${arr.map(x => `<span class="tag">${esc(x)}</span>`).join("")}</div></div>` : "";
  const html = row("sumDry", "--ok", good) + row("sumRain", "--rain", rain) + row("sumUnsure", "--warn", unsure)
    + row("sumSnow", "--snow", snow) + row("sumWind", "--stop", wind) + row("sumFrostAir", "--snow", frost) + row("sumFrostSoil", "--snow", soilFrost) + row("sumFog", "--muted", fog);
  return html ? `${noTitle ? "" : `<h2>${esc(t("summaryTitle"))}</h2>`}<div>${html}</div>` : "";
}

function plannerHtml(cs) {
  const ws = activeWorks();
  if (!ws.length || !cs.length) return "";
  const Ls = cs.map(c => dayLabel(c.date));
  const head = Ls.map(L => `<th scope="col"${L.isToday ? ' class="today"' : ""}>${esc(L.col[0])}<br>${esc(L.col[1])}</th>`).join("");
  const J = cs.map(judgeWorks);
  const body = ws.map(w => `<tr><th scope="row">${esc(t("ws_" + w))}</th>${cs.map((c, i) => {
    const j = (c.n ? J[i][w] : null) || { level: "na", reason: t("rt_nodata") };
    return `<td><button type="button" class="cell ${j.level}" data-date="${c.date}" aria-label="${esc(t("w_" + w))}, ${esc(Ls[i].big)}: ${esc(lvl(j.level))}. ${esc(j.reason)}" title="${esc(j.reason)}">${LEVEL_SYM[j.level]}</button></td>`;
  }).join("")}</tr>`).join("");
  return `<h2>${esc(t("plannerTitle"))}</h2>
    <div class="pl-wrap"><table class="pl"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="pl-legend"><span><b class="cell ok">✓</b>${esc(lvl("ok"))}</span><span><b class="cell warn">!</b>${esc(lvl("warn"))}</span><span><b class="cell stop">✕</b>${esc(lvl("stop"))}</span><span>${esc(t("legendTap"))}</span></div>`;
}

function drawCurve(root) {
  const grid = root.querySelector(".hgrid"), svgEl = grid && grid.querySelector("svg.curve");
  if (!svgEl) return;
  const g = grid.getBoundingClientRect();
  const pts = [];
  grid.querySelectorAll(".hc").forEach(c => {
    const p = parseFloat(c.dataset.p), bar = c.querySelector(".bar");
    if (!isFinite(p) || !bar) return;
    const r = bar.getBoundingClientRect();
    pts.push([r.left - g.left + r.width / 2, r.bottom - g.top - p * r.height]);
  });
  svgEl.setAttribute("width", Math.ceil(g.width)); svgEl.setAttribute("height", Math.ceil(g.height));
  svgEl.setAttribute("viewBox", `0 0 ${Math.ceil(g.width)} ${Math.ceil(g.height)}`);
  if (pts.length < 2) { svgEl.innerHTML = ""; return; }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    const lo = Math.max(p1[1], p2[1]), hi = Math.min(p1[1], p2[1]);   // fără depășiri în afara celor două puncte
    c1[1] = Math.min(lo, Math.max(hi, c1[1])); c2[1] = Math.min(lo, Math.max(hi, c2[1]));
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  svgEl.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function toggle(el, forceOpen) {
  const det = el.querySelector(".d-detail");
  const open = forceOpen || el.dataset.open !== "true";
  document.querySelectorAll('.day[data-open="true"]').forEach(o => {
    if (o !== el) { o.dataset.open = "false"; o.querySelector(".d-detail").hidden = true; o.querySelector(".day-head").setAttribute("aria-expanded", "false"); }
  });
  el.dataset.open = String(open); det.hidden = !open;
  el.querySelector(".day-head").setAttribute("aria-expanded", String(open));
  state.open = open ? el.dataset.date : null;
  if (open) {
    det.innerHTML = detailHtml(el.dataset.date);
    const hs = det.querySelector(".hours");
    const first = hs && (hs.querySelector(".hc.now") || hs.querySelectorAll(".hc")[6]);
    if (first) hs.scrollLeft = Math.max(0, first.offsetLeft - hs.offsetLeft - 8);
    drawCurve(det);
  }
}

function detailHtml(date) {
  const c = consensus(date), J = judgeWorks(c);
  const works = activeWorks().map(w => {
    const j = J[w] || { level: "na", reason: "" };
    return `<li><span class="cell ${j.level}" aria-hidden="true">${LEVEL_SYM[j.level]}</span><span><b>${esc(t("w_" + w))}</b> · ${esc(lvl(j.level))}<br><small>${esc(j.reason)}</small></span></li>`;
  }).join("");
  const soil = (isNum(c.soil0) || isNum(c.soil6))
    ? `<div class="soil-line">${svg("flake")}<span>${esc(t("soilLine", { a: fmtT(c.soil0), b: fmtT(c.soil6) }))}${isNum(c.soil0) && c.soil0 < 0 ? esc(t("soilFrost")) : ""}</span></div>` : "";
  const isToday = date === todayStr();
  const nowH = new Date(Date.now() + state.offset * 1000).getUTCHours();
  const fogH = fogByHour(date);
  const hrs = hourly(date).map(b => {
    const fz = fogH[b.h] && fogH[b.h].n && fogH[b.h].frac >= FOG_FRAC;
    const hh = String(b.h).padStart(2, "0");
    const cls = `hc${isToday && nowH === b.h ? " now" : ""}${isToday && b.h < nowH ? " past" : ""}${b.n ? "" : " na"}`;
    if (!b.n) return `<div class="${cls}" data-p=""><span class="h">${hh}</span><span class="bar"></span><span class="t">–</span><span class="g">–</span></div>`;
    return `<div class="${cls}" data-p="${b.chance.toFixed(3)}" title="${hh}:00–${String((b.h + 1) % 24).padStart(2, "0")}:00 · ${esc(t("hourTip", { wet: b.wet, drz: b.drz, n: b.n }))}"><span class="h">${hh}</span>
      <span class="bar"><span class="dz" style="height:${Math.round((b.frac + b.dfrac) * 100)}%"></span><span class="${b.snow * 2 >= b.wet && b.snow ? "s" : ""}" style="height:${Math.round(b.frac * 100)}%"></span></span>
      <span class="t">${fmtT(b.t)}</span><span class="g">${isNum(b.g) ? fmt(toUser.wind(b.g)) : "–"}</span><span class="fz${fz ? " on" : ""}" title="${fz ? esc(t("fogTip", { f: fogH[b.h].f, n: fogH[b.h].n })) : ""}">${fz ? "≋" : ""}</span></div>`;
  }).join("");
  const thr = state.thr;
  const rows = state.results.map(r => {
    const d = r.days[date]; if (!d) return "";
    const wet = d.ok && d.precip >= thr;
    return `<tr><td>${esc(r.model.name)} <small>${esc(r.model.org)}</small></td>
      <td>${fmtT(d.tmin)} / ${fmtT(d.tmax)}</td>
      <td class="${wet ? "wet" : ""}">${d.ok ? fmtPn(d.precip) : "–"}</td>
      <td>${d.ok && isNum(d.snow) ? fmt(toUser.snow(d.snow), 1) : "–"}</td>
      <td>${isNum(d.gust) ? fmt(toUser.wind(d.gust)) : "–"}</td>
      <td>${isNum(d.sun) ? fmt(d.sun, 1) : "–"}</td></tr>`;
  }).join("");
  return `${works ? `<div class="section-h">${esc(t("worksTitle"))}</div><ul class="works">${works}</ul>` : ""}
    ${soil}
    <div class="section-h">${esc(t("hourlyTitle"))}</div>
    <div class="hours"><div class="hgrid">${hrs}<svg class="curve" aria-hidden="true"></svg></div></div>
    <div class="legend">${esc(t("hourlyLegend", { u: unitLabel.wind() }))} ${esc(t("drizzleLegend", { a: fmtPn(DRIZZLE), b: fmtPn(WET_HOUR), u: unitLabel.precip() }))} ${esc(t("fogLegend"))} ${esc(t("curveLegend"))}</div>
    <div class="section-h">${esc(t("modelsTitle"))}</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>${esc(t("th_model"))}</th><th>${esc(t("th_minmax"))}</th><th>${esc(t("th_rain", { u: unitLabel.precip() }))}</th><th>${esc(t("th_snow", { u: unitLabel.snow() }))}</th><th>${esc(t("th_gust", { u: unitLabel.wind() }))}</th><th>${esc(t("th_sun"))}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function renderModels() {
  $("#modelList").innerHTML = MODELS.map(m => {
    const s = state.status[m.id];
    return `<span class="${s === "off" ? "off" : ""}" title="${esc(m.org)}">${esc(m.name)}</span>`;
  }).join("");
}

/* ---------- textele fixe și setările ---------- */
function applyStatic() {
  document.documentElement.lang = state.lang;
  document.title = t("brand");
  const at = document.querySelector('meta[name="apple-mobile-web-app-title"]'); if (at) at.content = t("brand");
  const mf = document.querySelector('link[rel="manifest"]'); if (mf) mf.href = `manifest-${state.lang}.json`;
  const md = document.querySelector('meta[name="description"]'); if (md) md.content = t("tagline");
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  $("#q").placeholder = t("searchPh");
  $("#days").setAttribute("aria-label", t("tagline"));
  if (state.loc) $("#placeName").textContent = state.loc.name || t("myLocation");
}

function renderSettings() {
  const sel = (id, opts, cur) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const thrOpts = [[0.5, "thrAny"], [1, "thrReal"], [1.5, ""], [2, ""], [3, "thrHeavy"]].map(([v, k]) => [v, k ? `${fmtP(v)} · ${t(k)}` : fmtP(v)]);
  const limits = WORK_IDS.map(w => `<fieldset><legend>${esc(t("w_" + w))}</legend>${LIMITS[w].map(x => {
    const v = toUser[x.u](state.limits[w][x.k]);
    const dec = x.u === "precip" && state.units.precip === "in" ? 1 : 0;
    const step = dec ? "0.1" : "1";
    return `<label for="lim-${w}-${x.k}"><span>${esc(t(limitLabelKey(w, x.k)))}</span><span class="lim-in"><input type="number" inputmode="decimal" step="${step}" id="lim-${w}-${x.k}" data-w="${w}" data-k="${x.k}" data-u="${x.u}" value="${Number(v.toFixed(dec))}"><i>${esc(unitLabel[x.u]())}</i></span></label>`;
  }).join("")}</fieldset>`).join("");
  $("#settings").innerHTML = `
    <details class="set-box" id="setBox"${state.setOpen ? " open" : ""}>
    <summary>${esc(t("settingsTitle"))}</summary>
    <div class="set-grid">
      <label>${esc(t("setLang"))}${sel("setLang", [["auto", `${t("langAuto")} · ${(LANGS.find(x => x[0] === detectLang()) || LANGS[0])[1]}`]].concat(LANGS), state.langChoice || "auto")}</label>
      <label>${esc(t("setTemp"))}${sel("setTemp", [["C", "°C"], ["F", "°F"]], state.units.temp)}</label>
      <label>${esc(t("setWind"))}${sel("setWind", [["kmh", "km/h"], ["ms", "m/s"], ["mph", "mph"]], state.units.wind)}</label>
      <label>${esc(t("setPrecip"))}${sel("setPrecip", [["mm", "mm · cm"], ["in", "in"]], state.units.precip)}</label>
      <label class="wide">${esc(t("setRainThr"))}${sel("thr", thrOpts, state.thr)}</label>
    </div>
    <h2 class="section-h">${esc(t("worksFollowed"))}</h2>
    <div class="work-pick">${WORK_IDS.map(w => `<label><input type="checkbox" id="wk-${w}" value="${w}"${state.works.includes(w) ? " checked" : ""}>${esc(t("w_" + w))}</label>`).join("")}</div>
    <details class="limits" id="limitsBox"${state.limitsOpen ? " open" : ""}>
      <summary>${esc(t("limitsTitle"))}</summary>
      <p>${esc(t("limitsNote"))}</p>
      <div class="lim-grid">${limits}</div>
      <button type="button" class="reset" id="resetLimits">${esc(t("resetLimits"))}</button>
    </details>
    </details>
    <h2 class="section-h">${esc(t("modelsUsed"))}</h2>
    <div class="models" id="modelList"></div>
    <p>${esc(t("helpVotes"))}</p>
    <p>${esc(t("disclaimer"))}</p>
    <p>${t("credit", { link: '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>' })}</p>`;
  renderModels();
  const rerender = () => { renderSettings(); renderNow(); if (state.results.length) render(); };
  $("#setLang").onchange = e => {
    const v = e.target.value;
    state.langChoice = v === "auto" ? null : v;
    if (state.langChoice) store.set("ms.lang", state.langChoice); else store.del("ms.lang");
    state.lang = state.langChoice || detectLang();
    track(`lang-set/${v}`, `Language chosen: ${v}`, true); applyStatic(); renderUpdated(); if (state.results.length) finishLoad(); rerender(); };
  $("#setTemp").onchange = e => { state.userUnits.temp = e.target.value; store.set("ms.units", state.userUnits); applyUnits(); rerender(); };
  $("#setWind").onchange = e => { state.userUnits.wind = e.target.value; store.set("ms.units", state.userUnits); applyUnits(); rerender(); };
  $("#setPrecip").onchange = e => { state.userUnits.precip = e.target.value; store.set("ms.units", state.userUnits); applyUnits(); rerender(); };
  $("#thr").onchange = e => { state.thr = Number(e.target.value); store.set("ms.thr", state.thr); if (state.results.length) render(); };
  WORK_IDS.forEach(w => { $(`#wk-${w}`).onchange = () => {
    state.works = WORK_IDS.filter(id => $(`#wk-${id}`).checked);
    store.set("ms.works", state.works);
    if (state.results.length) render();
  }; });
  $("#limitsBox").addEventListener("toggle", e => { state.limitsOpen = e.target.open; });
  $("#setBox").addEventListener("toggle", e => { state.setOpen = e.target.open; });
  document.querySelectorAll(".lim-grid input").forEach(i => i.onchange = () => {
    const v = parseFloat(String(i.value).replace(",", "."));
    if (!isFinite(v)) { renderSettings(); return; }
    state.limits[i.dataset.w][i.dataset.k] = fromUser[i.dataset.u](v);
    store.set("ms.limits", state.limits);
    if (state.results.length) render();
  });
  $("#resetLimits").onclick = () => { state.limits = defaultLimits(); store.del("ms.limits"); rerender(); toast(t("toastReset")); };
}

/* ---------- locație ---------- */
function setLoc(loc, opts = {}) {
  state.loc = { lat: +loc.lat, lon: +loc.lon, name: loc.name || null, cc: loc.cc || null };
  setCountry(state.loc.cc, true);
  $("#placeName").textContent = state.loc.name || t("myLocation");
  $("#placeCoords").textContent = `${state.loc.lat.toFixed(4)}, ${state.loc.lon.toFixed(4)}`;
  store.set("ms.last", state.loc);
  renderSaved();
  if (!opts.noLoad) load();
}

// Țara locului schimbă unitățile implicite; redesenăm doar dacă s-au schimbat.
function setCountry(cc, quiet) {
  if (!state.loc) return;
  state.loc.cc = cc ? String(cc).toUpperCase() : state.loc.cc;
  const before = JSON.stringify(state.units);
  applyUnits();
  if (!quiet && JSON.stringify(state.units) !== before) { renderSettings(); renderNow(); if (state.results.length) render(); }
}
async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=${state.lang}`);
    const j = await r.json();
    return { name: j.locality || j.city || j.principalSubdivision || null, cc: j.countryCode || null };
  } catch (e) { return { name: null, cc: null }; }
}

function showNoLoc() {
  $("#placeName").textContent = t("noLocTitle");
  $("#placeCoords").textContent = "";
  $("#now").hidden = true;
  $("#status").hidden = true;
  $("#days").innerHTML = "";
  $("#noLoc").hidden = false;
}

// Locația curentă a telefonului. La pornire, fără locație: ultimul loc folosit sau ecranul de căutare.
// La pornire, dacă există un loc folosit anterior, îl arătăm imediat și căutăm locația exactă în fundal.
function locateMe(atStartup) {
  const last = atStartup ? store.get("ms.last", null) : null;
  const hasLast = !!(last && isFinite(last.lat));
  const coordsText = () => state.loc ? `${state.loc.lat.toFixed(4)}, ${state.loc.lon.toFixed(4)}` : "";
  if (hasLast) { state.mode = "manual"; setLoc(last); $("#placeCoords").textContent = t("locating"); }
  else { $("#placeName").textContent = t("locating"); $("#placeCoords").textContent = ""; }
  const startLoc = state.loc;
  const fail = async () => {
    if (state.loc !== startLoc) return;          // utilizatorul a ales între timp alt loc
    if (atStartup) {
      if (hasLast) { $("#placeCoords").textContent = coordsText(); return; }
      const ip = await ipLocation();
      if (state.loc !== startLoc) return;
      if (ip) { state.mode = "manual"; setLoc(ip); toast(t("toastApprox")); track("loc/approx", "Location: approximate", true); }
      else { showNoLoc(); track("loc/none", "Location: none", true); }
    } else {
      $("#placeName").textContent = state.loc ? (state.loc.name || t("myLocation")) : t("noLocTitle");
      $("#placeCoords").textContent = coordsText();
      toast(t("toastNoLoc"));
    }
  };
  getPosition().then(async pos => {
    if (state.loc !== startLoc) return;
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    state.mode = "gps";
    track("loc/gps", "Location: GPS", true);
    if (hasLast && near(state.loc, { lat, lon })) {
      // același loc ca data trecută: păstrăm prognoza afișată, actualizăm doar coordonatele
      state.loc.lat = lat; state.loc.lon = lon; store.set("ms.last", state.loc);
      $("#placeCoords").textContent = coordsText();
      if (!state.loc.cc) reverseName(lat, lon).then(rv => { if (rv.cc && state.loc && state.loc.lat === lat) { setCountry(rv.cc); store.set("ms.last", state.loc); } });
      return;
    }
    setLoc({ lat, lon, name: null });
    const rv = await reverseName(lat, lon);
    if (state.loc && state.loc.lat === lat) {
      if (rv.name) { state.loc.name = rv.name; $("#placeName").textContent = rv.name; }
      if (rv.cc) setCountry(rv.cc);
      store.set("ms.last", state.loc);
    }
  }, fail);
}

/* În aplicația Android/iOS folosim pluginurile native; în browser, API-urile web. */
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* ---------- statistici anonime (GoatCounter: fără cookie-uri, fără date personale, fără coordonate) ---------- */
const PLATFORM = NATIVE ? ((window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || "app") : "web";
const sentEvents = new Set();
function track(path, title, isEvent) {
  if (isEvent && sentEvents.has(path)) return;   // fiecare eveniment o singură dată pe deschidere
  if (isEvent) sentEvents.add(path);
  let tries = 0;
  const go = () => {
    const gc = window.goatcounter;
    if (gc && gc.count) { try { gc.count({ path, title: title || path, event: !!isEvent }); } catch (e) {} return; }
    if (++tries < 50) setTimeout(go, 200);   // scriptul se încarcă asincron; renunțăm după 10 s
  };
  go();
}
const plugin = name => (NATIVE && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
const PUBLIC_URL = "https://vitalicmalachi-ops.github.io/meteo-santier/";
// Locație aproximativă după conexiune (orașul), când telefonul nu dă GPS și nu există un loc folosit anterior.
async function ipLocation() {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=${state.lang}`);
    const j = await r.json();
    if (!isNum(j.latitude) || !isNum(j.longitude) || (j.latitude === 0 && j.longitude === 0)) return null;
    return { lat: j.latitude, lon: j.longitude, name: j.city || j.locality || j.principalSubdivision || null, cc: j.countryCode || null };
  } catch (e) { return null; }
}
async function getPosition() {
  const opts = { enableHighAccuracy: false, timeout: 25000, maximumAge: 300000 };
  const G = plugin("Geolocation");
  if (G) {
    const perm = await G.checkPermissions().catch(() => null);
    if (!perm || perm.coarseLocation !== "granted") {
      const r = await G.requestPermissions({ permissions: ["coarseLocation"] }).catch(() => null);
      if (!r || r.coarseLocation !== "granted") throw new Error("denied");
    }
    // Pluginul folosește serviciile Google; dacă ele nu răspund, încercăm localizarea standard a sistemului.
    try { return await G.getCurrentPosition(opts); } catch (e) { return webPosition(Object.assign({}, opts, { timeout: 15000 })); }
  }
  return webPosition(opts);
}
function webPosition(opts) {
  if (!navigator.geolocation) return Promise.reject(new Error("unsupported"));
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, opts));
}

let searchT = null;
function openSearch() {
  const bx = $("#searchBox"); bx.hidden = false;
  $("#btnSearch").setAttribute("aria-expanded", "true");
  $("#q").focus();
}
async function doSearch(q) {
  const box = $("#results");
  if (q.trim().length < 2) { box.innerHTML = ""; return; }
  try {
    const j = await fetchJson(`${GEO_API}?name=${encodeURIComponent(q.trim())}&count=8&language=${state.lang}&format=json`);
    const list = j.results || [];
    box.innerHTML = list.length ? list.map((r, i) => `<button type="button" data-i="${i}">${esc(r.name)} <small>${esc([r.admin1, r.country].filter(Boolean).join(", "))}</small></button>`).join("")
      : `<div class="note">${esc(t("noResults"))}</div>`;
    box.querySelectorAll("button").forEach(b => b.onclick = () => {
      const r = list[+b.dataset.i];
      state.mode = "manual";
      setLoc({ lat: r.latitude, lon: r.longitude, name: r.name, cc: r.country_code || null });
      $("#searchBox").hidden = true; $("#btnSearch").setAttribute("aria-expanded", "false"); $("#q").value = ""; box.innerHTML = "";
    });
  } catch (e) { box.innerHTML = `<div class="note">${esc(t("searchFail"))}</div>`; }
}

function shareUrl() {
  if (NATIVE) return PUBLIC_URL;
  const u = new URL(location.href.split("#")[0]); u.search = ""; return u.toString();
}

function renderSaved() {
  const list = store.get("ms.saved", []);
  $("#saved").innerHTML = list.map((s, i) => {
    const cur = state.loc && Math.abs(s.lat - state.loc.lat) < 1e-3 && Math.abs(s.lon - state.loc.lon) < 1e-3;
    return `<button type="button" data-i="${i}" aria-current="${cur}">${esc(s.name)}</button>`;
  }).join("");
  $("#saved").querySelectorAll("button").forEach(b => b.onclick = () => { state.mode = "manual"; setLoc(list[+b.dataset.i]); });
}

let toastT = null;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------- pornire ---------- */
/* ---------- actualizare automată ----------
   Telefonul poate păstra fișierele vechi în cache. La pornire și la revenirea în aplicație citim version.json
   fără cache; dacă versiunea publicată e alta decât cea rulată, reîncărcăm pagina cu o adresă nouă (ocolește cache-ul). */
const APP_VERSION = "20261022-130855";
async function checkVersion() {
  if (NATIVE || location.protocol === "file:") return;   // aplicația Android are fișierele în pachet; se actualizează prin magazin
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    const j = await r.json();
    if (!j.v || j.v === APP_VERSION) return;
    let tried = null; try { tried = sessionStorage.getItem("ms.reloadFor"); } catch (e) {}
    if (tried === j.v) return;                            // o singură încercare pe versiune, fără bucle
    try { sessionStorage.setItem("ms.reloadFor", j.v); } catch (e) {}
    location.replace(`${location.pathname}?v=${encodeURIComponent(j.v)}`);
  } catch (e) {}
}

function init() {
  checkVersion();
  store.del("ms.cache"); store.del("ms.cache2"); store.del("ms.cache3"); store.del("ms.work"); store.del("ms.limitsOpen");   // date vechi, nu se mai folosesc
  applyStatic();
  renderSettings();
  $("#btnLocate").onclick = () => locateMe(false);
  $("#btnSearch").onclick = () => {
    const bx = $("#searchBox");
    if (bx.hidden) openSearch(); else { bx.hidden = true; $("#btnSearch").setAttribute("aria-expanded", "false"); }
  };
  $("#noLocBtn").onclick = openSearch;
  $("#q").addEventListener("input", e => { clearTimeout(searchT); searchT = setTimeout(() => doSearch(e.target.value), 350); });
  $("#btnShare").onclick = () => {
    const url = shareUrl();
    const S = plugin("Share");
    if (S) { S.share({ title: t("brand"), text: t("tagline"), url }).catch(() => {}); return; }
    const fb = () => { const n = $("#shareFallback"); n.hidden = false; n.innerHTML = `${esc(t("copyManual"))} <input readonly value="${esc(url)}">`; const i = n.querySelector("input"); i.focus(); i.select(); };
    try { navigator.clipboard.writeText(url).then(() => toast(t("toastCopied")), fb); } catch (e) { fb(); }
  };
  $("#btnSave").onclick = () => {
    if (!state.loc) return;
    const list = store.get("ms.saved", []);
    if (list.some(s => Math.abs(s.lat - state.loc.lat) < 1e-3 && Math.abs(s.lon - state.loc.lon) < 1e-3)) { toast(t("toastAlreadySaved")); return; }
    const name = state.loc.name || t("placeN", { n: list.length + 1 });
    list.push({ lat: state.loc.lat, lon: state.loc.lon, name, cc: state.loc.cc || null });
    store.set("ms.saved", list.slice(-8)); renderSaved(); toast(t("toastSaved", { name }));
  };

  // Oricine deschide aplicația (și din link) vede vremea de unde se află.
  // Coordonatele dintr-un link vechi servesc doar ca rezervă dacă telefonul nu dă locația.
  const p = new URLSearchParams(location.search);
  const lat = parseFloat(p.get("lat")), lon = parseFloat(p.get("lon"));
  if (isFinite(lat) && isFinite(lon)) store.set("ms.last", { lat, lon, name: p.get("n") || null });
  if (location.search) history.replaceState(null, "", location.pathname);
  track("/" + PLATFORM, `${t("brand")} · ${PLATFORM}`);
  track(`lang/${state.lang}`, `Language: ${state.lang}`, true);
  locateMe(true);

  // Aplicația de pe ecranul principal rămâne deschisă în fundal: la revenire după 15 min reîmprospătăm.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    checkVersion();
    if (hiddenAt && Date.now() - hiddenAt > 15 * 60 * 1000) {
      if (state.mode === "gps") locateMe(false); else if (state.loc) load(true);
    }
  });
  setInterval(() => { if (document.visibilityState === "visible" && state.loc) load(true); }, CACHE_MIN * 60 * 1000);
}

if (typeof window !== "undefined" && window.document && !window.__TEST__) init();
