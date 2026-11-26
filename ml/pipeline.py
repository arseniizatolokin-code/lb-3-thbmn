"""Відтворюваний конвеєр підготовки даних (одна команда):  python ml/pipeline.py

1) генерує набір угод симулятором ЛР 1 (seed фіксовано);
2) очищує (дублікати, некоректні рядки);
3) ділить ЗА ЧАСОМ на train/val/test із «карантином» між частинами;
4) зберігає ml/data/{train,val,test}.csv та ml/data/split_report.json
"""
import json, os, sys
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from simulator import simulate
from features import LIMITS

SEED, N = 42, 12000
EMBARGO_DAYS = 45          # «карантин»: угоди ближче ніж 45 днів до межі відкидаються
OUT = os.path.join(os.path.dirname(__file__), "data")


def clean(df):
    n0 = len(df)
    df = df.drop_duplicates(subset="deal_id").copy()
    df = df[(df.budget_usd > 0) & (df.planned_days > 0) & df.n_milestones.between(1, 10)]
    return df, n0 - len(df)


def main():
    os.makedirs(OUT, exist_ok=True)
    raw = simulate(N, SEED)
    raw["created_at"] = pd.to_datetime(raw["created_at"])
    df, dropped = clean(raw)
    df = df.sort_values("created_at").reset_index(drop=True)
    t0, t1 = df.created_at.min(), df.created_at.max()
    q65, q82 = df.created_at.quantile(0.65), df.created_at.quantile(0.82)
    gap = pd.Timedelta(days=EMBARGO_DAYS)
    train = df[df.created_at < q65 - gap]
    val = df[(df.created_at >= q65) & (df.created_at < q82 - gap)]
    test = df[df.created_at >= q82]
    for name, part in (("train", train), ("val", val), ("test", test)):
        part.to_csv(os.path.join(OUT, f"{name}.csv"), index=False)
    rep = {"seed": SEED, "n_generated": N, "dropped_by_cleaning": int(dropped),
           "period": [str(t0.date()), str(t1.date())], "embargo_days": EMBARGO_DAYS,
           "boundaries": {"train_end": str((q65 - gap).date()), "val_start": str(q65.date()),
                          "val_end": str((q82 - gap).date()), "test_start": str(q82.date())},
           "sizes": {k: int(len(v)) for k, v in (("train", train), ("val", val), ("test", test))},
           "dispute_rate": {k: round(float(v.dispute.mean()), 4) for k, v in (("train", train), ("val", val), ("test", test))},
           "overlap_ids_with_train": {
               "val_clients_seen": round(float(val.client_id.isin(train.client_id).mean()), 3),
               "test_clients_seen": round(float(test.client_id.isin(train.client_id).mean()), 3),
               "test_freelancers_seen": round(float(test.freelancer_id.isin(train.freelancer_id).mean()), 3)},
           "max_train_time": str(train.created_at.max()), "min_val_time": str(val.created_at.min()),
           "max_val_time": str(val.created_at.max()), "min_test_time": str(test.created_at.min())}
    assert train.created_at.max() < val.created_at.min() <= val.created_at.max() < test.created_at.min()
    json.dump(rep, open(os.path.join(OUT, "split_report.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(rep, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
