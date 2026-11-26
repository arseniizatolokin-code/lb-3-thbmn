import os, sys, tempfile
os.environ["API_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
import pytest
from fastapi.testclient import TestClient
from eth_hash.auto import keccak
from api.main import app, META

c = TestClient(app)
OK = dict(category="web_dev", budget_usd=900, n_milestones=2, planned_days=30, first_milestone_share=0.4, spec_words=150)
CL, FR = "0x" + "11" * 20, "0x" + "22" * 20


def spec(text="Зробити сайт-візитку з трьома сторінками та формою зворотного зв'язку", cat="web_dev"):
    r = c.post("/specs", json={"text": text, "category": cat}); assert r.status_code == 200; return r.json()["spec_hash"]


def test_health():
    r = c.get("/health").json(); assert r["status"] == "ok" and r["model_version"] == "0x" + META["sha256"]


def test_model_info_has_card_and_hash():
    r = c.get("/model").json(); assert "Картка моделі" in r["card"] and len(r["sha256"]) == 64


def test_predict_returns_probability_and_factors():
    r = c.post("/predict", json=OK).json()
    assert 0 <= r["risk"] <= 1 and 0 <= r["risk_bps"] <= 10000 and len(r["factors"]) >= 1 and r["input_hash"].startswith("0x")


def test_predict_is_deterministic():
    assert c.post("/predict", json=OK).json() == c.post("/predict", json=OK).json()


def test_risky_client_history_raises_risk():
    lo = c.post("/predict", json={**OK, "client_prev_deals": 10, "client_prev_dispute_rate": 0.0}).json()["risk"]
    hi = c.post("/predict", json={**OK, "client_prev_deals": 10, "client_prev_dispute_rate": 0.8}).json()["risk"]
    assert hi > lo


@pytest.mark.parametrize("bad", [{"budget_usd": -5}, {"budget_usd": 10**7}, {"n_milestones": 0}, {"n_milestones": 99},
                                 {"first_milestone_share": 1.5}, {"client_avg_rating": 9}, {"planned_days": 0}])
def test_predict_rejects_anomalous_input(bad):
    assert c.post("/predict", json={**OK, **bad}).status_code == 422


def test_predict_rejects_unknown_category():
    assert c.post("/predict", json={**OK, "category": "cooking"}).status_code == 422


def test_spec_hash_matches_keccak_and_roundtrip():
    t = "Розробити мобільний застосунок для обліку витрат з синхронізацією"
    h = spec(t); assert h == "0x" + keccak(t.encode()).hex()
    assert c.get(f"/specs/{h}").json()["text"] == t


def test_spec_verify_detects_tampering():
    h = spec("Переклад технічної документації з англійської на українську мову")
    assert c.get(f"/specs/{h}/verify").json()["ok"] is True
    import sqlite3
    con = sqlite3.connect(os.environ["API_DB"]); con.execute("UPDATE specs SET text='ПІДМІНЕНО' WHERE hash=?", (h,)); con.commit()
    assert c.get(f"/specs/{h}/verify").json()["ok"] is False


def test_spec_not_found_and_short_text_rejected():
    assert c.get("/specs/0x00").status_code == 404
    assert c.post("/specs", json={"text": "коротко", "category": "design"}).status_code == 422


def test_score_stores_decision_and_hash_is_reproducible():
    import hashlib
    h = spec("Дизайн логотипу та фірмового стилю для кав'ярні, три варіанти", "design")
    r = c.post("/score", json={"deal_id": 7, "spec_hash": h, "client": CL, "freelancer": FR, "amounts_eth": [0.2, 0.4], "due_days": [7, 14]})
    assert r.status_code == 200, r.text
    d = c.get("/decisions/7").json()
    assert d["input_hash"] == "0x" + hashlib.sha256(d["features_canonical"].encode()).hexdigest() == r.json()["input_hash"]
    assert r.json()["features"]["budget_usd"] == 1800.0


def test_score_refuses_tampered_spec():
    import sqlite3
    h = spec("Копірайтинг: десять статей про здоровий сон для блогу компанії", "copywriting")
    con = sqlite3.connect(os.environ["API_DB"]); con.execute("UPDATE specs SET text='інший текст ТЗ' WHERE hash=?", (h,)); con.commit()
    r = c.post("/score", json={"deal_id": 8, "spec_hash": h, "client": CL, "freelancer": FR, "amounts_eth": [0.1], "due_days": [5]})
    assert r.status_code == 409


def test_score_unknown_spec_and_bad_milestones():
    base = {"deal_id": 9, "client": CL, "freelancer": FR}
    assert c.post("/score", json={**base, "spec_hash": "0xdead", "amounts_eth": [1], "due_days": [3]}).status_code == 404
    h = spec("Налаштування рекламної кампанії в соцмережах для інтернет-магазину", "marketing")
    assert c.post("/score", json={**base, "spec_hash": h, "amounts_eth": [1, 2], "due_days": [3]}).status_code == 422


def test_profile_used_in_score():
    h = spec("Аналіз даних продажів та побудова прогнозної моделі попиту", "data_science")
    c.put(f"/profiles/{CL}", json={"verified": 1, "prev_deals": 12, "prev_dispute_rate": 0.7, "avg_rating": 3.1})
    assert c.get(f"/profiles/{CL}").json()["prev_deals"] == 12
    r = c.post("/score", json={"deal_id": 10, "spec_hash": h, "client": CL, "freelancer": FR, "amounts_eth": [0.5], "due_days": [20]}).json()
    assert r["features"]["client_prev_dispute_rate"] == 0.7


def test_openapi_documents_endpoints():
    paths = c.get("/openapi.json").json()["paths"]
    assert {"/predict", "/score", "/specs", "/decisions/{deal_id}"} <= set(paths)
