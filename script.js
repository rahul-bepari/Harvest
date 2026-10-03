/* =====================================================================
   HARVEST — script.js
   Single JS file, organized into the sections requested in the spec:
   db · crop-calendar · plot-tracker · expense-yield · price-tracking ·
   weather-check · pwa, plus a small nav/UI-helper layer and a bootstrap
   at the bottom that wires everything together on load.
   No frameworks — plain DOM APIs throughout.
   ===================================================================== */

"use strict";

/* ============================== SECTION: db ==============================
   Thin promise-based wrapper around IndexedDB. One database, five object
   stores. Everything the app needs — plots, crop cycles (which carry both
   the planting/harvest dates AND the cost/yield numbers once harvested),
   price logs, price alerts, and misc settings — lives here so the whole
   app works fully offline. Indexes are declared up front so trend/­market
   queries (by crop, by date, by status) don't need full-table scans.
   ========================================================================= */
const DB_NAME = "harvestDB";
const DB_VERSION = 1;
let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains("plots")) {
        db.createObjectStore("plots", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("cycles")) {
        const cycles = db.createObjectStore("cycles", { keyPath: "id" });
        cycles.createIndex("byPlotId", "plotId", { unique: false });
        cycles.createIndex("byCropId", "cropId", { unique: false });
        cycles.createIndex("byStatus", "status", { unique: false });
        // date-indexed for countdown / reminder scans without a full scan
        cycles.createIndex("byExpectedHarvest", "expectedHarvestDate", { unique: false });
      }

      if (!db.objectStoreNames.contains("priceLogs")) {
        const prices = db.createObjectStore("priceLogs", { keyPath: "id" });
        prices.createIndex("byCropId", "cropId", { unique: false });
        prices.createIndex("byDate", "date", { unique: false });
        // compound index: lets the trend chart pull one crop's history,
        // already ordered by date, in a single cursor pass
        prices.createIndex("byCropDate", ["cropId", "date"], { unique: false });
      }

      if (!db.objectStoreNames.contains("priceAlerts")) {
        const alerts = db.createObjectStore("priceAlerts", { keyPath: "id" });
        alerts.createIndex("byCropId", "cropId", { unique: false });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode = "readonly") {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function dbPut(storeName, value) {
  return tx(storeName, "readwrite").then((store) => new Promise((res, rej) => {
    const r = store.put(value);
    r.onsuccess = () => res(value);
    r.onerror = () => rej(r.error);
  }));
}

function dbGetAll(storeName) {
  return tx(storeName).then((store) => new Promise((res, rej) => {
    const r = store.getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

function dbGetAllByIndex(storeName, indexName, query) {
  return tx(storeName).then((store) => new Promise((res, rej) => {
    const r = store.index(indexName).getAll(query);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

function dbDelete(storeName, id) {
  return tx(storeName, "readwrite").then((store) => new Promise((res, rej) => {
    const r = store.delete(id);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  }));
}

function dbGetSetting(key, fallback) {
  return tx("settings").then((store) => new Promise((res) => {
    const r = store.get(key);
    r.onsuccess = () => res(r.result ? r.result.value : fallback);
    r.onerror = () => res(fallback);
  }));
}
function dbSetSetting(key, value) { return dbPut("settings", { key, value }); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const months = ["জানু","ফেব্রু","মার্চ","এপ্রিল","মে","জুন","জুলাই","আগস্ট","সেপ্টে","অক্টো","নভে","ডিসে"];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}
function bnNum(n) {
  const digits = ["০","১","২","৩","৪","৫","৬","৭","৮","৯"];
  return String(Math.round(n)).replace(/[0-9]/g, (d) => digits[d]);
}
function taka(n) { return "৳" + bnNum(n); }


/* ======================== SECTION: crop-calendar =========================
   Loads the bundled data/crops.json, renders the hand-drawn SVG season
   wheel, and works out — purely from today's date — which crops are
   plantable right now vs. coming up soon. All the calendar date math
   (angle-per-month, wrap-around planting windows like Nov→Feb, "days
   until the window opens") lives in this section.
   ========================================================================= */
let CROPS = [];
let CROPS_BY_ID = {};

async function loadCrops() {
  const res = await fetch("data/crops.json");
  const json = await res.json();
  CROPS = json.crops;
  CROPS_BY_ID = Object.fromEntries(CROPS.map((c) => [c.id, c]));
}

// ---- hand-drawn crop icons -------------------------------------------------
// Each entry returns the *inner* markup of a 64x64 viewBox SVG for one
// icon key. Kept as simple flat shapes (not photographic) on purpose: at
// a glance, on a cracked low-res screen, a bold silhouette reads faster
// than a detailed illustration — which is the whole point of an
// icon-first UI for a mixed-literacy audience.
const CROP_ICONS = {
  rice: (c) => `<path d="M32 54V28" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M32 30c-2-10-10-14-16-14 2 8 8 14 16 14z" fill="${c}"/>
    <path d="M32 26c2-10 10-14 16-14-2 8-8 14-16 14z" fill="${c}"/>
    <path d="M32 20c-1-8-7-12-12-13 2 7 6 12 12 13z" fill="${c}" opacity=".8"/>
    <path d="M32 16c1-8 7-12 12-13-2 7-6 12-12 13z" fill="${c}" opacity=".8"/>`,
  wheat: (c) => `<path d="M32 54V16" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/>
    ${[20,26,32,38,44].map(y=>`<ellipse cx="26" cy="${y}" rx="5" ry="3" fill="${c}" transform="rotate(-25 26 ${y})"/><ellipse cx="38" cy="${y}" rx="5" ry="3" fill="${c}" transform="rotate(25 38 ${y})"/>`).join("")}`,
  maize: (c) => `<rect x="24" y="14" width="16" height="38" rx="8" fill="${c}"/>
    ${[0,1,2,3,4,5,6].map(i=>`<line x1="24" y1="${18+i*5.5}" x2="40" y2="${18+i*5.5}" stroke="#fff" stroke-width="1.4" opacity=".55"/>`).join("")}
    <path d="M24 20c-8-2-12 2-14 8 8 2 12-2 14-8z" fill="#5B8C3E"/>
    <path d="M40 20c8-2 12 2 14 8-8 2-12-2-14-8z" fill="#5B8C3E"/>`,
  potato: (c) => `<path d="M14 36c-2-10 8-18 18-18s20 6 18 18-10 16-18 16-16-6-18-16z" fill="${c}"/>
    <circle cx="24" cy="30" r="2" fill="#fff" opacity=".6"/><circle cx="36" cy="36" r="2" fill="#fff" opacity=".6"/><circle cx="30" cy="24" r="1.6" fill="#fff" opacity=".6"/>`,
  tomato: (c) => `<circle cx="32" cy="36" r="18" fill="${c}"/>
    <path d="M32 18c-4 0-6 4-6 4s3-1 6-1 6 1 6 1-2-4-6-4z" fill="#4C7A3D"/>
    <ellipse cx="26" cy="30" rx="4" ry="6" fill="#fff" opacity=".25"/>`,
  brinjal: (c) => `<path d="M32 20c10 0 16 10 12 22s-14 12-20 6-2-18 8-28z" fill="${c}"/>
    <path d="M28 18c1-3 3-5 4-5s3 2 4 5c-2-1-6-1-8 0z" fill="#4C7A3D"/>
    <line x1="30" y1="16" x2="30" y2="12" stroke="#4C7A3D" stroke-width="2" stroke-linecap="round"/>`,
  cabbage: (c) => `<circle cx="32" cy="34" r="17" fill="${c}" opacity=".9"/>
    <circle cx="32" cy="34" r="12" fill="none" stroke="#fff" stroke-width="2" opacity=".5"/>
    <circle cx="32" cy="34" r="6" fill="none" stroke="#fff" stroke-width="2" opacity=".5"/>`,
  cauliflower: (c) => `<path d="M20 38c-4 0-6-8 0-10 0-6 8-8 12-4 4-4 12-2 12 4 6 2 4 10 0 10z" fill="#F3F0E4"/>
    ${[24,32,40].map(x=>`<circle cx="${x}" cy="34" r="4" fill="#F3F0E4" stroke="#DAD4BE" stroke-width="1"/>`).join("")}
    <path d="M18 40c2 6 6 10 14 10s12-4 14-10z" fill="${c}"/>`,
  okra: (c) => `<path d="M30 14c10 4 12 24 4 38-8-2-10-24-4-38z" fill="${c}"/>
    ${[20,28,36,44].map(y=>`<line x1="27" y1="${y}" x2="33" y2="${y+2}" stroke="#4C7A3D" stroke-width="1.4"/>`).join("")}
    <path d="M28 14c1-3 2-4 3-4s2 1 3 4c-2-1-4-1-6 0z" fill="#4C7A3D"/>`,
  leafy: (c) => `<path d="M32 54c0-22 2-34 14-38-6 16-4 30-14 38z" fill="${c}"/>
    <path d="M32 54c0-22-2-34-14-38 6 16 4 30 14 38z" fill="${c}" opacity=".85"/>
    <path d="M32 20V52" stroke="#3F5B2A" stroke-width="1.4" opacity=".6"/>`,
  cucumber: (c) => `<rect x="12" y="26" width="40" height="14" rx="7" fill="${c}"/>
    ${[18,26,34,42].map(x=>`<line x1="${x}" y1="27" x2="${x}" y2="39" stroke="#fff" stroke-width="1.2" opacity=".4"/>`).join("")}`,
  pumpkin: (c) => `<ellipse cx="32" cy="36" rx="18" ry="15" fill="${c}"/>
    ${[20,26,32,38,44].map(x=>`<path d="M${x} 21 Q${x} 36 ${x} 51" stroke="#00000022" stroke-width="1.6" fill="none"/>`).join("")}
    <rect x="29" y="14" width="6" height="8" rx="2" fill="#5B8C3E"/>`,
  gourd: (c) => `<path d="M26 14c-10 6-14 22-6 34 6 8 16 8 18-2 4-16-2-28-12-32z" fill="${c}"/>
    ${[[24,24],[30,32],[22,38],[32,44]].map(([x,y])=>`<circle cx="${x}" cy="${y}" r="1.6" fill="#3F5B2A"/>`).join("")}`,
  onion: (c) => `<path d="M32 52c-10 0-16-10-14-22 2-10 8-16 14-16s12 6 14 16c2 12-4 22-14 22z" fill="${c}"/>
    <path d="M32 14v-6M28 14c0-4 2-6 4-8M36 14c0-4-2-6-4-8" stroke="#6B4F1D" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
  garlic: (c) => `<path d="M32 50c-9 0-15-7-15-16 0-10 7-16 15-16s15 6 15 16c0 9-6 16-15 16z" fill="${c}"/>
    ${[0,1,2,3,4].map(i=>`<path d="M32 18 L32 46" stroke="#fff" stroke-width="1" opacity=".3" transform="rotate(${i*36} 32 32)"/>`).join("")}
    <path d="M32 18v-8" stroke="#8A7A4E" stroke-width="2" stroke-linecap="round"/>`,
  chili: (c) => `<path d="M18 20c16-4 34 6 34 20 0 8-6 12-12 10-10-3-8-16-22-18-4-6-4-10 0-12z" fill="${c}"/>
    <path d="M18 20c-2-3-2-6 0-8" stroke="#4C7A3D" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  pulse: (c) => `<path d="M12 34c0-10 10-18 20-18s20 8 20 18-10 14-20 14-20-4-20-14z" fill="${c}"/>
    ${[22,32,42].map(x=>`<circle cx="${x}" cy="34" r="4.5" fill="#00000022"/>`).join("")}`,
  mustard: (c) => `<line x1="32" y1="52" x2="32" y2="26" stroke="#5B8C3E" stroke-width="2.4"/>
    ${[0,1,2,3].map(i=>`<ellipse cx="32" cy="22" rx="5" ry="8" fill="${c}" transform="rotate(${i*90} 32 22)"/>`).join("")}
    <circle cx="32" cy="22" r="3" fill="#8A5A00"/>`,
  jute: (c) => `<line x1="32" y1="54" x2="32" y2="12" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
    ${[20,28,36,44].map((y,i)=>`<path d="M32 ${y} q${i%2?8:-8} -4 ${i%2?14:-14} 2" stroke="#4C7A3D" stroke-width="2" fill="none" stroke-linecap="round"/>`).join("")}`,
};
function cropIconSVG(crop, size = 44) {
  const inner = (CROP_ICONS[crop.icon] || CROP_ICONS.leafy)(crop.color);
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${inner}</svg>`;
}

// ---- date math --------------------------------------------------------
// All month arithmetic below treats months as 1-12 and wraps around the
// December→January boundary with `((m - 1 + 12) % 12) + 1`, since several
// real Bangladesh crop windows straddle the new year (e.g. Boro rice is
// planted Dec-Jan).
function currentMonth(d = new Date()) { return d.getMonth() + 1; }

function isPlantableNow(crop, d = new Date()) {
  return crop.planting_months.includes(currentMonth(d));
}

// Days from `d` until the *next* time one of crop.planting_months begins
// (returns 0 if already plantable now).
function daysUntilPlantable(crop, d = new Date()) {
  if (isPlantableNow(crop, d)) return 0;
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let best = Infinity;
  for (const m of crop.planting_months) {
    // the 1st of month `m` this year if it's still ahead of us, otherwise
    // the 1st of month `m` next year (handles windows that wrap Dec->Jan)
    const candidate = new Date(d.getFullYear() + (m <= currentMonth(d) ? 1 : 0), m - 1, 1);
    const diff = Math.round((candidate - today) / 86400000);
    if (diff >= 0 && diff < best) best = diff;
  }
  return best === Infinity ? null : best;
}

// Groups a crop's (possibly non-contiguous, possibly wrap-around) list of
// planting months into contiguous runs, e.g. [10,11,1,2] -> [[10,11],[1,2]].
// Used to draw one continuous wedge per run on the season wheel instead of
// one wedge per month.
function monthsToRuns(months) {
  const sorted = [...new Set(months)].sort((a, b) => a - b);
  const runs = [];
  let run = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === run[run.length - 1] + 1) run.push(sorted[i]);
    else { runs.push(run); run = [sorted[i]]; }
  }
  runs.push(run);
  // merge last run into first if they wrap across Dec(12)->Jan(1)
  if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][runs[runs.length - 1].length - 1] === 12) {
    const wrapped = runs.pop();
    runs[0] = [...wrapped, ...runs[0]];
  }
  return runs;
}

// ---- SVG season wheel --------------------------------------------------
// The wheel maps the 12 calendar months to 360 degrees, starting at the
// top (12 o'clock = mid-January) and moving clockwise, so "today" always
// points roughly upward-ish and the whole year reads like a clock face.
function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function monthAngle(month, dayFrac = 0) {
  // month 1..12 -> 0..360, each month = 30deg, dayFrac (0-1) moves within it
  return ((month - 1) + dayFrac) * 30;
}
function arcPath(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const large = (a1 - a0) % 360 > 180 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`;
}
function bandPath(cx, cy, rOuter, rInner, a0, a1) {
  const o0 = polar(cx, cy, rOuter, a0), o1 = polar(cx, cy, rOuter, a1);
  const i0 = polar(cx, cy, rInner, a0), i1 = polar(cx, cy, rInner, a1);
  const large = (a1 - a0) % 360 > 180 ? 1 : 0;
  return `M ${o0.x} ${o0.y} A ${rOuter} ${rOuter} 0 ${large} 1 ${o1.x} ${o1.y} L ${i1.x} ${i1.y} A ${rInner} ${rInner} 0 ${large} 0 ${i0.x} ${i0.y} Z`;
}

function renderSeasonWheel() {
  const cx = 210, cy = 210;
  const monthLabels = ["জানু","ফেব্রু","মার্চ","এপ্রিল","মে","জুন","জুলাই","আগস্ট","সেপ্টে","অক্টো","নভে","ডিসে"];
  const now = new Date();
  const todayAngle = monthAngle(currentMonth(now), (now.getDate() - 1) / 30);

  let svg = `<svg viewBox="0 0 420 420" role="img" aria-label="মৌসুম চাকা">`;

  // month background wedges, alternating shade
  for (let m = 1; m <= 12; m++) {
    const a0 = monthAngle(m), a1 = monthAngle(m + 1);
    svg += `<path d="${bandPath(cx, cy, 195, 150, a0, a1)}" fill="${m % 2 ? "#F1EEE1" : "#E9E4D0"}"/>`;
    const lp = polar(cx, cy, 172, (a0 + a1) / 2);
    svg += `<text x="${lp.x}" y="${lp.y}" font-size="11" fill="#7A5A3A" text-anchor="middle" dominant-baseline="middle">${monthLabels[m - 1]}</text>`;
  }

  // signature element: the three rice-season bands (Boro/Aman/Aus) drawn as
  // the innermost, boldest rings — rice is the crop this wheel is really
  // built around, everything else orbits it
  const riceCrops = CROPS.filter((c) => c.category === "rice");
  riceCrops.forEach((crop, i) => {
    const rOuter = 148 - i * 30, rInner = rOuter - 24;
    monthsToRuns(crop.planting_months).forEach((run) => {
      const a0 = monthAngle(run[0]);
      const a1 = monthAngle(run[run.length - 1] + 1);
      svg += `<path d="${bandPath(cx, cy, rOuter, rInner, a0, a1)}" fill="${crop.color}" opacity=".85"/>`;
    });
  });

  // other crops: one dot per crop positioned at the midpoint of its first
  // planting run, radius/size/opacity encode "plantable now" vs "later"
  const others = CROPS.filter((c) => c.category !== "rice");
  others.forEach((crop) => {
    const run = monthsToRuns(crop.planting_months)[0];
    const mid = (run[0] + (run[run.length - 1] + 1)) / 2;
    const angle = monthAngle(mid);
    const ring = 205;
    const p = polar(cx, cy, ring, angle);
    const now_ = isPlantableNow(crop);
    const size = now_ ? 15 : 10;
    const iconMarkup = (CROP_ICONS[crop.icon] || CROP_ICONS.leafy)(crop.color);
    svg += `<g transform="translate(${p.x - size / 2},${p.y - size / 2})" opacity="${now_ ? 1 : 0.45}">
      <svg x="0" y="0" width="${size}" height="${size}" viewBox="0 0 64 64">${iconMarkup}</svg>
    </g>`;
  });

  // "today" needle
  const needleTip = polar(cx, cy, 200, todayAngle);
  svg += `<line x1="${cx}" y1="${cy}" x2="${needleTip.x}" y2="${needleTip.y}" stroke="#B3261E" stroke-width="2.5" stroke-linecap="round"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="6" fill="#B3261E"/>`;

  // center label
  const monthNow = monthLabels[currentMonth(now) - 1];
  svg += `<circle cx="${cx}" cy="${cy}" r="66" fill="#0F5132"/>`;
  svg += `<text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#fff" font-size="15" font-weight="700">আজ</text>`;
  svg += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#F2A93B" font-size="16" font-weight="800">${monthNow}</text>`;

  svg += `</svg>`;
  document.getElementById("wheelWrap").innerHTML = svg;

  // legend for the three rice bands (the wheel's signature element)
  document.getElementById("categoryLegend").innerHTML = riceCrops.map((c) =>
    `<span class="legend-chip"><span class="legend-dot" style="background:${c.color}"></span>${c.name_bn}</span>`
  ).join("");
}

function renderPlantableGrids() {
  const now = new Date();
  const nowList = CROPS.filter((c) => isPlantableNow(c, now));
  const soonList = CROPS.filter((c) => !isPlantableNow(c, now))
    .map((c) => ({ c, days: daysUntilPlantable(c, now) }))
    .filter((x) => x.days !== null && x.days <= 45)
    .sort((a, b) => a.days - b.days);

  document.getElementById("plantableNowGrid").innerHTML = nowList.map((c) => cropCardHTML(c,
    `আজই লাগানো যায়`)).join("") || `<p class="empty-note">এই মুহূর্তে লাগানোর মতো কোনো ফসল তালিকায় নেই</p>`;

  document.getElementById("plantableSoonGrid").innerHTML = soonList.map(({ c, days }) => cropCardHTML(c,
    `${bnNum(days)} দিন পর`)).join("") || `<p class="empty-note">শীঘ্রই নতুন কিছু আসছে না</p>`;
}
function cropCardHTML(crop, whenLabel) {
  return `<div class="crop-card plantable" data-crop="${crop.id}">
    ${cropIconSVG(crop, 44)}
    <span class="cname">${crop.name_bn}</span>
    <span class="cwhen">${whenLabel}</span>
  </div>`;
}


/* ========================= SECTION: plot-tracker ==========================
   CRUD for named plots ("জমি") and the crop cycles logged inside them.
   A cycle carries planting_date + expected_harvest_date (auto-suggested
   from the crop's average duration, editable) so the app can show a live
   countdown and fire a Notification when harvest is close — without any
   server, purely by checking on app open / while the tab stays open.
   ========================================================================= */
async function renderPlots() {
  const plots = await dbGetAll("plots");
  const allCycles = await dbGetAll("cycles");
  const list = document.getElementById("plotsList");

  if (!plots.length) {
    list.innerHTML = `<p class="empty-note">এখনও কোনো জমি যোগ করা হয়নি। উপরের বোতামে চাপুন।</p>`;
  } else {
    list.innerHTML = plots.map((plot) => {
      const cycles = allCycles.filter((c) => c.plotId === plot.id)
        .sort((a, b) => (a.status === "active" ? -1 : 1) - (b.status === "active" ? -1 : 1));
      return `<div class="plot-card" data-plot="${plot.id}">
        <h3>🌾 ${plot.name}</h3>
        <div class="plot-meta">${plot.sizeText ? plot.sizeText : "আকার উল্লেখ নেই"}</div>
        ${cycles.map(cycleRowHTML).join("") || `<p class="empty-note">কোনো ফসল চক্র নেই</p>`}
        <button class="add-cycle-btn" data-plot="${plot.id}">➕ ফসল লাগানো শুরু করুন</button>
      </div>`;
    }).join("");
  }
  await renderWeatherFlagsOnPlots();
  await renderProfitRanking();
}

function cycleRowHTML(cycle) {
  const crop = CROPS_BY_ID[cycle.cropId];
  if (!crop) return "";
  let badge = "";
  if (cycle.status === "harvested") {
    const profit = cycle.profit || 0;
    badge = `<span class="cycle-profit ${profit >= 0 ? "pos" : "neg"}">${profit >= 0 ? "লাভ " : "ক্ষতি "}${taka(Math.abs(profit))}</span>`;
  } else {
    const days = Math.ceil((new Date(cycle.expectedHarvestDate) - new Date(todayISO())) / 86400000);
    badge = days < 0
      ? `<span class="cycle-badge overdue">কাটার সময় পার হয়ে গেছে</span>`
      : days === 0
      ? `<span class="cycle-badge overdue">আজই কাটার সময়!</span>`
      : `<span class="cycle-badge countdown">${bnNum(days)} দিন বাকি</span>`;
  }
  return `<div class="cycle-item" data-cycle="${cycle.id}">
    <div class="cycle-icon">${cropIconSVG(crop, 42)}</div>
    <div class="cycle-info">
      <div class="cname">${crop.name_bn}</div>
      <div class="sub">লাগানো: ${fmtDate(cycle.plantedDate)} · কাটা: ${fmtDate(cycle.expectedHarvestDate)}</div>
    </div>
    ${badge}
  </div>`;
}

async function addPlot(name, sizeText) {
  await dbPut("plots", { id: uid(), name, sizeText, createdAt: todayISO() });
  await renderPlots();
}

async function addCycle(plotId, cropId, plantedDate) {
  const crop = CROPS_BY_ID[cropId];
  const expected = new Date(plantedDate);
  expected.setDate(expected.getDate() + crop.duration_days);
  await dbPut("cycles", {
    id: uid(), plotId, cropId, plantedDate,
    expectedHarvestDate: expected.toISOString().slice(0, 10),
    status: "active", notifiedAt: null,
  });
  await renderPlots();
}


/* ========================= SECTION: expense-yield ==========================
   The core "was it actually worth it?" calculation. When a farmer marks a
   crop cycle as harvested, they enter their real input costs and what they
   actually sold — and we turn that into a profit/loss number per cycle,
   then aggregate those across cycles to rank crops by REAL past
   performance (not a guess) to guide next season's planting choice.
   ========================================================================= */
async function markHarvested(cycleId, data) {
  const cycles = await dbGetAll("cycles");
  const cycle = cycles.find((c) => c.id === cycleId);
  if (!cycle) return;

  // ---- Cost side -----------------------------------------------------
  // Every input cost the farmer paid to grow this cycle: seed/seedling,
  // fertilizer, hired labor, and a free-text "other" bucket (irrigation,
  // pesticide, transport to the field, etc). All optional -> default 0.
  const totalCost =
    (Number(data.seedCost) || 0) +
    (Number(data.fertilizerCost) || 0) +
    (Number(data.laborCost) || 0) +
    (Number(data.otherCost) || 0);

  // ---- Revenue side ----------------------------------------------------
  // Revenue = actual harvested quantity × the actual price it sold for.
  // Both numbers are what really happened, not the crop-calendar average,
  // which is what makes this "genuinely useful for deciding what to plant
  // next season" rather than another guess layered on a guess.
  const yieldQty = Number(data.yieldQty) || 0;
  const salePrice = Number(data.salePricePerUnit) || 0;
  const revenue = yieldQty * salePrice;

  // ---- Profit / loss -----------------------------------------------------
  // Simple and transparent on purpose: profit = revenue - totalCost.
  // A negative number means the cycle lost money even though something
  // was harvested — that's exactly the signal a farmer can't get from
  // yield alone, and the whole reason costs are tracked per cycle instead
  // of just once per season.
  const profit = revenue - totalCost;

  Object.assign(cycle, {
    status: "harvested",
    actualHarvestDate: data.actualHarvestDate || todayISO(),
    costs: {
      seed: Number(data.seedCost) || 0,
      fertilizer: Number(data.fertilizerCost) || 0,
      labor: Number(data.laborCost) || 0,
      other: Number(data.otherCost) || 0,
    },
    totalCost, yieldQty, yieldUnit: data.yieldUnit || "kg",
    salePricePerUnit: salePrice, marketName: data.marketName || "",
    revenue, profit,
  });
  await dbPut("cycles", cycle);
  await renderPlots();
  showToast(profit >= 0 ? `লাভ হয়েছে ${taka(profit)}` : `ক্ষতি হয়েছে ${taka(Math.abs(profit))}`);
}

async function renderProfitRanking() {
  const cycles = (await dbGetAll("cycles")).filter((c) => c.status === "harvested");
  const byCrop = {};
  for (const c of cycles) {
    if (!byCrop[c.cropId]) byCrop[c.cropId] = { total: 0, count: 0 };
    byCrop[c.cropId].total += c.profit;
    byCrop[c.cropId].count += 1;
  }
  const rows = Object.entries(byCrop)
    .map(([cropId, v]) => ({ crop: CROPS_BY_ID[cropId], avg: v.total / v.count, count: v.count }))
    .filter((r) => r.crop)
    .sort((a, b) => b.avg - a.avg);

  const el = document.getElementById("profitRanking");
  el.innerHTML = rows.length ? rows.map((r) => `<div class="rank-row">
      ${cropIconSVG(r.crop, 32)}
      <span class="rname">${r.crop.name_bn}</span>
      <span class="ramt" style="color:${r.avg >= 0 ? "var(--green-700)" : "var(--danger)"}">${r.avg >= 0 ? "" : "-"}${taka(Math.abs(r.avg))}/চক্র</span>
    </div>`).join("")
    : `<p class="empty-note">এখনও কোনো ফসল কাটা শেষ হয়নি — কাটার পর হিসাব এখানে দেখাবে</p>`;
}


/* ========================= SECTION: price-tracking =========================
   Manual (and optionally crowd-sourced, via Supabase) market price logs.
   Renders a hand-drawn canvas trend line per crop, a same-crop market
   comparison net of transport cost, and simple local price alerts.
   ========================================================================= */
async function addPriceLog(entry) {
  const row = { id: uid(), ...entry };
  await dbPut("priceLogs", row);
  if (entry.shareToCommunity) await pushPriceToSupabase(row);
  await checkPriceAlerts();
  return row;
}

async function getPriceHistory(cropId) {
  const rows = await dbGetAllByIndex("priceLogs", "byCropId", cropId);
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// ---- hand-drawn canvas trend chart --------------------------------------
function drawTrendChart(canvas, points) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const padL = 50, padR = 16, padT = 16, padB = 30;

  const emptyEl = document.getElementById("trendEmpty");
  if (!points.length) { emptyEl.classList.remove("hidden"); return; }
  emptyEl.classList.add("hidden");

  const prices = points.map((p) => p.price);
  const min = Math.min(...prices) * 0.92, max = Math.max(...prices) * 1.08;
  const xFor = (i) => padL + (i / Math.max(1, points.length - 1)) * (W - padL - padR);
  const yFor = (v) => H - padB - ((v - min) / Math.max(1, max - min)) * (H - padT - padB);

  // gridlines + y labels
  ctx.strokeStyle = "#E4DFCC"; ctx.fillStyle = "#5A5648"; ctx.font = "11px sans-serif";
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const y = yFor(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(Math.round(v), 6, y + 4);
  }

  // hand-drawn-feel line: slight jitter-free but rounded, thick, warm stroke
  ctx.strokeStyle = "#0F5132"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  points.forEach((p, i) => { const x = xFor(i), y = yFor(p.price); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();

  // points + x labels (every ~nth to avoid crowding)
  const step = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((p, i) => {
    const x = xFor(i), y = yFor(p.price);
    ctx.fillStyle = "#F2A93B"; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#0F5132"; ctx.lineWidth = 1.5; ctx.stroke();
    if (i % step === 0 || i === points.length - 1) {
      ctx.fillStyle = "#5A5648"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(fmtDate(p.date), x, H - 10);
    }
  });
}

async function renderMarketComparison(cropId) {
  const rows = await getPriceHistory(cropId);
  const byMarket = {};
  for (const r of rows) {
    // keep the latest price per market (rows are date-sorted ascending)
    byMarket[r.marketName] = r;
  }
  const list = Object.values(byMarket).map((r) => ({
    ...r, net: r.price - (Number(r.transportCost) || 0),
  })).sort((a, b) => b.net - a.net);

  const el = document.getElementById("marketCompare");
  el.innerHTML = list.length ? list.map((r, i) => `<div class="market-row ${i === 0 ? "best" : ""}">
      <div><div class="mname">${r.marketName}</div><div class="sub">দাম ${taka(r.price)}${r.transportCost ? ` − যাতায়াত ${taka(r.transportCost)}` : ""}</div></div>
      <div class="mnet">${taka(r.net)}</div>
    </div>`).join("")
    : `<p class="empty-note">একাধিক বাজারের দাম যোগ করলে এখানে তুলনা দেখাবে</p>`;
}

async function checkPriceAlerts() {
  const alerts = await dbGetAll("priceAlerts");
  for (const alert of alerts) {
    const history = await getPriceHistory(alert.cropId);
    if (!history.length) continue;
    const latest = history[history.length - 1];
    const hit = latest.price >= alert.targetPrice;
    if (hit && !alert.notifiedAt) {
      alert.notifiedAt = new Date().toISOString();
      await dbPut("priceAlerts", alert);
      notify(`দাম লক্ষ্যে পৌঁছেছে`, `${CROPS_BY_ID[alert.cropId]?.name_bn || ""} এখন ${taka(latest.price)}`);
    }
    alert._hit = hit;
    alert._latest = latest.price;
  }
  await renderAlerts(alerts);
}
async function renderAlerts(preloaded) {
  const alerts = preloaded || await dbGetAll("priceAlerts");
  const el = document.getElementById("alertsList");
  el.innerHTML = alerts.length ? alerts.map((a) => {
    const crop = CROPS_BY_ID[a.cropId];
    return `<div class="alert-row ${a._hit ? "hit" : ""}" data-alert="${a.id}">
      <div><div class="mname">${crop ? crop.name_bn : ""}</div><div class="sub">টার্গেট ${taka(a.targetPrice)}${a._latest ? ` · এখন ${taka(a._latest)}` : ""}</div></div>
      <button class="icon-btn" data-del-alert="${a.id}" style="background:var(--danger-bg);color:var(--danger);" aria-label="মুছুন">✕</button>
    </div>`;
  }).join("") : `<p class="empty-note">এখনও কোনো টার্গেট দাম বসানো হয়নি</p>`;
}

// ---- optional Supabase crowd-sourced price sharing ---------------------
// Entirely optional: the app is fully functional without it. When the
// user pastes their own Supabase project URL + anon key in Settings, new
// price logs marked "share with community" get POSTed to a `price_logs`
// table via PostgREST, and community rows get merged in when browsing a
// crop's trend/market comparison. Everything no-ops silently if unset or
// offline.
async function getSupabaseConfig() {
  const url = await dbGetSetting("supabaseUrl", "");
  const key = await dbGetSetting("supabaseKey", "");
  return url && key ? { url, key } : null;
}
async function pushPriceToSupabase(row) {
  const cfg = await getSupabaseConfig();
  if (!cfg || !navigator.onLine) return;
  try {
    await fetch(`${cfg.url}/rest/v1/price_logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "apikey": cfg.key,
        "Authorization": `Bearer ${cfg.key}`, "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        crop_id: row.cropId, market_name: row.marketName, price: row.price,
        unit: row.unit, log_date: row.date,
      }),
    });
  } catch (_) { /* offline or misconfigured — fail silently, local copy is safe */ }
}


/* ========================= SECTION: weather-check ===========================
   Free, no-key Open-Meteo forecast. Purely additive: if the device is
   online and the user picked their district, we check the days around
   each active cycle's expected harvest date for heavy rain / extreme heat
   and surface a warning — otherwise this section quietly does nothing.
   ========================================================================= */
const DISTRICTS = [
  { name: "ঢাকা", lat: 23.81, lon: 90.41 },
  { name: "চট্টগ্রাম", lat: 22.36, lon: 91.83 },
  { name: "রাজশাহী", lat: 24.37, lon: 88.6 },
  { name: "খুলনা", lat: 22.82, lon: 89.55 },
  { name: "বরিশাল", lat: 22.7, lon: 90.37 },
  { name: "সিলেট", lat: 24.9, lon: 91.87 },
  { name: "রংপুর", lat: 25.75, lon: 89.25 },
  { name: "ময়মনসিংহ", lat: 24.75, lon: 90.4 },
  { name: "কুমিল্লা", lat: 23.46, lon: 91.18 },
  { name: "বগুড়া", lat: 24.85, lon: 89.37 },
  { name: "যশোর", lat: 23.17, lon: 89.21 },
  { name: "কক্সবাজার", lat: 21.44, lon: 92.0 },
];
let latestWeatherWarnings = {}; // cycleId -> warning text

async function initDistrictSelect() {
  const sel = document.getElementById("districtSelect");
  sel.innerHTML = DISTRICTS.map((d) => `<option value="${d.name}">${d.name}</option>`).join("");
  const saved = await dbGetSetting("district", "ঢাকা");
  sel.value = saved;
  sel.addEventListener("change", async () => {
    await dbSetSetting("district", sel.value);
    await runWeatherCheck();
  });
}

async function runWeatherCheck() {
  const warnEl = document.getElementById("weatherWarnings");
  latestWeatherWarnings = {};
  if (!navigator.onLine) { warnEl.innerHTML = `<p class="sub">অফলাইনে আছেন — আবহাওয়ার তথ্য পাওয়া যাচ্ছে না।</p>`; return; }

  const districtName = await dbGetSetting("district", "ঢাকা");
  const district = DISTRICTS.find((d) => d.name === districtName) || DISTRICTS[0];
  const cycles = (await dbGetAll("cycles")).filter((c) => c.status === "active");
  if (!cycles.length) { warnEl.innerHTML = `<p class="sub">এখনও কোনো চলমান ফসল চক্র নেই।</p>`; return; }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${district.lat}&longitude=${district.lon}&daily=precipitation_sum,temperature_2m_max&forecast_days=16&timezone=Asia%2FDhaka`;
    const res = await fetch(url);
    const json = await res.json();
    const dates = json.daily.time;
    const rain = json.daily.precipitation_sum;
    const heat = json.daily.temperature_2m_max;

    const warnings = [];
    for (const cycle of cycles) {
      // look at the 3-day window centered on the expected harvest date
      const harvest = cycle.expectedHarvestDate;
      const idx = dates.indexOf(harvest);
      if (idx === -1) continue; // outside the 16-day forecast horizon
      const windowIdx = [idx - 1, idx, idx + 1].filter((i) => i >= 0 && i < dates.length);
      const heavyRain = windowIdx.some((i) => rain[i] >= 20);
      const extremeHeat = windowIdx.some((i) => heat[i] >= 36);
      const crop = CROPS_BY_ID[cycle.cropId];
      if (heavyRain) {
        const msg = `${crop?.name_bn || ""} কাটার সময়ের কাছে ভারী বৃষ্টির পূর্বাভাস — আগে কাটার কথা ভাবুন`;
        warnings.push(msg); latestWeatherWarnings[cycle.id] = msg;
      } else if (extremeHeat) {
        const msg = `${crop?.name_bn || ""} কাটার সময়ের কাছে তীব্র তাপের পূর্বাভাস`;
        warnings.push(msg); latestWeatherWarnings[cycle.id] = msg;
      }
    }
    warnEl.innerHTML = warnings.length
      ? warnings.map((w) => `<div class="weather-flag">⚠️ ${w}</div>`).join("")
      : `<p class="sub">${district.name} এলাকায় আগামী কয়েক দিনে বড় কোনো সতর্কতা নেই।</p>`;
  } catch (_) {
    warnEl.innerHTML = `<p class="sub">আবহাওয়ার তথ্য আনা যায়নি। পরে আবার চেষ্টা করুন।</p>`;
  }
  await renderWeatherFlagsOnPlots();
}

async function renderWeatherFlagsOnPlots() {
  document.querySelectorAll(".cycle-item").forEach((el) => {
    const id = el.dataset.cycle;
    let flag = el.querySelector(".weather-flag");
    if (latestWeatherWarnings[id]) {
      if (!flag) { flag = document.createElement("div"); flag.className = "weather-flag"; el.appendChild(flag); }
      flag.textContent = "⚠️ " + latestWeatherWarnings[id];
    } else if (flag) { flag.remove(); }
  });
}


/* ============================== SECTION: pwa ===============================
   Service worker registration, install prompt, and online/offline status.
   The actual caching strategy lives in sw.js (app shell + crops.json
   cache-first, everything else network-first with cache fallback).
   ========================================================================= */
function initPWA() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  const updateOnlineBadge = () => {
    const el = document.getElementById("onlineBadge");
    const on = navigator.onLine;
    el.textContent = on ? "অনলাইন" : "অফলাইন";
    el.classList.toggle("online", on);
    if (on) { runWeatherCheck(); checkPriceAlerts(); }
  };
  window.addEventListener("online", updateOnlineBadge);
  window.addEventListener("offline", updateOnlineBadge);
  updateOnlineBadge();

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); deferredPrompt = e;
    document.getElementById("installBtn").classList.remove("hidden");
  });
  document.getElementById("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    document.getElementById("installBtn").classList.add("hidden");
  });
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body, icon: "manifest.webmanifest" }); } catch (_) {}
  }
}

// scans active cycles and fires a local notification once per cycle when
// harvest is within 2 days or already overdue — re-checked on load and
// every 6 hours while the app stays open (no real background push
// without a server, which is out of scope for the fully-offline core)
async function scanHarvestReminders() {
  const cycles = (await dbGetAll("cycles")).filter((c) => c.status === "active");
  const today = new Date(todayISO());
  for (const cycle of cycles) {
    const days = Math.ceil((new Date(cycle.expectedHarvestDate) - today) / 86400000);
    if (days <= 2 && !cycle.notifiedAt) {
      const crop = CROPS_BY_ID[cycle.cropId];
      notify("ফসল কাটার সময় হয়ে এসেছে", `${crop?.name_bn || ""} — ${days <= 0 ? "আজই কাটুন" : `আর ${bnNum(days)} দিন বাকি`}`);
      cycle.notifiedAt = new Date().toISOString();
      await dbPut("cycles", cycle);
    }
  }
}


/* ============================ UI / nav helpers ============================ */
function switchView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
}
function openSheet(html) {
  document.getElementById("sheetContent").innerHTML = `<button class="sheet-close" id="sheetCloseBtn">✕</button>${html}`;
  document.getElementById("sheetOverlay").classList.remove("hidden");
  document.getElementById("sheetCloseBtn").addEventListener("click", closeSheet);
}
function closeSheet() { document.getElementById("sheetOverlay").classList.add("hidden"); }
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(showToast._h);
  showToast._h = setTimeout(() => t.classList.add("hidden"), 2200);
}
function cropChipSelectHTML(selectedId) {
  return `<div class="chip-select" id="cropChipSelect">${CROPS.map((c) =>
    `<button type="button" data-crop="${c.id}" class="${c.id === selectedId ? "sel" : ""}">${c.name_bn}</button>`
  ).join("")}</div>`;
}


/* =============================== BOOTSTRAP ================================= */
async function bootstrap() {
  await loadCrops();
  await openDB();

  renderSeasonWheel();
  renderPlantableGrids();
  await initDistrictSelect();
  await renderPlots();
  initPWA();

  // price view crop selector
  const priceSel = document.getElementById("priceCropSelect");
  priceSel.innerHTML = CROPS.map((c) => `<option value="${c.id}">${c.name_bn}</option>`).join("");
  async function refreshPriceView() {
    const cropId = priceSel.value;
    const history = await getPriceHistory(cropId);
    drawTrendChart(document.getElementById("trendCanvas"), history);
    await renderMarketComparison(cropId);
  }
  priceSel.addEventListener("change", refreshPriceView);
  await refreshPriceView();
  await checkPriceAlerts();

  // supabase settings fields
  document.getElementById("supabaseUrl").value = await dbGetSetting("supabaseUrl", "");
  document.getElementById("supabaseKey").value = await dbGetSetting("supabaseKey", "");
  const notifStatus = document.getElementById("notifStatus");
  notifStatus.textContent = ("Notification" in window)
    ? (Notification.permission === "granted" ? "নোটিফিকেশন চালু আছে" : "নোটিফিকেশন বন্ধ আছে")
    : "এই ব্রাউজারে নোটিফিকেশন সমর্থিত নয়";

  await scanHarvestReminders();
  setInterval(scanHarvestReminders, 6 * 60 * 60 * 1000);
  if (navigator.onLine) await runWeatherCheck();

  wireEvents(refreshPriceView);
}

function wireEvents(refreshPriceView) {
  document.querySelectorAll(".nav-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchView(btn.dataset.view)));

  document.getElementById("sheetOverlay").addEventListener("click", (e) => {
    if (e.target.id === "sheetOverlay") closeSheet();
  });

  // ---- add plot ----
  document.getElementById("addPlotBtn").addEventListener("click", () => {
    openSheet(`<h2>নতুন জমি</h2>
      <div class="field-row"><label>জমির নাম</label><input id="plotName" placeholder="যেমন: বাড়ির পাশের জমি"></div>
      <div class="field-row"><label>আকার (ঐচ্ছিক)</label><input id="plotSize" placeholder="যেমন: ৩০ শতক"></div>
      <button class="btn-primary big-btn" id="savePlotBtn">সংরক্ষণ করুন</button>`);
    document.getElementById("savePlotBtn").addEventListener("click", async () => {
      const name = document.getElementById("plotName").value.trim();
      if (!name) return showToast("জমির নাম দিন");
      await addPlot(name, document.getElementById("plotSize").value.trim());
      closeSheet(); showToast("জমি যোগ হয়েছে");
    });
  });

  // ---- delegated clicks inside plotsList: add cycle / open cycle detail ----
  document.getElementById("plotsList").addEventListener("click", async (e) => {
    const addBtn = e.target.closest(".add-cycle-btn");
    if (addBtn) return openAddCycleSheet(addBtn.dataset.plot);

    const cycleEl = e.target.closest(".cycle-item");
    if (cycleEl) return openCycleDetailSheet(cycleEl.dataset.cycle);
  });

  function openAddCycleSheet(plotId) {
    let selected = CROPS[0].id;
    openSheet(`<h2>ফসল লাগানো শুরু</h2>
      <div class="field-row"><label>ফসল বাছাই করুন</label></div>
      ${cropChipSelectHTML(selected)}
      <div class="field-row"><label>লাগানোর তারিখ</label><input type="date" id="plantDate" value="${todayISO()}"></div>
      <button class="btn-primary big-btn" id="saveCycleBtn">শুরু করুন</button>`);
    document.getElementById("cropChipSelect").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      selected = b.dataset.crop;
      document.querySelectorAll("#cropChipSelect button").forEach((x) => x.classList.toggle("sel", x === b));
    });
    document.getElementById("saveCycleBtn").addEventListener("click", async () => {
      const date = document.getElementById("plantDate").value || todayISO();
      await addCycle(plotId, selected, date);
      closeSheet(); showToast("ফসল চক্র যোগ হয়েছে");
    });
  }

  async function openCycleDetailSheet(cycleId) {
    const cycles = await dbGetAll("cycles");
    const cycle = cycles.find((c) => c.id === cycleId);
    if (!cycle) return;
    const crop = CROPS_BY_ID[cycle.cropId];

    if (cycle.status === "harvested") {
      openSheet(`<h2>${crop.name_bn}</h2>
        <p class="sub">কাটা হয়েছে: ${fmtDate(cycle.actualHarvestDate)}</p>
        <div class="field-row"><label>মোট খরচ</label><div>${taka(cycle.totalCost)}</div></div>
        <div class="field-row"><label>ফলন</label><div>${bnNum(cycle.yieldQty)} ${cycle.yieldUnit}</div></div>
        <div class="field-row"><label>বিক্রয় মূল্য (প্রতি একক)</label><div>${taka(cycle.salePricePerUnit)}</div></div>
        <div class="field-row"><label>মোট আয়</label><div>${taka(cycle.revenue)}</div></div>
        <div class="field-row"><label>${cycle.profit >= 0 ? "লাভ" : "ক্ষতি"}</label>
          <div style="font-size:1.3rem;font-weight:800;color:${cycle.profit >= 0 ? "var(--green-700)" : "var(--danger)"}">${taka(Math.abs(cycle.profit))}</div></div>`);
      return;
    }

    const days = Math.ceil((new Date(cycle.expectedHarvestDate) - new Date(todayISO())) / 86400000);
    openSheet(`<h2>${crop.name_bn}</h2>
      <p class="sub">লাগানো: ${fmtDate(cycle.plantedDate)} · প্রত্যাশিত কাটা: ${fmtDate(cycle.expectedHarvestDate)} (${days >= 0 ? bnNum(days) + " দিন বাকি" : "সময় পার হয়েছে"})</p>
      ${latestWeatherWarnings[cycle.id] ? `<div class="weather-flag">⚠️ ${latestWeatherWarnings[cycle.id]}</div>` : ""}
      <h2 class="section-title">ফসল কাটার হিসাব লিখুন</h2>
      <div class="row-2">
        <div class="field-row"><label>বীজ খরচ</label><input type="number" id="c_seed" value="0"></div>
        <div class="field-row"><label>সার খরচ</label><input type="number" id="c_fert" value="0"></div>
        <div class="field-row"><label>শ্রমিক খরচ</label><input type="number" id="c_labor" value="0"></div>
        <div class="field-row"><label>অন্যান্য খরচ</label><input type="number" id="c_other" value="0"></div>
      </div>
      <div class="row-2">
        <div class="field-row"><label>ফলন পরিমাণ</label><input type="number" id="c_yield" value="0"></div>
        <div class="field-row"><label>একক</label>
          <select id="c_unit"><option value="kg">কেজি</option><option value="mon">মণ</option><option value="quintal">কুইন্টাল</option></select>
        </div>
      </div>
      <div class="field-row"><label>প্রতি একক বিক্রয় মূল্য</label><input type="number" id="c_price" value="0"></div>
      <div class="field-row"><label>যেখানে বিক্রি হয়েছে (ঐচ্ছিক)</label><input id="c_market" placeholder="বাজারের নাম"></div>
      <div class="field-row"><label>কাটার প্রকৃত তারিখ</label><input type="date" id="c_date" value="${todayISO()}"></div>
      <button class="btn-primary big-btn" id="saveHarvestBtn">হিসাব সংরক্ষণ করুন</button>`);

    document.getElementById("saveHarvestBtn").addEventListener("click", async () => {
      await markHarvested(cycleId, {
        seedCost: document.getElementById("c_seed").value,
        fertilizerCost: document.getElementById("c_fert").value,
        laborCost: document.getElementById("c_labor").value,
        otherCost: document.getElementById("c_other").value,
        yieldQty: document.getElementById("c_yield").value,
        yieldUnit: document.getElementById("c_unit").value,
        salePricePerUnit: document.getElementById("c_price").value,
        marketName: document.getElementById("c_market").value,
        actualHarvestDate: document.getElementById("c_date").value,
      });
      closeSheet();
    });
  }

  // ---- add price log ----
  document.getElementById("addPriceBtn").addEventListener("click", async () => {
    const cfg = await getSupabaseConfig();
    let selected = document.getElementById("priceCropSelect").value;
    openSheet(`<h2>দাম যোগ করুন</h2>
      ${cropChipSelectHTML(selected)}
      <div class="field-row"><label>বাজারের নাম</label><input id="p_market" placeholder="যেমন: কারওয়ান বাজার"></div>
      <div class="row-2">
        <div class="field-row"><label>দাম</label><input type="number" id="p_price" value="0"></div>
        <div class="field-row"><label>একক</label>
          <select id="p_unit"><option value="kg">কেজি</option><option value="mon">মণ</option><option value="quintal">কুইন্টাল</option></select>
        </div>
      </div>
      <div class="field-row"><label>যাতায়াত খরচ (ঐচ্ছিক)</label><input type="number" id="p_transport" value="0"></div>
      <div class="field-row"><label>তারিখ</label><input type="date" id="p_date" value="${todayISO()}"></div>
      ${cfg ? `<div class="field-row"><label><input type="checkbox" id="p_share" checked> কমিউনিটির সাথে শেয়ার করুন</label></div>` : ""}
      <button class="btn-primary big-btn" id="savePriceBtn">সংরক্ষণ করুন</button>`);
    document.getElementById("cropChipSelect").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      selected = b.dataset.crop;
      document.querySelectorAll("#cropChipSelect button").forEach((x) => x.classList.toggle("sel", x === b));
    });
    document.getElementById("savePriceBtn").addEventListener("click", async () => {
      const market = document.getElementById("p_market").value.trim();
      if (!market) return showToast("বাজারের নাম দিন");
      await addPriceLog({
        cropId: selected, marketName: market,
        price: Number(document.getElementById("p_price").value) || 0,
        unit: document.getElementById("p_unit").value,
        transportCost: Number(document.getElementById("p_transport").value) || 0,
        date: document.getElementById("p_date").value || todayISO(),
        shareToCommunity: document.getElementById("p_share")?.checked || false,
      });
      document.getElementById("priceCropSelect").value = selected;
      await refreshPriceView();
      closeSheet(); showToast("দাম সংরক্ষিত হয়েছে");
    });
  });

  // ---- add price alert ----
  document.getElementById("addAlertBtn").addEventListener("click", () => {
    let selected = document.getElementById("priceCropSelect").value;
    openSheet(`<h2>টার্গেট দাম</h2>
      ${cropChipSelectHTML(selected)}
      <div class="field-row"><label>এই দামে পৌঁছালে জানাও</label><input type="number" id="a_target" value="0"></div>
      <button class="btn-primary big-btn" id="saveAlertBtn">সংরক্ষণ করুন</button>`);
    document.getElementById("cropChipSelect").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      selected = b.dataset.crop;
      document.querySelectorAll("#cropChipSelect button").forEach((x) => x.classList.toggle("sel", x === b));
    });
    document.getElementById("saveAlertBtn").addEventListener("click", async () => {
      await dbPut("priceAlerts", { id: uid(), cropId: selected, targetPrice: Number(document.getElementById("a_target").value) || 0, notifiedAt: null });
      await checkPriceAlerts();
      closeSheet(); showToast("সতর্কতা যোগ হয়েছে");
    });
  });
  document.getElementById("alertsList").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-alert]");
    if (del) { await dbDelete("priceAlerts", del.dataset.delAlert); await checkPriceAlerts(); }
  });

  // ---- settings: notifications ----
  document.getElementById("enableNotifBtn").addEventListener("click", async () => {
    if (!("Notification" in window)) return showToast("এই ব্রাউজারে নোটিফিকেশন সমর্থিত নয়");
    const perm = await Notification.requestPermission();
    document.getElementById("notifStatus").textContent = perm === "granted" ? "নোটিফিকেশন চালু আছে" : "নোটিফিকেশন বন্ধ আছে";
  });

  // ---- settings: supabase ----
  document.getElementById("saveSupabaseBtn").addEventListener("click", async () => {
    await dbSetSetting("supabaseUrl", document.getElementById("supabaseUrl").value.trim());
    await dbSetSetting("supabaseKey", document.getElementById("supabaseKey").value.trim());
    document.getElementById("supabaseStatus").textContent = "সংরক্ষিত হয়েছে";
  });

  // ---- settings: export ----
  document.getElementById("exportBtn").addEventListener("click", async () => {
    const data = {
      plots: await dbGetAll("plots"), cycles: await dbGetAll("cycles"),
      priceLogs: await dbGetAll("priceLogs"), priceAlerts: await dbGetAll("priceAlerts"),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "harvest-backup.json"; a.click();
  });
}

document.addEventListener("DOMContentLoaded", bootstrap);
