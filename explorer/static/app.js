import { createMap } from "./map3d.js?v=82";
import { createScatter } from "./scatter.js?v=39";
import { $, api, esc, fmtDose, bus, tokPrefs, tokChips, tokText } from "./common.js?v=2";

let agentSelecting = false, agentMarked = false;  // Claude's selections and marks (see agentUi); declared early, openNeuron reads them on load
const state = { layer: null, units: {}, unitMap: {}, focus: null, view: "map" };

const index = await api("/api/index");
const arch = index.arch;
const tip = $("#tip");

// ---------- map ----------
const map = createMap($("#map"), $("#layer-labels"), arch, {
  onPick: (layer, n) => openNeuron(layer, n, "neuron", true, false),
  onPickHead: (layer, head) => openHead(layer, head),
  onPickLayer: l => { if (l !== state.layer) { layerSel.value = l; setLayer(l); } },
  onLayerMode: l => {
    $("#layer-back").classList.toggle("on", l !== null);
    $("#layer-back").textContent = l !== null ? `‹ all layers  ·  L${l}` : "";
    if (l !== null && l !== state.layer) setLayer(l);
  },
  onHover: (p, x, y) => {
    if (!p) return hideTip();
    if (p.type === "head") {
      if (hoverKey !== `h/${p.layer}/${p.head}`) map.setHoverConnections(null);
      const key = `h/${p.layer}/${p.head}`, head = `L${p.layer} h${p.head}`;
      const body = () => {
        const h = hoverCache.get(key);
        const side = (sg, list) => list.slice(0, 3).map(c => `<div class="tl"><span class="sgn">${sg}</span><span class="faint">L${c.layer} N${c.n}</span>  ${state.unitMap[c.layer]?.get(c.n)?.name ? esc(state.unitMap[c.layer].get(c.n).name) : tokText(c.lens || [], 4)}</div>`).join("");
        return h ? side("←", h.reads) + side("→", h.writes) : "";
      };
      showTipHTML(x, y, head, body());
      clearTimeout(hoverTimer);
      hoverKey = key;
      hoverTimer = setTimeout(async () => {
        if (!hoverCache.has(key)) hoverCache.set(key, await api(`/api/head?layer=${p.layer}&head=${p.head}`));
        if (hoverKey !== key) return;
        const h = hoverCache.get(key);
        if (!(state.focus && (state.focus.kind === "neuron" || state.focus.kind === "head")))
          map.setHoverHead(p.layer, p.head, headRoleLinks(h));
        showTipHTML(x, y, head, body());
      }, 120);
      return;
    }
    if (p.type === "block") {
      if (hoverKey) { hoverKey = null; map.setHoverConnections(null); }
      const full = p.full;
      return showTip(x, y, `L${p.layer}`, full ? `full attention · ${arch.attn_heads} q / ${arch.kv_heads} kv heads` : `linear attention · ${arch.linear_k_heads} k / ${arch.linear_v_heads} v heads`);
    }
    const u = state.unitMap[p.layer]?.get(p.n), key = `${p.layer}/${p.n}`;
    const head = `L${p.layer} N${p.n}${u ? `  mass ${u.z.toFixed(1)}` : ""}`;
    const body = () => {
      const h = hoverCache.get(key), rows = [];
      if (u?.name) rows.push(`<div class="tname">${esc(u.name)}</div>`);
      if (u) rows.push(`<div class="twords">${esc(u.words.join("  "))}</div>`);
      if (h && h.steer) rows.push(`<div class="tl"><span class="sgn up">+</span>${tokText(h.steer)}</div><div class="tl"><span class="sgn down">−</span>${tokText(h.steer_neg)}</div>`);
      if (h) rows.push(`<div class="tl faintline"><span class="sgn up">+</span>${tokText(h.lens)}</div><div class="tl faintline"><span class="sgn down">−</span>${tokText(h.lens_neg)}</div>`);
      const nh = hoverCache.get(`nh/${key}`);
      if (nh) {
        const top = roleHeads(nh), into = top.filter(k => k.role === "o").slice(0, 3), from = top.filter(k => k.role !== "o").slice(0, 4);
        if (into.length) rows.push(`<div class="tl faintline"><span class="sgn">←</span>${into.map(k => `L${k.layer} h${k.head}`).join("  ")}</div>`);
        if (from.length) rows.push(`<div class="tl faintline"><span class="sgn">→</span>${from.map(k => `${k.role} L${k.layer} h${k.head}`).join("  ")}</div>`);
      }
      return rows.join("");
    };
    showTipHTML(x, y, head, body());
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      const [hv, nh] = await Promise.all([hoverCache.get(key) || api(`/api/hover?layer=${p.layer}&n=${p.n}`),
        hoverCache.get(`nh/${key}`) || api(`/api/neuron/heads?layer=${p.layer}&n=${p.n}`)]);
      hoverCache.set(key, hv); hoverCache.set(`nh/${key}`, nh);
      if (hoverKey !== key) return;
      // with a neuron or head open, hover only shows the tooltip; its links and web stay on screen
      if (!(state.focus && (state.focus.kind === "neuron" || state.focus.kind === "head"))) map.setHoverConnections({ layer: p.layer, n: p.n }, hoverCache.get(key).con);
      showTipHTML(x, y, head, body());
    }, 120);
    hoverKey = key;
  },
});
// a neuron's heads over all four roles (/api/neuron/heads roles), strongest first, each head once
const roleHeads = r => {
  const seen = new Set();
  return ["q", "k", "v", "o"].flatMap(role => (r.roles?.[role] || []).map(x => ({ ...x, role }))).filter(x => x.z >= 3)
    .sort((a, b) => b.z - a.z).filter(x => !seen.has(`${x.layer}/${x.head}`) && seen.add(`${x.layer}/${x.head}`));
};
function showTip(x, y, head, body) { showTipHTML(x, y, head, esc(body)); }
function showTipHTML(x, y, head, html) {
  tip.innerHTML = `<div class="lab">${esc(head)}</div>${html}`;
  tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(y + 14, innerHeight - r.height - 8)}px`;
}
function hideTip() {
  tip.style.display = "none";
  if (hoverKey) { hoverKey = null; clearTimeout(hoverTimer); map.setHoverConnections(null); }
}
let hoverTimer, hoverKey = null;
const hoverCache = new Map();
// tip lives in the embed view section; lift it to body so the map can use it too
document.body.appendChild(tip);

// ---------- sheet layout ----------
const layouts = {};
let wantLayout = null;
async function setLayout(kind) {
  wantLayout = kind;
  document.querySelectorAll("#layout-mode button").forEach(b => b.classList.toggle("on", b.dataset.k === kind));
  if (kind === "index") { map.setLayout(null); return; }
  if (!layouts[kind]) {
    const r = await api(`/api/layout?kind=${kind}`);
    if (wantLayout !== kind) return;
    if (!r.available) { document.querySelectorAll("#layout-mode button").forEach(b => b.classList.toggle("on", b.dataset.k === "index")); map.setLayout(null); return; }
    const bin = atob(r.cell), a = new Int16Array(bin.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    layouts[kind] = a;
  }
  map.setLayout(layouts[kind]);
}
document.querySelectorAll("#layout-mode button").forEach(b => b.onclick = () => setLayout(b.dataset.k));
setLayout("writes");

// connection web of the focused neuron: downstream cone forward, upstream cone backward
let webOn = true, webKey = null;
async function refreshWeb() {
  document.querySelectorAll("#web-mode button").forEach(b => b.classList.toggle("on", (b.dataset.w === "on") === webOn));
  const f = state.focus, first = Math.max(1, Math.min(24, Math.round(Number($("#web-z").value) || 5)));
  const k = Number(new URLSearchParams(location.search).get("webk")) || 2;
  const hops = Number(new URLSearchParams(location.search).get("webhops")) || 0;  // hops out each way; 0 = all the way
  if (!webOn || !f || f.kind !== "neuron") { webKey = null; state.webSum = null; map.setWeb(null); renderList(); return; }
  const key = `${f.layer}/${f.n}/${first}/${k}/${hops}`;
  if (key === webKey) return;
  webKey = key;
  const r = await fetch(`/api/web?layer=${f.layer}&n=${f.n}&first=${first}&k=${k}&hops=${hops}`);
  if (!r.ok || webKey !== key) return;
  $("#web-z").title = `web: the open neuron's top links each way (later hops follow ${k}) · ${r.headers.get("X-Web-Total")} links`;
  map.setWeb(new Int16Array(await r.arrayBuffer()));
  const sum = await api(`/api/web/summary?layer=${f.layer}&n=${f.n}&first=${first}&k=${k}&hops=${hops}&top=24`);
  if (webKey !== key) return;
  state.webSum = { ...sum, layer: f.layer, n: f.n, links: r.headers.get("X-Web-Total") };
  renderList();
}
document.querySelectorAll("#web-mode button").forEach(b => b.onclick = () => { webOn = b.dataset.w === "on"; webKey = null; refreshWeb(); });
$("#web-z").onchange = () => refreshWeb();

// ---------- scatter ----------
const scatter = createScatter($("#scatter"), {
  onPick: i => { const d = scatter.data; if (d.kind[i] === "neuron") openNeuron(d.layer, d.neuron[i]); },
  onHover: async (i, x, y) => {
    if (i < 0) { scatterHover = null; return hideTip(); }
    const d = scatter.data, layer = d.layer, key = `${layer}/${d.row[i]}`;
    const head = `${d.kind[i] === "baseline" ? "baseline" : (d.kind[i] === "random" ? "random " : "N") + d.neuron[i]} · ${d.prompt[i]} · ${fmtDose(d.dose[i])}`;
    scatterHover = key;
    if (rolloutCache.has(key)) return showTip(x, y, head, rolloutCache.get(key));
    showTip(x, y, head, "…");
    const r = await api(`/api/rollout?layer=${layer}&i=${d.row[i]}`);
    rolloutCache.set(key, r.text.slice(0, 500));
    if (scatterHover === key && state.view === "embed") showTip(x, y, head, rolloutCache.get(key));
  },
});
let scatterHover = null;
const rolloutCache = new Map();
document.querySelectorAll("#color-by button").forEach(b => b.onclick = () => {
  document.querySelectorAll("#color-by button").forEach(x => x.classList.toggle("on", x === b));
  scatter.setColorBy(b.dataset.c);
});

// ---------- views / layer ----------
document.querySelectorAll("#views button").forEach(b => b.onclick = () => setView(b.dataset.view));
function setView(v) {
  state.view = v;
  document.querySelectorAll("#views button").forEach(x => x.classList.toggle("on", x.dataset.view === v));
  $("#map-view").classList.toggle("on", v === "map");
  $("#embed-view").classList.toggle("on", v === "embed");
  if (v === "embed") loadEmbeddings();
}
const layerSel = $("#layer");
for (let l = 0; l < arch.n_layers; l++) {
  const o = document.createElement("option"); o.value = l;
  o.textContent = `L${l}${index.layers[l] ? "" : " ·"}`;
  layerSel.appendChild(o);
}
layerSel.onchange = () => { setLayer(+layerSel.value); map.enterLayer(+layerSel.value); };

async function setLayer(l) {
  state.layer = l; layerSel.value = l;
  if (scatter.data && scatter.data.layer !== l) { scatter.setData(null); hideTip(); }
  try { localStorage.setItem("ne.layer", l); } catch {}
  if (!state.units[l]) {
    if (!lensResults) $("#rows").innerHTML = `<li class="head">…</li>`;
    const us = index.layers[l] ? await api(`/api/units?layer=${l}`) : [];
    state.units[l] = us;
    state.unitMap[l] = new Map(us.filter(u => u.kind === "neuron").map(u => [u.n, u]));
    if (state.layer !== l) return;
  }
  if (state.units[l].length) map.setUnits(l, state.units[l]);
  renderList();
  if (state.view === "embed") loadEmbeddings();
}
async function loadEmbeddings() {
  const l = state.layer;
  $("#embed-empty").textContent = "…";
  const d = index.layers[l] ? await api(`/api/embeddings?layer=${l}`) : {};
  if (state.layer !== l) return;
  $("#embed-empty").textContent = d.x ? "" : "—";
  scatter.setData(d.x ? { ...d, layer: l } : null);
  scatter.select(state.layer, state.focus?.layer === state.layer ? state.focus.n : null);
}

// ---------- left panel: net (the open neuron's web, then the list) | run (text through the model) ----------
let leftTab = "net";
document.querySelectorAll("#ltabs button[data-lt]").forEach(b => b.onclick = () => showLeft(b.dataset.lt));
function showLeft(t) {
  if (t === leftTab) return;
  leftTab = t;
  document.querySelectorAll("#ltabs button[data-lt]").forEach(b => b.classList.toggle("on", b.dataset.lt === t));
  $("#lt-net").classList.toggle("on", t === "net"); $("#lt-run").classList.toggle("on", t === "run");
  $(`#ltabs button[data-lt="${t}"]`).classList.remove("fresh");
  syncLeftMap();
}
// a tab whose contents changed while hidden (Claude ran text, or searched) gets a dot until opened
function markLeftFresh(t) { if (t !== leftTab) $(`#ltabs button[data-lt="${t}"]`).classList.add("fresh"); }
// the map shows what the open tab shows: lens hits and the open neuron's web on net, what fired on run
function syncLeftMap() {
  lightHeads(state.inf.pos);
  if (leftTab === "run" && state.inf.text) { inferView(); showTokenPaths(state.inf.pos); return; }
  map.setMarks(leftTab === "net" && lensResults?.results ? lensResults.results : []);
  if (String(webKey).startsWith("tok/")) { webKey = null; refreshWeb(); }
}

// ---------- lens search ----------
let lensTimer, lensResults = null, fireResults = null;
$("#lens-q").addEventListener("input", e => {
  if (e.isTrusted) showLeft(state.qMode === "fires" ? "run" : "net");
  clearTimeout(lensTimer);
  lensTimer = setTimeout(runLensSearch, state.qMode === "fires" ? 700 : 250);
});
state.qMode = "lens";
document.querySelectorAll("#q-mode button").forEach(b => b.onclick = e => {
  state.qMode = b.dataset.q;
  document.querySelectorAll("#q-mode button").forEach(x => x.classList.toggle("on", x === b));
  $("#lens-q").placeholder = state.qMode === "fires" ? "Run text, e.g. golden gate bridge" : "Search lens tokens…";
  if (e.isTrusted) {
    showLeft(state.qMode === "fires" ? "run" : "net");
    if (state.qMode === "fires" && document.activeElement !== $("#inf-text")) $("#inf-text").focus();
  }
  runLensSearch();
});
// the paste box in the list drives the same search as the header box
$("#inf-text").addEventListener("input", () => {
  if (state.qMode !== "fires") $('#q-mode button[data-q="fires"]').click();  // typing here means fires mode
  $("#lens-q").value = $("#inf-text").value; $("#lens-q").dispatchEvent(new Event("input"));
});
$("#lens-q").addEventListener("input", () => { if (state.qMode === "fires" && document.activeElement === $("#lens-q")) $("#inf-text").value = $("#lens-q").value; });
// fires: run text through the model once, then filter what fired without re-running
state.inf = { text: null, pos: -1, sign: "both" };
let qGen = 0;
const stillWanted = (g, mode, q) => g === qGen && state.qMode === mode && $("#lens-q").value.trim() === q;
async function runInfer(text, g) {
  markLeftFresh("run");
  if (text !== state.inf.text) {
    $("#run-rows").innerHTML = `<li class="head">running…</li>`;
    const r = await api("/api/infer", { text });
    if (!stillWanted(g, "fires", text)) return;
    if (!r.ready) { $("#run-rows").innerHTML = `<li class="head">${esc(state.statusText || "measuring neuron ranges")}</li>`; return; }
    state.inf = { ...state.inf, text, pos: -1, tokens: r.tokens };
    $("#inf-toks").innerHTML = r.tokens.map((t, i) => `<button data-i="${r.pos[i]}">${esc(t)}</button>`).join("");
  }
  await inferView(g);
}
// hovering a token previews it: its strongest neurons marked on the map, and the direct links among them as the web;
// clicking pins it; leaving the tokens goes back to the pinned token (or none) and the open neuron's web
let tokHover = null, tokTimer;
async function showTokenPaths(pos) {
  if (pos < 0) { webKey = null; return refreshWeb(); }
  if (leftTab !== "run") return;
  const r = await fetch(`/api/infer/paths?pos=${pos}&min=${$("#inf-min").value || 1}`);
  if (!r.ok || (tokHover ?? state.inf.pos) !== pos) return;
  webKey = `tok/${pos}`;
  map.setWeb(new Int16Array(await r.arrayBuffer()));
}
function previewToken(pos) {
  const keep = state.inf.pos;
  state.inf.pos = pos; inferView(); state.inf.pos = keep;
  showTokenPaths(pos); lightHeads(pos);
}
// on run, the head lines light by how much each head writes at the token (pinned or hovered), and with a head open
// the token chips shade by where that head reads from there
let headsGen = 0;
async function lightHeads(pos) {
  const g = ++headsGen, f = state.focus;
  const on = leftTab === "run" && state.inf.text && pos >= 0;
  const r = on ? await api(`/api/infer/heads?pos=${pos}`) : null;
  if (g !== headsGen) return;
  if (r?.layers) map.setHeadLevels(r.layers.map(row => row.map(v => Math.max(0, (v - 0.15) / 0.6))));
  else if (f?.kind === "neuron" && state.nheads?.layer === f.layer && state.nheads.n === f.n) {
    const lv = [];
    for (const [l, zs] of Object.entries(state.nheads.layers)) lv[+l] = zs.map(z => Math.max(0, Math.min(1, (z - 2.5) / 5)));
    map.setHeadLevels(lv);
  } else map.setHeadLevels(null);
  shadeTokens(on ? pos : -1);
}
let shadeGen = 0;
async function shadeTokens(pos) {
  const g = ++shadeGen, f = state.focus, btns = [...document.querySelectorAll("#inf-toks button")];
  const r = pos >= 0 && f?.kind === "head" ? await api(`/api/head/row?layer=${f.layer}&head=${f.n}&pos=${pos}`) : null;
  if (g !== shadeGen) return;
  btns.forEach((b, i) => {
    const w = r?.units?.[i];
    b.style.background = w == null || b.classList.contains("on") ? "" :
      `rgba(${w >= 0 ? "255,181,71" : "255,79,154"},${Math.min(0.85, Math.abs(w) * 1.6).toFixed(3)})`;
    b.style.color = w != null && Math.abs(w) > 0.3 && !b.classList.contains("on") ? "#000" : "";
  });
}
$("#inf-toks").addEventListener("pointerover", e => {
  const b = e.target.closest("button"); if (!b || tokHover === +b.dataset.i) return;
  tokHover = +b.dataset.i; clearTimeout(tokTimer);
  tokTimer = setTimeout(() => previewToken(tokHover), 90);
});
$("#inf-toks").addEventListener("pointerleave", () => {
  clearTimeout(tokTimer); tokHover = null;
  inferView(); showTokenPaths(state.inf.pos); lightHeads(state.inf.pos);
});
$("#inf-toks").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  state.inf.pos = state.inf.pos === +b.dataset.i ? -1 : +b.dataset.i;
  document.querySelectorAll("#inf-toks button").forEach(x => x.classList.toggle("on", +x.dataset.i === state.inf.pos));
  inferView(); showTokenPaths(state.inf.pos); lightHeads(state.inf.pos);
});
document.querySelectorAll("#inf-sign button").forEach(b => b.onclick = () => {
  state.inf.sign = b.dataset.s;
  document.querySelectorAll("#inf-sign button").forEach(x => x.classList.toggle("on", x === b));
  inferView();
});
let infTimer;
for (const id of ["#inf-lo", "#inf-hi", "#inf-min", "#inf-q"]) $(id).addEventListener("input", () => { clearTimeout(infTimer); infTimer = setTimeout(inferView, 200); });
let viewGen = 0;
async function inferView(g = qGen) {
  const f = state.inf, mine = ++viewGen;
  if (!f.text) return;
  const qs = new URLSearchParams({ pos: f.pos, sign: f.sign, lo: $("#inf-lo").value || 0, hi: $("#inf-hi").value || 99,
    min: $("#inf-min").value || 0, q: $("#inf-q").value, limit: 300 });
  const r = await api(`/api/infer/view?${qs}`);
  if (mine !== viewGen || g !== qGen || state.qMode !== "fires") return;
  const marks = [];
  if (r.map) {
    const bin = atob(r.map), u16 = new Uint16Array(bin.length / 2);
    for (let i = 0; i < u16.length; i++) u16[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    const N = r.shape[1];
    for (let i = 0; i < u16.length; i++) {
      if (!u16[i]) continue;
      const v = halfToFloat(u16[i]);
      if (v) marks.push({ layer: Math.floor(i / N), n: i % N, sign: v < 0 ? "-" : "+", w: Math.min(1, 0.25 + Math.abs(v) / 4) });
    }
  }
  if (leftTab === "run") map.setMarks(marks.length > 40000 ? marks.sort((a, b) => b.w - a.w).slice(0, 40000) : marks);
  fireResults = { ...r, fires: true, ready: true };
  renderResults(fireResults, $("#run-rows"));
}
function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}

async function runLensSearch() {
  const q = $("#lens-q").value.trim(), g = ++qGen;
  if (q.length < 2) {
    // an emptied box clears both: lens hits, and the last run with its token chips, pinned token and token web
    lensResults = null; fireResults = null;
    state.inf = { ...state.inf, text: null, pos: -1, tokens: null };
    $("#inf-toks").innerHTML = ""; $("#run-rows").innerHTML = "";
    syncLeftMap(); renderList(); return;
  }
  if (state.qMode === "fires") return runInfer(q, g);
  const r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=400`);
  if (!stillWanted(g, "lens", q)) return;
  lensResults = r;
  if (leftTab === "net") map.setMarks(r.results || []); else markLeftFresh("net");
  if ($("#list").classList.contains("hidden")) setListHidden(false);
  renderList();
}

// ---------- list ----------
$("#filter").oninput = renderList;
$("#show-random").onchange = renderList;
// what the open neuron's web says: lens tokens pooled over its cone (see /api/web/summary); click a token to search it
function webSummaryHTML() {
  const w = state.webSum, f = state.focus;
  if (!w || !f || f.kind !== "neuron" || w.layer !== f.layer || w.n !== f.n) return "";
  const chips = list => list.length ? tokChips(list, { tip: t => `${t.n} neurons in the web carry it${t.w != null ? ` · score ${t.w}` : ""} · click to search the lens` })
    : `<span class="faint">nothing above chance</span>`;
  const sec = (sw, label, tip, list) => `<div class="wsum"><div class="lab" title="${esc(tip)}"><span class="sw ${sw}"></span>${label}</div><div class="chips">${chips(list)}</div></div>`;
  return `<div class="head" title="The neuron's web: its strongest direct weight links, chained up and downstream. Tokens below pool the linked neurons' ${w.src} lenses, ranked by how much more often the web carries them than chance; the number on a chip is how many web neurons carry it.">web of L${w.layer} N${w.n} · ${w.links} links · ${w.src} lens, ranked by lift over each layer</div>`
    + sec("up", `fed by · ${w.up.neurons} upstream neurons`, "Earlier neurons whose output excites this neuron (raises its activation), shown by what their lenses say.", w.up.fed_by)
    + sec("down", "held back by", "Earlier neurons whose output inhibits this neuron (lowers its activation).", w.up.held_by || [])
    + sec("up", `feeds → pushes toward · ${w.down.neurons} downstream neurons`, "When this neuron fires, the later neurons it drives push the model toward these tokens.", w.down.toward)
    + sec("down", "feeds → pushes away from", "When this neuron fires, the later neurons it drives push the model away from these tokens.", w.down.away);
}
// the open neuron's heads by role: later heads whose query, key or value reads it, and heads whose output it reads
function nheadsHTML() {
  const H = state.nheads, f = state.focus;
  if (!H?.roles || !f || f.kind !== "neuron" || H.layer !== f.layer || H.n !== f.n) return "";
  const name = x => `L${x.layer} h${x.heads.length > 1 ? `${x.heads[0]}–${x.heads.at(-1)}` : x.head}`;
  const ROLE_TIP = { q: "q: later heads whose query reads this neuron's output (it shapes what they look for from its token)",
    k: "k: later heads whose key reads its output (it makes its token findable)",
    v: "v: later heads whose value reads its output (they carry it on to other tokens)",
    o: "o: heads at this layer or earlier whose output this neuron reads" };
  const row = r => `<div class="lrow" title="${ROLE_TIP[r]}"><span class="sgn">${r}</span><div class="chips">${(H.roles[r] || []).filter(x => x.z >= 2).map(x =>
    `<span class="chip" data-l="${x.layer}" data-h="${x.head}" title="${name(x)} · z ${x.z} against the other heads · click to open the head">${name(x)}<i>${x.z}</i></span>`).join("")}</div></div>`;
  return `<div class="wsum"><div class="lab" title="Attention heads that meet this neuron, from weights alone. The number on a chip is a z-score against the other heads (higher = more of the neuron's direction in that head's space).">heads</div>${["q", "k", "v", "o"].map(row).join("")}</div>`;
}
// the open neuron's own lenses (what it writes), above its web (what its cone does)
function lensHTML() {
  const L = state.lens, f = state.focus;
  if (!L || !f || f.kind !== "neuron" || L.layer !== f.layer || L.n !== f.n) return "";
  const chips = ts => tokChips(ts, { max: 12, tip: () => "click to search the lens" });
  const pair = (up, down) => `<div class="lrow" title="+ : the neuron pushed up (fires positive)"><span class="sgn up">+</span><div class="chips">${chips(up)}</div></div>
    <div class="lrow" title="− : the neuron pushed down (fires negative)"><span class="sgn down">−</span><div class="chips">${chips(down)}</div></div>`;
  return (L.steer_up ? `<div class="wsum"><div class="lab" title="Steer lens: the next tokens that gain the most probability when this neuron is pushed up (+) or down (−) by ${L.dose ?? 0.8}× the residual norm, through every later layer. KL (+ / −) is how much each push changes the prediction.">steer lens · KL ${L.kl_up} / ${L.kl_down}</div>${pair(L.steer_up, L.steer_down)}</div>` : "")
    + `<div class="wsum"><div class="lab" title="Logit lens: the tokens this neuron's output direction points at directly through the unembedding, ignoring every later layer. + when it fires positive, − when negative.">logit lens</div>${pair(L.up, L.down)}</div>`;
}
// a head's strongest neurons in each role, as map links
const ROLE_COL = { q: "#73ff8c", k: "#b399ff", v: "#66d9ff", o: "#66d9ff" };
const headRoleLinks = h => [["q", h.q], ["k", h.k], ["v", h.reads], ["o", h.writes]]
  .flatMap(([role, list]) => (list || []).slice(0, 5).map(c => ({ ...c, role, side: role === "o" ? "down" : "up" })));
// the open head by role: the neurons feeding its query, key and value (earlier) and reading its output (later), each
// with its own lens tokens
function headHTML() {
  const H = state.headInfo, f = state.focus;
  if (!H || !f || f.kind !== "head" || H.layer !== f.layer || H.head !== f.n) return "";
  const line = c => { const nm = state.unitMap[c.layer]?.get(c.n)?.name;
    return `<div class="nline" data-nl="${c.layer}" data-nn="${c.n}"><span class="id">L${c.layer} N${c.n}</span>`
      + `<span class="w">${nm ? `<b>${esc(nm)}</b> ` : ""}${tokText(c.lens || [], 4)}</span><span class="z" title="link strength, z-score">${c.z.toFixed(0)}</span></div>`; };
  const role = (r, list) => `<div class="wsum"><div class="lab"><span class="sw" style="background:${ROLE_COL[r]}"></span>${r}</div>${(list || []).slice(0, 10).map(line).join("")}</div>`;
  return role("q", H.q) + role("k", H.k) + role("v", H.reads) + role("o", H.writes);
}
function renderList() {
  $("#net").innerHTML = headHTML() || lensHTML() + webSummaryHTML() + nheadsHTML();
  if (lensResults) return renderResults(lensResults, $("#rows"));
  const q = $("#filter").value.trim().toLowerCase(), showR = $("#show-random").checked;
  const units = (state.units[state.layer] || []).filter(u => (showR || u.kind === "neuron") &&
    (!q || u.words.some(w => w.includes(q)) || u.name.toLowerCase().includes(q) || String(u.n) === q));
  const rnd = (state.units[state.layer] || []).filter(u => u.kind === "random").map(u => u.z);
  const floor = rnd.length ? Math.max(...rnd) : -Infinity;
  const ol = $("#rows");
  ol.innerHTML = units.slice(0, 600).map(u => `<li data-n="${u.n}" data-kind="${u.kind}" class="${u.kind}${u.z <= floor ? " below" : ""}${state.focus && state.focus.n === u.n && state.focus.layer === state.layer && u.kind === "neuron" ? " sel" : ""}">
    <span class="n">${u.kind === "random" ? "r" : "N"}${u.n}</span><span class="z">${u.z.toFixed(1)}</span>
    <span class="w">${u.name ? `<b>${esc(u.name)}</b> ` : ""}${esc(u.words.join(" "))}</span></li>`).join("");
}
// lens hits (net tab) or what fired (run tab)
function renderResults(r, ol) {
  if (!r.ready) { ol.innerHTML = `<li class="head">${esc(state.statusText || "indexing lens")}</li>`; return; }
  const rows = (r.results || []).map(x => `<li class="res${x.swept === false ? " unswept" : ""}" data-l="${x.layer}" data-n="${x.n}" data-kind="neuron">
    <span class="n">L${x.layer} N${x.n}</span><span class="sg ${x.sign === "+" ? "up" : "down"}">${r.fires ? `${x.sign === "+" ? "" : "−"}${x.score.toFixed(1)}×` : `${x.sign === "+" ? "+" : "−"}${x.rank + 1}`}</span>
    <span class="w">${r.fires ? `<span class="tk">"${esc(x.token)}"</span>` : ""}${x.name ? `<b>${esc(x.name)}</b> ` : ""}${tokText(x.lens, Infinity, " ")}</span></li>`).join("");
  const head = r.fires ? `${r.total ?? 0} neurons pass · score = activation ÷ its typical extreme` : `${r.total ?? 0} neurons · ${r.tokens ?? 0} tokens`;
  ol.innerHTML = `<li class="head">${head}</li>` + rows;
}
// junk / variant settings: redraw every token list in place
function syncTokPrefs() {
  document.querySelectorAll("#tok-junk button").forEach(b => b.classList.toggle("on", b.dataset.j === tokPrefs.junk));
  $("#tok-group").classList.toggle("on", tokPrefs.group);
}
function setTokPrefs(p) {
  Object.assign(tokPrefs, p);
  try { localStorage.setItem("tokPrefs", JSON.stringify(tokPrefs)); } catch {}
  syncTokPrefs(); renderList(); renderLensViews(); renderConnections(); bus.postMessage({ type: "tokprefs", prefs: { ...tokPrefs } });
  if (fireResults) renderResults(fireResults, $("#run-rows"));
}
document.querySelectorAll("#tok-junk button").forEach(b => b.onclick = () => setTokPrefs({ junk: b.dataset.j }));
$("#tok-group").onclick = () => setTokPrefs({ group: !tokPrefs.group });
syncTokPrefs();
try { $("#legend").open = localStorage.getItem("legendOpen") !== "0"; } catch { $("#legend").open = true; }
$("#legend").addEventListener("toggle", () => { try { localStorage.setItem("legendOpen", $("#legend").open ? "1" : "0"); } catch {} });
$("#map-home").onclick = () => { if (map.layerMode !== null) map.exitLayer(); map.home(); };
addEventListener("click", e => { const m = $("#view-menu"); if (m.open && !m.contains(e.target)) m.open = false; });
addEventListener("keydown", e => { if (e.key === "Escape") $("#view-menu").open = false; });
$("#inf-hi").value = arch.n_layers - 1;

// a head chip marks its head on the map while hovered
$("#net").addEventListener("mouseover", e => { const c = e.target.closest(".chip[data-h]"); map.hoverHead(c ? +c.dataset.l : null, c ? +c.dataset.h : null); });
$("#net").addEventListener("mouseleave", () => map.hoverHead(null));
// a web-summary token searches the lens for it
$("#net").addEventListener("click", e => {
  const nl = e.target.closest(".nline"); if (nl) return goToNeuron(+nl.dataset.nl, +nl.dataset.nn, "neuron");
  const chip = e.target.closest(".chip"); if (!chip) return;
  if (chip.dataset.h) return openHead(+chip.dataset.l, +chip.dataset.h);

  if (state.qMode !== "lens") $('#q-mode button[data-q="lens"]').click();
  $("#lens-q").value = chip.dataset.q; $("#lens-q").dispatchEvent(new Event("input"));
});
for (const ol of [$("#rows"), $("#run-rows")]) {
  ol.addEventListener("click", e => {
    const li = e.target.closest("li"); if (!li || !li.dataset.n) return;
    goToNeuron(li.dataset.l ? +li.dataset.l : state.layer, +li.dataset.n, li.dataset.kind);
  });
  ol.addEventListener("pointerover", e => {
    const li = e.target.closest("li"); if (li && li.dataset.kind === "neuron") map.hover(li.dataset.l ? +li.dataset.l : state.layer, +li.dataset.n);
  });
  ol.addEventListener("pointerleave", () => map.hover(null));
}

// ---------- jump / routing ----------
$("#jump").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const m = e.target.value.match(/L?\s*(\d+)\D+N?\s*(\d+)/i);
  if (m) openNeuron(+m[1], +m[2]);
});
addEventListener("hashchange", fromHash);
// what's open is kept in this browser (a reload reopens it) and never in the address bar, where every neuron would
// become a browser-history entry; a link with #L19/N7176 (a neuron) or #L19/h2 (an attention head) opens that
function saveFocus() {
  const f = state.focus;
  try { localStorage.setItem("explorer.focus", JSON.stringify(f && (f.kind === "neuron" || f.kind === "head") ? f : null)); } catch {}
}
const postFocus = () => { const f = state.focus; bus.postMessage({ type: "focus", focus: f && (f.kind === "neuron" || f.kind === "head") ? f : null }); };
function restoreFocus() {
  let f = null; try { f = JSON.parse(localStorage.getItem("explorer.focus") || "null"); } catch {}
  if (!f) return;
  if (f.kind === "head") openHead(f.layer, f.n); else openNeuron(f.layer, f.n, "neuron", false);
}
function fromHash() {
  const m = location.hash.match(/^#L(\d+)\/(N|h)(\d+)/);
  if (!m) return;
  const kind = m[2] === "h" ? "head" : "neuron";
  history.replaceState(null, "", location.pathname + location.search);  // the link is used up; later picks are remembered
  if (isFocus(+m[1], +m[3], kind)) return;
  if (kind === "head") openHead(+m[1], +m[3]); else openNeuron(+m[1], +m[3], "neuron", true);
}

// ---------- panel collapse ----------
function updateInsets() {
  const listShown = !$("#list").classList.contains("hidden");
  const focusShown = focusEl.classList.contains("on") && !focusEl.classList.contains("collapsed");
  map.setInsets(listShown ? $("#list").getBoundingClientRect().width + 24 : 0, focusShown ? focusEl.getBoundingClientRect().width + 24 : 0);
}
$("#layer-back").onclick = () => map.exitLayer();
// panel widths follow the window (vw-based), so window resizes and browser zoom must re-measure them
addEventListener("resize", () => updateInsets());
function setListHidden(h) {
  document.body.classList.toggle("list-hidden", h);
  $("#list").classList.toggle("hidden", h); $("#list-tab").classList.toggle("on", h); updateInsets();
}
function setFocusCollapsed(c) {
  focusEl.classList.toggle("collapsed", c);
  syncEdge(); updateInsets();
}
// the right edge handle brings back a collapsed neuron panel
function syncEdge() {
  const on = focusEl.classList.contains("on"), col = focusEl.classList.contains("collapsed"), f = state.focus;
  const t = $("#focus-tab");
  t.classList.toggle("on", on && col);
  t.textContent = f && f.kind !== "head" ? `‹ ${f.kind === "random" ? "r" : "N"}${f.n}` : "‹";
}
$("#list-hide").onclick = () => setListHidden(true);
$("#list-tab").onclick = () => setListHidden(false);
$("#f-collapse").onclick = () => setFocusCollapsed(true);
$("#focus-tab").onclick = () => setFocusCollapsed(false);

// ---------- focus panel ----------
const focusEl = $("#focus");
$("#f-close").onclick = () => { flushName(); state.focus = null; $("#list").classList.remove("has-focus");
  map.selectHead(null); state.headInfo = null; state.nheads = null; $("#f-name").style.display = ""; lightHeads(state.inf.pos);
  focusEl.classList.remove("on");
  setFocusCollapsed(false); map.select(null); refreshWeb(); scatter.select(null, null); saveFocus(); postFocus(); renderList(); };
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => setTab(b.dataset.tab));
const tabBtn = t => $(`#tabs button[data-tab="${t}"]`);
const curTab = () => $("#tabs button.on")?.dataset.tab;
function setTab(t) {
  document.querySelectorAll("#tabs button[data-tab]").forEach(x => x.classList.toggle("on", x.dataset.tab === t));
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x.id === `tab-${t}`));
  tabBtn(t).classList.remove("fresh");
}
// a tab that changed while another was showing gets a dot until opened
function markFresh(t) { if (curTab() !== t) tabBtn(t).classList.add("fresh"); }
// the neuron's tabs (Examples only when it has sweep rollouts); chat, variants and Claude live on /chat
function syncTabs() {
  const f = state.focus?.kind === "head" ? null : state.focus;
  for (const t of ["examples", "details"]) tabBtn(t).style.display = f && (t !== "examples" || state.hasRollouts !== false) ? "" : "none";
  if (tabBtn(curTab()).style.display === "none") setTab("details");
}

async function openNeuron(layer, n, kind = "neuron", push = true, fly = true) {
  if (!agentSelecting) clearAgentMarks();
  flushName();
  state.focus = { layer, n, kind };
  if (kind === "neuron") postFocus();
  map.selectHead(null); state.headInfo = null; state.nheads = null; $("#f-name").style.display = ""; lightHeads(state.inf.pos);
  if (map.layerMode !== null && map.layerMode !== layer) map.enterLayer(layer);
  if (push && kind === "neuron") saveFocus();
  focusEl.classList.add("on"); $("#list").classList.add("has-focus");
  setFocusCollapsed(false);
  $("#f-id").textContent = kind === "random" ? `L${layer} random ${n}` : `L${layer} N${n}`;
  $("#f-rank").textContent = "";
  setNameField(state.unitMap[layer]?.get(n)?.name || "");
  $("#f-name").disabled = kind !== "neuron";
  $("#tab-examples").innerHTML = ""; $("#tab-details").innerHTML = ""; state.hasRollouts = null;
  syncTabs();
  if (layer !== state.layer) await setLayer(layer);
  if (!isFocus(layer, n, kind)) return;
  setNameField(state.unitMap[layer]?.get(n)?.name || "");
  renderList();
  if (kind === "neuron") { map.select(layer, n, fly); scatter.select(layer, n); loadNeuronHeads(layer, n); }
  refreshWeb();
  const u = await api(`/api/unit?layer=${layer}&n=${n}&kind=${kind}`);
  if (!isFocus(layer, n, kind)) return;
  setNameField(u.name || "");
  if (u.stats) $("#f-rank").textContent = `#${u.rank ?? "—"}/${u.n_ranked}  mass ${(u.stats.mass ?? u.stats.z).toFixed(1)}  null ${(u.stats.null_pct * 100).toFixed(0)}%`;
  renderExamples(u);
  renderDetails(u);
  const hasRollouts = state.hasRollouts = !!(u.rollouts && u.rollouts.length);
  document.querySelector('#tabs button[data-tab="examples"]').style.display = hasRollouts ? "" : "none";
  if (!hasRollouts && document.querySelector("#tabs button.on")?.dataset.tab === "examples") setTab("details");
  if (kind === "neuron") loadLive(layer, n);
}
// the heads linked to the open neuron light up on their slabs (see /api/neuron/heads)
async function loadNeuronHeads(layer, n) {
  state.nheads = null; lightHeads(tokHover ?? state.inf.pos);
  const r = await api(`/api/neuron/heads?layer=${layer}&n=${n}`);
  if (!isFocus(layer, n, "neuron")) return;
  state.nheads = { ...r, layer, n }; lightHeads(tokHover ?? state.inf.pos); renderList(); renderConnections();
  const want = Object.values(r.roles || {}).flat().filter(x => x.z >= 2 && !hoverCache.has(`h/${x.layer}/${x.head}`));
  await Promise.all(want.map(async x => hoverCache.set(`h/${x.layer}/${x.head}`, await api(`/api/head?layer=${x.layer}&head=${x.head}`))));
  if (isFocus(layer, n, "neuron")) renderConnections();
  map.setNeuronHeads(roleHeads(r).slice(0, 8));
}

// a head opens in the list panel: its id up top, what it reads and writes in net, and on run the text shaded by
// where it reads from; the neuron panel steps aside
async function openHead(layer, head) {
  if (!agentSelecting) clearAgentMarks();
  flushName();
  state.focus = { layer, n: head, kind: "head" };
  saveFocus(); postFocus();
  map.select(null); scatter.select(null, null); map.selectHead(layer, head);
  $("#list").classList.add("has-focus");
  if ($("#list").classList.contains("hidden")) setListHidden(false);
  $("#f-id").textContent = `L${layer} h${head}`; $("#f-rank").textContent = "";
  $("#f-name").style.display = "none";
  focusEl.classList.remove("on"); syncTabs();
  syncEdge(); updateInsets();
  refreshWeb();
  shadeTokens(tokHover ?? state.inf.pos);
  lightHeads(tokHover ?? state.inf.pos);
  const r = await api(`/api/head?layer=${layer}&head=${head}`);
  if (!isFocus(layer, head, "head")) return;
  state.headInfo = r; hoverCache.set(`h/${layer}/${head}`, r);
  map.setHeadLinks(layer, head, headRoleLinks(r));
  renderList();
}

const isFocus = (layer, n, kind) => state.focus && state.focus.layer === layer && state.focus.n === n && state.focus.kind === kind;

function renderExamples(u) {
  if (!u.rollouts || !u.rollouts.length) { $("#tab-examples").innerHTML = `<div class="slot">—</div>`; return; }
  const prompts = Object.keys(u.prompts).filter(p => u.rollouts.some(r => r.prompt === p));
  const count = {};
  for (const r of u.rollouts) count[r.dose] = (count[r.dose] || 0) + 1;
  // doses shared by several prompts get columns; a prompt's one-off doses span its empty cells
  const doses = Object.keys(count).map(Number).filter(d => count[d] > 1).sort((a, b) => a - b);
  const relOf = d => u.rollouts.find(r => r.dose === d).rel_push.toFixed(2);
  const cell = r => `<div class="cell${r.finish === "length" ? " capped" : ""}">${esc(r.text)}</div>`;
  let h = `<div class="grid" style="grid-template-columns: 66px repeat(${1 + doses.length}, minmax(0,1fr))"><div class="h"></div><div class="h">0</div>`;
  for (const d of doses) h += `<div class="h ${d > 0 ? "up" : "down"}">${fmtDose(d)}<span class="dim"> · ${relOf(d)}</span></div>`;
  for (const p of prompts) {
    const b = u.baselines.find(r => r.prompt === p);
    h += `<div class="h">${p}</div><div class="cell base${b?.finish === "length" ? " capped" : ""}">${esc(b?.text ?? "")}</div>`;
    const mine = u.rollouts.filter(r => r.prompt === p);
    const shared = doses.map(d => mine.find(r => r.dose === d));
    const extra = mine.filter(r => !doses.includes(r.dose));
    if (shared.some(Boolean)) h += shared.map(r => r ? cell(r) : "<div></div>").join("");
    else if (extra.length) {
      const span = Math.max(1, Math.floor(doses.length / extra.length));
      h += extra.map((r, i) => `<div class="cell${r.finish === "length" ? " capped" : ""}" style="grid-column: span ${i === extra.length - 1 ? doses.length - span * (extra.length - 1) : span}"><span class="h ${r.dose > 0 ? "up" : "down"}">${fmtDose(r.dose)} · ${r.rel_push.toFixed(2)}</span>  ${esc(r.text)}</div>`).join("");
    } else h += doses.map(() => "<div></div>").join("");
  }
  $("#tab-examples").innerHTML = h + "</div>";
}
$("#tab-examples").addEventListener("click", e => { const c = e.target.closest(".cell"); if (c) c.classList.toggle("open"); });

function renderDetails(u) {
  const s = u.stats;
  let h = "";
  if (s) {
    h += `<div class="lab">words</div><div class="crumbs">` + s.words.map(([w, c, z]) =>
      `<span class="tok" title="${c} rollouts · z ${z.toFixed(1)} · ${esc((s.per_prompt[w] || []).join(" "))}">${esc(w)}</span>`).join("") + `</div>`;
    h += `<table class="dtable"><tr><th class="num">dose</th><th class="num">push</th><th class="num">distinct-4</th><th class="num">capped</th><th class="num">logprob</th></tr>` +
      Object.entries(s.dose).map(([d, v]) => `<tr><td class="num">${d}</td><td class="num">${v.rel_push.toFixed(2)}</td><td class="num">${v.distinct4.toFixed(2)}</td><td class="num">${(v.capped * 100).toFixed(0)}%</td><td class="num">${v.logprob.toFixed(2)}</td></tr>`).join("") + `</table>`;
  }
  h += `<div id="d-lens" class="slot">—</div><div class="lab" style="margin-top:18px">connections</div><div id="d-con" class="slot">—</div>`;
  $("#tab-details").innerHTML = h;
}

async function loadLive(layer, n) {
  $("#d-lens") && ($("#d-lens").textContent = "…");
  $("#d-con") && ($("#d-con").textContent = "…");
  const conP = api(`/api/connections?layer=${layer}&n=${n}&k=24`);
  let lens;
  try { lens = await api(`/api/lens?layer=${layer}&n=${n}`); }
  catch (err) { if (isFocus(layer, n, "neuron") && $("#d-lens")) $("#d-lens").textContent = err.message; }
  if (!isFocus(layer, n, "neuron")) return;
  conP.then(con => {
    if (!isFocus(layer, n, "neuron")) return;
    map.setConnections(con); state.con = con; renderConnections();
  }, err => { if (isFocus(layer, n, "neuron") && $("#d-con")) $("#d-con").textContent = err.message; });
  if (!lens) return;
  state.lens = { ...lens, layer, n }; renderList(); renderLensViews();
}
// the open neuron's lenses in Details (state.lens)
function renderLensViews() {
  const L = state.lens; if (!L || !isFocus(L.layer, L.n, "neuron")) return;
  const tok = list => tokChips(list, { cls: "tok" });
  const steer = L.steer_up ? `<div class="lab" title="the next tokens that gain the most probability when the neuron is pushed up (+) or down (−), through every later layer">steer lens</div><div class="lens"><div class="up"><div class="lab">+ push · KL ${L.kl_up}</div>${tok(L.steer_up)}</div><div class="down"><div class="lab">− push · KL ${L.kl_down}</div>${tok(L.steer_down)}</div></div><div class="lab" style="margin-top:14px">logit lens</div>` : "";
  if ($("#d-lens")) $("#d-lens").outerHTML = `<div id="d-lens">${steer}<div class="lens" title="logit lens: the tokens the neuron's output direction points at directly, ignoring later layers"><div class="up"><div class="lab">+</div>${tok(L.up)}</div><div class="down"><div class="lab">−</div>${tok(L.down)}</div></div></div>`;

}

// sign = sign(g * u): the sign of the reading neuron's activation that the writing neuron's direction produces on its
// own. Reversing the writer reverses g and u together, so the sign holds for either direction of the writer.
function renderConnections() {
  const el = $("#d-con") || $("#d-con-wrap"); if (!el || !state.con) return;
  const tok = list => tokChips(list, { cls: "tok", max: 4 });
  const row = c => {
    const pole = c.sign > 0 ? 1 : -1, toks = (pole > 0 ? c.lens : c.lens_neg) || [];
    const logit = (pole > 0 ? c.logit : c.logit_neg) || [];
    const sweep = c.name || (c.words || []).join(" ");
    return `<tr data-l="${c.layer}" data-n="${c.n}" class="con"><td class="pole ${pole > 0 ? "up" : "down"}" title="${pole > 0 ? "↑ the link raises the reading neuron's activation" : "↓ the link lowers the reading neuron's activation"}">${pole > 0 ? "↑" : "↓"}</td>
      <td>${tok(toks)}${logit.length ? `<div class="logit">${tok(logit)}</div>` : ""}${sweep ? `<div class="dim">${esc(sweep)}</div>` : ""}</td>
      <td class="num dim" title="link strength: z-score of the direct weight path">${c.z.toFixed(0)}</td><td class="mono faint">L${c.layer}·${c.n}</td></tr>`;
  };
  el.outerHTML = `<div id="d-con-wrap">
    <div class="lens"><div><div class="lab" title="later neurons this neuron's output feeds directly (weights only)">writes into</div><table class="dtable">${state.con.down.slice(0, 14).map(row).join("")}</table></div>
    <div><div class="lab" title="earlier neurons whose output feeds this neuron directly (weights only)">driven by</div><table class="dtable">${state.con.up.slice(0, 14).map(row).join("")}</table></div></div>
    ${headTablesHTML()}</div>`;
}
// the open neuron's heads in Details: later heads reading it (q / k / v) and heads it reads (o), each with what the
// head writes (its o tokens) over what it carries (v tokens, faint)
function headTablesHTML() {
  const H = state.nheads, f = state.focus;
  if (!H?.roles || !f || f.kind !== "neuron" || H.layer !== f.layer || H.n !== f.n) return "";
  const tok = t => `<span class="tok">${esc(t.tok)}</span>`;
  const row = x => {
    const info = hoverCache.get(`h/${x.layer}/${x.head}`);
    const id = `L${x.layer}·h${x.heads.length > 1 ? `${x.heads[0]}–${x.heads.at(-1)}` : x.head}`;
    return `<tr class="con" data-hl="${x.layer}" data-hh="${x.head}"><td class="pole mono dim">${x.role}</td>
      <td>${info ? info.write_toks.slice(0, 4).map(tok).join("") + `<div class="logit">${info.read_toks.slice(0, 4).map(tok).join("")}</div>` : ""}</td>
      <td class="num dim">${x.z.toFixed(1)}</td><td class="mono faint">${id}</td></tr>`;
  };
  const rows = roles => roles.flatMap(r => (H.roles[r] || []).map(x => ({ ...x, role: r }))).filter(x => x.z >= 2).sort((a, b) => b.z - a.z);
  return `<div class="lens"><div><div class="lab">heads reading it</div><table class="dtable">${rows(["q", "k", "v"]).slice(0, 10).map(row).join("")}</table></div>
    <div><div class="lab">heads feeding it</div><table class="dtable">${rows(["o"]).slice(0, 10).map(row).join("")}</table></div></div>`;
}
// opening a neuron from a list or link also centres the camera on it
function goToNeuron(layer, n, kind = "neuron") {
  openNeuron(layer, n, kind, true, false);
  if (kind === "neuron") map.focusNeuron(layer, n);
}
$("#tab-details").addEventListener("click", e => {
  const th = e.target.closest("tr[data-hl]"); if (th) return openHead(+th.dataset.hl, +th.dataset.hh);
  const tr = e.target.closest("tr[data-l]"); if (tr) goToNeuron(+tr.dataset.l, +tr.dataset.n);
});
$("#tab-details").addEventListener("mouseover", e => { const th = e.target.closest("tr[data-hl]"); map.hoverHead(th ? +th.dataset.hl : null, th ? +th.dataset.hh : null); });
$("#tab-details").addEventListener("mouseleave", () => map.hoverHead(null));

// name autosave
let nameTimer, pendingName = null;
async function saveName(p) {
  await api("/api/name", { layer: p.layer, n: p.n, name: p.name });
  bus.postMessage({ type: "names" });
  const u = state.unitMap[p.layer]?.get(p.n); if (u) u.name = p.name.trim();
  if (p.layer === state.layer && state.units[p.layer]?.length) map.setUnits(p.layer, state.units[p.layer]);
  renderList();
  if (isFocus(p.layer, p.n, "neuron")) { $("#f-name").classList.add("saved"); setTimeout(() => $("#f-name").classList.remove("saved"), 900); }
}
function flushName() {
  clearTimeout(nameTimer);
  if (pendingName) { const p = pendingName; pendingName = null; saveName(p); }
}
// the name field wraps long names: a one-line textarea that grows to fit; Enter finishes editing instead of a newline
function sizeNameField() { const t = $("#f-name"); t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; }
function setNameField(v) { $("#f-name").value = v; sizeNameField(); }
$("#f-name").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
$("#f-name").addEventListener("input", () => { const t = $("#f-name"); if (t.value.includes("\n")) t.value = t.value.replace(/\n+/g, " "); sizeNameField(); });
addEventListener("resize", sizeNameField);
$("#f-name").addEventListener("input", () => {
  const f = state.focus; if (!f || f.kind !== "neuron") return;
  pendingName = { layer: f.layer, n: f.n, name: $("#f-name").value };
  clearTimeout(nameTimer);
  nameTimer = setTimeout(flushName, 500);
});

// ---------- status ----------
// keeps polling (slowly once ready), so a server restart or a one-off error message clears itself
async function pollStatus() {
  try {
    const s = await api("/api/status");
    state.statusText = s.status;
    $("#status").textContent = s.status === "ready" ? "" : s.status;
    if (s.status === "ready" && lensResults && !lensResults.ready) runLensSearch();
    setTimeout(pollStatus, s.status === "ready" ? 8000 : 2000);
  } catch {
    $("#status").textContent = "server unreachable";
    setTimeout(pollStatus, 2000);
  }
}
pollStatus();

window.__ne = { map, state, scatter };
// ---------- start ----------
const have = Object.keys(index.layers).map(Number);
let saved = null; try { const v = localStorage.getItem("ne.layer"); if (v !== null) saved = +v; } catch {}
const first = have.includes(saved) ? saved : have.includes(22) ? 22 : (have[0] ?? 0);
await setLayer(first);
if (location.hash) fromHash(); else restoreFocus();

// ---------- the live link to the chat page (/chat) ----------
// what Claude does to the screen (see agent_mcp.py), relayed by the chat page
// Claude's labels and highlights last until its next reply, or until the person opens a neuron themselves
function clearAgentMarks() {
  map.setNotes([]);
  if (agentMarked) { agentMarked = false; syncLeftMap(); }
}
async function agentUi(e) {
  if (e.action === "head") {
    agentSelecting = true;
    try { await openHead(e.layer, e.head); } finally { agentSelecting = false; }
  } else if (e.action === "select") {  // visibly go there
    agentSelecting = true;
    try { await openNeuron(e.layer, e.n, "neuron", true, false); } finally { agentSelecting = false; }
    map.flyToNeuron(e.layer, e.n, 0.3);
  }
  else if (e.action === "highlight") { agentMarked = true; map.setMarks((e.neurons || []).map(x => ({ layer: x.layer, n: x.n, sign: x.sign || "+", w: 1 }))); }
  else if (e.action === "rename") {
    const u = state.unitMap[e.layer]?.get(e.n); if (u) u.name = e.name.trim();
    if (isFocus(e.layer, e.n, "neuron")) setNameField(e.name.trim());
    if (e.layer === state.layer && state.units[e.layer]?.length) map.setUnits(e.layer, state.units[e.layer]);
    renderList();
  }
  else if (e.action === "annotate") map.setNotes(e.items || []);
  else if (e.action === "camera") {
    if (map.layerMode !== null) map.exitLayer();
    if (e.mode === "home") map.home();
    else if (e.mode === "layer") map.viewLayer(e.layer);
    else if (e.mode === "neuron") map.flyToNeuron(e.layer, e.n, e.closeness || 0.22);
    else if (e.mode === "view") {
      if (state.view !== "map") setView("map");
      const [lo, hi] = Array.isArray(e.layers) ? e.layers : e.layer != null ? [e.layer, e.layer] : [];
      map.orbit({ lo, hi, azimuth: e.azimuth, elevation: e.elevation, zoom: e.zoom });
    }
  } else if (e.action === "tab") { if (state.focus && tabBtn(e.tab)) setTab(e.tab); }
  else if (e.action === "view") {
    if (e.layout) setLayout(e.layout);
    if (e.web_depth) $("#web-z").value = Math.max(1, Math.min(24, Math.round(e.web_depth)));
    if (e.web != null) webOn = !!e.web;
    if (e.web != null || e.web_depth) { webKey = null; refreshWeb(); }
    if (e.junk || e.group_variants != null) setTokPrefs({ ...(e.junk && { junk: e.junk }), ...(e.group_variants != null && { group: !!e.group_variants }) });
    if (e.view) setView(e.view === "embeddings" ? "embed" : "map");
    if (e.layer != null && e.layer >= 0 && e.layer < arch.n_layers) setLayer(+e.layer);
    if (e.left_panel != null) setListHidden(!e.left_panel);
    if (e.left_tab) showLeft(e.left_tab === "run" ? "run" : "net");
    if (e.neuron_panel != null && focusEl.classList.contains("on")) setFocusCollapsed(!e.neuron_panel);
  }
  else if (e.action === "search") {
    if (state.qMode !== "lens") $('#q-mode button[data-q="lens"]').click();
    $("#lens-q").value = e.query; $("#lens-q").dispatchEvent(new Event("input"));
  } else if (e.action === "text") showText(e.text, e.token);
}
// put text in the fires box, run it, and pin the first token containing `token` (or the strongest one)
async function showText(text, token) {
  if (state.qMode !== "fires") $('#q-mode button[data-q="fires"]').click();
  $("#inf-text").value = text; $("#lens-q").value = text;
  clearTimeout(lensTimer);
  const g = ++qGen;
  await runInfer(text, g);
  if (g !== qGen || !state.inf.tokens) return;
  const i = token ? state.inf.tokens.findIndex(t => t.includes(token)) : -1;
  const pos = i >= 0 ? +document.querySelectorAll("#inf-toks button")[i].dataset.i : -1;
  state.inf.pos = pos;
  document.querySelectorAll("#inf-toks button").forEach(x => x.classList.toggle("on", +x.dataset.i === pos));
  inferView(); showTokenPaths(pos);
}
bus.onmessage = ({ data: m }) => {
  if (m.type === "ui") agentUi(m.e);
  else if (m.type === "open") goToNeuron(m.layer, m.n);
  else if (m.type === "clear-marks") clearAgentMarks();
  else if (m.type === "hello") postFocus();
};
syncEdge(); updateInsets();
