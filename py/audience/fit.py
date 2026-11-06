"""Fit the simulated audience from creative_performance.csv.

Model (two-stage, per impression):
    P(click)            = sigmoid(main layer effects + segment x layer interactions + os + fatigue)
    P(install | click)  = sigmoid(main layer effects + segment x layer interactions + os)
    P(install | no click) = per-segment constant (view-through installs; 68 of 436 installs)
    P(install) = P(click) * P(install | click) + (1 - P(click)) * P(install | no click)

Why two stages: CTR is the guardrail and install rate the primary metric, so the simulator has to produce both,
consistently (an install mostly follows a click). Ridge penalties are picked by 5-fold cross-validation; segment
interactions get their own (stronger) penalty, so a segment-specific effect only survives when the data supports it.

Fatigue: log(min(exposure_n, 50)) with a per-segment slope.

Outputs:
    models/audience_model.json   coefficients + simulation inputs (segment mix, impressions-per-user histogram)
    models/history_summary.json  raw historical rates per layer value x segment (the agent's prior knowledge)

Usage: uv run python audience/fit.py --csv ../data/creative_performance.csv.gz --out ../models
"""
import argparse, hashlib, json, math, os, time
import numpy as np
import pandas as pd

LAYERS = {  # manifest layer -> CSV column
    "background": "background",
    "character": "subject_character",
    "action": "subject_action",
    "hook": "hook_text",
    "cta": "cta_text",
    "audio": "audio_style",
}
SEGMENTS = ["rpg", "companion", "casual"]
EXPO_CAP = 50
IMPRESSIONS_CAP = 10


def load(path):
    df = pd.read_csv(path)
    df["duration"] = df["duration_s"].astype(str)
    df["expo"] = np.log(np.minimum(df["exposure_n"].to_numpy(), EXPO_CAP))
    return df


def feature_names(levels):
    names = ["(intercept)"]
    kinds = ["intercept"]
    for layer in LAYERS:
        for v in levels[layer]:
            names.append(f"{layer}={v}"); kinds.append("main")
    for col in ("aspect", "duration", "os", "segment"):
        for v in levels[col]:
            names.append(f"{col}={v}"); kinds.append("main")
    for s in SEGMENTS:
        for layer in LAYERS:
            for v in levels[layer]:
                names.append(f"segment={s}|{layer}={v}"); kinds.append("interaction")
    return names, kinds


def design(df, levels, with_expo):
    """Aggregate identical feature rows (binomial counts) and one-hot encode them."""
    keys = [LAYERS[l] for l in LAYERS] + ["aspect", "duration", "os", "segment"] + (["expo"] if with_expo else [])
    names, kinds = feature_names(levels)
    if with_expo:
        names = names + ["expo"] + [f"segment={s}|expo" for s in SEGMENTS]
        kinds = kinds + ["main"] + ["main"] * len(SEGMENTS)
    idx = {n: i for i, n in enumerate(names)}
    return keys, names, kinds, idx


def build(df, ycol, levels, with_expo):
    keys, names, kinds, idx = design(df, levels, with_expo)
    g = df.groupby(keys, observed=True)[ycol].agg(["sum", "size"]).reset_index()
    X = np.zeros((len(g), len(names)))
    X[:, 0] = 1.0
    rows = np.arange(len(g))
    for layer, col in LAYERS.items():
        X[rows, [idx[f"{layer}={v}"] for v in g[col]]] = 1.0
        X[rows, [idx[f"segment={s}|{layer}={v}"] for s, v in zip(g["segment"], g[col])]] = 1.0
    for col in ("aspect", "duration", "os", "segment"):
        X[rows, [idx[f"{col}={v}"] for v in g[col]]] = 1.0
    if with_expo:
        X[:, idx["expo"]] = g["expo"].to_numpy()
        for s in SEGMENTS:
            X[:, idx[f"segment={s}|expo"]] = g["expo"].to_numpy() * (g["segment"] == s).to_numpy()
    return X, g["sum"].to_numpy(float), g["size"].to_numpy(float), names, kinds


def fit_logit(X, y, n, penalty, iters=60, tol=1e-8):
    """Ridge-penalized binomial logistic regression by Newton-Raphson."""
    beta = np.zeros(X.shape[1])
    rate = max(y.sum() / n.sum(), 1e-6)
    beta[0] = math.log(rate / (1 - rate))
    for _ in range(iters):
        eta = X @ beta
        p = 1 / (1 + np.exp(-eta))
        grad = X.T @ (y - n * p) - penalty * beta
        w = n * p * (1 - p)
        H = (X * w[:, None]).T @ X + np.diag(penalty + 1e-9)
        step = np.linalg.solve(H, grad)
        beta += step
        if np.max(np.abs(step)) < tol:
            break
    return beta


def deviance(X, y, n, beta):
    p = np.clip(1 / (1 + np.exp(-(X @ beta))), 1e-12, 1 - 1e-12)
    return float(-2 * np.sum(y * np.log(p) + (n - y) * np.log(1 - p)))


def penalties(kinds, lam_main, lam_int):
    return np.array([0.0 if k == "intercept" else (lam_main if k == "main" else lam_int) for k in kinds])


def cv_select(df, ycol, levels, with_expo, grid, folds=5, seed=0):
    rng = np.random.default_rng(seed)
    fold = rng.integers(0, folds, len(df))
    best = None
    table = []
    for lam_main, lam_int in grid:
        dev = 0.0
        for f in range(folds):
            tr, te = df[fold != f], df[fold == f]
            Xtr, ytr, ntr, _, kinds = build(tr, ycol, levels, with_expo)
            beta = fit_logit(Xtr, ytr, ntr, penalties(kinds, lam_main, lam_int))
            Xte, yte, nte, _, _ = build(te, ycol, levels, with_expo)
            dev += deviance(Xte, yte, nte, beta)
        table.append({"lambda_main": lam_main, "lambda_interaction": lam_int, "cv_deviance": round(dev, 2)})
        if best is None or dev < best[0]:
            best = (dev, lam_main, lam_int)
    return best[1], best[2], table


def auc(score, label):
    order = np.argsort(score)
    ranks = np.empty(len(score)); ranks[order] = np.arange(1, len(score) + 1)
    pos = label == 1
    npos, nneg = pos.sum(), (~pos).sum()
    return float((ranks[pos].sum() - npos * (npos + 1) / 2) / (npos * nneg))


def predict_rows(df, levels, beta, names, with_expo):
    idx = {n: i for i, n in enumerate(names)}
    eta = np.full(len(df), beta[0])
    for layer, col in LAYERS.items():
        eta += beta[[idx[f"{layer}={v}"] for v in df[col]]]
        eta += beta[[idx[f"segment={s}|{layer}={v}"] for s, v in zip(df["segment"], df[col])]]
    for col in ("aspect", "duration", "os", "segment"):
        eta += beta[[idx[f"{col}={v}"] for v in df[col]]]
    if with_expo:
        eta += beta[idx["expo"]] * df["expo"].to_numpy()
        for s in SEGMENTS:
            eta += beta[idx[f"segment={s}|expo"]] * df["expo"].to_numpy() * (df["segment"] == s).to_numpy()
    return 1 / (1 + np.exp(-eta))


def wilson(k, n, z=1.96):
    if n == 0:
        return [0.0, 0.0]
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [max(0.0, (c - r) / d), min(1.0, (c + r) / d)]


def history_summary(df):
    out = {"note": "Raw historical rates from 2 weeks of serving. Observational: variants were not randomized, "
                   "so marginal rates are confounded by which combinations were served to whom. Use as a prior, "
                   "not as truth. ipm = installs per 1000 impressions.",
           "totals": {}, "layers": {}, "variants": []}
    def stats(g):
        n, c, i = int(len(g)), int(g["click"].sum()), int(g["install"].sum())
        lo, hi = wilson(i, n)
        return {"impressions": n, "clicks": c, "installs": i, "ctr": round(c / n, 5) if n else 0,
                "ipm": round(1000 * i / n, 3) if n else 0, "ipm_ci95": [round(1000 * lo, 3), round(1000 * hi, 3)]}
    out["totals"]["all"] = stats(df)
    for s in SEGMENTS:
        out["totals"][s] = stats(df[df.segment == s])
    for layer, col in LAYERS.items():
        out["layers"][layer] = {}
        for v, g in df.groupby(col):
            row = {"all": stats(g)}
            for s in SEGMENTS:
                row[s] = stats(g[g.segment == s])
            out["layers"][layer][v] = row
    for vid, g in df.groupby("variant_id"):
        r = g.iloc[0]
        out["variants"].append({"variant_id": vid, **{l: r[c] for l, c in LAYERS.items()},
                                "aspect": r["aspect"], "duration_s": int(r["duration_s"]), **stats(g)})
    out["variants"].sort(key=lambda v: -v["impressions"])
    return out


def impressions_per_user(df):
    """How many times one user saw one variant (max exposure_n per user x variant), capped, per segment."""
    m = df.groupby(["user_id", "variant_id", "segment"])["exposure_n"].max().reset_index()
    m["k"] = np.minimum(m["exposure_n"], IMPRESSIONS_CAP)
    out = {}
    for s in SEGMENTS:
        h = m[m.segment == s]["k"].value_counts().sort_index()
        tot = h.sum()
        out[s] = {str(int(k)): round(float(v / tot), 6) for k, v in h.items()}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--quick", action="store_true", help="smaller CV grid")
    a = ap.parse_args()
    t0 = time.time()
    raw = open(a.csv, "rb").read()
    df = load(a.csv)
    levels = {l: sorted(df[c].unique().tolist()) for l, c in LAYERS.items()}
    for col in ("aspect", "duration", "os", "segment"):
        levels[col] = sorted(df[col].unique().tolist())
    print(f"rows={len(df)} clicks={int(df.click.sum())} installs={int(df.install.sum())}")

    mains = [10, 30, 100] if a.quick else [3, 10, 30, 100, 300]
    mults = [1, 3] if a.quick else [0.3, 1, 3, 10, 30]
    grid = [(m, m * k) for m in mains for k in mults]

    lam_c, lam_ci, cv_click = cv_select(df, "click", levels, True, grid)
    print(f"click: lambda_main={lam_c} lambda_int={lam_ci}")
    clicked = df[df.click == 1]
    lam_i, lam_ii, cv_inst = cv_select(clicked, "install", levels, False, grid)
    print(f"install|click: lambda_main={lam_i} lambda_int={lam_ii}")

    Xc, yc, nc, names_c, kinds_c = build(df, "click", levels, True)
    beta_c = fit_logit(Xc, yc, nc, penalties(kinds_c, lam_c, lam_ci))
    Xi, yi, ni, names_i, kinds_i = build(clicked, "install", levels, False)
    beta_i = fit_logit(Xi, yi, ni, penalties(kinds_i, lam_i, lam_ii))
    noclick = df[df.click == 0]
    p_nc = {s: float((noclick[noclick.segment == s].install.sum() + 0.5) / (len(noclick[noclick.segment == s]) + 1))
            for s in SEGMENTS}

    # held-out diagnostics (one 80/20 split, same penalties)
    rng = np.random.default_rng(1)
    te_mask = rng.random(len(df)) < 0.2
    tr, te = df[~te_mask], df[te_mask]
    Xa, ya, na, _, ka = build(tr, "click", levels, True)
    bc = fit_logit(Xa, ya, na, penalties(ka, lam_c, lam_ci))
    Xb, yb, nb, _, kb = build(tr[tr.click == 1], "install", levels, False)
    bi = fit_logit(Xb, yb, nb, penalties(kb, lam_i, lam_ii))
    pc = predict_rows(te, levels, bc, names_c, True)
    pic = predict_rows(te, levels, bi, names_i, False)
    pnc = te["segment"].map(p_nc).to_numpy()
    pin = pc * pic + (1 - pc) * pnc
    base_c, base_i = tr.click.mean(), tr.install.mean()
    def ll(p, y):
        p = np.clip(p, 1e-9, 1 - 1e-9); return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    diag = {
        "holdout_rows": int(te_mask.sum()),
        "click_auc": round(auc(pc, te.click.to_numpy()), 4),
        "install_auc": round(auc(pin, te.install.to_numpy()), 4),
        "click_logloss": round(ll(pc, te.click.to_numpy()), 5), "click_logloss_base": round(ll(np.full(len(te), base_c), te.click.to_numpy()), 5),
        "install_logloss": round(ll(pin, te.install.to_numpy()), 6), "install_logloss_base": round(ll(np.full(len(te), base_i), te.install.to_numpy()), 6),
    }
    # per-variant calibration on all data
    pc_all = predict_rows(df, levels, beta_c, names_c, True)
    pic_all = predict_rows(df, levels, beta_i, names_i, False)
    pin_all = pc_all * pic_all + (1 - pc_all) * df["segment"].map(p_nc).to_numpy()
    cal = df.assign(pc=pc_all, pin=pin_all).groupby("variant_id").agg(
        n=("click", "size"), ctr=("click", "mean"), ctr_hat=("pc", "mean"), ir=("install", "mean"), ir_hat=("pin", "mean"))
    w = cal["n"].to_numpy()
    def wcorr(a, b):
        a, b = np.asarray(a), np.asarray(b); ma, mb = np.average(a, weights=w), np.average(b, weights=w)
        return float(np.average((a - ma) * (b - mb), weights=w) / math.sqrt(np.average((a - ma) ** 2, weights=w) * np.average((b - mb) ** 2, weights=w)))
    diag["variant_ctr_corr_weighted"] = round(wcorr(cal.ctr, cal.ctr_hat), 4)
    diag["variant_install_corr_weighted"] = round(wcorr(cal.ir, cal.ir_hat), 4)
    diag["calibration_by_variant"] = [{"variant_id": i, "n": int(r.n), "ctr": round(r.ctr, 5), "ctr_hat": round(r.ctr_hat, 5),
                                       "ipm": round(1000 * r.ir, 3), "ipm_hat": round(1000 * r.ir_hat, 3)} for i, r in cal.iterrows()]
    print(json.dumps({k: v for k, v in diag.items() if k != "calibration_by_variant"}, indent=1))

    seg_mix = (df.groupby("user_id").segment.first().value_counts(normalize=True)).to_dict()
    os_mix = {s: df[df.segment == s].groupby("user_id").os.first().value_counts(normalize=True).to_dict() for s in SEGMENTS}
    model = {
        "version": 1,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "data_sha256": hashlib.sha256(raw).hexdigest(),
        "description": "Two-stage ridge logistic audience model fit on creative_performance.csv (see py/audience/fit.py).",
        "layers": {l: levels[l] for l in LAYERS},
        "columns": LAYERS,
        "aspects": levels["aspect"], "durations": levels["duration"], "segments": SEGMENTS, "os": levels["os"],
        "expo_cap": EXPO_CAP,
        "click": {"lambda_main": lam_c, "lambda_interaction": lam_ci,
                  "weights": {n: round(float(b), 6) for n, b in zip(names_c, beta_c)}},
        "install_given_click": {"lambda_main": lam_i, "lambda_interaction": lam_ii,
                                "weights": {n: round(float(b), 6) for n, b in zip(names_i, beta_i)}},
        "install_given_no_click": {s: round(p, 7) for s, p in p_nc.items()},
        "segment_mix": {s: round(float(seg_mix.get(s, 0)), 5) for s in SEGMENTS},
        "os_mix": {s: {o: round(float(p), 5) for o, p in os_mix[s].items()} for s in SEGMENTS},
        "impressions_per_user": impressions_per_user(df),
        "cv": {"click": cv_click, "install_given_click": cv_inst},
        "diagnostics": diag,
        "fit_seconds": round(time.time() - t0, 1),
    }
    os.makedirs(a.out, exist_ok=True)
    json.dump(model, open(os.path.join(a.out, "audience_model.json"), "w"), indent=1)
    json.dump(history_summary(df), open(os.path.join(a.out, "history_summary.json"), "w"), indent=1)
    print(f"wrote {a.out}/audience_model.json and history_summary.json in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
