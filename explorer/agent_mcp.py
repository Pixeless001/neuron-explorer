"""Stdio MCP server that gives the explorer's Claude chat its tools: read any neuron data through the explorer's HTTP API,
run the live model (steered rollouts, activations) when it is loaded, and drive the map (select, highlight) in the browser that started the chat. Standard library only; started by
`claude -p --mcp-config ...` from server.py with EXPLORER_URL and EXPLORER_CHAT set.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
import uuid

URL = os.environ.get("EXPLORER_URL", "http://127.0.0.1:8791")
CHAT = os.environ.get("EXPLORER_CHAT", "")
with urllib.request.urlopen(f"{URL}/api/index", timeout=30) as _r:  # the explorer's own model, for the ranges below
    ARCH = json.load(_r)["arch"]

LAYER = {"type": "integer", "description": f"layer, 0-{ARCH['n_layers'] - 1}"}
LN = {"layer": LAYER, "n": {"type": "integer", "description": f"neuron, 0-{ARCH['inter'] - 1}"}}
HEAD = {"layer": LAYER, "head": {"type": "integer", "description": f"head: 0-{ARCH['attn_heads'] - 1} on full-attention layers, 0-{ARCH['linear_v_heads'] - 1} on linear-attention layers"}}
STACK = {"type": "array", "description": "neurons steered together; the reversed column flips every dose",
         "items": {"type": "object", "properties": {**LN, "dose": {"type": "number"}}, "required": ["layer", "n", "dose"]}}
MODE = {"type": "string", "enum": ["add", "mul"], "default": "add"}
TOOLS = [
    {"name": "overview", "description": "Model architecture and which layers have sweep runs (rollouts and rankings).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "neuron", "description": "Everything cached for one neuron: name, logit lens and steer lens (with KL) for "
     "both poles, activation range, sweep rank if any, and its 24 strongest direct-path links each way (writes_into, "
     "reads_from) with each linked neuron's steer lens, top words and name.",
     "inputSchema": {"type": "object", "properties": LN, "required": ["layer", "n"]}},
    {"name": "rollouts", "description": "Sweep rollouts for a neuron: steered text per prompt and dose beside the "
     "unsteered baselines, distinctive words and stats. Empty when the layer has no sweep run.",
     "inputSchema": {"type": "object", "properties": {**LN, "max_chars": {"type": "integer", "default": 500}},
                     "required": ["layer", "n"]}},
    {"name": "cone", "description": "The neuron's connection cone: links chained forward (downstream) and backward "
     "(upstream), first hop all links, later hops each node's top k. Returns the neurons reached with hop, best z and "
     "steer lens. Multi-hop paths are weight-only guesses: leads to check, not circuits.",
     "inputSchema": {"type": "object", "properties": {**LN, "k": {"type": "integer", "default": 2},
                                                       "limit": {"type": "integer", "default": 120}},
                     "required": ["layer", "n"]}},
    {"name": "web_summary", "description": "The token summary of the neuron's web, the same one the person sees in the "
     "left panel: steer-lens tokens pooled over its cone, each connected neuron read on the pole the chain drives, ranked "
     "by lift over that layer's base rate. `toward` / `away`: what its downstream neurons push the model toward and away "
     "from when this neuron fires (indirect effect). `fed_by` / `held_by`: what its upstream writers say when they "
     "excite / inhibit it (its inputs). Each token has n (neurons carrying it) and a score.",
     "inputSchema": {"type": "object", "properties": {**LN, "first": {"type": "integer", "default": 5},
                                                       "k": {"type": "integer", "default": 2}},
                     "required": ["layer", "n"]}},
    {"name": "search_lens", "description": "Neurons whose logit lens or steer lens (top 12, either pole) contains a token "
     "matching the query (case-insensitive substring). Best matches first.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"},
                                                       "limit": {"type": "integer", "default": 40}},
                     "required": ["query"]}},
    {"name": "top_units", "description": "A layer's neurons ranked by sweep word-cluster mass against random-direction "
     "controls, with top words and names. Empty when the layer has no sweep run.",
     "inputSchema": {"type": "object", "properties": {"layer": LN["layer"], "limit": {"type": "integer", "default": 30}},
                     "required": ["layer"]}},
    {"name": "set_name", "description": "Name a neuron in the explorer (the name field in its panel, shown in lists and on "
     "the map), or clear its name with an empty string. Only when the person asks, or after they agree to a name you "
     "suggested.",
     "inputSchema": {"type": "object", "properties": {**LN, "name": {"type": "string"}}, "required": ["layer", "n", "name"]}},
    {"name": "names", "description": "Every neuron the person has named so far, as {\"L14/N3262\": name}.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "steer", "description": "Live: generate from a chat prompt three ways in one batch, pushed up, unsteered, "
     "and pushed down (greedy). Steer one neuron (layer, n) or several at once (neurons: [{layer, n, dose?, mode?}]; all "
     "are applied together, each reversed in the down row; a negative per-neuron dose pushes that one the other way). "
     "dose in units of the layer's median residual norm for mode 'add' (0.8 is the steer-lens push; 2-3 is strong), or "
     "a multiplier for mode 'mul'. Needs the live model; errors if it is off.",
     "inputSchema": {"type": "object", "properties": {**LN, "prompt": {"type": "string"},
                                                       "neurons": {"type": "array", "items": {"type": "object", "properties": {
                                                           **LN, "dose": {"type": "number"},
                                                           "mode": {"type": "string", "enum": ["add", "mul"]}},
                                                           "required": ["layer", "n"]}},
                                                       "dose": {"type": "number", "default": 0.8},
                                                       "mode": {"type": "string", "enum": ["add", "mul"], "default": "add"},
                                                       "max_new": {"type": "integer", "default": 150}},
                     "required": ["prompt"]}},
    {"name": "activations", "description": "Live: the neuron's raw activation on every token of a text (chat=true wraps "
     "it as a user turn). Compare against act_range from `neuron`. Optional `neurons` [{layer, n, dose?, mode?}] are "
     "pushed during the same pass (steering units), to test causally whether they drive this neuron: compare with the "
     "same call without them. {layer, all: true, dose: 0} zeroes that layer's whole MLP. Optional `heads` [{layer, "
     "head, dose}] scale attention heads (dose 0 = ablate; head 'all' = every head; full-attention layers have "
     f"{ARCH['attn_heads']} heads, linear-attention layers {ARCH['linear_v_heads']} value heads; layer types are in `overview`). Only earlier layers can move it. Needs "
     "the live model; errors if it is off.",
     "inputSchema": {"type": "object", "properties": {**LN, "text": {"type": "string"},
                                                       "chat": {"type": "boolean", "default": False},
                                                       "neurons": {"type": "array", "items": {"type": "object", "properties": {
                                                           **LN, "all": {"type": "boolean"}, "dose": {"type": "number"},
                                                           "mode": {"type": "string", "enum": ["add", "mul"]}},
                                                           "required": ["layer"]}},
                                                       "heads": {"type": "array", "items": {"type": "object", "properties": {
                                                           "layer": {"type": "integer"},
                                                           "head": {"type": ["integer", "string"]},
                                                           "dose": {"type": "number", "default": 0}},
                                                           "required": ["layer", "head"]}}},
                     "required": ["layer", "n", "text"]}},
    {"name": "compare", "description": "Live: read many neurons across several texts in one call (one forward pass per "
     "text). Per neuron and text: its strongest positive and negative activation with the token, and peak_score (the "
     "activation over the neuron's usual extreme; 1 = as strong as its usual max). For screening candidates against "
     "target texts and controls; `activations` gives one neuron's full per-token trace and takes pushes for causal "
     "tests. Up to 300 neurons and 24 texts.",
     "inputSchema": {"type": "object", "properties": {
         "neurons": {"type": "array", "items": {"type": "object", "properties": LN, "required": ["layer", "n"]}},
         "texts": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {
             "label": {"type": "string"}, "text": {"type": "string"}}, "required": ["text"]}]}},
         "chat": {"type": "boolean", "default": False}},
                     "required": ["neurons", "texts"]}},
    {"name": "logprobs", "description": "Live: the next token's log-probabilities after a text (chat=true by default: "
     "the text is a user turn and the next token opens the reply; `prefix` continues from the start of a reply or any "
     "text). Returns the top k tokens and the logprob of each `targets` string's first token. With `neurons` and/or "
     "`heads` (same as `activations`: pushes, whole-layer zeroing, head scaling) it runs with and without them and "
     "returns both, the KL from baseline to intervened, and the tokens that gained and lost the most probability "
     "across the whole vocabulary: a direct read of what an intervention does to the output.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "chat": {"type": "boolean", "default": True},
                                                       "prefix": {"type": "string"}, "k": {"type": "integer", "default": 15},
                                                       "targets": {"type": "array", "items": {"type": "string"}},
                                                       "neurons": {"type": "array", "items": {"type": "object", "properties": {
                                                           **LN, "all": {"type": "boolean"}, "dose": {"type": "number"},
                                                           "mode": {"type": "string", "enum": ["add", "mul"]}},
                                                           "required": ["layer"]}},
                                                       "heads": {"type": "array", "items": {"type": "object", "properties": {
                                                           "layer": {"type": "integer"},
                                                           "head": {"type": ["integer", "string"]},
                                                           "dose": {"type": "number", "default": 0}},
                                                           "required": ["layer", "head"]}}},
                     "required": ["text"]}},
    {"name": "top_firing", "description": "Live: run text through the model and list the neurons firing hardest at one "
     "token (the first token containing `token`; omit it for the token with the strongest firing). Each neuron has its "
     "pole, score (activation over its usual extreme; 1 = as strong as its usual max), raw activation and steer lens. "
     "`layers` [lo, hi] restricts the layers. Doesn't change the person's screen; use show_text to show them.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "at": {"type": "integer", "description": "token index into the returned tokens (negative counts from the end); overrides token"}, "token": {"type": "string"},
                                                       "limit": {"type": "integer", "default": 30},
                                                       "layers": {"type": "array", "items": {"type": "integer"}},
                                                       "chat": {"type": "boolean", "default": False}},
                     "required": ["text"]}},
    {"name": "camera", "description": "Move the person's 3D view, animated, while they watch. mode 'home': the whole "
     "model. 'layer': look at one layer's neuron sheet face-on (give layer). 'neuron': fly close to one neuron (give "
     "layer and n; closeness 0.1 = very close, 0.5 = wide). 'view': frame a span of layers (layers [lo, hi], default "
     "all), framed to fit beside the side panels, from any angle: azimuth 0 = broadside (layers in a row left to "
     "right, sheets edge-on), 90 = from the output end looking down the layer axis (sheets face-on), -90 = from the "
     "input end; elevation 0 = level, 90 = from above; home is about 32 / 19; an omitted angle keeps the current one. "
     "zoom > 1 closer, < 1 wider.",
     "inputSchema": {"type": "object", "properties": {"mode": {"type": "string", "enum": ["home", "layer", "neuron", "view"]},
                                                       **LN, "closeness": {"type": "number", "default": 0.22},
                                                       "layers": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
                                                       "azimuth": {"type": "number"}, "elevation": {"type": "number"},
                                                       "zoom": {"type": "number", "default": 1}},
                     "required": ["mode"]}},
    {"name": "annotate_neurons", "description": "Pin short text labels to neurons on the 3D map (they follow the camera). "
     "Replaces the previous labels; an empty list clears them. Keep each label a few words.",
     "inputSchema": {"type": "object", "properties": {"items": {"type": "array", "items": {
         "type": "object", "properties": {**LN, "text": {"type": "string"}}, "required": ["layer", "n", "text"]}}},
                     "required": ["items"]}},
    {"name": "show_text", "description": "Put text in the explorer's paste box and run it through the live model, so the "
     "person sees its tokens; pin the first token containing `token` to show the neurons firing most there and the "
     "direct links among them on the map. Needs the live model.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "token": {"type": "string"}},
                     "required": ["text"]}},
    {"name": "show_search", "description": "Run a lens search in the explorer's left panel, so the person sees the "
     "matching neurons listed and can click them.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "open_tab", "description": "Switch the open neuron's panel to a tab: examples (sweep rollouts), chat (the "
     "person's own steered chat), details (lenses and connections) or variants (saved steer setups).",
     "inputSchema": {"type": "object", "properties": {"tab": {"type": "string", "enum": ["examples", "chat", "details", "variants"]}},
                     "required": ["tab"]}},
    {"name": "variants", "description": "The person's saved steer setups (their Variants tab): [{id, name, mode, neurons: "
     "[{layer, n, dose}], prompt}]. mode 'add': dose in units of the layer's median residual norm (0.8 is a typical "
     "push, negative pushes the other way); 'mul': the neuron's activation times dose.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "save_variant", "description": "Save a steer setup to the person's Variants tab (a variant with the same name "
     "is replaced). Only when the person asks, or after they agree to save it.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "neurons": STACK, "mode": MODE,
                                                       "prompt": {"type": "string", "description": "the prompt it is run on"}},
                     "required": ["name", "neurons"]}},
    {"name": "delete_variant", "description": "Delete a saved variant by name. Only when the person asks.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "load_variant", "description": "Load a saved variant into the person's Chat tab (its steering stack and "
     "prompt). run=true also generates there, so they watch the steered, normal and reversed replies stream in.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "run": {"type": "boolean", "default": False}},
                     "required": ["name"]}},
    {"name": "set_steering", "description": "Set up the person's Chat tab: the neurons steered together with their doses, "
     "the mode, the prompt, and which reply columns show ([steered +, normal, steered -]). run=true generates there "
     "(slow on CPU; to read rollouts yourself, use `steer`). Replaces their current stack and clears that chat.",
     "inputSchema": {"type": "object", "properties": {"neurons": STACK, "mode": MODE, "prompt": {"type": "string"},
                                                       "run": {"type": "boolean", "default": False},
                                                       "show": {"type": "array", "items": {"type": "boolean"}, "minItems": 3, "maxItems": 3}},
                     "required": ["neurons"]}},
    {"name": "view_settings", "description": "Change what the person sees; give only what should change. layout: "
     "sheet layout ('index' order or 'writes', similar output directions together). web: show the open neuron's "
     "connection web; web_depth: its top links each way (1-24). junk: lone �, punctuation and whitespace tokens in "
     "every token list ('show', 'dim', 'hide'). group_variants: merge word variants (create / created) into one chip. "
     "view: 'map' or 'embeddings'. layer: the current layer (its list and embeddings). left_panel / neuron_panel: show "
     "or hide the side panels (more room for the map). left_tab: 'network' or 'run' (text through the model).",
     "inputSchema": {"type": "object", "properties": {"layout": {"type": "string", "enum": ["index", "writes"]},
                                                       "web": {"type": "boolean"}, "web_depth": {"type": "integer"},
                                                       "junk": {"type": "string", "enum": ["show", "dim", "hide"]},
                                                       "group_variants": {"type": "boolean"},
                                                       "view": {"type": "string", "enum": ["map", "embeddings"]},
                                                       "layer": {"type": "integer"}, "left_panel": {"type": "boolean"},
                                                       "neuron_panel": {"type": "boolean"},
                                                       "left_tab": {"type": "string", "enum": ["network", "run"]}}}},
    {"name": "select_neuron", "description": "Open a neuron in the explorer: its panel, and its connection web on the map.",
     "inputSchema": {"type": "object", "properties": LN, "required": ["layer", "n"]}},
    {"name": "head", "description": "One attention head from weights, by role. q / k / v: the earlier neurons whose "
     "output feeds its query (what it looks for from the current token), its key (what makes an earlier token "
     "findable) and its value (what it carries); o: the later neurons reading its output. Each role has its top neurons "
     "(z, logit lens, name) and their steer-lens tokens pooled. `profile`: where it looks over 8 reference texts: dist is "
     "the mean share of weight on self / previous token / 2-5 back / further / first token, neg the share of negative "
     "weight (linear-attention heads are signed), src the tokens it reads most against chance, pairs its strongest "
     "single reads (query <- source) with the text they come from.",
     "inputSchema": {"type": "object", "properties": HEAD, "required": ["layer", "head"]}},
    {"name": "neuron_heads", "description": "The attention heads a neuron meets, from weights, by role: q / k / v are "
     "later heads whose query, key or value reads its output (it shapes what they look for from its token, makes its "
     "token findable, or is what they carry on); o are heads at its layer or earlier whose output it reads. z per head "
     "(share of the neuron's vector in that head's space, against a random direction, z-scored over heads); grouped "
     "heads share one key or value space.",
     "inputSchema": {"type": "object", "properties": LN, "required": ["layer", "n"]}},
    {"name": "attention", "description": "Live: one head's attention on a text. At the query token (first containing "
     "`token`, else the last) the weight on every earlier token, and the strongest single reads anywhere in the text. "
     "Full attention: softmax weights. Linear attention (Gated DeltaNet): the exact effective weights, signed, absolute "
     "values summing to 1. first_token_weight is the mean weight on token 0 (the attention sink).",
     "inputSchema": {"type": "object", "properties": {**HEAD, "text": {"type": "string"}, "at": {"type": "integer", "description": "token index into the returned tokens (negative counts from the end); overrides token"}, "token": {"type": "string"},
                                                       "chat": {"type": "boolean", "default": False}},
                     "required": ["layer", "head", "text"]}},
    {"name": "attn_drive", "description": "Live: which attention heads drive a neuron at one token of a text (first "
     "containing `token`, else where it fires hardest), and which earlier tokens each top head read that from. The "
     "activation silu(gate)*up is linearised at that token; each head's contribution is its output there read by that "
     "linearisation, `share` its fraction of linearised_total (the whole residual's drive, about 2x the activation), "
     "attention_sum all heads together and rest everything else (MLPs, embedding). `from` splits a head's contribution "
     "exactly over source tokens.",
     "inputSchema": {"type": "object", "properties": {**LN, "text": {"type": "string"}, "at": {"type": "integer", "description": "token index into the returned tokens (negative counts from the end); overrides token"}, "token": {"type": "string"},
                                                       "chat": {"type": "boolean", "default": False},
                                                       "top": {"type": "integer", "default": 8}},
                     "required": ["layer", "n", "text"]}},
    {"name": "select_head", "description": "Open an attention head in the explorer: its q / k / v / o panel, and its "
     "links on the map.",
     "inputSchema": {"type": "object", "properties": HEAD, "required": ["layer", "head"]}},
    {"name": "highlight_neurons", "description": "Mark a set of neurons on the 3D map (replaces the previous marks; an "
     "empty list clears them). sign '-' draws a neuron in the negative-pole colour.",
     "inputSchema": {"type": "object", "properties": {"neurons": {"type": "array", "items": {
         "type": "object", "properties": {**LN, "sign": {"type": "string", "enum": ["+", "-"]}},
         "required": ["layer", "n"]}}}, "required": ["neurons"]}},
]


def get(path, **q):
    with urllib.request.urlopen(f"{URL}{path}?{urllib.parse.urlencode(q)}", timeout=60) as r:
        return json.load(r)


def post(path, body, timeout=60):
    req = urllib.request.Request(f"{URL}{path}", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def stack(neurons, mode):
    """Checks a steering stack against the model before it reaches the person's page."""
    if mode not in ("add", "mul") or not neurons:
        raise ValueError("mode must be 'add' or 'mul', with at least one neuron")
    out = [{"layer": int(x["layer"]), "n": int(x["n"]), "dose": float(x["dose"])} for x in neurons]
    for x in out:
        if not (0 <= x["layer"] < ARCH["n_layers"] and 0 <= x["n"] < ARCH["inter"]):
            raise ValueError(f"no neuron L{x['layer']} N{x['n']} (layers 0-{ARCH['n_layers'] - 1}, neurons 0-{ARCH['inter'] - 1})")
    return out


def call(name, a):
    if name == "overview":
        return get("/api/agent/overview")
    if name == "neuron":
        return get("/api/agent/neuron", layer=a["layer"], n=a["n"])
    if name == "rollouts":
        u = get("/api/unit", layer=a["layer"], n=a["n"])
        cut = int(a.get("max_chars", 500))
        for key in ("rollouts", "baselines"):
            for r in u.get(key, []):
                r["text"] = r["text"][:cut]
        return u
    if name == "cone":
        return get("/api/agent/cone", layer=a["layer"], n=a["n"], k=a.get("k", 2), limit=a.get("limit", 120))
    if name == "web_summary":
        r = get("/api/web/summary", layer=a["layer"], n=a["n"], first=a.get("first", 5), k=a.get("k", 2), top=20)
        slim = lambda lst: [f"{t['tok']} ({t['n']})" for t in lst]
        return {"lens": r["src"], "links": r["links"],
                "downstream_neurons": r["down"]["neurons"], "toward": slim(r["down"]["toward"]), "away": slim(r["down"]["away"]),
                "upstream_neurons": r["up"]["neurons"], "fed_by": slim(r["up"]["fed_by"]), "held_by": slim(r["up"]["held_by"])}
    if name == "search_lens":
        r = get("/api/search", q=a["query"], limit=a.get("limit", 40))
        return {"tokens_matched": r.get("tokens"), "total": r.get("total"), "results": r.get("results", [])}
    if name == "top_units":
        us = sorted((u for u in get("/api/units", layer=a["layer"]) if u["kind"] == "neuron"), key=lambda u: -u["z"])
        return us[: int(a.get("limit", 30))]
    if name == "set_name":
        post("/api/name", {"layer": a["layer"], "n": a["n"], "name": a["name"]})
        post("/api/agent/ui", {"chat": CHAT, "action": "rename", "layer": a["layer"], "n": a["n"], "name": a["name"]})
        return {"ok": True, "neuron": f"L{a['layer']} N{a['n']}", "name": a["name"].strip() or None}
    if name == "names":
        return get("/api/agent/names")
    if name == "head":
        r = get("/api/head", layer=a["layer"], head=a["head"])
        slim = lambda lst: [{"neuron": f"L{c['layer']} N{c['n']}", "z": c["z"], "lens": c.get("lens", [])} for c in lst[:12]]
        toks = lambda lst: [f"{t['tok']} ({t['n']})" for t in lst[:16]]
        out = {"head": f"L{a['layer']} h{a['head']}", "kind": "full attention" if r["full"] else "linear attention",
               "q": {"neurons": slim(r["q"]), "tokens": toks(r["q_toks"])},
               "k": {"neurons": slim(r["k"]), "tokens": toks(r["k_toks"])},
               "v": {"neurons": slim(r["reads"]), "tokens": toks(r["read_toks"])},
               "o": {"neurons": slim(r["writes"]), "tokens": toks(r["write_toks"])}}
        try:
            p = get("/api/head/profile", layer=a["layer"], head=a["head"])
            if "dist" in p:
                out["profile"] = {"dist": dict(zip(["self", "prev", "2-5 back", "further", "first"], p["dist"])),
                                  "neg": p["neg"], "src": p["src"],
                                  "pairs": [{"query": x["qt"], "source": x["kt"], "weight": x["w"], "text": x["text"][:160]}
                                            for x in p["pairs"]]}
        except Exception:
            pass
        return out
    if name == "neuron_heads":
        r = get("/api/neuron/heads", layer=a["layer"], n=a["n"])
        return {role: [{"head": f"L{x['layer']} h{x['heads'][0]}" + (f"-{x['heads'][-1]}" if len(x["heads"]) > 1 else ""), "z": x["z"]}
                       for x in rows] for role, rows in r["roles"].items()}
    if name == "attention":
        return post("/api/agent/attention", a, timeout=900)
    if name == "attn_drive":
        return post("/api/agent/attn_drive", a, timeout=900)
    if name == "select_head":
        return post("/api/agent/ui", {"chat": CHAT, "action": "head", "layer": a["layer"], "head": a["head"]})
    if name == "steer":
        return post("/api/agent/steer", a, timeout=900)  # the first call may wait for the model to load
    if name == "top_firing":
        return post("/api/agent/fires", a, timeout=900)
    if name == "logprobs":
        return post("/api/agent/logprobs", a, timeout=900)
    if name == "compare":
        return post("/api/agent/compare", a, timeout=900)
    if name == "activations":
        return post("/api/agent/activations", a, timeout=900)
    if name == "variants":
        return get("/api/variants")
    if name == "save_variant":
        v = {"id": str(uuid.uuid4()), "name": a["name"].strip(), "mode": a.get("mode", "add"),
             "neurons": stack(a["neurons"], a.get("mode", "add")), "prompt": a.get("prompt", "")}
        if not v["name"]:
            raise ValueError("a variant needs a name")
        post("/api/variants", [v] + [x for x in get("/api/variants") if x["name"] != v["name"]])
        post("/api/agent/ui", {"chat": CHAT, "action": "variants"})
        return {"saved": v}
    if name == "delete_variant":
        vs = get("/api/variants")
        keep = [x for x in vs if x["name"] != a["name"]]
        if len(keep) == len(vs):
            raise ValueError(f"no variant named {a['name']!r}; saved: {[x['name'] for x in vs]}")
        post("/api/variants", keep)
        post("/api/agent/ui", {"chat": CHAT, "action": "variants"})
        return {"deleted": a["name"]}
    if name == "load_variant":
        vs = get("/api/variants")
        v = next((x for x in vs if x["name"] == a["name"]), None)
        if v is None:
            raise ValueError(f"no variant named {a['name']!r}; saved: {[x['name'] for x in vs]}")
        return post("/api/agent/ui", {"chat": CHAT, "action": "steering", "neurons": v["neurons"], "mode": v["mode"],
                                      "prompt": v.get("prompt", ""), "run": bool(a.get("run"))})
    if name == "set_steering":
        return post("/api/agent/ui", {"chat": CHAT, "action": "steering", **a, "neurons": stack(a["neurons"], a.get("mode", "add"))})
    if name == "view_settings":
        return post("/api/agent/ui", {"chat": CHAT, "action": "view", **a})
    ui = {"camera": "camera", "annotate_neurons": "annotate", "show_text": "text", "show_search": "search", "open_tab": "tab"}
    if name in ui:
        return post("/api/agent/ui", {"chat": CHAT, "action": ui[name], **a})
    if name == "select_neuron":
        return post("/api/agent/ui", {"chat": CHAT, "action": "select", "layer": a["layer"], "n": a["n"]})
    if name == "highlight_neurons":
        return post("/api/agent/ui", {"chat": CHAT, "action": "highlight", "neurons": a["neurons"]})
    raise ValueError(f"unknown tool {name}")


def reply(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    msg.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    if not line.strip():
        continue
    m = json.loads(line)
    method, id_ = m.get("method"), m.get("id")
    if id_ is None:
        continue  # notifications
    if method == "initialize":
        reply(id_, {"protocolVersion": m["params"].get("protocolVersion", "2025-06-18"),
                    "capabilities": {"tools": {}}, "serverInfo": {"name": "explorer", "version": "0.1"}})
    elif method == "tools/list":
        reply(id_, {"tools": TOOLS})
    elif method == "tools/call":
        p = m["params"]
        try:
            out = call(p["name"], p.get("arguments") or {})
            reply(id_, {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]})
        except Exception as e:  # tool errors go back to the model, not the protocol
            reply(id_, {"content": [{"type": "text", "text": f"error: {e}"}], "isError": True})
    elif method == "ping":
        reply(id_, {})
    else:
        reply(id_, error={"code": -32601, "message": f"method not found: {method}"})
