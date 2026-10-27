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

// markdown for model and agent replies: # headings, **bold**, *italic*, `code`, ``` blocks, - / 1. lists, > quotes,
// --- rules. refs: "L12 N100" becomes a link that opens the neuron. Streaming text re-renders whole each time.
function inline(t, refs) {
  const codes = [];
  let s = esc(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "<b>$1</b>").replace(/__(\S(?:.*?\S)?)__/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*(\S(?:.*?\S)?)\*(?![*\w])/g, "$1<i>$2</i>").replace(/(^|[^_\w])_(\S(?:.*?\S)?)_(?![_\w])/g, "$1<i>$2</i>");
  if (refs) s = s.replace(/\bL(\d{1,2})[ \/]N(\d{1,4})\b/g, (m, l, n) => `<a class="nref" data-l="${l}" data-n="${n}">${m}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
export function md(src, refs = true) {
  const out = [];
  let list = null, code = null, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(l => inline(l, refs)).join("<br>")}</p>`); para = []; } };
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of src.split("\n")) {
    if (code) { if (/^\s*```/.test(line)) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; } else code.push(line); continue; }
    if (/^\s*```/.test(line)) { flush(); endList(); code = []; continue; }
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/), ul = line.match(/^\s*[-*+]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      flush();
      const tag = ul ? "ul" : "ol";
      if (list !== tag) { endList(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((ul || ol)[1], refs)}</li>`);
      continue;
    }
    endList();
    if (h) { flush(); out.push(`<div class="mh mh${h[1].length}">${inline(h[2], refs)}</div>`); }
    else if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { flush(); out.push("<hr>"); }
    else if (/^\s*>/.test(line)) { flush(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""), refs)}</blockquote>`); }
    else if (!line.trim()) flush();
    else para.push(line);
  }
  if (code) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);  // a block still streaming
  flush(); endList();
  return out.join("");
}
