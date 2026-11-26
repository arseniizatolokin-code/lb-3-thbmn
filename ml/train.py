"""Навчання, підбір гіперпараметрів, оцінювання, графіки, збереження моделі.   python ml/train.py"""
import hashlib, itertools, json, os, sys, time
import joblib, numpy as np, pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (average_precision_score, brier_score_loss, confusion_matrix, f1_score, log_loss,
                             precision_recall_curve, precision_score, recall_score, roc_auc_score, roc_curve)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
sys.path.insert(0, os.path.dirname(__file__))
from features import CAT, FEATURES, NUM, engineer

SEED = 42
HERE = os.path.dirname(__file__)
D, M = os.path.join(HERE, "data"), os.path.join(HERE, "model")
FIG = os.path.join(HERE, "..", "reports", "figs")
os.makedirs(M, exist_ok=True); os.makedirs(FIG, exist_ok=True)
plt.rcParams.update({"figure.dpi": 130, "font.size": 10, "axes.grid": True, "grid.alpha": .3})
COL = {"Базовий метод": "#8d99ae", "Логістична регресія": "#2b6cb0", "Градієнтний бустинг": "#2f9e6f"}

tr, va, te = (pd.read_csv(os.path.join(D, f"{n}.csv"), parse_dates=["created_at"]) for n in ("train", "val", "test"))
Xtr, Xva, Xte = engineer(tr), engineer(va), engineer(te)
ytr, yva, yte = tr.dispute.values, va.dispute.values, te.dispute.values


def prep(scale):
    num = [("imp", SimpleImputer(strategy="median", add_indicator=True))] + ([("sc", StandardScaler())] if scale else [])
    return ColumnTransformer([("num", Pipeline(num), NUM), ("cat", OneHotEncoder(handle_unknown="ignore"), CAT)])


def make(kind, **p):
    if kind == "lr":
        return Pipeline([("prep", prep(True)), ("clf", LogisticRegression(max_iter=2000, random_state=SEED, **p))])
    return Pipeline([("prep", prep(False)), ("clf", HistGradientBoostingClassifier(random_state=SEED, **p))])


class CategoryRate:
    """Базовий метод: частка спорів у категорії (з навчальної вибірки)."""
    def fit(self, X, y):
        self.r = pd.Series(y, index=X.category.values).groupby(level=0).mean(); self.g = float(np.mean(y)); return self
    def predict_proba(self, X):
        p = X.category.map(self.r).fillna(self.g).values; return np.c_[1 - p, p]


def ece(y, p, bins=10):
    b = np.minimum((p * bins).astype(int), bins - 1); e = 0.0
    for i in range(bins):
        m = b == i
        if m.any(): e += m.mean() * abs(y[m].mean() - p[m].mean())
    return float(e)


def best_thr(y, p):
    pr, rc, th = precision_recall_curve(y, p)
    f = 2 * pr * rc / np.maximum(pr + rc, 1e-9)
    return float(th[np.argmax(f[:-1])])


def metrics(y, p, thr):
    yh = (p >= thr).astype(int)
    return {"ROC_AUC": roc_auc_score(y, p), "PR_AUC": average_precision_score(y, p), "F1": f1_score(y, yh),
            "precision": precision_score(y, yh, zero_division=0), "recall": recall_score(y, yh),
            "Brier": brier_score_loss(y, p), "ECE": ece(y, p)}


# ---------- 1. підбір гіперпараметрів на валідаційній вибірці ----------
grids = {"lr": [{"C": c} for c in (0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10)],
         "hgb": [{"learning_rate": lr, "max_depth": d, "max_iter": n, "l2_regularization": l2}
                 for lr, d, n, l2 in itertools.product((0.03, 0.1), (2, 3, 4, 6), (100, 200, 400), (0.0, 1.0))]}
rows = []
for kind, grid in grids.items():
    for p in grid:
        m = make(kind, **p).fit(Xtr, ytr); pv = m.predict_proba(Xva)[:, 1]
        rows.append({"model": kind, **p, "val_PR_AUC": average_precision_score(yva, pv), "val_ROC_AUC": roc_auc_score(yva, pv),
                     "val_logloss": log_loss(yva, pv)})
tune = pd.DataFrame(rows); tune.to_csv(os.path.join(M, "tuning_results.csv"), index=False)
best = {k: tune[tune.model == k].sort_values("val_PR_AUC", ascending=False).iloc[0] for k in grids}
bp = {"lr": {"C": float(best["lr"].C)},
      "hgb": {"learning_rate": float(best["hgb"].learning_rate), "max_depth": int(best["hgb"].max_depth),
              "max_iter": int(best["hgb"].max_iter), "l2_regularization": float(best["hgb"].l2_regularization)}}
print("найкращі параметри:", bp)

# ---------- 2. фінальне навчання, час, розмір, метрики ----------
names = {"base": "Базовий метод", "lr": "Логістична регресія", "hgb": "Градієнтний бустинг"}
models, times, sizes, lat = {}, {}, {}, {}
for k in names:
    t = time.perf_counter()
    models[k] = CategoryRate().fit(Xtr, ytr) if k == "base" else make(k, **bp[k]).fit(Xtr, ytr)
    times[k] = time.perf_counter() - t
    joblib.dump(models[k], f"/tmp/_m_{k}.joblib"); sizes[k] = os.path.getsize(f"/tmp/_m_{k}.joblib") / 1024
    one = Xte.iloc[[0]]; t = time.perf_counter()
    for _ in range(100): models[k].predict_proba(one)
    lat[k] = (time.perf_counter() - t) / 100 * 1000
P = {s: {k: models[k].predict_proba(X)[:, 1] for k in names} for s, X in (("val", Xva), ("test", Xte))}
thr = {k: best_thr(yva, P["val"][k]) for k in names}
Mt = {k: metrics(yte, P["test"][k], thr[k]) for k in names}
Mv = {k: metrics(yva, P["val"][k], thr[k]) for k in names}

# ---------- 3. розкид по фолдах (часові) і бутстреп-ДІ ----------
cv = {}
for k in names:
    rs = []
    for a, b in TimeSeriesSplit(5).split(Xtr):
        m = CategoryRate().fit(Xtr.iloc[a], ytr[a]) if k == "base" else make(k, **bp[k]).fit(Xtr.iloc[a], ytr[a])
        pb = m.predict_proba(Xtr.iloc[b])[:, 1]; th = best_thr(ytr[a], m.predict_proba(Xtr.iloc[a])[:, 1])
        rs.append(metrics(ytr[b], pb, th))
    cv[k] = pd.DataFrame(rs)
rng = np.random.default_rng(SEED); ci = {k: {} for k in names}
idx = [rng.integers(0, len(yte), len(yte)) for _ in range(500)]
for k in names:
    boot = pd.DataFrame([metrics(yte[i], P["test"][k][i], thr[k]) for i in idx])
    for mname in ("PR_AUC", "ROC_AUC", "F1"):
        ci[k][mname] = [float(boot[mname].quantile(.025)), float(boot[mname].quantile(.975))]

# ---------- 4. вибір фінальної моделі та збереження ----------
final = max(("lr", "hgb"), key=lambda k: Mv[k]["PR_AUC"])
joblib.dump(models[final], os.path.join(M, "model.joblib"))
sha = hashlib.sha256(open(os.path.join(M, "model.joblib"), "rb").read()).hexdigest()
open(os.path.join(M, "model.sha256"), "w").write(sha + "\n")
json.dump({"final": final, "name": names[final], "threshold": thr[final], "sha256": sha, "params": bp[final],
           "seed": SEED, "train_rows": len(tr), "train_period": [str(tr.created_at.min().date()), str(tr.created_at.max().date())]},
          open(os.path.join(M, "meta.json"), "w"), ensure_ascii=False, indent=1)
comp = pd.DataFrame([{"Модель": names[k], **{m: round(v, 4) for m, v in Mt[k].items()},
                      "Час навчання, с": round(times[k], 3), "Час 1 передбачення, мс": round(lat[k], 3),
                      "Розмір, КБ": round(sizes[k], 1)} for k in names])
comp.to_csv(os.path.join(M, "comparison.csv"), index=False)
cvs = {names[k]: {m: [round(cv[k][m].mean(), 4), round(cv[k][m].std(), 4)] for m in ("PR_AUC", "ROC_AUC", "F1")} for k in names}
json.dump({"test": {names[k]: Mt[k] for k in names}, "val": {names[k]: Mv[k] for k in names}, "cv_mean_std": cvs,
           "bootstrap_ci_95": {names[k]: ci[k] for k in names}, "thresholds": {names[k]: thr[k] for k in names},
           "test_pos_rate": float(yte.mean()), "val_pos_rate": float(yva.mean())},
          open(os.path.join(M, "metrics.json"), "w"), ensure_ascii=False, indent=1)
print(comp.to_string()); print("фінальна модель:", names[final], "sha256", sha)

# ---------- 5. графіки ----------
def save(n): plt.tight_layout(); plt.savefig(os.path.join(FIG, n)); plt.close()
fm, pt = models[final], P["test"][final]
# 1 криві навчання: втрати за ітераціями (бустинг) і якість від розміру вибірки
fig, ax = plt.subplots(1, 2, figsize=(10, 3.8))
hg = models["hgb"]; Xt_, Xv_ = hg.named_steps["prep"].transform(Xtr), hg.named_steps["prep"].transform(Xva)
tl = [log_loss(ytr, p[:, 1]) for p in hg.named_steps["clf"].staged_predict_proba(Xt_)]
vl = [log_loss(yva, p[:, 1]) for p in hg.named_steps["clf"].staged_predict_proba(Xv_)]
ax[0].plot(tl, label="навчальна", color="#2f9e6f"); ax[0].plot(vl, label="валідаційна", color="#c05621")
ax[0].set(xlabel="ітерація бустингу", ylabel="logloss", title="Градієнтний бустинг: функція втрат"); ax[0].legend()
fr = [0.1, 0.2, 0.35, 0.5, 0.75, 1.0]
for k in ("lr", "hgb"):
    sc = []
    for f in fr:
        n = int(len(Xtr) * f); m = make(k, **bp[k]).fit(Xtr.iloc[:n], ytr[:n]); sc.append(average_precision_score(yva, m.predict_proba(Xva)[:, 1]))
    ax[1].plot([int(len(Xtr) * f) for f in fr], sc, "o-", label=names[k], color=COL[names[k]])
ax[1].set(xlabel="розмір навчальної вибірки", ylabel="PR-AUC (валідація)", title="Якість залежно від обсягу даних"); ax[1].legend()
save("01_learning_curves.png")
# 2 матриця помилок
cm = confusion_matrix(yte, (pt >= thr[final]).astype(int))
fig, ax = plt.subplots(figsize=(4.2, 3.8)); ax.imshow(cm, cmap="Blues"); ax.grid(False)
for i in range(2):
    for j in range(2): ax.text(j, i, cm[i, j], ha="center", va="center", fontsize=14, color="white" if cm[i, j] > cm.max() / 2 else "black")
ax.set(xticks=[0, 1], yticks=[0, 1], xticklabels=["без спору", "спір"], yticklabels=["без спору", "спір"], xlabel="прогноз", ylabel="факт",
       title="Матриця помилок (тест)"); save("02_confusion_matrix.png")
# 3 ROC і 4 PR
fig, ax = plt.subplots(figsize=(4.8, 4.2))
for k in names:
    f, t, _ = roc_curve(yte, P["test"][k]); ax.plot(f, t, label=f"{names[k]} ({Mt[k]['ROC_AUC']:.3f})", color=COL[names[k]])
ax.plot([0, 1], [0, 1], "k:"); ax.set(xlabel="частка хибних тривог", ylabel="повнота", title="ROC-крива (тест)"); ax.legend(fontsize=8); save("03_roc.png")
fig, ax = plt.subplots(figsize=(4.8, 4.2))
for k in names:
    p_, r_, _ = precision_recall_curve(yte, P["test"][k]); ax.plot(r_, p_, label=f"{names[k]} ({Mt[k]['PR_AUC']:.3f})", color=COL[names[k]])
ax.axhline(yte.mean(), color="k", ls=":", label=f"частка спорів {yte.mean():.2f}"); ax.set(xlabel="повнота", ylabel="точність", title="PR-крива (тест)"); ax.legend(fontsize=8); save("04_pr.png")
# 5 важливість ознак (перестановками, тест)
raw = Xte.copy()
pi = permutation_importance(fm, raw, yte, scoring="average_precision", n_repeats=8, random_state=SEED)
o = np.argsort(pi.importances_mean)[::-1][:12][::-1]
fig, ax = plt.subplots(figsize=(6.4, 4.6)); ax.barh(np.array(FEATURES)[o], pi.importances_mean[o], xerr=pi.importances_std[o], color="#2b6cb0")
ax.set(xlabel="падіння PR-AUC при перемішуванні ознаки", title=f"Важливість ознак ({names[final]})"); save("05_feature_importance.png")
imp_top = [(FEATURES[i], float(pi.importances_mean[i])) for i in np.argsort(pi.importances_mean)[::-1][:6]]
# 6 порівняння моделей із розкидом
fig, ax = plt.subplots(1, 3, figsize=(11, 3.6))
for a, m in zip(ax, ("PR_AUC", "ROC_AUC", "F1")):
    mu = [cv[k][m].mean() for k in names]; sd = [cv[k][m].std() for k in names]
    a.bar([names[k].replace(" ", "\n") for k in names], mu, yerr=sd, capsize=4, color=[COL[names[k]] for k in names]); a.set_title(f"{m}: середнє ± σ по 5 фолдах")
save("06_model_comparison.png")
# 7 вплив гіперпараметрів
fig, ax = plt.subplots(1, 2, figsize=(10, 3.6))
t1 = tune[tune.model == "lr"]; ax[0].semilogx(t1.C, t1.val_PR_AUC, "o-", color=COL["Логістична регресія"]); ax[0].set(xlabel="C (сила регуляризації)", ylabel="PR-AUC (валідація)", title="Логістична регресія")
t2 = tune[tune.model == "hgb"]; g = t2.groupby("max_depth").val_PR_AUC
ax[1].errorbar(g.mean().index, g.mean().values, yerr=g.std().values, fmt="o-", capsize=4, color=COL["Градієнтний бустинг"]); ax[1].set(xlabel="max_depth", ylabel="PR-AUC (валідація)", title="Бустинг: глибина дерев")
save("07_hyperparameters.png")
# 8-10 аналіз помилок
yh = (pt >= thr[final]).astype(int); te2 = te.assign(p=pt, yh=yh)
fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
g = te2.groupby("category").apply(lambda d: pd.Series({"повнота": recall_score(d.dispute, d.yh, zero_division=0), "хибні тривоги": ((d.yh == 1) & (d.dispute == 0)).sum() / max((d.dispute == 0).sum(), 1)}), include_groups=False)
g.plot.bar(ax=ax[0], color=["#c05621", "#8d99ae"]); ax[0].set(title="Помилки за категоріями (тест)", xlabel="", ylabel="частка"); ax[0].tick_params(axis="x", rotation=40)
seen = te2.client_id.isin(tr.client_id); rows_ = []
for nm, mk in (("відомий замовник", seen), ("новий замовник", ~seen)):
    d = te2[mk]; rows_.append({"група": nm, "n": len(d), "PR_AUC": average_precision_score(d.dispute, d.p), "повнота": recall_score(d.dispute, d.yh)})
gr = pd.DataFrame(rows_); ax[1].bar(gr["група"], gr["PR_AUC"], color=["#2b6cb0", "#c05621"]); ax[1].set(ylabel="PR-AUC (тест)", title="Відомі й нові замовники")
for i, r in gr.iterrows(): ax[1].text(i, r.PR_AUC + .005, f"n={r.n}", ha="center")
save("08_error_by_group.png")
fig, ax = plt.subplots(1, 2, figsize=(10, 3.8))
bins = np.linspace(0, 1, 11); mid, obs, cnt = [], [], []
for i in range(10):
    m = (pt >= bins[i]) & (pt < bins[i + 1] + (1e-9 if i == 9 else 0))
    if m.sum() >= 15: mid.append(pt[m].mean()); obs.append(yte[m].mean()); cnt.append(m.sum())
ax[0].plot([0, .8], [0, .8], "k:"); ax[0].plot(mid, obs, "o-", color="#2b6cb0"); ax[0].set(xlabel="передбачена ймовірність", ylabel="фактична частка спорів", title="Калібрування (тест)")
ax[1].hist(pt[yte == 0], bins=30, alpha=.65, label="без спору", color="#8d99ae"); ax[1].hist(pt[yte == 1], bins=30, alpha=.65, label="спір", color="#c05621")
ax[1].axvline(thr[final], color="k", ls="--", label="поріг"); ax[1].set(xlabel="передбачений ризик", ylabel="кількість", title="Розподіл ризику за фактом"); ax[1].legend(); save("09_calibration_distribution.png")
fn, tp = te2[(te2.yh == 0) & (te2.dispute == 1)], te2[(te2.yh == 1) & (te2.dispute == 1)]
cols = ["budget_vs_category", "client_prev_dispute_rate", "spec_clarity", "workload_tightness"]
fig, ax = plt.subplots(1, 4, figsize=(12, 3.4))
for a, c in zip(ax, cols):
    a.boxplot([tp[c].dropna(), fn[c].dropna()], tick_labels=["виявлені", "пропущені"], showfliers=False); a.set_title(c, fontsize=9)
fig.suptitle("Спори, які модель виявила та пропустила: значення ознак", fontsize=10); save("10_false_negatives.png")
err = {"fn": int(len(fn)), "tp": int(len(tp)), "fp": int(((te2.yh == 1) & (te2.dispute == 0)).sum()),
       "seen_share": float(seen.mean()), "by_group": gr.to_dict("records"), "importance_top": imp_top,
       "by_category": g.round(3).to_dict("index"),
       "fn_medians": {c: [float(tp[c].median()), float(fn[c].median())] for c in cols}}
json.dump(err, open(os.path.join(M, "error_analysis.json"), "w"), ensure_ascii=False, indent=1, default=float)
print(json.dumps(err, ensure_ascii=False, indent=1, default=float)); print(json.dumps(cvs, ensure_ascii=False)); print(json.dumps(ci, ensure_ascii=False))
print(tune.sort_values("val_PR_AUC", ascending=False).head(5).to_string())
