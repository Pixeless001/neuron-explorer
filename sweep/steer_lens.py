"""Steer lens: what pushing each neuron does to the model's next-token prediction, through every layer after it.

For each neuron and sign, adds ±dose x (median residual norm / ||W_down[:, n]||) to the neuron at every position of a
few short contexts, runs one forward pass, and compares the last position's log-probabilities with the unsteered run.
Keeps, per neuron and sign, the 12 tokens whose log-probability rises most (averaged over contexts) and the KL
divergence from the unsteered prediction.

    uv run python sweep/steer_lens.py                         # every layer; CUDA, MPS or CPU
    uv run python sweep/steer_lens.py --layers 12 --limit 96  # timing test, written beside the real files

Writes <out>_L{l}.npz per layer: up_tok[N, 12], down_tok[N, 12] (token ids for the + push and - push), up_kl[N],
down_kl[N]. Layers already on disk are skipped, so an interrupted run resumes. Once every layer is there it writes the
explorer's steer_index.npz (up, down [L, N, 12], up_kl, down_kl [L, N]). Standalone: needs no other repo file.
"""
import argparse
import os
import time

import numpy as np
import torch
from transformers import AutoConfig, AutoTokenizer, Qwen3_5ForConditionalGeneration

CHAT = ["Who are you?", "Write whatever you like."]
PLAIN = ["I think the most important thing to remember is", "Today we are going to talk about"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Skip(torch.nn.Module):
    """Stands in for a decoder layer whose output is already known: passes the hidden state through."""
    def forward(self, hidden_states, **kwargs):
        return hidden_states


def build_index(paths, out):
    z = [np.load(p) for p in paths]
    np.savez(out, up=np.stack([x["up_tok"] for x in z]), down=np.stack([x["down_tok"] for x in z]),
             up_kl=np.stack([x["up_kl"] for x in z]), down_kl=np.stack([x["down_kl"] for x in z]), dose=z[0]["dose"])
    print("->", out, np.load(out)["up"].shape, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("EXPLORER_MODEL", "Qwen/Qwen3.5-0.8B"))
    ap.add_argument("--layers", default=None, help="e.g. 12 or 0-7; default every layer")
    ap.add_argument("--dose", type=float, default=0.8)
    ap.add_argument("--neurons-per-batch", type=int, default=96)
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("--out", default=None, help="file prefix; default stats/q35-<size>_steer_lens")
    ap.add_argument("--limit", type=int, default=None, help="first N neurons per layer only (timing tests)")
    ap.add_argument("--full-forward", action="store_true", help="rerun the layers before the pushed one every pass")
    ap.add_argument("--index", default=os.path.join(ROOT, os.environ.get("EXPLORER_CACHE", "explorer/cache"),
                                                    "steer_index.npz"))
    a = ap.parse_args()
    n_layers = AutoConfig.from_pretrained(a.model).get_text_config().num_hidden_layers
    a.out = a.out or "stats/q35-" + a.model.rsplit("-", 1)[-1].lower() + "_steer_lens"
    if a.limit:  # partial layers never count as done
        a.out += f"_limit{a.limit}" + ("_full" if a.full_forward else "")
    lo, _, hi = (a.layers or f"0-{n_layers - 1}").partition("-")
    layers = list(range(int(lo), int(hi or lo) + 1))
    path = lambda l: f"{a.out}_L{l}.npz"
    todo = [l for l in layers if not os.path.exists(path(l))]
    print(f"{len(layers) - len(todo)} of {len(layers)} layers already done", flush=True)

    if todo:
        run(a, todo, path)
    every = [path(l) for l in range(n_layers)]
    if not a.limit and all(map(os.path.exists, every)):
        os.makedirs(os.path.dirname(a.index), exist_ok=True)
        build_index(every, a.index)


def run(a, layers, path):
    dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    # bf16 only where it is native; a T4 or a CPU without AMX runs it slowly
    native_bf16 = dev == "cuda" and torch.cuda.is_bf16_supported(including_emulation=False)
    dtype = torch.bfloat16 if native_bf16 or dev == "mps" else torch.float32
    print(f"device {dev}, {dtype}", flush=True)
    tok = AutoTokenizer.from_pretrained(a.model)
    model = Qwen3_5ForConditionalGeneration.from_pretrained(a.model, dtype=dtype).to(dev).eval()
    lm = model.model.language_model
    ctxs = [tok.apply_chat_template([{"role": "user", "content": c}], add_generation_prompt=True, enable_thinking=False,
                                    tokenize=True) for c in CHAT] + [tok(p).input_ids for p in PLAIN]
    ctxs = [list(c["input_ids"] if hasattr(c, "keys") else c) for c in ctxs]
    C, T = len(ctxs), max(map(len, ctxs))
    pad = tok.pad_token_id if tok.pad_token_id is not None else 0
    ids = torch.tensor([[pad] * (T - len(c)) + c for c in ctxs], device=dev)
    mask = torch.tensor([[0] * (T - len(c)) + [1] * len(c) for c in ctxs], device=dev)
    posn = (mask.cumsum(-1) - 1).clamp(min=0)

    push = {"layer": None, "cols": None, "vals": None}
    resid, resid_in = {}, {}

    def make_hook(i):
        def hook(mod, inp):
            if push["layer"] != i:
                return
            h = inp[0].clone()
            rows = torch.arange(h.shape[0], device=h.device)
            h[rows, :, push["cols"]] += push["vals"][:, None].to(h.dtype)
            return (h,)
        return hook

    def keep_input(i):
        def hook(mod, inp):
            resid_in.setdefault(i, inp[0])  # the first (unsteered base) pass only
        return hook

    for i, layer in enumerate(lm.layers):
        layer.mlp.down_proj.register_forward_pre_hook(make_hook(i))
        layer.register_forward_pre_hook(keep_input(i))
        layer.register_forward_hook(lambda m, inp, out, i=i: resid.__setitem__(i, (out[0] if isinstance(out, tuple) else out)))

    def last_logprobs(input_ids, attn, pos, start=0):
        """With start > 0, layers before `start` are skipped and the base run's input to layer `start` is fed in: a
        push at layer `start` can't change anything before it."""
        real = list(lm.layers)
        for i in range(start):
            lm.layers[i] = Skip()
        try:
            if start:
                x = resid_in[start].repeat(input_ids.shape[0] // C, 1, 1)
                h = lm(inputs_embeds=x, attention_mask=attn, position_ids=pos, use_cache=False).last_hidden_state[:, -1]
            else:
                h = lm(input_ids=input_ids, attention_mask=attn, position_ids=pos, use_cache=False).last_hidden_state[:, -1]
        finally:
            for i in range(start):
                lm.layers[i] = real[i]
        return torch.log_softmax(model.lm_head(h).float(), -1)

    with torch.inference_mode():
        base = last_logprobs(ids, mask, posn)  # [C, V]
        # median residual norm leaving each layer over these contexts' real tokens
        norms = {i: r[mask.bool()].float().norm(dim=-1).median().item() for i, r in resid.items()}

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    B = a.neurons_per_batch
    for l in layers:
        W = lm.layers[l].mlp.down_proj.weight  # [hidden, inter]
        N = W.shape[1]
        n_run = min(N, a.limit or N)
        unit = norms[l] / W.float().norm(dim=0)  # [N]
        out = {k: [] for k in ("up_tok", "down_tok", "up_kl", "down_kl")}
        t0 = time.time()
        for s in range(0, n_run, B):
            n = torch.arange(s, min(s + B, n_run), device=dev)
            b = len(n)
            for sign, key in ((1.0, "up"), (-1.0, "down")):
                # rows: neuron-major, contexts repeated
                cols = n.repeat_interleave(C)
                vals = sign * a.dose * unit[cols]
                push.update(layer=l, cols=cols, vals=vals)
                with torch.inference_mode():
                    lp = last_logprobs(ids.repeat(b, 1), mask.repeat(b, 1), posn.repeat(b, 1),
                                       0 if a.full_forward else l).view(b, C, -1)
                push["layer"] = None
                delta = (lp - base[None]).mean(1)  # [b, V]
                kl = (lp.exp() * (lp - base[None])).sum(-1).mean(1)  # KL(steered || base), averaged over contexts
                out[f"{key}_tok"].append(delta.topk(a.k).indices.int().cpu())
                out[f"{key}_kl"].append(kl.cpu())
        arrs = {k: torch.cat(v).numpy() for k, v in out.items()}
        tmp = path(l)[:-4] + ".tmp.npz"  # written whole, then renamed: a crash never leaves a half layer behind
        np.savez(tmp, **arrs, dose=a.dose, contexts=np.array(CHAT + PLAIN))
        os.replace(tmp, path(l))
        dt = time.time() - t0
        print(f"L{l}: {n_run} neurons in {dt:.0f}s ({dt * N / n_run:.0f}s for all {N}), "
              f"KL+ median {np.median(arrs['up_kl']):.3f}", flush=True)


if __name__ == "__main__":
    main()
