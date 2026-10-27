// the chat page (/chat): the steering chat and saved variants on the left, Claude on the right. Live-linked to the
// explorer page through `bus`: the neuron open there drives the steering stack and the lens shown here, and what
// Claude does to the screen (camera, selections, highlights, view) is applied there.
import { $, api, esc, bus, md, tokPrefs, tokText } from "./common.js?v=3";

const index = await api("/api/index");
const arch = index.arch;
const state = { focus: null };
try { state.focus = JSON.parse(localStorage.getItem("explorer.focus") || "null"); } catch {}
let names = {};  // "L16/N954" -> name, the same file the explorer edits
async function loadNames() { names = await api("/api/agent/names").catch(() => names); renderStack(); renderThread(); showFocus(); }
const goToNeuron = (layer, n) => bus.postMessage({ type: "open", layer, n });
const clearAgentMarks = () => bus.postMessage({ type: "clear-marks" });

// the left pane's two views
function setPane(p) {
  document.querySelectorAll("#pane-steer .pane-tabs button").forEach(b => b.classList.toggle("on", b.dataset.pane === p));
  $("#tab-chat").classList.toggle("on", p === "chat"); $("#tab-variants").classList.toggle("on", p === "variants");
}
document.querySelectorAll("#pane-steer .pane-tabs button").forEach(b => b.onclick = () => setPane(b.dataset.pane));

// the boundary between the steering chat and Claude: drag it (or arrow keys while it has focus); remembered
const split = $("#split"), mainEl = $(".chat-main");
function setSplit(frac) {
  frac = Math.min(0.8, Math.max(0.2, frac));
  mainEl.style.setProperty("--left", `${(frac * 100).toFixed(1)}%`);
  split.setAttribute("aria-valuenow", Math.round(frac * 100));
  try { localStorage.setItem("chatSplit", frac); } catch {}
}
let splitAt = 0.53; try { splitAt = +(localStorage.getItem("chatSplit") || splitAt); } catch {}
setSplit(splitAt);
split.addEventListener("pointerdown", e => {
  split.setPointerCapture(e.pointerId); document.body.classList.add("dragging");
  const r = mainEl.getBoundingClientRect();
  const move = ev => setSplit((ev.clientX - r.left) / r.width);
  const up = () => { split.removeEventListener("pointermove", move); document.body.classList.remove("dragging"); };
  split.addEventListener("pointermove", move); split.addEventListener("pointerup", up, { once: true });
});
split.addEventListener("keydown", e => {
  const now = parseFloat(mainEl.style.getPropertyValue("--left")) / 100;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setSplit(now + (e.key === "ArrowLeft" ? -0.03 : 0.03)); }
});
split.addEventListener("dblclick", () => setSplit(0.53));

// ---------- chat: a stack of neurons steered together ----------
// row 0 pushes every neuron by its dose, row 1 is left alone, row 2 reverses each push (add: -dose, ×: ×-dose)
const DOSE = { add: { min: -2, max: 2, step: 0.05, def: 0.8 }, mul: { min: 0, max: 16, step: 0.5, def: 2 } };
// auto: the stack still just follows the open neuron; adding a neuron or loading a variant takes it over
// the stack, its runs and the prompt are saved per model on the server (chat_session.json) and restored here
const session = await api("/api/session").catch(() => ({}));
// Compare always starts off (it costs two extra replies per run); it lasts until the page reloads
state.steer = { mode: "add", neurons: [], auto: true, max: 600, ...session.steer, compare: false, dir: "writes" };
delete state.steer.show;  // sessions from before the Compare toggle
let sessionSaved = JSON.stringify(session), sessionTimer;
// debounced, skipped while a run streams (its end saves) and when nothing changed; the last 50 runs are kept
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    if (running) return;
    const { mode, neurons, auto, max } = state.steer;
    const body = JSON.stringify({ steer: { mode, neurons, auto, max }, prompt: $("#c-input").value,
      thread: state.thread.slice(-50).map(({ user, replies, mode, neurons, cols, cut, max, error }) => ({ user, replies, mode, neurons, cols, cut, max, ...(error && { error }) })) });
    if (body === sessionSaved) return;
    sessionSaved = body;
    fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => { sessionSaved = ""; });
  }, 600);
}
const nid = x => `L${x.layer} N${x.n}`;
const unitName = x => names[`L${x.layer}/N${x.n}`] || "";
const fmtStep = (d, mode) => mode === "mul" ? `×${d}` : (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d);
const recipe = (neurons, mode) => neurons.map(x => `${nid(x)} ${fmtStep(x.dose, mode)}`).join(" · ") + (mode === "mul" ? " · ×" : " · add");

// opening a neuron moves an auto stack onto it; returns whether the stack changed (the thread then starts over)
function followFocus(f) {
  const S = state.steer;
  if (!S.auto || f?.kind !== "neuron") return false;
  const cur = S.neurons[0];
  if (cur && cur.layer === f.layer && cur.n === f.n && S.neurons.length === 1) return false;
  S.neurons = [{ layer: f.layer, n: f.n, dose: cur?.dose ?? DOSE[S.mode].def }];
  renderStack();
  return true;
}
// room for the replies: the steering panel folds to one summary line and the lens above the chat to its steer
// lines; both remembered in this browser
const chatFold = { steer: true, lens: true };
try { Object.assign(chatFold, JSON.parse(localStorage.getItem("chatFold") || "{}")); } catch {}
const saveFold = () => { try { localStorage.setItem("chatFold", JSON.stringify(chatFold)); } catch {} };
function syncFold() {
  const folded = chatFold.steer && state.steer.neurons.length > 0;  // an empty stack stays open, to add a neuron
  $("#steer-panel").classList.toggle("folded", folded);
  $("#c-fold").textContent = folded ? "Adjust" : "Done";
  $("#c-fold").hidden = !state.steer.neurons.length;
  $("#c-lens").classList.toggle("open", !chatFold.lens);
}
$("#c-fold").onclick = () => { chatFold.steer = !$("#steer-panel").classList.contains("folded"); saveFold(); syncFold(); };
$("#c-lens").addEventListener("click", () => { chatFold.lens = !chatFold.lens; saveFold(); syncFold(); });
function renderStack() {
  const S = state.steer, R = DOSE[S.mode];
  $("#c-stack").innerHTML = S.neurons.map((x, i) => `<div class="srow" data-i="${i}">
      <button type="button" class="sid mono" data-go="${i}" title="open ${nid(x)}">${nid(x)}</button>
      <span class="snm" title="${esc(unitName(x))}">${esc(unitName(x))}</span>
      <input type="range" min="${R.min}" max="${R.max}" step="${R.step}" value="${x.dose}" aria-label="dose for ${nid(x)}">
      <input class="sdose mono" value="${fmtStep(x.dose, S.mode)}" inputmode="decimal" aria-label="dose for ${nid(x)}">
      <button type="button" class="srm" data-rm="${i}" aria-label="remove ${nid(x)}" title="remove">×</button></div>`).join("")
    || `<div class="sempty">No neurons to steer. Open one on the map, or add one below.</div>`;
  const f = state.focus, open = f?.kind === "neuron" && !S.neurons.some(x => x.layer === f.layer && x.n === f.n);
  $("#c-add-open").hidden = !open;
  if (open) $("#c-add-open").textContent = `+ add open ${nid(f)}`;
  document.querySelectorAll("#c-mode button").forEach(b => b.classList.toggle("on", b.dataset.m === S.mode));
  $("#c-compare").classList.toggle("on", !!S.compare);
  $("#c-max").value = S.max;
  $("#v-current").textContent = S.neurons.length ? `Current: ${recipe(S.neurons, S.mode)}` : "Nothing to save yet: set up steering in Chat first.";
  $("#c-sum").textContent = S.neurons.length ? recipe(S.neurons, S.mode) : "";
  syncFold();
  saveSession();
}
function addToStack(layer, n, dose) {
  const S = state.steer;
  if (!(layer >= 0 && layer < arch.n_layers && n >= 0 && n < arch.inter)) return false;
  S.auto = false;
  if (!S.neurons.some(x => x.layer === layer && x.n === n)) S.neurons.push({ layer, n, dose: dose ?? DOSE[S.mode].def });
  renderStack();
  return true;
}
const setDose = (i, v) => {
  const R = DOSE[state.steer.mode];
  state.steer.neurons[i].dose = +Math.min(R.max, Math.max(R.min, v)).toFixed(2);
};
$("#c-stack").addEventListener("input", e => {
  if (e.target.type !== "range") return;
  const row = e.target.closest(".srow"), i = +row.dataset.i;
  setDose(i, +e.target.value);
  row.querySelector(".sdose").value = fmtStep(state.steer.neurons[i].dose, state.steer.mode);
  $("#c-sum").textContent = recipe(state.steer.neurons, state.steer.mode);
  saveSession();
});
$("#c-stack").addEventListener("change", e => {
  if (!e.target.classList.contains("sdose")) return;
  const i = +e.target.closest(".srow").dataset.i, v = parseFloat(e.target.value.replace(/[×x*+\s]/g, "").replace("−", "-"));
  if (Number.isFinite(v)) setDose(i, v);
  renderStack();
});
$("#c-stack").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList.contains("sdose")) { e.preventDefault(); e.target.blur(); } });
$("#c-stack").addEventListener("click", e => {
  const rm = e.target.closest("[data-rm]"), go = e.target.closest("[data-go]");
  if (rm) { state.steer.auto = false; state.steer.neurons.splice(+rm.dataset.rm, 1); renderStack(); }
  else if (go) { const x = state.steer.neurons[+go.dataset.go]; goToNeuron(x.layer, x.n); }
});
$("#c-add").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const m = e.target.value.match(/L?\s*(\d+)\s*[\s,/·]\s*N?\s*(\d+)/i);
  if (m && addToStack(+m[1], +m[2])) e.target.value = "";
  else { e.target.classList.add("bad"); setTimeout(() => e.target.classList.remove("bad"), 900); }
});
$("#c-add-open").onclick = () => addToStack(state.focus.layer, state.focus.n);
$("#c-reset").onclick = () => { state.steer.auto = true; state.steer.neurons = []; followFocus(state.focus); renderStack(); };
document.querySelectorAll("#c-mode button").forEach(b => b.onclick = () => {
  const S = state.steer; if (S.mode === b.dataset.m) return;
  S.mode = b.dataset.m; S.neurons.forEach(x => x.dose = DOSE[S.mode].def);  // doses don't carry over between add and ×
  renderStack();
});
$("#c-compare").onclick = () => { state.steer.compare = !state.steer.compare; renderStack(); };
$("#c-max").onchange = e => { state.steer.max = +e.target.value; renderStack(); };
document.querySelectorAll("#c-dir button").forEach(b => b.onclick = () => {
  state.steer.dir = b.dataset.d;
  document.querySelectorAll("#c-dir button").forEach(x => x.classList.toggle("on", x === b));
  $("#tab-chat").classList.toggle("reads", b.dataset.d === "reads");
  $("#c-input").placeholder = b.dataset.d === "reads" ? "Text to read" : "Who are you?";
});

let running = null;
state.thread = (session.thread || []).map(t => ({ ...t, done: [true, true, true] }));
$("#c-input").value = session.prompt || "";
$("#c-input").addEventListener("input", saveSession);
const ROWS = ["up", "zero", "down"], COL_NAMES = ["Steered +", "Normal", "Steered −"];
function colDose(t, r) {
  if (r === 1) return t.mode === "mul" ? "×1" : "0";
  if (t.neurons.length > 1) return r === 0 ? "as set" : "reversed";
  const d = t.neurons[0].dose;
  return fmtStep(r === 0 ? d : -d, t.mode);
}
// each run: which neurons at which doses, the shared prompt, then its replies side by side as markdown: the steered
// one, and with Compare the unsteered and reversed ones (t.cols: the columns that run generated)
const turnCols = t => t.cols || [0, 1, 2];
function renderThread() {
  const el = $("#c-thread");
  el.innerHTML = state.thread.length ? state.thread.map((t, i) => `<div class="turn" data-i="${i}">
    <div class="run-head"><span class="mono">${esc(recipe(t.neurons, t.mode))}</span>${t.neurons.length === 1 && unitName(t.neurons[0]) ? ` <span class="nm">${esc(unitName(t.neurons[0]))}</span>` : ""}</div>
    <div class="user">${esc(t.user)}</div>
    <div class="cols" style="grid-template-columns: repeat(${turnCols(t).length}, minmax(0, 1fr))">${turnCols(t).map(r => `<div class="col ${ROWS[r]}${t.live && !t.done[r] ? " live" : ""}" data-c="${r}"><span class="lab">${COL_NAMES[r]} <b>${colDose(t, r)}</b></span><div class="md">${md(t.replies[r], false)}</div>${t.cut?.includes(r) ? `<div class="cutnote" title="the reply had not ended; raise Length for longer replies">stopped at the ${t.max}-token limit</div>` : ""}</div>`).join("")}
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ""}</div></div>`).join("")
    : `<div class="c-empty dim">Type a prompt and press Run to see the steered reply. Turn on Compare to also see it without the steering and with the steering reversed.</div>`;
  saveSession();
}
// a new run scrolls to its top, so its header and the start of all three replies are in view while they stream
const showLastTurn = () => { const t = $("#c-thread").lastElementChild; if (t) $("#c-thread").scrollTop = t.offsetTop - 14; };
$("#c-clear").onclick = () => { if (running) running.abort(); state.thread = []; renderThread(); };
let reading = false;

async function runSteer(text) {
  const S = state.steer;
  if (!S.neurons.length) { $("#c-add").focus(); return; }
  const neurons = S.neurons.map(x => ({ layer: x.layer, n: x.n, dose: x.dose }));
  // a reply that run didn't generate carries on from the steered one, so every column has a whole conversation
  const history = state.thread.filter(t => !t.error).map(t => ({ user: t.user, replies: [0, 1, 2].map(i => turnCols(t).includes(i) ? t.replies[i] : t.replies[0]) }));
  const cols = S.compare ? [0, 1, 2] : [0];
  const turn = { user: text, replies: ["", "", ""], done: [0, 1, 2].map(i => !cols.includes(i)), mode: S.mode, neurons, cols, max: S.max, live: true };
  state.thread.push(turn); $("#c-input").value = ""; renderThread(); showLastTurn();
  const boxes = Object.fromEntries([...$("#c-thread").lastElementChild.querySelectorAll(".col")].map(c => [c.dataset.c, c.querySelector(".md")]));
  const ctl = new AbortController(), thread = state.thread;
  running = ctl; $("#c-go").textContent = "Stop"; $("#c-go").classList.add("stop");
  try {
    const res = await fetch("/api/steer", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ neurons, mode: S.mode, prompt: text, history, signs: [1, 0, -1].filter((_, i) => cols.includes(i)), max_new: S.max }) });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 2);
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.error) turn.error = ev.error;
        if (ev.cut) turn.cut = ev.cut;
        if (ev.row == null) continue;
        turn.replies[ev.row] += ev.t;
        boxes[ev.row].innerHTML = md(turn.replies[ev.row], false);
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") turn.error = String(err);
  } finally {
    turn.live = false; turn.done = [true, true, true];
    if (running === ctl) { running = null; $("#c-go").textContent = "Run"; $("#c-go").classList.remove("stop"); }
    if (state.thread === thread) { const top = $("#c-thread").scrollTop; renderThread(); $("#c-thread").scrollTop = top; }
  }
}
$("#c-form").addEventListener("submit", e => {
  e.preventDefault();
  if (running) { running.abort(); return; }
  const text = $("#c-input").value.trim() || $("#c-input").placeholder;
  if (state.steer.dir === "reads") { const f = state.focus; if (f?.kind === "neuron") runReads(f, text); return; }
  runSteer(text);
});

// ---------- variants: saved steer setups, kept per model on the server ----------
let variants = [];
const saveVariants = () => api("/api/variants", variants);
function renderVariants() {
  $("#v-list").innerHTML = variants.length ? variants.map((v, i) => `<li class="vrow" data-i="${i}">
      <div class="vmain"><span class="vname">${esc(v.name)}</span><span class="vrecipe mono">${esc(recipe(v.neurons, v.mode))}</span>${v.prompt ? `<span class="vprompt">“${esc(v.prompt)}”</span>` : ""}</div>
      <div class="vact"><button type="button" data-a="run" class="primary" title="load it and run its prompt in Chat">Run</button><button type="button" data-a="load" title="load it into the Chat steering">Load</button><button type="button" data-a="rename">Rename</button><button type="button" data-a="delete">Delete</button></div></li>`).join("")
    : `<li class="v-empty dim">No saved variants yet. Set up steering in Chat (one or more neurons and their doses), then name and save it here to load or rerun it later.</li>`;
}
// a variant (or Claude's setup) into the steering chat
function loadVariant(v) {
  const S = state.steer;
  if (running) running.abort();
  S.auto = false; S.mode = v.mode === "mul" ? "mul" : "add"; S.neurons = v.neurons.map(x => ({ layer: +x.layer, n: +x.n, dose: +x.dose }));
  if (v.compare != null) S.compare = !!v.compare;
  if (v.prompt) $("#c-input").value = v.prompt;
  if (S.dir === "reads") $('#c-dir button[data-d="writes"]').click();
  state.thread = []; renderThread(); renderStack();
  setPane("chat");
}
$("#v-save").addEventListener("submit", async e => {
  e.preventDefault();
  const S = state.steer, name = $("#v-name").value.trim();
  if (!S.neurons.length) return;
  if (!name) { $("#v-name").focus(); return; }
  const prompt = $("#c-input").value.trim() || state.thread.at(-1)?.user || "";
  variants = (await api("/api/variants")).filter(x => x.name !== name);  // Claude may have changed the list meanwhile
  variants.unshift({ id: crypto.randomUUID(), name, mode: S.mode, neurons: S.neurons.map(x => ({ layer: x.layer, n: x.n, dose: x.dose })), prompt });
  $("#v-name").value = ""; renderVariants(); await saveVariants();
});
$("#v-list").addEventListener("click", async e => {
  const b = e.target.closest("button[data-a]"); if (!b) return;
  const li = b.closest(".vrow"), id = variants[+li.dataset.i].id;
  if (b.dataset.a !== "delete" || b.classList.contains("confirm")) variants = await api("/api/variants");  // Claude may have changed it
  const v = variants.find(x => x.id === id);
  if (!v) return renderVariants();
  if (b.dataset.a === "load") loadVariant(v);
  else if (b.dataset.a === "run") { loadVariant(v); runSteer(v.prompt || $("#c-input").placeholder); }
  else if (b.dataset.a === "rename") {
    li.querySelector(".vname").outerHTML = `<input class="vname-edit" value="${esc(v.name)}" aria-label="new name">`;
    const inp = li.querySelector(".vname-edit"); inp.focus(); inp.select();
    let finished = false;
    const done = async ok => { if (finished) return; finished = true; if (ok && inp.value.trim()) { v.name = inp.value.trim(); await saveVariants(); } renderVariants(); };
    inp.addEventListener("keydown", ev => { if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); });
    inp.addEventListener("blur", () => done(true));
  } else if (b.dataset.a === "delete") {
    if (!b.classList.contains("confirm")) {  // two clicks: the first arms it for a few seconds
      b.classList.add("confirm"); b.textContent = "Delete?";
      setTimeout(() => { if (b.isConnected) { b.classList.remove("confirm"); b.textContent = "Delete"; } }, 2500);
      return;
    }
    variants = variants.filter(x => x.id !== id); renderVariants(); await saveVariants();
  }
});
$("#c-save").onclick = () => { setPane("variants"); $("#v-name").focus(); };

renderStack(); renderThread();
api("/api/variants").then(v => { variants = v; renderVariants(); });

async function runReads(f, text) {
  if (reading) return;
  reading = true; $("#c-go").textContent = "…";
  let r;
  try { r = await api("/api/reads", { layer: f.layer, n: f.n, text, chat: true }); }
  catch (err) { $("#c-reads").textContent = err.message; return; }
  finally { reading = false; $("#c-go").textContent = "Run"; }
  if (state.focus?.layer !== f.layer || state.focus?.n !== f.n) return;
  const m = Math.max(1e-6, ...r.units.map(u => Math.abs(u.act)));
  $("#c-reads").innerHTML = r.units.map(u => {
    const a = u.act / m, c = a >= 0 ? `rgba(255,181,71,${a * 0.85})` : `rgba(255,79,154,${-a * 0.85})`;
    return `<span style="background:${c}" title="${u.pieces.map(v => v.toFixed(3)).join(" · ")}">${esc(u.text)}</span>`;
  }).join("");
}

// ---------- claude: one claude -p session per conversation ----------
const agent = { chat: null, kind: "claude", busy: false, sending: 0, box: null, seg: null, segText: "", reply: "", waiters: [] };
const agentEl = $("#tab-claude");
const EMPTY = `<div class="a-empty dim">Ask anything about the model, or open a neuron and press <b>explain</b>.</div>`;
// the conversation persists in this browser: chat id (= claude session, resumed server side) and the rendered thread
const AGENT_KEY = "explorer.agent";
function saveAgent() {
  try { localStorage.setItem(AGENT_KEY, JSON.stringify({ chat: agent.chat, kind: agent.kind, html: $("#a-thread").innerHTML })); } catch {}
}
// which agent the chat runs on: the pane is named after it, and the dropdown picks it for the next new chat
function setAgentKind(kind) {
  agent.kind = kind === "codex" ? "codex" : "claude";
  $("#a-agent").value = agent.kind;
  $("#a-title").textContent = agent.kind === "codex" ? "Codex" : "Claude";
}
$("#a-agent").addEventListener("change", e => {
  const kind = e.target.value;
  try { localStorage.setItem("explorer.agentKind", kind); } catch {}
  if (agent.chat || $("#a-thread .a-msg")) { pastStash = null; $("#a-past").classList.remove("on"); resetAgent(); clearAgentMarks(); }
  setAgentKind(kind);
});
function loadAgent() {
  try {
    const v = JSON.parse(localStorage.getItem(AGENT_KEY) || "null"); if (!v) return;
    agent.chat = v.chat; $("#a-thread").innerHTML = v.html || EMPTY; setAgentKind(v.kind);
    $("#a-thread").querySelectorAll("#a-usename, .a-msg.queued, .a-busy, .a-qctl").forEach(b => b.remove());
    $("#a-thread").scrollTop = $("#a-thread").scrollHeight;
    addTurnControls();
  } catch {}
}
// quick actions above the input, for the open neuron
function renderAgentActions() {
  const f = state.focus;
  $("#a-actions").innerHTML = f && f.kind === "neuron" ? `<button data-a="explain">explain L${f.layer} N${f.n}</button><button data-a="web">what does its web do?</button>`
    : f && f.kind === "head" ? `<button data-a="explain">explain L${f.layer} h${f.n}</button>` : "";
}
$("#a-actions").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || agent.busy) return;
  if (b.dataset.a === "explain") explainFocus();
  else if (b.dataset.a === "web") { const f = state.focus; agentTurn(`Look at the cone of L${f.layer} N${f.n} (what it reads from and writes into, a few hops out) and tell me briefly what that circuit seems to do. Highlight the neurons you mention.`, `what does the web of L${f.layer} N${f.n} do?`); }
});
function resetAgent() {
  closeEvents(); if (agent.busy) finishTurn();
  agent.chat = null; $("#a-thread").innerHTML = EMPTY;
  let pref = "claude"; try { pref = localStorage.getItem("explorer.agentKind") || "claude"; } catch {}
  setAgentKind(pref);
  saveAgent();
}
agentEl.addEventListener("click", e => {
  const a = e.target.closest("a.nref"); if (a) goToNeuron(+a.dataset.l, +a.dataset.n);
});
// a tool call as one short inline line: neuron L15 N6254 · search_lens "Sure"
function toolLabel(name, a = {}) {
  const ref = a.layer != null && a.n != null ? `L${a.layer} N${a.n}` : a.layer != null ? `L${a.layer}` : "";
  const short = t => (t.length > 90 ? t.slice(0, 90) + "…" : t);
  const extra = a.command ? short(a.command) : a.file_path ? a.file_path.replace(/^\/Users\/[^/]+/, "~")
    : a.pattern ? `"${a.pattern}"` : a.query ? `"${a.query}"` : a.neurons ? `${a.neurons.length} neurons` : "";
  return [name.replace(/_/g, " "), ref, extra].filter(Boolean).join(" ");
}
function prettyOut(t) {
  try { return JSON.stringify(JSON.parse(t), null, 1); } catch { return t; }
}
function addMsg(cls, html) {
  const th = $("#a-thread"); th.querySelector(".a-empty")?.remove();
  const d = document.createElement("div"); d.className = `a-msg ${cls}`; d.innerHTML = html; th.append(d);
  th.scrollTop = th.scrollHeight; return d;
}
// one turn: the reply streams into a new assistant message, text and tool calls interleaved in the order they happen
// ---- the chat: one claude process per chat on the server and one event stream here. Messages go in any time:
// mid-reply they reach Claude between tool calls. Stop ends the reply only; background work keeps running and
// reports back in a turn of its own, which renders like any other. ----
function ensureChatId() { if (!agent.chat) agent.chat = crypto.randomUUID(); return agent.chat; }
let evCtl = null, evChat = null;
async function openEvents() {
  const chat = agent.chat; if (!chat || (evCtl && evChat === chat)) return;
  if (evCtl) evCtl.abort();
  const ctl = evCtl = new AbortController(); evChat = chat;
  while (!ctl.signal.aborted) {
    try {
      const r = await fetch(`/api/agent/events?chat=${encodeURIComponent(chat)}`, { signal: ctl.signal });
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line && evCtl === ctl) onAgentEvent(JSON.parse(line));
        }
      }
    } catch { if (ctl.signal.aborted) return; }
    await new Promise(r => setTimeout(r, 1500));  // reconnect (server restarts); its state event settles a turn that ended meanwhile
  }
}
function closeEvents() { if (evCtl) evCtl.abort(); evCtl = evChat = null; }
// the reply box under the latest message; its "thinking…" line moves with it
function replyBox() {
  if (agent.box) return agent.box;
  $("#a-thread").querySelectorAll(".a-busy").forEach(x => x.remove());
  $("#a-thread").querySelectorAll(".a-msg.assistant:empty").forEach(x => x.remove());  // a reply that moved under a newer message
  const box = agent.box = addMsg("assistant", "");
  agent.seg = null;
  if (agent.busy) { const busy = document.createElement("div"); busy.className = "a-busy"; box.append(busy); }
  return box;
}
const putInBox = el => { const box = replyBox(), busy = box.querySelector(".a-busy"); busy ? box.insertBefore(el, busy) : box.append(el); };
function setBusy(b) { agent.busy = b; setSendMode(b); }
function onAgentEvent(e) {
  const th = $("#a-thread"), stick = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  if (e.t === "state") {
    // (re)connected: the turn in progress replays from its start, so what was drawn of it is drawn again
    if (agent.box && e.busy) { agent.box.innerHTML = ""; agent.seg = null; agent.reply = ""; }
    if (e.busy) { setBusy(true); replyBox(); if (!agent.box.querySelector(".a-busy")) { const d = document.createElement("div"); d.className = "a-busy"; agent.box.append(d); } }
    else if (agent.busy && !agent.sending) finishTurn();  // a message still on its way makes the server busy in a moment
    return;
  }
  if (e.t === "ping" || e.t === "sent") return;
  if (e.t === "ui") return onUi(e);
  if (e.t === "done") return finishTurn();
  if (!agent.busy) { setBusy(true); clearTurnControls(); }  // a turn Claude started itself (background work finished)
  if (e.t === "text") {
    if (!agent.seg) { agent.seg = document.createElement("div"); agent.seg.className = "a-md"; agent.segText = ""; putInBox(agent.seg); }
    agent.segText += e.text; agent.reply += e.text; agent.seg.innerHTML = md(agent.segText);
  } else if (e.t === "tool") { agent.seg = null; putInBox(toolDetails(e)); }
  else if (e.t === "tool_result") { if (agent.box) fillTool(agent.box, e); }
  else if (e.t === "error") { const d = document.createElement("div"); d.className = "a-err"; d.textContent = e.error; putInBox(d); }
  if (stick) th.scrollTop = th.scrollHeight;
}
function finishTurn() {
  const box = agent.box, reply = agent.reply;
  $("#a-thread").querySelectorAll(".a-busy").forEach(x => x.remove());
  agent.box = agent.seg = null; agent.reply = "";
  setBusy(false); addTurnControls(); saveAgent();
  for (const w of agent.waiters.splice(0)) w({ reply, box });
}
async function agentTurn(message, shown, shownCls = "user", atts = []) {
  const f = state.focus, th = $("#a-thread");
  if (pastStash !== null) { th.innerHTML = pastStash; pastStash = null; $("#a-past").classList.remove("on"); }
  clearAgentMarks(); clearTurnControls();
  const ub = addMsg(shownCls, esc(shown) + (atts.length ? `<span class="a-att">📎 ${atts.map(a => esc(a.name)).join(", ")}</span>` : ""));
  ub.dataset.msg = message; ub.dataset.shown = shown; ub.dataset.cls = shownCls; ub.dataset.att = JSON.stringify(atts);
  agent.box = agent.seg = null;  // the reply, or the rest of the one in progress, goes under this message
  ensureChatId(); openEvents();
  setBusy(true); replyBox(); th.scrollTop = th.scrollHeight; saveAgent();
  const out = new Promise(res => agent.waiters.push(res));
  agent.sending++;
  try {
    const r = await api("/api/agent/send", { chat: agent.chat, agent: agent.kind, message, attachments: atts.map(a => a.id),
      ...(f && f.kind === "neuron" ? { layer: f.layer, n: f.n } : f && f.kind === "head" ? { layer: f.layer, head: f.n } : {}) });
    if (r.error) throw new Error(r.error);
  } catch (err) {
    const d = document.createElement("div"); d.className = "a-err"; d.textContent = String(err.message || err); putInBox(d); finishTurn();
  } finally { agent.sending--; }
  return out;
}
async function stopAgent() {
  if (!agent.busy) return;
  const d = document.createElement("div"); d.className = "a-stopped"; d.textContent = "stopped"; putInBox(d);
  const r = agent.chat ? await api("/api/agent/interrupt", { chat: agent.chat }).catch(() => ({})) : {};
  if (!r.running && agent.busy) finishTurn();  // nothing running server side: settle here
}
function toolDetails(e) {
  const d = document.createElement("details"); d.className = "a-tool"; if (e.id) d.dataset.id = e.id;
  d.innerHTML = `<summary>${esc(toolLabel(e.name, e.input || {}))}</summary><pre class="a-io"><b>${esc(e.name)}</b> ${esc(JSON.stringify(e.input || {}, null, 1))}</pre><pre class="a-io out">running…</pre>`;
  return d;
}
function fillTool(box, e) {
  const d = [...box.querySelectorAll("details.a-tool")].find(x => x.dataset.id === e.id);
  if (d) { const o = d.querySelector(".out"); o.textContent = prettyOut(e.output); o.classList.toggle("err", e.error); }
}
// ---- past chats: "past" lists the sessions on disk; picking one rebuilds its thread and later turns resume it ----
let pastStash = null;  // the thread shown before the list opened
const ago = t => { const s = Date.now() / 1000 - t; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t * 1000).toLocaleDateString(); };
async function togglePast() {
  const th = $("#a-thread");
  if (pastStash !== null) { th.innerHTML = pastStash; pastStash = null; $("#a-past").classList.remove("on"); addTurnControls(); return; }
  pastStash = th.innerHTML; $("#a-past").classList.add("on");
  th.innerHTML = `<div class="dim">…</div>`;
  const list = await api("/api/agent/chats");
  if (pastStash === null) return;
  th.innerHTML = list.length ? list.map(c => `<button class="a-pastrow${c.chat === agent.chat ? " on" : ""}" data-chat="${c.chat}" data-agent="${c.agent || "claude"}"><span class="t">${esc(c.title || "—")}</span><span class="m">${c.agent === "codex" ? "codex · " : ""}${ago(c.t)} · ${c.turns} message${c.turns === 1 ? "" : "s"}</span></button>`).join("")
    : `<div class="dim">—</div>`;
}
async function openPast(chat, kind) {
  const r = await api(`/api/agent/history?chat=${encodeURIComponent(chat)}`);
  pastStash = null; $("#a-past").classList.remove("on");
  const th = $("#a-thread"); th.innerHTML = EMPTY;
  let box = null, seg = null, segText = "";
  for (const e of r.events || []) {
    if (e.t === "user") {
      const ub = addMsg("user", esc(e.text));
      Object.assign(ub.dataset, { msg: e.text, shown: e.text, cls: "user", att: "[]" });
      box = seg = null; continue;
    }
    if (!box) { box = addMsg("assistant", ""); seg = null; }
    if (e.t === "text") {
      if (!seg) { seg = document.createElement("div"); seg.className = "a-md"; box.append(seg); segText = ""; }
      segText += (segText ? "\n\n" : "") + e.text; seg.innerHTML = md(segText);
    } else if (e.t === "tool") { seg = null; box.append(toolDetails(e)); }
    else if (e.t === "tool_result") fillTool(box, e);
    else if (e.t === "error") { seg = null; const d = document.createElement("div"); d.className = "a-err"; d.textContent = e.error; box.append(d); }
  }
  closeEvents(); if (agent.busy) { agent.box = null; finishTurn(); }
  agent.chat = chat; setAgentKind(kind); clearAgentMarks(); addTurnControls(); saveAgent(); openEvents();
  th.scrollTop = th.scrollHeight;
}
$("#a-thread").addEventListener("click", e => { const b = e.target.closest(".a-pastrow"); if (b) openPast(b.dataset.chat, b.dataset.agent); });
async function explainFocus() {
  const f = state.focus; if (!f) return;
  if (f.kind === "head") return agentTurn(`Explain attention head L${f.layer} h${f.n}: write the head report.`, `explain L${f.layer} h${f.n}`);
  if (f.kind !== "neuron") return;
  const { reply, box } = await agentTurn(`Explain L${f.layer} N${f.n}: write the autointerp report.`, `explain L${f.layer} N${f.n}`);
  const name = reply.match(/\*\*Name\*\*:?\s*(.+)/)?.[1].replace(/[*`]/g, "").trim();
  if (name) {
    const b = document.createElement("button"); b.id = "a-usename"; b.textContent = `use name: ${name}`;
    b.onclick = async () => {
      await api("/api/name", { layer: f.layer, n: f.n, name }); b.remove();
      bus.postMessage({ type: "ui", e: { action: "rename", layer: f.layer, n: f.n, name } }); loadNames();
    };
    box.append(b);
  }
}
function sendChat() {
  const msg = $("#a-input").value.trim();
  if (agent.pending.some(a => !a.id) || (!msg && !agent.pending.length)) return false;
  const atts = agent.pending; agent.pending = []; renderPending();
  $("#a-input").value = ""; growInput();
  agentTurn(msg || "(see the attached files)", msg || "(attached files)", "user", atts);
  return true;
}
function setSendMode(busy) {
  const b = $("#a-send"); b.disabled = false; b.classList.toggle("stop", busy);
  b.textContent = busy ? "■" : "↑"; b.title = busy ? "stop" : "send"; b.setAttribute("aria-label", busy ? "stop" : "send");
}

// ---- attachments: picked, dropped or pasted files upload right away and go with the next message ----
agent.pending = [];
function renderPending() {
  $("#a-files").innerHTML = agent.pending.map((a, i) => `<span class="a-file${a.id ? "" : " up"}">${esc(a.name)}<button data-i="${i}" aria-label="remove">×</button></span>`).join("");
}
$("#a-files").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { agent.pending.splice(+b.dataset.i, 1); renderPending(); } });
async function attachFiles(files) {
  for (const file of files) {
    const a = { name: file.name || "pasted", id: null }; agent.pending.push(a); renderPending();
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = bad; r.readAsDataURL(file); });
    try {
      const res = await api("/api/agent/upload", { name: a.name, type: file.type, data });
      if (res.error) throw new Error(res.error);
      a.id = res.id;
    } catch (err) { agent.pending.splice(agent.pending.indexOf(a), 1); addMsg("assistant", `<div class="a-err">${esc(a.name)}: ${esc(String(err.message || err))}</div>`); }
    renderPending();
  }
}
$("#a-attach").onclick = () => $("#a-file").click();
$("#a-file").addEventListener("change", e => { attachFiles([...e.target.files]); e.target.value = ""; });
agentEl.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); agentEl.classList.add("drop"); } });
agentEl.addEventListener("dragleave", e => { if (!agentEl.contains(e.relatedTarget)) agentEl.classList.remove("drop"); });
agentEl.addEventListener("drop", e => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); agentEl.classList.remove("drop"); attachFiles([...e.dataTransfer.files]); });
$("#a-input").addEventListener("paste", e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); attachFiles(fs); } });

// ---- edit / reroll the latest turn: cut the claude session back to before it, then resend or hand it back ----
function clearTurnControls() { document.querySelectorAll("#a-thread .a-ctl").forEach(x => x.remove()); }
function lastTurn() {
  const users = [...document.querySelectorAll("#a-thread .a-msg.user")], u = users[users.length - 1];
  if (!u) return null;
  const after = []; for (let x = u.nextElementSibling; x; x = x.nextElementSibling) after.push(x);
  return { u, after };
}
function addTurnControls() {
  clearTurnControls();
  const t = lastTurn(); if (!t) return;
  const uc = document.createElement("div"); uc.className = "a-ctl"; uc.innerHTML = `<button data-act="edit" title="remove this message and its reply, and put it back in the box">edit</button>`;
  t.u.append(uc);
  const a = t.after.find(x => x.classList.contains("assistant"));
  if (a) { const ac = document.createElement("div"); ac.className = "a-ctl"; ac.innerHTML = `<button data-act="reroll" title="throw this reply away and ask again">↻ reroll</button>`; a.append(ac); }
}
async function rewindLast(act) {
  const t = lastTurn(); if (!t) return;
  if (agent.busy) { agent.box = null; finishTurn(); }
  const u = t.u, msg = u.dataset.msg ?? u.childNodes[0]?.textContent ?? "", shown = u.dataset.shown ?? msg;
  const cls = u.dataset.cls || "user", atts = JSON.parse(u.dataset.att || "[]");
  if (agent.chat) { try { await api("/api/agent/rewind", { chat: agent.chat, text: msg }); } catch {} }
  for (const x of [u, ...t.after]) x.remove();
  if (!$("#a-thread").children.length) $("#a-thread").innerHTML = EMPTY;
  if (act === "reroll") agentTurn(msg, shown, cls, atts);
  else { $("#a-input").value = cls.includes("interp") || shown !== msg ? shown : msg; growInput(); agent.pending = atts; renderPending(); $("#a-input").focus(); addTurnControls(); saveAgent(); }
}
$("#a-thread").addEventListener("click", e => { const b = e.target.closest(".a-ctl button"); if (b) rewindLast(b.dataset.act); });
function growInput() { const t = $("#a-input"); t.style.height = "auto"; t.style.height = `${Math.min(200, t.scrollHeight)}px`; }
$("#a-input").addEventListener("input", growInput);
// Enter sends, also while Claude works: the message reaches it between tool calls
$("#a-input").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  sendChat();
});
// the button sends, or stops the reply while Claude works (Enter always sends: mid-reply the message goes straight in)
$("#a-form").addEventListener("submit", e => { e.preventDefault(); if (agent.busy) stopAgent(); else sendChat(); });
$("#a-new").onclick = () => { pastStash = null; $("#a-past").classList.remove("on"); resetAgent(); clearAgentMarks(); };
$("#a-past").onclick = togglePast;
{ let pref = "claude"; try { pref = localStorage.getItem("explorer.agentKind") || "claude"; } catch {} setAgentKind(pref); }
loadAgent(); renderAgentActions(); openEvents();

// ---------- the live link ----------
// the neuron open in the explorer: header, lens lines and quick actions; an automatic stack follows it
function showFocus() {
  const f = state.focus, nm = f?.kind === "neuron" ? names[`L${f.layer}/N${f.n}`] : "";
  $("#ch-focus").innerHTML = f ? `<span class="dim">open in the explorer</span> <b class="mono">L${f.layer} ${f.kind === "head" ? "h" : "N"}${f.n}</b>${nm ? ` ${esc(nm)}` : ""}`
    : `<span class="dim">no neuron open in the explorer</span>`;
}
let lens = null;
async function loadLens() {
  const f = state.focus; lens = null; $("#c-lens").innerHTML = "";
  if (f?.kind !== "neuron") return;
  const L = await api(`/api/lens?layer=${f.layer}&n=${f.n}`).catch(() => null);
  if (!L || state.focus?.layer !== f.layer || state.focus?.n !== f.n) return;
  lens = L; renderChatLens();
}
function renderChatLens() {
  const L = lens; if (!L) return;
  $("#c-lens").innerHTML = (L.steer_up ? `<div class="sl" title="steer lens: what pushing the open neuron up (+) or down (−) makes the model say next · click to show or fold the other lines"><span class="sgn up">+</span>${tokText(L.steer_up, 10)}</div><div class="sl" title="steer lens, pushed down"><span class="sgn down">−</span>${tokText(L.steer_down, 10)}</div>` : "") +
    `<div class="faintline" title="logit lens: tokens the neuron's output direction points at directly (+ positive, − negative)"><span class="sgn up">+</span>${tokText(L.up, 10)}</div><div class="faintline" title="logit lens, negative side"><span class="sgn down">−</span>${tokText(L.down, 10)}</div>`;
}
function onFocus(f) {
  const same = JSON.stringify(f) === JSON.stringify(state.focus) && lens;
  state.focus = f;
  if (followFocus(f)) { if (running) running.abort(); state.thread = []; renderThread(); } else renderStack();
  showFocus(); renderAgentActions();
  if (!same) { $("#c-reads").innerHTML = ""; loadLens(); }
}
// what Claude does to the screen: steering and variants happen here, everything else on the explorer page
async function onUi(e) {
  if (e.action === "steering") { loadVariant(e); if (e.run) runSteer(e.prompt || $("#c-input").placeholder); }
  else if (e.action === "variants") { variants = await api("/api/variants"); renderVariants(); }
  else if (e.action === "tab" && (e.tab === "chat" || e.tab === "variants")) setPane(e.tab);
  else { if (e.action === "rename") loadNames(); bus.postMessage({ type: "ui", e }); }
}
bus.onmessage = ({ data: m }) => {
  if (m.type === "focus") onFocus(m.focus);
  else if (m.type === "names") loadNames();
  else if (m.type === "tokprefs") { Object.assign(tokPrefs, m.prefs); renderChatLens(); }
};
loadNames(); onFocus(state.focus);
bus.postMessage({ type: "hello" });  // an open explorer answers with what is open now
