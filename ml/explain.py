"""Пояснення окремого рішення: «затуляння» ознаки (значення -> пропуск, який модель замінює медіаною)."""
import numpy as np
import pandas as pd
from features import BASE_FIELDS, engineer

LABELS = {"category": "категорія робіт", "budget_usd": "бюджет", "n_milestones": "кількість етапів",
          "planned_days": "строк", "first_milestone_share": "частка першого етапу", "spec_words": "обсяг ТЗ",
          "spec_clarity": "ясність ТЗ", "client_account_age_days": "вік акаунта замовника",
          "freelancer_account_age_days": "вік акаунта виконавця", "client_prev_deals": "угод замовника раніше",
          "client_prev_dispute_rate": "частка спорів замовника", "client_avg_rating": "рейтинг замовника",
          "freelancer_prev_deals": "угод виконавця раніше", "freelancer_prev_dispute_rate": "частка спорів виконавця",
          "freelancer_avg_rating": "рейтинг виконавця", "freelancer_response_hours": "швидкість відповіді виконавця",
          "client_verified": "верифікація замовника", "freelancer_verified": "верифікація виконавця",
          "repeat_pair": "повторна пара"}


def predict_proba(model, base: dict) -> float:
    return float(model.predict_proba(engineer(pd.DataFrame([base])))[:, 1][0])


def top_factors(model, base: dict, k: int = 5):
    row = {f: base.get(f, np.nan) for f in BASE_FIELDS}
    frame = pd.DataFrame([row] * (len(BASE_FIELDS) + 1))
    for i, f in enumerate(BASE_FIELDS):
        frame.loc[i + 1, f] = np.nan
    p = model.predict_proba(engineer(frame))[:, 1]
    out = []
    for i, f in enumerate(BASE_FIELDS):
        if base.get(f) is None or (isinstance(base.get(f), float) and np.isnan(base.get(f))):
            continue
        out.append({"feature": f, "label": LABELS[f], "value": base.get(f),
                    "effect": round(float(p[0] - p[i + 1]), 4)})
    out.sort(key=lambda x: -abs(x["effect"]))
    return out[:k]
