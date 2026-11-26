"""Спільний код підготовки ознак: використовується і при навчанні, і в API (щоб не було розбіжності між ними)."""
import numpy as np
import pandas as pd

CAT_MEDIAN = {"web_dev": 900, "mobile_dev": 1500, "design": 400, "copywriting": 120,
              "translation": 150, "data_science": 1800, "video": 600, "marketing": 500}
CATEGORIES = list(CAT_MEDIAN)

# Вхідні (базові) поля. Саме їх передає оракул / приймає API.
BASE_FIELDS = ["category", "budget_usd", "n_milestones", "planned_days", "first_milestone_share",
               "spec_words", "spec_clarity", "client_account_age_days", "freelancer_account_age_days",
               "client_prev_deals", "client_prev_dispute_rate", "client_avg_rating",
               "freelancer_prev_deals", "freelancer_prev_dispute_rate", "freelancer_avg_rating",
               "freelancer_response_hours", "client_verified", "freelancer_verified", "repeat_pair"]
# Поля, яких НЕМАЄ на момент створення угоди (знання після виконання) — у модель не потрапляють.
LEAKY = ["milestones_rejected", "dispute", "skills_match"]

NUM = ["log_budget", "log_budget_vs_category", "log_workload_tightness", "n_milestones", "log_planned_days",
       "first_milestone_share", "log_spec_words", "spec_clarity", "log_client_age", "log_freelancer_age",
       "log_client_prev_deals", "client_prev_dispute_rate", "client_avg_rating", "log_freelancer_prev_deals",
       "freelancer_prev_dispute_rate", "freelancer_avg_rating", "log_response_hours",
       "client_verified", "freelancer_verified", "repeat_pair"]
CAT = ["category"]
FEATURES = NUM + CAT

# Допустимі діапазони (доменні правила очищення; не залежать від даних навчання)
LIMITS = {"budget_usd": (1, 50000), "n_milestones": (1, 10), "planned_days": (1, 365),
          "first_milestone_share": (0.01, 1.0), "spec_words": (1, 20000),
          "freelancer_response_hours": (0, 72), "client_account_age_days": (0, 5000),
          "freelancer_account_age_days": (0, 5000)}


def clarity_from_words(words):
    """Евристика ясності ТЗ за кількістю слів (як у симуляторі, без шуму)."""
    return float(np.clip(0.25 + 0.5 * (np.log(max(words, 1)) - 3) / 5, 0, 1))


def engineer(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    for c in BASE_FIELDS:
        if c not in d:
            d[c] = np.nan
    for c, (lo, hi) in LIMITS.items():          # викиди обрізаємо за доменними межами
        d[c] = d[c].astype(float).clip(lo, hi)
    med = d["category"].map(CAT_MEDIAN).astype(float)
    ratio = d["budget_usd"] / med
    tight = (d["budget_usd"] / d["planned_days"]) / (med / 21)
    o = pd.DataFrame(index=d.index)
    o["log_budget"] = np.log(d["budget_usd"])
    o["log_budget_vs_category"] = np.log(ratio)
    o["log_workload_tightness"] = np.log(tight.clip(0.02, 30))
    o["n_milestones"] = d["n_milestones"].astype(float)
    o["log_planned_days"] = np.log(d["planned_days"])
    o["first_milestone_share"] = d["first_milestone_share"].astype(float)
    o["log_spec_words"] = np.log(d["spec_words"])
    o["spec_clarity"] = d["spec_clarity"].astype(float)
    o["log_client_age"] = np.log1p(d["client_account_age_days"].astype(float))
    o["log_freelancer_age"] = np.log1p(d["freelancer_account_age_days"].astype(float))
    o["log_client_prev_deals"] = np.log1p(d["client_prev_deals"].astype(float))
    o["client_prev_dispute_rate"] = d["client_prev_dispute_rate"].astype(float)
    o["client_avg_rating"] = d["client_avg_rating"].astype(float)
    o["log_freelancer_prev_deals"] = np.log1p(d["freelancer_prev_deals"].astype(float))
    o["freelancer_prev_dispute_rate"] = d["freelancer_prev_dispute_rate"].astype(float)
    o["freelancer_avg_rating"] = d["freelancer_avg_rating"].astype(float)
    o["log_response_hours"] = np.log1p(d["freelancer_response_hours"].astype(float))
    for c in ["client_verified", "freelancer_verified", "repeat_pair"]:
        o[c] = d[c].astype(float)
    o["category"] = d["category"].astype(str)
    return o[FEATURES]
