"use strict";
/* Fuel Log — offline-first fuel tracker. Data lives in localStorage on this device. */

const LS_DATA = "fuellog.v1";
const LS_THEME = "fuellog.theme";

/* ---------------- state & storage ---------------- */
let entries = [];          // {id,date,station,odometer,fuelType,price,litres,partial}
let editingId = null;
let rangeSel = { kind: "all" };   // {kind:"all"} | {kind:"months",n} | {kind:"year",y}
let currentTab = "add";

function load() {
  try {
    const raw = localStorage.getItem(LS_DATA);
    if (raw) { entries = JSON.parse(raw).entries || []; return; }
  } catch (e) { /* corrupted store — start fresh */ }
  entries = [];
}
function save() {
  localStorage.setItem(LS_DATA, JSON.stringify({ v: 1, entries }));
}
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2));
}

/* ---------------- derived data ---------------- */
const isBaseline = (e) => e.litres == null;

function sorted() {
  return [...entries].sort((a, b) =>
    a.odometer !== b.odometer ? a.odometer - b.odometer : a.date.localeCompare(b.date));
}

// Adds .dist, .cost, .econ (L/100km, full-to-full), .intervalDist, .intervalLitres
function derived() {
  const list = sorted().map((e) => ({ ...e }));
  let prevOdo = null, lastFullOdo = null, litresSince = 0;
  for (const e of list) {
    e.dist = prevOdo != null && e.odometer > prevOdo ? e.odometer - prevOdo : null;
    prevOdo = e.odometer;
    if (isBaseline(e)) { lastFullOdo = e.odometer; litresSince = 0; continue; }
    e.cost = e.litres * (e.price || 0);
    litresSince += e.litres;
    if (!e.partial) {
      if (lastFullOdo != null && e.odometer > lastFullOdo) {
        e.intervalDist = e.odometer - lastFullOdo;
        e.intervalLitres = litresSince;
        e.econ = (litresSince / e.intervalDist) * 100;
      }
      lastFullOdo = e.odometer;
      litresSince = 0;
    }
  }
  return list;
}

function inRange(e) {
  if (rangeSel.kind === "months") {
    const d = new Date();
    d.setMonth(d.getMonth() - rangeSel.n);
    return e.date >= d.toISOString().slice(0, 10);
  }
  if (rangeSel.kind === "year") return e.date.slice(0, 4) === rangeSel.y;
  return true;
}

/* ---------------- formatting ---------------- */
const fmtMoney = (n, dp = 2) => "$" + n.toLocaleString("en-NZ", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtInt = (n) => n.toLocaleString("en-NZ");
const fmtNZDate = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (key) => { const [y, m] = key.split("-"); return MONTHS[+m - 1] + " " + y.slice(2); };
const fmtTick = (ms) => { const d = new Date(ms); return MONTHS[d.getMonth()] + " " + String(d.getFullYear()).slice(2); };

/* ---------------- tiny DOM helpers ---------------- */
const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
  return n;
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------------- tabs ---------------- */
function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab").forEach((s) => { s.hidden = s.id !== "tab-" + name; });
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (name === "history") renderHistory();
  if (name === "dash") renderDash();
  if (name === "data") renderData();
  if (name === "add" && !editingId) prepAddForm();
  window.scrollTo(0, 0);
}

/* ---------------- add / edit form ---------------- */
function lastFuelEntry() {
  const list = sorted();
  for (let i = list.length - 1; i >= 0; i--) if (!isBaseline(list[i])) return list[i];
  return null;
}
function maxOdo() {
  return entries.length ? Math.max(...entries.map((e) => e.odometer)) : 0;
}
function stations() {
  const count = {};
  for (const e of entries) if (e.station) count[e.station] = (count[e.station] || 0) + 1;
  return Object.keys(count).sort((a, b) => count[b] - count[a]);
}

function setFuelType(v) {
  document.querySelectorAll("#fuelSeg button").forEach((b) =>
    b.setAttribute("aria-checked", b.dataset.v === v ? "true" : "false"));
}
function getFuelType() {
  const b = document.querySelector('#fuelSeg button[aria-checked="true"]');
  return b ? b.dataset.v : "91";
}

function prepAddForm() {
  editingId = null;
  $("#addTitle").textContent = "Add fill";
  $("#saveBtn").textContent = "Save fill";
  $("#cancelEditBtn").hidden = true;
  $("#deleteBtn").hidden = true;
  $("#fillForm").reset();
  const now = new Date();
  $("#fDate").value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const last = lastFuelEntry();
  setFuelType(last ? last.fuelType : "91");
  $("#fPartial").checked = false;
  $("#odoHint").textContent = last ? `Last: ${fmtInt(maxOdo())} km on ${fmtNZDate(last.date)}` : "";
  renderStationChips();
  updateLiveCalc();
}

function renderStationChips() {
  const box = $("#stationChips");
  box.textContent = "";
  for (const s of stations().slice(0, 4)) {
    const b = el("button", null, s);
    b.type = "button";
    b.addEventListener("click", () => { $("#fStation").value = s; updateLiveCalc(); });
    box.appendChild(b);
  }
  const dl = $("#stationList");
  dl.textContent = "";
  for (const s of stations()) {
    const o = document.createElement("option");
    o.value = s;
    dl.appendChild(o);
  }
}

function updateLiveCalc() {
  const litres = parseFloat($("#fLitres").value);
  const price = parseFloat($("#fPrice").value);
  const odo = parseFloat($("#fOdo").value);
  const box = $("#liveCalc");
  box.textContent = "";
  if (!(litres > 0 && price > 0) && !(odo > 0)) { box.hidden = true; return; }
  if (litres > 0 && price > 0) {
    const s = el("div");
    s.append("Total cost ");
    s.appendChild(el("strong", null, fmtMoney(litres * price)));
    box.appendChild(s);
  }
  if (!editingId && odo > 0) {
    const prev = maxOdo();
    if (odo > prev && prev > 0) {
      const s = el("div");
      s.append(`Distance since last fill `);
      s.appendChild(el("strong", null, fmtInt(odo - prev) + " km"));
      if (litres > 0 && !$("#fPartial").checked) {
        s.append(" · ");
        s.appendChild(el("strong", null, ((litres / (odo - prev)) * 100).toFixed(2) + " L/100km"));
      }
      box.appendChild(s);
    }
  }
  box.hidden = box.childNodes.length === 0;
}

function onSubmitFill(ev) {
  ev.preventDefault();
  const entry = {
    id: editingId || uid(),
    date: $("#fDate").value,
    station: $("#fStation").value.trim(),
    odometer: Math.round(parseFloat($("#fOdo").value)),
    fuelType: getFuelType(),
    price: parseFloat($("#fPrice").value),
    litres: parseFloat($("#fLitres").value),
    partial: $("#fPartial").checked,
  };
  if (!entry.date || !(entry.odometer >= 0) || !(entry.litres > 0) || !(entry.price > 0)) {
    toast("Please fill in all fields"); return;
  }
  if (!editingId && entry.odometer <= maxOdo()) {
    if (!confirm(`Odometer (${fmtInt(entry.odometer)}) is not higher than the last recorded (${fmtInt(maxOdo())}). Save anyway?`)) return;
  }
  if (editingId) {
    entries = entries.map((e) => (e.id === editingId ? entry : e));
    save();
    toast("Fill updated");
    editingId = null;
    switchTab("history");
  } else {
    entries.push(entry);
    save();
    toast(`Saved — ${fmtMoney(entry.litres * entry.price)}`);
    prepAddForm();
  }
}

function startEdit(id) {
  const e = entries.find((x) => x.id === id);
  if (!e || isBaseline(e)) return;
  editingId = id;
  switchTab("add");
  $("#addTitle").textContent = "Edit fill";
  $("#saveBtn").textContent = "Save changes";
  $("#cancelEditBtn").hidden = false;
  $("#deleteBtn").hidden = false;
  $("#fDate").value = e.date;
  $("#fStation").value = e.station;
  $("#fOdo").value = e.odometer;
  $("#fLitres").value = e.litres;
  $("#fPrice").value = e.price;
  setFuelType(e.fuelType);
  $("#fPartial").checked = !!e.partial;
  $("#odoHint").textContent = "";
  renderStationChips();
  updateLiveCalc();
}

/* ---------------- history ---------------- */
function renderHistory() {
  const list = derived().reverse();
  const box = $("#historyList");
  box.textContent = "";
  const fuel = list.filter((e) => !isBaseline(e));
  const totalSpend = fuel.reduce((s, e) => s + e.cost, 0);
  const odos = list.map((e) => e.odometer);
  const tracked = odos.length > 1 ? Math.max(...odos) - Math.min(...odos) : 0;
  $("#historySummary").textContent = fuel.length
    ? `${fuel.length} fills · ${fmtInt(tracked)} km tracked · ${fmtMoney(totalSpend, 0)} total`
    : "";
  if (!list.length) {
    box.appendChild(el("div", "empty", "No fills yet — add your first one."));
    return;
  }
  let month = "";
  for (const e of list) {
    const mk = e.date.slice(0, 7);
    if (mk !== month) {
      month = mk;
      const [y, m] = mk.split("-");
      box.appendChild(el("div", "month-head", MONTHS[+m - 1] + " " + y));
    }
    const row = el("button", "fill-row");
    row.type = "button";
    const left = el("div");
    const l1 = el("div", "l1", isBaseline(e) ? "Starting point" : (e.station || "Unknown station"));
    if (!isBaseline(e)) {
      if (e.fuelType) l1.appendChild(el("span", "badge", e.fuelType));
      if (e.partial) l1.appendChild(el("span", "badge warn", "partial"));
    }
    const l2 = el("div", "l2", isBaseline(e)
      ? `${fmtNZDate(e.date)} · odometer ${fmtInt(e.odometer)} km`
      : `${fmtNZDate(e.date)} · ${e.litres} L @ ${fmtMoney(e.price)}` + (e.dist ? ` · ${fmtInt(e.dist)} km` : ""));
    left.append(l1, l2);
    const right = el("div", "r");
    if (!isBaseline(e)) {
      right.appendChild(el("div", "cost", fmtMoney(e.cost)));
      if (e.econ != null) right.appendChild(el("div", "econ-pill", e.econ.toFixed(2) + " L/100km"));
    }
    row.append(left, right);
    if (!isBaseline(e)) row.addEventListener("click", () => startEdit(e.id));
    else row.disabled = true;
    box.appendChild(row);
  }
}

/* ---------------- dashboard ---------------- */
function dataYears() {
  const ys = new Set(entries.filter((e) => !isBaseline(e)).map((e) => e.date.slice(0, 4)));
  return [...ys].sort().reverse();
}
function renderRangeChips() {
  const box = $("#rangeChips");
  box.textContent = "";
  const defs = [
    ["All", { kind: "all" }],
    ["3 mo", { kind: "months", n: 3 }],
    ["6 mo", { kind: "months", n: 6 }],
    ["12 mo", { kind: "months", n: 12 }],
    ...dataYears().map((y) => [y, { kind: "year", y }]),
  ];
  for (const [label, sel] of defs) {
    const btn = el("button", null, label);
    if (sel.kind === rangeSel.kind && sel.n === rangeSel.n && sel.y === rangeSel.y) btn.classList.add("on");
    btn.addEventListener("click", () => { rangeSel = sel; renderDash(); });
    box.appendChild(btn);
  }
}

function renderDash() {
  const all = derived();
  const fuel = all.filter((e) => !isBaseline(e) && inRange(e));
  renderRangeChips();
  renderTiles(fuel);
  renderEconChart(all);
  renderPriceChart(fuel);
  renderSpendChart(fuel);
  renderStationChart(fuel);
  renderInsights(all, fuel);
}

function renderTiles(fuel) {
  const box = $("#tiles");
  box.textContent = "";
  const spend = fuel.reduce((s, e) => s + e.cost, 0);
  const litres = fuel.reduce((s, e) => s + e.litres, 0);
  const avgPrice = litres ? spend / litres : 0;
  const ivals = fuel.filter((e) => e.econ != null);
  const aggDist = ivals.reduce((s, e) => s + e.intervalDist, 0);
  const aggLit = ivals.reduce((s, e) => s + e.intervalLitres, 0);
  const avgEcon = aggDist ? (aggLit / aggDist) * 100 : 0;
  const costKm = avgEcon && avgPrice ? (avgEcon / 100) * avgPrice : 0;
  const dist = fuel.reduce((s, e) => s + (e.dist || 0), 0);
  const tiles = [
    ["Distance driven", dist ? fmtInt(dist) : "–", "km", fuel.length + (fuel.length === 1 ? " fill" : " fills")],
    ["Fuel used", litres ? fmtInt(Math.round(litres)) : "–", "L", fuel.length ? "avg " + (litres / fuel.length).toFixed(1) + " L per fill" : ""],
    ["Total spend", spend ? fmtMoney(spend, spend >= 1000 ? 0 : 2) : "–", "", fuel.length ? "avg " + fmtMoney(spend / fuel.length) + " per fill" : ""],
    ["Avg economy", avgEcon ? avgEcon.toFixed(2) : "–", "L/100km", ivals.length + " tanks"],
    ["Avg price paid", avgPrice ? fmtMoney(avgPrice) : "–", "/L", "litre-weighted"],
    ["Running cost", costKm ? (costKm * 100).toFixed(1) + "¢" : "–", "/km", "economy × price"],
  ];
  for (const [label, value, unit, note] of tiles) {
    const t = el("div", "tile");
    t.appendChild(el("div", "t-label", label));
    const v = el("div", "t-value", value);
    if (unit) v.appendChild(el("span", "t-unit", unit));
    t.appendChild(v);
    t.appendChild(el("div", "t-note", note));
    box.appendChild(t);
  }
}

/* ---------------- chart primitives ---------------- */
function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  let step = mag;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= step0) { step = m * mag; break; }
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi, ticks };
}

function clearChart(box) { box.textContent = ""; }

function makeTip(box) {
  const tip = el("div", "viz-tip");
  tip.hidden = true;
  box.appendChild(tip);
  return tip;
}
function placeTip(tip, box, px, py) {
  tip.hidden = false;
  const bw = box.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = px + 12;
  if (x + tw > bw - 4) x = px - tw - 12;
  let y = py - th - 10;
  if (y < 0) y = py + 14;
  tip.style.left = Math.max(2, x) + "px";
  tip.style.top = y + "px";
}
function tipRow(tip, label, value, strongValue) {
  const r = el("div");
  if (strongValue) {
    r.appendChild(el("span", "v", value));
    if (label) { r.append(" "); r.append(label); }
  } else {
    r.append(label + (label ? " " : ""));
    r.appendChild(el("span", null, value));
  }
  tip.appendChild(r);
}

// Generic time-series line chart with crosshair + tooltip.
// pts: [{x(ms), y, tipLines:[{v,label,strong}]}] sorted by x
function lineChart(box, pts, { fmtY, height = 200 }) {
  clearChart(box);
  if (pts.length < 2) { box.appendChild(el("div", "empty", "Not enough data in this range.")); return; }
  const W = Math.max(box.clientWidth, 280), H = height;
  const M = { l: 40, r: 14, t: 12, b: 24 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys));
  const X = (v) => M.l + ((v - x0) / (x1 - x0 || 1)) * iw;
  const Y = (v) => M.t + (1 - (v - lo) / (hi - lo || 1)) * ih;

  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });

  for (const t of ticks) {
    svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: "var(--grid)", "stroke-width": 1 }));
    const txt = sv("text", { x: M.l - 7, y: Y(t) + 3.5, "text-anchor": "end" });
    txt.textContent = fmtY(t);
    svg.appendChild(txt);
  }
  svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(lo), y2: Y(lo), stroke: "var(--axis)", "stroke-width": 1 }));

  // x ticks: ~4 evenly spread
  const nT = Math.min(4, pts.length);
  const seen = new Set();
  for (let i = 0; i < nT; i++) {
    const p = pts[Math.round((i * (pts.length - 1)) / (nT - 1 || 1))];
    const lab = fmtTick(p.x);
    if (seen.has(lab)) continue;
    seen.add(lab);
    const anchor = i === 0 ? "start" : i === nT - 1 ? "end" : "middle";
    const txt = sv("text", { x: X(p.x), y: H - 7, "text-anchor": anchor });
    txt.textContent = lab;
    svg.appendChild(txt);
  }

  // area wash + line
  const dLine = pts.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
  const dArea = dLine + ` L ${X(pts[pts.length - 1].x).toFixed(1)} ${Y(lo)} L ${X(pts[0].x).toFixed(1)} ${Y(lo)} Z`;
  svg.appendChild(sv("path", { d: dArea, fill: "var(--series-wash)" }));
  svg.appendChild(sv("path", { d: dLine, fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // dots with surface ring
  const dots = [];
  for (const p of pts) {
    svg.appendChild(sv("circle", { cx: X(p.x), cy: Y(p.y), r: 5.5, fill: "var(--surface)" }));
    const d = sv("circle", { cx: X(p.x), cy: Y(p.y), r: 3.5, fill: "var(--series-1)" });
    svg.appendChild(d);
    dots.push(d);
  }

  // end label (selective direct label)
  const lastP = pts[pts.length - 1];
  const endTxt = sv("text", { x: X(lastP.x) - 4, y: Y(lastP.y) - 9, "text-anchor": "end", class: "dl" });
  endTxt.textContent = fmtY(lastP.y);
  svg.appendChild(endTxt);

  // crosshair + tooltip
  const cross = sv("line", { y1: M.t, y2: H - M.b, stroke: "var(--axis)", "stroke-width": 1, opacity: 0 });
  svg.appendChild(cross);
  const tip = makeTip(box);
  let hi_i = -1;
  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(X(p.x) - mx); if (d < bd) { bd = d; best = i; } });
    const p = pts[best];
    cross.setAttribute("x1", X(p.x)); cross.setAttribute("x2", X(p.x));
    cross.setAttribute("opacity", 1);
    if (hi_i >= 0) dots[hi_i].setAttribute("r", 3.5);
    dots[best].setAttribute("r", 5);
    hi_i = best;
    tip.textContent = "";
    for (const l of p.tipLines) tipRow(tip, l.label, l.v, l.strong);
    placeTip(tip, box, (X(p.x) / W) * rect.width, (Y(p.y) / H) * rect.height);
  }
  function onLeave() {
    cross.setAttribute("opacity", 0);
    tip.hidden = true;
    if (hi_i >= 0) dots[hi_i].setAttribute("r", 3.5);
    hi_i = -1;
  }
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerdown", onMove);
  svg.addEventListener("pointerleave", onLeave);
  box.appendChild(svg);
}

// Vertical bar chart (monthly). bars: [{label, y, tipLines}]
function barChart(box, bars, { fmtY, height = 200 }) {
  clearChart(box);
  if (!bars.length) { box.appendChild(el("div", "empty", "Not enough data in this range.")); return; }
  const W = Math.max(box.clientWidth, 280), H = height;
  const M = { l: 44, r: 8, t: 12, b: 24 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const { lo, hi, ticks } = niceTicks(0, Math.max(...bars.map((b) => b.y), 1));
  const Y = (v) => M.t + (1 - (v - lo) / (hi - lo || 1)) * ih;
  const band = iw / bars.length;
  const bw = Math.min(24, Math.max(3, band - 2)); // 2px surface gap between bars

  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  for (const t of ticks) {
    svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: "var(--grid)", "stroke-width": 1 }));
    const txt = sv("text", { x: M.l - 7, y: Y(t) + 3.5, "text-anchor": "end" });
    txt.textContent = fmtY(t);
    svg.appendChild(txt);
  }
  svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(0), y2: Y(0), stroke: "var(--axis)", "stroke-width": 1 }));

  const tip = makeTip(box);
  const rects = [];
  bars.forEach((b, i) => {
    const cx = M.l + band * i + band / 2;
    const x = cx - bw / 2;
    const yTop = Y(b.y), y0 = Y(0);
    const h = Math.max(y0 - yTop, 0);
    const r = Math.min(4, bw / 2, h); // rounded data-end, square baseline
    const d = h <= 0 ? "" :
      `M ${x} ${y0} L ${x} ${yTop + r} Q ${x} ${yTop} ${x + r} ${yTop} L ${x + bw - r} ${yTop} Q ${x + bw} ${yTop} ${x + bw} ${yTop + r} L ${x + bw} ${y0} Z`;
    const path = sv("path", { d, fill: "var(--series-1)" });
    svg.appendChild(path);
    rects.push(path);
    // hit area = full band height
    const hit = sv("rect", { x: M.l + band * i, y: M.t, width: band, height: ih, fill: "transparent" });
    hit.addEventListener("pointermove", (ev) => {
      rects.forEach((p) => p.setAttribute("opacity", 1));
      path.setAttribute("opacity", 0.75);
      tip.textContent = "";
      for (const l of b.tipLines) tipRow(tip, l.label, l.v, l.strong);
      const rect = svg.getBoundingClientRect();
      placeTip(tip, box, (cx / W) * rect.width, (yTop / H) * rect.height);
    });
    hit.addEventListener("pointerleave", () => { path.setAttribute("opacity", 1); tip.hidden = true; });
    svg.appendChild(hit);
  });

  // x labels: up to 6
  const every = Math.ceil(bars.length / 6);
  bars.forEach((b, i) => {
    if (i % every && i !== bars.length - 1) return;
    const txt = sv("text", { x: M.l + band * i + band / 2, y: H - 7, "text-anchor": "middle" });
    txt.textContent = b.label;
    svg.appendChild(txt);
  });
  box.appendChild(svg);
}

// Horizontal bars for station comparison. rows: [{label, y(price), n}]
function hbarChart(box, rows, { fmtY }) {
  clearChart(box);
  if (!rows.length) { box.appendChild(el("div", "empty", "Not enough data in this range.")); return; }
  const W = Math.max(box.clientWidth, 280);
  const rowH = 34, M = { l: 8, r: 52, t: 4, b: 4 };
  const H = M.t + M.b + rows.length * rowH;
  const iw = W - M.l - M.r;
  const maxV = Math.max(...rows.map((r) => r.y));
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  const tip = makeTip(box);
  rows.forEach((r, i) => {
    const yTop = M.t + i * rowH;
    const name = sv("text", { x: M.l, y: yTop + 12, "text-anchor": "start", fill: "var(--ink-2)" });
    name.textContent = r.label + "  ·  " + r.n + (r.n === 1 ? " visit" : " visits");
    svg.appendChild(name);
    const bw = Math.max((r.y / maxV) * iw, 2);
    const bh = 10, by = yTop + 17;
    const rad = Math.min(4, bh / 2, bw);
    const d = `M ${M.l} ${by} L ${M.l + bw - rad} ${by} Q ${M.l + bw} ${by} ${M.l + bw} ${by + rad} L ${M.l + bw} ${by + bh - rad} Q ${M.l + bw} ${by + bh} ${M.l + bw - rad} ${by + bh} L ${M.l} ${by + bh} Z`;
    svg.appendChild(sv("path", { d, fill: "var(--series-1)" }));
    const val = sv("text", { x: M.l + bw + 7, y: by + bh - 1, "text-anchor": "start", class: "dl" });
    val.textContent = fmtY(r.y);
    svg.appendChild(val);
    const hit = sv("rect", { x: 0, y: yTop, width: W, height: rowH, fill: "transparent" });
    hit.addEventListener("pointermove", () => {
      tip.textContent = "";
      tipRow(tip, "/L average", fmtY(r.y), true);
      tipRow(tip, "", `${r.label} · ${r.n} ${r.n === 1 ? "visit" : "visits"}`);
      const rect = svg.getBoundingClientRect();
      placeTip(tip, box, (M.l + bw) / W * rect.width, (yTop / H) * rect.height + 10);
    });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
    svg.appendChild(hit);
  });
  box.appendChild(svg);
}

/* ---------------- dashboard charts ---------------- */
function renderEconChart(all) {
  const pts = all
    .filter((e) => e.econ != null && inRange(e))
    .map((e) => ({
      x: Date.parse(e.date), y: e.econ,
      tipLines: [
        { v: e.econ.toFixed(2) + " L/100km", label: "", strong: true },
        { v: `${fmtNZDate(e.date)} · ${e.station}`, label: "" },
        { v: `${e.intervalLitres.toFixed(1)} L over ${fmtInt(e.intervalDist)} km`, label: "" },
      ],
    }));
  lineChart($("#chartEcon"), pts, { fmtY: (v) => v.toFixed(1) });
}

function renderPriceChart(fuel) {
  const pts = fuel.map((e) => ({
    x: Date.parse(e.date), y: e.price,
    tipLines: [
      { v: fmtMoney(e.price) + "/L", label: "", strong: true },
      { v: `${fmtNZDate(e.date)} · ${e.station || "—"}`, label: "" },
      { v: `${e.litres} L (${e.fuelType})`, label: "" },
    ],
  }));
  lineChart($("#chartPrice"), pts, { fmtY: (v) => "$" + v.toFixed(2) });
}

function renderSpendChart(fuel) {
  if (!fuel.length) { barChart($("#chartSpend"), [], { fmtY: (v) => "$" + v }); return; }
  const byMonth = new Map();
  for (const e of fuel) {
    const k = e.date.slice(0, 7);
    const m = byMonth.get(k) || { spend: 0, litres: 0, n: 0 };
    m.spend += e.cost; m.litres += e.litres; m.n++;
    byMonth.set(k, m);
  }
  // continuous month axis from first to last
  const keys = [...byMonth.keys()].sort();
  const bars = [];
  let [y, m] = keys[0].split("-").map(Number);
  const [ey, em] = keys[keys.length - 1].split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    const v = byMonth.get(k) || { spend: 0, litres: 0, n: 0 };
    bars.push({
      label: fmtMonth(k), y: v.spend,
      tipLines: [
        { v: fmtMoney(v.spend), label: "", strong: true },
        { v: `${fmtMonth(k)} · ${v.n} fill${v.n === 1 ? "" : "s"} · ${v.litres.toFixed(1)} L`, label: "" },
      ],
    });
    m++; if (m > 12) { m = 1; y++; }
  }
  barChart($("#chartSpend"), bars, { fmtY: (v) => "$" + fmtInt(v) });
}

function renderStationChart(fuel) {
  const agg = new Map();
  for (const e of fuel) {
    if (!e.station) continue;
    const a = agg.get(e.station) || { spend: 0, litres: 0, n: 0 };
    a.spend += e.cost; a.litres += e.litres; a.n++;
    agg.set(e.station, a);
  }
  const rows = [...agg.entries()]
    .map(([label, a]) => ({ label, y: a.spend / a.litres, n: a.n }))
    .sort((a, b) => a.y - b.y);
  hbarChart($("#chartStations"), rows, { fmtY: (v) => "$" + v.toFixed(2) });
}

function renderInsights(all, fuel) {
  const ul = $("#insightsList");
  ul.textContent = "";
  const add = (emoji, frag) => {
    const li = el("li");
    li.appendChild(el("span", "em", emoji));
    const d = el("div");
    d.append(...frag);
    li.appendChild(d);
    ul.appendChild(li);
  };
  const b = (t) => el("strong", null, t);
  if (!fuel.length) { add("·", ["No fills in this range."]); return; }

  // cheapest / priciest station (≥2 visits)
  const agg = new Map();
  for (const e of fuel) {
    if (!e.station) continue;
    const a = agg.get(e.station) || { spend: 0, litres: 0, n: 0 };
    a.spend += e.cost; a.litres += e.litres; a.n++;
    agg.set(e.station, a);
  }
  const multi = [...agg.entries()].filter(([, a]) => a.n >= 2)
    .map(([s, a]) => ({ s, p: a.spend / a.litres, n: a.n }))
    .sort((a, b) => a.p - b.p);
  if (multi.length >= 2) {
    const lo = multi[0], hi2 = multi[multi.length - 1];
    add("⛽", [b(lo.s), ` is your cheapest regular station at `, b(fmtMoney(lo.p) + "/L"),
      ` — ${fmtMoney(hi2.p - lo.p)}/L less than ${hi2.s}. On a 28 L tank that's about `,
      b(fmtMoney((hi2.p - lo.p) * 28)), ` per fill.`]);
  }
  const most = [...agg.entries()].sort((a, b2) => b2[1].n - a[1].n)[0];
  if (most) add("📍", [`Most visited: `, b(most[0]), ` (${most[1].n} of ${fuel.length} fills).`]);

  // best & worst tank
  const ivals = fuel.filter((e) => e.econ != null).sort((a, b2) => a.econ - b2.econ);
  if (ivals.length >= 2) {
    const best = ivals[0], worst = ivals[ivals.length - 1];
    add("🌿", [`Best tank: `, b(best.econ.toFixed(2) + " L/100km"), ` (${fmtNZDate(best.date)}). Thirstiest: `,
      b(worst.econ.toFixed(2)), ` (${fmtNZDate(worst.date)}).`]);
  }

  // cadence
  const dates = fuel.map((e) => Date.parse(e.date)).sort((a, b2) => a - b2);
  if (dates.length >= 3) {
    const days = (dates[dates.length - 1] - dates[0]) / 86400000 / (dates.length - 1);
    const spend = fuel.reduce((s, e) => s + e.cost, 0);
    const months = (dates[dates.length - 1] - dates[0]) / 86400000 / 30.44;
    add("🗓", [`You fill up every `, b(Math.round(days) + " days"), ` on average — about `,
      b(fmtMoney(months > 0.5 ? spend / months : spend, 0)), ` per month on petrol.`]);
  }

  // 91 vs 95 comparison (lifetime, needs both)
  const by = {};
  for (const e of all.filter((x) => !isBaseline(x) && x.econ != null)) {
    (by[e.fuelType] = by[e.fuelType] || []).push(e);
  }
  const types = Object.keys(by).filter((t) => by[t].length >= 3);
  if (types.length >= 2) {
    const stats = types.map((t) => {
      const d = by[t].reduce((s, e) => s + e.intervalDist, 0);
      const l = by[t].reduce((s, e) => s + e.intervalLitres, 0);
      return { t, econ: (l / d) * 100, n: by[t].length };
    }).sort((a, b2) => a.econ - b2.econ);
    add("🧪", [`Across all your data, `, b(stats[0].t), ` averaged `, b(stats[0].econ.toFixed(2) + " L/100km"),
      ` vs ${stats.map((s) => s.t + " " + s.econ.toFixed(2)).slice(1).join(", ")} — worth comparing against the price gap.`]);
  }
}

/* ---------------- data tab: export / import ---------------- */
function toCSV() {
  const head = "Date,Station,Odometer (km),Petrol type,Price per litre,Litres,Partial,Total cost,Distance (km),L per 100 km";
  const esc = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const lines = derived().map((e) => [
    e.date, esc(e.station || ""), e.odometer, e.fuelType || "",
    e.price ?? "", e.litres ?? "", isBaseline(e) ? "" : (e.partial ? "yes" : "no"),
    isBaseline(e) ? "" : e.cost.toFixed(2), e.dist ?? "", e.econ != null ? e.econ.toFixed(2) : "",
  ].join(","));
  return head + "\n" + lines.join("\n") + "\n";
}
function csvFileName() {
  return "fuel-log-" + new Date().toISOString().slice(0, 10) + ".csv";
}
function exportCSV() {
  const blob = new Blob([toCSV()], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = csvFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("CSV downloaded");
}
async function shareCSV() {
  const file = new File([toCSV()], csvFileName(), { type: "text/csv" });
  try {
    await navigator.share({ files: [file], title: "Fuel Log export" });
  } catch (e) { /* user cancelled the share sheet */ }
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}
function parseDateCell(s) {
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error("No data rows found");
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (name) => head.findIndex((h) => h.startsWith(name));
  const iDate = col("date"), iStation = col("station"), iOdo = col("odometer"),
    iType = col("petrol type"), iPrice = col("price"), iLitres = col("litres"), iPartial = col("partial");
  if (iDate < 0 || iOdo < 0 || iLitres < 0) throw new Error("Missing Date / Odometer / Litres columns");
  const out = [];
  for (const r of rows.slice(1)) {
    const date = parseDateCell(r[iDate] || "");
    if (!date) continue;
    const odo = Math.round(parseFloat(r[iOdo]));
    if (!(odo >= 0)) continue;
    const litres = parseFloat(r[iLitres]);
    out.push({
      id: uid(), date,
      station: iStation >= 0 ? (r[iStation] || "").trim() : "",
      odometer: odo,
      fuelType: iType >= 0 ? (r[iType] || "").trim() : "",
      price: iPrice >= 0 && r[iPrice] !== "" ? parseFloat(String(r[iPrice]).replace(/[$\s]/g, "")) : null,
      litres: Number.isFinite(litres) ? litres : null,
      partial: iPartial >= 0 ? /^(yes|true|1)$/i.test((r[iPartial] || "").trim()) : false,
    });
  }
  if (!out.length) throw new Error("No valid rows found");
  return out;
}

function renderData() {
  const fuel = entries.filter((e) => !isBaseline(e));
  $("#dataSummary").textContent =
    `${entries.length} records on this device (${fuel.length} fills).`;
  $("#shareBtn").hidden = !(navigator.share && navigator.canShare &&
    navigator.canShare({ files: [new File(["x"], "x.csv", { type: "text/csv" })] }));
}

/* ---------------- theme ---------------- */
function applyTheme() {
  const t = localStorage.getItem(LS_THEME) || "auto";
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const cur = localStorage.getItem(LS_THEME) || "auto";
  const next = order[(order.indexOf(cur) + 1) % order.length];
  localStorage.setItem(LS_THEME, next);
  applyTheme();
  toast("Theme: " + next);
  if (currentTab === "dash") renderDash();
}

/* ---------------- wire up ---------------- */
function init() {
  load();
  applyTheme();

  document.querySelectorAll(".tabbar button").forEach((b) =>
    b.addEventListener("click", () => {
      if (editingId && b.dataset.tab !== "add") { editingId = null; }
      switchTab(b.dataset.tab);
    }));

  $("#fillForm").addEventListener("submit", onSubmitFill);
  document.querySelectorAll("#fuelSeg button").forEach((b) =>
    b.addEventListener("click", () => setFuelType(b.dataset.v)));
  ["fLitres", "fPrice", "fOdo", "fPartial"].forEach((id) =>
    $("#" + id).addEventListener("input", updateLiveCalc));
  $("#cancelEditBtn").addEventListener("click", () => { editingId = null; switchTab("history"); });
  $("#deleteBtn").addEventListener("click", () => {
    if (!editingId) return;
    const e = entries.find((x) => x.id === editingId);
    if (confirm(`Delete the ${fmtNZDate(e.date)} fill at ${e.station || "unknown station"}?`)) {
      entries = entries.filter((x) => x.id !== editingId);
      save();
      editingId = null;
      toast("Fill deleted");
      switchTab("history");
    }
  });

  $("#themeBtn").addEventListener("click", cycleTheme);
  $("#exportBtn").addEventListener("click", exportCSV);
  $("#shareBtn").addEventListener("click", shareCSV);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    try {
      const imported = importCSV(await f.text());
      if (confirm(`Replace the ${entries.length} records on this device with ${imported.length} imported records?`)) {
        entries = imported;
        save();
        toast("Imported " + imported.length + " records");
        renderData();
      }
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });
  $("#wipeBtn").addEventListener("click", () => {
    if (confirm("Erase ALL fuel data from this device? Consider exporting a CSV first.") &&
        confirm("Really erase everything? This cannot be undone.")) {
      entries = [];
      save();
      toast("All data erased");
      renderData();
    }
  });

  let rT = null;
  window.addEventListener("resize", () => {
    clearTimeout(rT);
    rT = setTimeout(() => { if (currentTab === "dash") renderDash(); }, 200);
  });

  switchTab("add");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
