"""Серверний API (FastAPI): модель, пояснення, сховище ТЗ, довідник учасників, журнал рішень.
Запуск:  uvicorn api.main:app --port 8000     Документація: /docs (OpenAPI: /openapi.json)"""
import hashlib, json, math, os, sqlite3, sys, threading, time
from typing import List, Optional
import joblib, numpy as np
from eth_hash.auto import keccak
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "ml"))
from features import BASE_FIELDS, CATEGORIES, clarity_from_words  # noqa: E402
from explain import predict_proba, top_factors  # noqa: E402

MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(ROOT, "ml", "model"))
DB_PATH = os.environ.get("API_DB", os.path.join(ROOT, "data", "api.db"))
ETH_USD = float(os.environ.get("ETH_USD", "3000"))
META = json.load(open(os.path.join(MODEL_DIR, "meta.json")))
_raw = open(os.path.join(MODEL_DIR, "model.joblib"), "rb").read()
if hashlib.sha256(_raw).hexdigest() != META["sha256"]:      # захист від підміни файлу моделі
    raise RuntimeError("Хеш файлу моделі не збігається з meta.json")
MODEL = joblib.load(os.path.join(MODEL_DIR, "model.joblib"))
MODEL_VERSION = "0x" + META["sha256"]

app = FastAPI(title="Freelance Escrow ML API", version="1.0",
              description="Оцінка ризику спору, пояснення рішень, сховище ТЗ і довідник учасників (ЛР 3, тема 38)")
_lock = threading.Lock()


def db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH); c.row_factory = sqlite3.Row
    c.executescript("""CREATE TABLE IF NOT EXISTS specs(hash TEXT PRIMARY KEY, text TEXT, category TEXT, created REAL);
        CREATE TABLE IF NOT EXISTS profiles(address TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE IF NOT EXISTS decisions(deal_id INTEGER PRIMARY KEY, risk REAL, risk_bps INTEGER, model_version TEXT,
            input_hash TEXT, features TEXT, factors TEXT, label TEXT, tx_hash TEXT, created REAL);""")
    return c


# ---------------- схеми ----------------
class Features(BaseModel):
    category: str
    budget_usd: float = Field(gt=0, le=50000)
    n_milestones: int = Field(ge=1, le=10)
    planned_days: int = Field(ge=1, le=365)
    first_milestone_share: float = Field(gt=0, le=1)
    spec_words: int = Field(ge=1, le=20000)
    spec_clarity: Optional[float] = Field(default=None, ge=0, le=1)
    client_account_age_days: Optional[float] = Field(default=None, ge=0)
    freelancer_account_age_days: Optional[float] = Field(default=None, ge=0)
    client_prev_deals: Optional[int] = Field(default=None, ge=0)
    client_prev_dispute_rate: Optional[float] = Field(default=None, ge=0, le=1)
    client_avg_rating: Optional[float] = Field(default=None, ge=1, le=5)
    freelancer_prev_deals: Optional[int] = Field(default=None, ge=0)
    freelancer_prev_dispute_rate: Optional[float] = Field(default=None, ge=0, le=1)
    freelancer_avg_rating: Optional[float] = Field(default=None, ge=1, le=5)
    freelancer_response_hours: Optional[float] = Field(default=None, ge=0)
    client_verified: Optional[int] = Field(default=None, ge=0, le=1)
    freelancer_verified: Optional[int] = Field(default=None, ge=0, le=1)
    repeat_pair: Optional[int] = Field(default=None, ge=0, le=1)


class SpecIn(BaseModel):
    text: str = Field(min_length=10, max_length=20000)
    category: str


class Profile(BaseModel):
    verified: Optional[int] = Field(default=None, ge=0, le=1)
    account_age_days: Optional[float] = Field(default=None, ge=0)
    prev_deals: Optional[int] = Field(default=None, ge=0)
    prev_dispute_rate: Optional[float] = Field(default=None, ge=0, le=1)
    avg_rating: Optional[float] = Field(default=None, ge=1, le=5)
    response_hours: Optional[float] = Field(default=None, ge=0)


class ScoreIn(BaseModel):
    deal_id: int = Field(ge=1)
    spec_hash: str
    client: str
    freelancer: str
    amounts_eth: List[float] = Field(min_length=1, max_length=10)
    due_days: List[int] = Field(min_length=1, max_length=10)
    freelancer_sbt_deals: int = Field(default=0, ge=0)
    freelancer_sbt_disputes: int = Field(default=0, ge=0)


class TxIn(BaseModel):
    tx_hash: str


def _canon(d): return json.dumps(d, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _clean(d):
    return {k: (None if (v is None or (isinstance(v, float) and math.isnan(v))) else v) for k, v in d.items()}


def _decide(features: dict):
    if features["category"] not in CATEGORIES:
        raise HTTPException(422, f"Невідома категорія: {features['category']}")
    f = {k: features.get(k, np.nan) if features.get(k) is not None else np.nan for k in BASE_FIELDS}
    p = predict_proba(MODEL, f)
    risk_bps = int(round(min(max(p, 0.0), 1.0) * 10000))
    high = p >= META["threshold"]
    return {"risk": round(p, 4), "risk_bps": risk_bps, "label": "високий" if high else "низький",
            "confidence": round(p if high else 1 - p, 4), "threshold": META["threshold"],
            "factors": top_factors(MODEL, f, 5), "model_version": MODEL_VERSION}


# ---------------- ендпоінти ----------------
@app.get("/health", tags=["service"])
def health():
    return {"status": "ok", "model": META["name"], "model_version": MODEL_VERSION}


@app.get("/model", tags=["model"])
def model_info():
    card = open(os.path.join(MODEL_DIR, "model_card.md"), encoding="utf8").read()
    return {**META, "model_version": MODEL_VERSION, "card": card}


@app.post("/predict", tags=["model"])
def predict(x: Features):
    """Ризик спору за готовим вектором ознак (без запису в журнал)."""
    feats = _clean(x.model_dump())
    return {**_decide(feats), "features": feats, "input_hash": "0x" + hashlib.sha256(_canon(feats).encode()).hexdigest()}


@app.post("/specs", tags=["storage"])
def put_spec(s: SpecIn):
    """Зберігає ТЗ поза ланцюгом; повертає keccak256-хеш для поля specHash контракту."""
    if s.category not in CATEGORIES:
        raise HTTPException(422, "Невідома категорія")
    h = "0x" + keccak(s.text.encode("utf8")).hex()
    with _lock, db() as c:
        c.execute("INSERT OR REPLACE INTO specs VALUES(?,?,?,?)", (h, s.text, s.category, time.time()))
    return {"spec_hash": h, "words": len(s.text.split())}


@app.get("/specs/{spec_hash}", tags=["storage"])
def get_spec(spec_hash: str):
    r = db().execute("SELECT * FROM specs WHERE hash=?", (spec_hash.lower(),)).fetchone()
    if not r:
        raise HTTPException(404, "ТЗ не знайдено")
    return {"spec_hash": r["hash"], "text": r["text"], "category": r["category"]}


@app.get("/specs/{spec_hash}/verify", tags=["storage"])
def verify_spec(spec_hash: str, onchain_hash: Optional[str] = None):
    """Перераховує хеш збереженого тексту й порівнює його з ключем (і, якщо задано, із хешем з ланцюга)."""
    r = db().execute("SELECT * FROM specs WHERE hash=?", (spec_hash.lower(),)).fetchone()
    if not r:
        raise HTTPException(404, "ТЗ не знайдено")
    real = "0x" + keccak(r["text"].encode("utf8")).hex()
    ref = (onchain_hash or spec_hash).lower()
    return {"ok": real == ref, "computed": real, "expected": ref}


@app.put("/profiles/{address}", tags=["directory"])
def put_profile(address: str, p: Profile):
    with _lock, db() as c:
        c.execute("INSERT OR REPLACE INTO profiles VALUES(?,?)", (address.lower(), p.model_dump_json()))
    return {"address": address.lower(), **p.model_dump()}


@app.get("/profiles/{address}", tags=["directory"])
def get_profile(address: str):
    r = db().execute("SELECT data FROM profiles WHERE address=?", (address.lower(),)).fetchone()
    return json.loads(r["data"]) if r else {}


@app.post("/score", tags=["oracle"])
def score(x: ScoreIn):
    """Збирає ознаки угоди (ланцюг + ТЗ + довідник), викликає модель, зберігає рішення в журнал. Викликає оракул."""
    if len(x.amounts_eth) != len(x.due_days) or any(a <= 0 for a in x.amounts_eth) or any(d < 1 for d in x.due_days):
        raise HTTPException(422, "Некоректні етапи угоди")
    sp = db().execute("SELECT * FROM specs WHERE hash=?", (x.spec_hash.lower(),)).fetchone()
    if not sp:
        raise HTTPException(404, "ТЗ угоди не знайдено у сховищі")
    if "0x" + keccak(sp["text"].encode("utf8")).hex() != x.spec_hash.lower():
        raise HTTPException(409, "Хеш ТЗ у сховищі не збігається з ланцюговим: ТЗ підмінено")
    total = sum(x.amounts_eth); words = len(sp["text"].split())
    cp, fp = get_profile(x.client), get_profile(x.freelancer)
    f_deals = x.freelancer_sbt_deals
    feats = {"category": sp["category"], "budget_usd": round(total * ETH_USD, 2), "n_milestones": len(x.amounts_eth),
             "planned_days": max(x.due_days), "first_milestone_share": round(x.amounts_eth[0] / total, 4),
             "spec_words": words, "spec_clarity": round(clarity_from_words(words), 4),
             "client_account_age_days": cp.get("account_age_days"), "freelancer_account_age_days": fp.get("account_age_days"),
             "client_prev_deals": cp.get("prev_deals"), "client_prev_dispute_rate": cp.get("prev_dispute_rate"),
             "client_avg_rating": cp.get("avg_rating"),
             "freelancer_prev_deals": f_deals,
             "freelancer_prev_dispute_rate": round(x.freelancer_sbt_disputes / f_deals, 4) if f_deals else None,
             "freelancer_avg_rating": fp.get("avg_rating"), "freelancer_response_hours": fp.get("response_hours"),
             "client_verified": cp.get("verified"), "freelancer_verified": fp.get("verified"), "repeat_pair": None}
    Features(**feats)                                   # та сама перевірка діапазонів
    d = _decide(feats); canon = _canon(feats)
    ih = "0x" + hashlib.sha256(canon.encode()).hexdigest()
    with _lock, db() as c:
        c.execute("INSERT OR REPLACE INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                  (x.deal_id, d["risk"], d["risk_bps"], MODEL_VERSION, ih, canon, json.dumps(d["factors"], ensure_ascii=False),
                   d["label"], None, time.time()))
    return {**d, "deal_id": x.deal_id, "input_hash": ih, "features": feats}


@app.get("/decisions/{deal_id}", tags=["oracle"])
def get_decision(deal_id: int):
    r = db().execute("SELECT * FROM decisions WHERE deal_id=?", (deal_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Рішення для угоди немає")
    return {"deal_id": deal_id, "risk": r["risk"], "risk_bps": r["risk_bps"], "model_version": r["model_version"],
            "label": r["label"], "input_hash": r["input_hash"], "features_canonical": r["features"],
            "factors": json.loads(r["factors"]), "tx_hash": r["tx_hash"],
            "confidence": round(r["risk"] if r["label"] == "високий" else 1 - r["risk"], 4)}


@app.put("/decisions/{deal_id}/tx", tags=["oracle"])
def set_tx(deal_id: int, t: TxIn):
    with _lock, db() as c:
        n = c.execute("UPDATE decisions SET tx_hash=? WHERE deal_id=?", (t.tx_hash, deal_id)).rowcount
    if not n:
        raise HTTPException(404, "Рішення для угоди немає")
    return {"ok": True}


@app.get("/config.json", include_in_schema=False)
def config():
    p = os.environ.get("DEPLOYMENT", os.path.join(ROOT, "deployments", "localhost.json"))
    d = json.load(open(p)) if os.path.exists(p) else {}
    return {**d, "rpc": os.environ.get("RPC_URL_PUBLIC", "http://127.0.0.1:8545"), "ethUsd": ETH_USD}


FRONT = os.path.join(ROOT, "frontend")
if os.path.isdir(FRONT):
    app.mount("/static", StaticFiles(directory=FRONT), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(os.path.join(FRONT, "index.html"))
