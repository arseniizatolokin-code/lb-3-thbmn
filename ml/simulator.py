"""Симулятор угод фріланс-біржі з ескроу (ЛР 1, тема 38).

Кожна угода створюється у хронологічному порядку. Ознаки історії сторін (кількість угод,
частка спорів, середній рейтинг) обчислюються лише з УГОД, ЩО ВЖЕ ЗАВЕРШИЛИСЬ до моменту
створення поточної, тому ознаки не «бачать майбутнього».

Запуск:  python ml/simulator.py --n 12000 --seed 42 --out data/processed/deals.csv
"""
import argparse, heapq
import numpy as np
import pandas as pd

CATEGORIES = {  # (частка угод, медіана бюджету USD, зсув logit)
    "web_dev":      (0.22, 900, 0.05),
    "mobile_dev":   (0.10, 1500, 0.20),
    "design":       (0.18, 400, -0.10),
    "copywriting":  (0.14, 120, -0.35),
    "translation":  (0.10, 150, -0.45),
    "data_science": (0.08, 1800, 0.35),
    "video":        (0.08, 600, 0.25),
    "marketing":    (0.10, 500, 0.00),
}
CAT_NAMES = list(CATEGORIES)
CAT_MEDIAN = {c: v[1] for c, v in CATEGORIES.items()}


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def simulate(n=12000, seed=42, n_clients=1800, n_freelancers=1500, months=24, b0=-3.6):
    rng = np.random.default_rng(seed)
    start = pd.Timestamp("2024-01-01")
    span = months * 30 * 24 * 3600
    # --- користувачі: дата реєстрації, приховані властивості (в наборі НЕ зберігаються)
    c_join = np.sort(rng.uniform(0, span * 0.9, n_clients))
    f_join = np.sort(rng.uniform(0, span * 0.9, n_freelancers))
    c_tough = rng.normal(0, 0.55, n_clients)          # схильність замовника до конфліктів
    f_qual = rng.normal(0, 1, n_freelancers)          # якість виконавця
    c_ver = rng.random(n_clients) < 0.55
    f_ver = rng.random(n_freelancers) < 0.60
    f_resp_base = rng.lognormal(np.log(5), 0.7, n_freelancers)  # типова швидкість відповіді (год)
    c_deals = np.zeros(n_clients); c_disp = np.zeros(n_clients)
    c_rsum = np.zeros(n_clients);  c_rcnt = np.zeros(n_clients)
    f_deals = np.zeros(n_freelancers); f_disp = np.zeros(n_freelancers)
    f_rsum = np.zeros(n_freelancers);  f_rcnt = np.zeros(n_freelancers)
    pairs = set()
    queue = []   # (час завершення, лічильник, ci, fi, dispute, rating_c, rating_f)

    times = np.sort(rng.uniform(0, span, n))
    rows = []
    for k, t in enumerate(times):
        # 1) застосувати результати угод, завершених до цього моменту
        while queue and queue[0][0] <= t:
            _, _, ci, fi, disp, rc, rf = heapq.heappop(queue)
            c_deals[ci] += 1; f_deals[fi] += 1
            c_disp[ci] += disp; f_disp[fi] += disp
            c_rsum[ci] += rc; c_rcnt[ci] += 1
            f_rsum[fi] += rf; f_rcnt[fi] += 1
        # 2) вибір сторін серед зареєстрованих (preferential attachment)
        nc = np.searchsorted(c_join, t); nf = np.searchsorted(f_join, t)
        if nc < 5 or nf < 5:
            nc, nf = max(nc, 5), max(nf, 5)
        wc = (1 + c_deals[:nc]) ** 0.7; ci = rng.choice(nc, p=wc / wc.sum())
        wf = (1 + f_deals[:nf]) ** 0.8; fi = rng.choice(nf, p=wf / wf.sum())
        repeat = (ci, fi) in pairs
        # 3) параметри угоди (з дрейфом структури категорій у часі)
        drift = t / span
        probs = np.array([v[0] for v in CATEGORIES.values()])
        probs[CAT_NAMES.index("data_science")] *= 1 + 0.9 * drift
        probs[CAT_NAMES.index("copywriting")] *= 1 - 0.3 * drift
        probs /= probs.sum()
        cat = CAT_NAMES[rng.choice(len(CAT_NAMES), p=probs)]
        budget = float(rng.lognormal(np.log(CAT_MEDIAN[cat]), 0.85))
        n_ms = int(np.clip(rng.poisson(1.6 + np.log10(budget) - 2) + 1, 1, 6))
        planned_days = int(np.clip(rng.lognormal(np.log(14 + budget ** 0.35 * 1.5), 0.5), 3, 150))
        first_share = float(np.clip(rng.beta(2.2, 3.2) if n_ms > 1 else 1.0, 0.05, 1.0))
        spec_words = int(np.clip(rng.lognormal(np.log(180), 0.8), 15, 4000))
        clarity = float(np.clip(0.25 + 0.5 * (np.log(spec_words) - 3) / 5 + rng.normal(0, 0.18), 0, 1))
        cat_budget_ratio = budget / CAT_MEDIAN[cat]
        tight = float(np.clip((budget / planned_days) / (CAT_MEDIAN[cat] / 21) , 0.02, 30))  # «обсяг/строк»
        # ознаки історії сторін (лише з завершених угод)
        c_prev = int(c_deals[ci]); f_prev = int(f_deals[fi])
        c_rate = c_disp[ci] / c_prev if c_prev else np.nan
        f_rate = f_disp[fi] / f_prev if f_prev else np.nan
        c_rating = c_rsum[ci] / c_rcnt[ci] if c_rcnt[ci] else np.nan
        f_rating = f_rsum[fi] / f_rcnt[fi] if f_rcnt[fi] else np.nan
        c_age = (t - c_join[ci]) / 86400; f_age = (t - f_join[fi]) / 86400
        resp = float(f_resp_base[fi] * rng.lognormal(0, 0.35))
        if rng.random() < 0.008:
            resp *= rng.uniform(15, 60)            # викиди: «зник» на кілька днів
        skills = float(np.clip(rng.beta(5, 2) - 0.12 * (cat in ("data_science", "mobile_dev")), 0, 1))
        # 4) справжня ймовірність спору (приховані чинники + ознаки + взаємодії)
        z = b0 + CATEGORIES[cat][2] + 0.25 * drift
        z += 0.42 * np.log(cat_budget_ratio) + 0.14 * (n_ms - 3)
        z += -1.5 * (clarity - 0.5) + 0.55 * max(tight - 1.0, 0) ** 0.6 * (1.3 - clarity)   # взаємодія
        z += 2.2 * (first_share - 0.35) ** 2 * (1 if first_share > 0.35 else 1.6) * 2.0      # U-подібний ефект
        z += 3.0 * (0 if np.isnan(c_rate) else c_rate) + 1.6 * (0 if np.isnan(f_rate) else f_rate)
        z += 0.45 * (c_prev == 0) + 0.35 * (f_prev == 0)
        z += -0.45 * repeat - 0.30 * c_ver[ci] - 0.30 * f_ver[fi]
        z += -0.55 * f_qual[fi] * 0.6 + c_tough[ci] * 1.2
        z += 0.20 * np.log1p(resp) - 0.9 * (skills - 0.7)
        z += rng.normal(0, 0.55)                                                 # неспостережуваний шум
        p_true = float(sigmoid(z))
        dispute = int(rng.random() < p_true)
        # 5) наслідки (відомі лише ПІСЛЯ виконання угоди)
        rejected = int(rng.poisson(0.15 + 1.9 * dispute) if n_ms > 0 else 0)
        rejected = min(rejected, n_ms)
        dur_factor = 1 + max(rng.normal(0.12, 0.25), -0.4) + 0.5 * dispute
        done_t = t + planned_days * dur_factor * 86400
        rc = float(np.clip(rng.normal(4.4 - 1.6 * dispute + 0.3 * f_qual[fi] * 0.5, 0.6), 1, 5))
        rf = float(np.clip(rng.normal(4.5 - 1.2 * dispute - 0.4 * c_tough[ci], 0.6), 1, 5))
        heapq.heappush(queue, (done_t, k, ci, fi, dispute, round(rc * 2) / 2, round(rf * 2) / 2))
        pairs.add((ci, fi))
        rows.append(dict(
            deal_id=k + 1, created_at=start + pd.to_timedelta(t, unit="s"),
            client_id=f"C{ci:04d}", freelancer_id=f"F{fi:04d}", category=cat,
            budget_usd=round(budget, 2), n_milestones=n_ms, planned_days=planned_days,
            first_milestone_share=round(first_share, 3), spec_words=spec_words,
            spec_clarity=round(clarity, 3), budget_vs_category=round(cat_budget_ratio, 3),
            workload_tightness=round(tight, 3), skills_match=round(skills, 3),
            repeat_pair=int(repeat), client_verified=int(c_ver[ci]), freelancer_verified=int(f_ver[fi]),
            client_account_age_days=round(c_age, 1), freelancer_account_age_days=round(f_age, 1),
            client_prev_deals=c_prev, client_prev_dispute_rate=None if np.isnan(c_rate) else round(c_rate, 3),
            client_avg_rating=None if np.isnan(c_rating) else round(c_rating, 2),
            freelancer_prev_deals=f_prev, freelancer_prev_dispute_rate=None if np.isnan(f_rate) else round(f_rate, 3),
            freelancer_avg_rating=None if np.isnan(f_rating) else round(f_rating, 2),
            freelancer_response_hours=round(resp, 2), created_hour=int((t // 3600) % 24),
            milestones_rejected=rejected, dispute=dispute))
    df = pd.DataFrame(rows)
    # пропуски, не пов'язані з історією: збій розбору ТЗ та відсутні дані про відповіді
    m1 = rng.random(len(df)) < 0.04; df.loc[m1, "spec_clarity"] = np.nan
    m2 = rng.random(len(df)) < 0.06; df.loc[m2, "freelancer_response_hours"] = np.nan
    return df


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=12000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="data/processed/deals.csv")
    a = ap.parse_args()
    d = simulate(a.n, a.seed)
    d.to_csv(a.out, index=False)
    print(f"{len(d)} угод, частка спорів {d.dispute.mean():.3f}, збережено в {a.out}")
