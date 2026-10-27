// shared by the explorer page (app.js) and the chat page (chat.js)
export const $ = s => document.querySelector(s);
export const api = async (p, body) => {
  const r = await fetch(p, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!r.ok) throw new Error(`${p.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
};
addEventListener("unhandledrejection", e => { const el = document.querySelector("#status"); if (el) el.textContent = String(e.reason?.message || e.reason); });
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtDose = d => (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d);

// the live link between the two pages (same origin, any number of tabs): the explorer posts what is open, names and
// display settings; the chat page posts what Claude does to the screen and neurons to open
export const bus = new BroadcastChannel("neuron-explorer");

// token lists everywhere: junk tokens (no letter, digit or emoji: lone �, punctuation, whitespace) are shown, dimmed or
// hidden, and word variants can share one chip. Dim, not hide, by default: some neurons' whole lens is punctuation.
export const tokPrefs = { junk: "dim", group: false };
try { Object.assign(tokPrefs, JSON.parse(localStorage.getItem("tokPrefs") || "{}")); } catch {}
const isJunk = t => !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(t);
const SUFFIXES = ["ings", "ing", "ions", "ion", "ives", "ive", "ers", "er", "ed", "es", "s", "e", "ly"];
// ponytail: one English suffix stripped (create/created/creating/creation/creative -> creat); a real stemmer if it misgroups
const stem = t => {
  const w = t.trim().toLowerCase();
  const s = /^[a-z]+$/.test(w) && SUFFIXES.find(x => w.endsWith(x) && w.length - x.length >= 3);
  return s ? w.slice(0, -s.length) : w;
};
// tokens (strings or {tok, n}) in rank order -> [{tok, n, members, junk, q}] after both settings; q is what a click searches
function tidy(list) {
  let out = list.map(x => typeof x === "string" ? { tok: x } : x)
    .map(x => ({ ...x, members: [x.tok], junk: isJunk(x.tok), q: x.tok.trim() || x.tok }));
  if (tokPrefs.group) {
    const by = new Map();
    for (const x of out) {
      const k = x.junk ? `\0${x.tok}` : stem(x.tok), g = by.get(k);
      if (!g) by.set(k, { ...x, members: [...x.members] });
      else { g.members.push(x.tok); if (g.n != null) g.n += x.n ?? 0; }
    }
    out = [...by.entries()].map(([k, g]) => g.members.length > 1 ? { ...g, q: k, n: g.n ?? g.members.length } : g);
  }
  return tokPrefs.junk === "hide" ? out.filter(x => !x.junk) : out;
}
const ONLY_JUNK = `<span class="faint" title="every token here is punctuation or whitespace; set junk to show or dim">only punctuation</span>`;
// token chips: cls "chip" (clickable, searches the lens) or "tok"; tip(x) adds to each chip's tooltip
export function tokChips(list, { cls = "chip", max = Infinity, tip } = {}) {
  const items = tidy(list).slice(0, max);
  if (!items.length) return list.length ? ONLY_JUNK : "";
  return items.map(x => {
    const title = [x.members.length > 1 ? `${x.members.map(m => m.trim() || m).join(" · ")}` : "", tip?.(x) || ""].filter(Boolean).join("\n");
    return `<span class="${cls}${x.junk && tokPrefs.junk === "dim" ? " junk" : ""}${x.members.length > 1 ? " grp" : ""}" data-q="${esc(x.q)}"${title ? ` title="${esc(title)}"` : ""}>${esc(x.tok)}${x.n != null ? `<i>${x.n}</i>` : ""}</span>`;
  }).join("");
}
// the same as running text (hover tips, chat lens lines, result rows)
export function tokText(list, max = Infinity, sep = "  ") {
  const items = tidy(list).slice(0, max);
  if (!items.length) return list.length ? ONLY_JUNK : "";
  return items.map(x => { const t = esc(x.tok) + (x.members.length > 1 ? `<sup>×${x.members.length}</sup>` : "");
    return x.junk && tokPrefs.junk === "dim" ? `<span class="junk">${t}</span>` : t; }).join(sep);
}
