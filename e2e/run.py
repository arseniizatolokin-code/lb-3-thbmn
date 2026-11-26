"""Наскрізний сценарій у браузері (Playwright) проти локального вузла Hardhat, API та оракула.
Запуск:  python e2e/run.py     Результат: reports/screens/*.png, reports/e2e_log.txt"""
import json, os, re, signal, sqlite3, subprocess, sys, time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.chdir(ROOT)
SHOTS = os.path.join(ROOT, "reports", "screens"); os.makedirs(SHOTS, exist_ok=True)
ORACLE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"   # акаунт #1 Hardhat (лише для локального тесту)
env = {**os.environ, "USE_SOLCJS": "1"}
procs, LOG = [], []
def log(*a):
    s = " ".join(str(x) for x in a); LOG.append(s); print(s, flush=True)
def run(cmd, **kw): return subprocess.run(cmd, shell=True, env={**env, **kw.pop("env", {})}, capture_output=True, text=True, **kw)
def spawn(cmd, out, extra=None):
    p = subprocess.Popen(cmd, shell=True, env={**env, **(extra or {})}, stdout=open(out, "w"), stderr=subprocess.STDOUT, preexec_fn=os.setsid); procs.append(p); return p
def http(url, data=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
def wait(url, tries=60):
    for _ in range(tries):
        try: urllib.request.urlopen(url); return
        except Exception: time.sleep(1)
    raise RuntimeError("не стартував " + url)

try:
    for f in ("oracle/state.db", "oracle/oracle.log", "data/api.db"):
        if os.path.exists(f): os.remove(f)
    spawn("npx hardhat node", "reports/node.log"); wait("http://127.0.0.1:8545") if False else time.sleep(8)
    log(run("npx hardhat run scripts/deploy.js --network localhost").stdout.strip())
    log(run("npx hardhat run scripts/register-model.js --network localhost").stdout.strip())
    spawn("python3 -m uvicorn api.main:app --port 8000", "reports/api.log"); wait("http://127.0.0.1:8000/health")
    spawn("node oracle/oracle.js", "reports/oracle.out", {"ORACLE_PRIVATE_KEY": ORACLE_KEY}); time.sleep(2)
    dep = json.load(open("deployments/localhost.json"))
    ACC = json.loads(run("node -e \"fetch('http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_accounts',params:[]})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.result)))\"").stdout)
    CLIENT, FREE, CLIENT2, OUT = ACC[2], ACC[3], ACC[5], ACC[6]
    # довідник учасників (позаланцюгові дані)
    http(f"http://127.0.0.1:8000/profiles/{CLIENT}", {"verified": 1, "account_age_days": 300, "prev_deals": 8, "prev_dispute_rate": 0.125, "avg_rating": 4.5}, "PUT")
    http(f"http://127.0.0.1:8000/profiles/{FREE}", {"verified": 1, "account_age_days": 420, "avg_rating": 4.6, "response_hours": 3.0}, "PUT")
    http(f"http://127.0.0.1:8000/profiles/{CLIENT2}", {"verified": 0, "account_age_days": 20, "prev_deals": 5, "prev_dispute_rate": 0.6, "avg_rating": 3.0}, "PUT")

    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={"width": 1280, "height": 1000})
        pg.on("dialog", lambda d: d.accept())
        shot = lambda n: (pg.wait_for_timeout(500), pg.screenshot(path=f"{SHOTS}/{n}.png"))
        def connect(idx):
            pg.select_option("#local-accounts", index=idx + 1); pg.wait_for_function("document.querySelector('#roles').textContent.includes('ролі:') && !document.querySelector('#roles').textContent.endsWith('—')"); pg.wait_for_timeout(700)
        pg.goto("http://127.0.0.1:8000/"); pg.wait_for_selector("#local-accounts option:nth-child(3)", state="attached"); shot("01_start")

        # --- Основний сценарій ---
        connect(2); shot("02_wallet_connected_client")
        pg.fill("#f-freelancer", FREE); pg.select_option("#f-category", "web_dev")
        pg.fill("#f-spec", "Розробити сайт-візитку для студії йоги: головна, розклад, ціни та форма запису на заняття. Адаптивна верстка, інтеграція з Google Maps, публікація на хостингу.")
        pg.click("#btn-create"); pg.wait_for_selector("#txlist li.st-ok"); shot("03_deal_created_tx")
        pg.wait_for_selector("text=Ризик спору: >> text=%", timeout=60000) if False else pg.wait_for_function("document.querySelector('[data-deal=\"1\"]')?.textContent.includes('Ризик спору: ') && !document.querySelector('[data-deal=\"1\"]').textContent.includes('очікуємо оцінку')", timeout=60000)
        shot("04_risk_received")
        pg.click("[data-deal='1'] >> text=Рішення моделі"); pg.wait_for_selector("#decision-card"); shot("05_model_decision")
        pg.click("#tabs [data-tab=deals]"); pg.wait_for_selector("[data-deal='1'] >> text=Профінансувати")
        pg.click("[data-deal='1'] >> text=Профінансувати"); pg.wait_for_selector("#txlist li.st-ok >> text=Профінансувати"); shot("06_funded")
        connect(3); pg.wait_for_selector("[data-deal='1'] >> text=Прийняти (депозит"); pg.click("[data-deal='1'] >> text=Прийняти (депозит")
        pg.wait_for_selector("#txlist li.st-ok >> text=Прийняти"); pg.wait_for_selector("[data-deal='1'] >> text=Здати етап 1"); shot("07_accepted_freelancer")
        for k in (1, 2):
            connect(3); pg.wait_for_selector(f"[data-deal='1'] >> text=Здати етап {k}"); pg.click(f"[data-deal='1'] >> text=Здати етап {k}"); pg.wait_for_selector("#txlist li.st-ok")
            if k == 1: shot("08_milestone_submitted")
            connect(2); pg.wait_for_selector(f"[data-deal='1'] >> text=Прийняти етап {k}"); pg.click(f"[data-deal='1'] >> text=Прийняти етап {k}"); pg.wait_for_selector("#txlist li.st-ok")
        pg.wait_for_selector("[data-deal='1'] >> text=Завершено"); shot("09_completed_withdraw")
        pg.click("#withdraw-box button"); pg.wait_for_selector("#txlist li.st-ok >> text=withdraw"); shot("10_withdrawn")
        # друга угода (ризикований замовник), щоб в аудиті було порівняння
        connect(5); pg.fill("#f-freelancer", FREE); pg.select_option("#f-category", "data_science")
        pg.fill("#f-spec", "Тест")
        pg.click("#btn-create"); pg.wait_for_selector("#error"); shot("11_negative_short_spec_ui_validation")
        pg.fill("#f-spec", "Побудувати модель прогнозу відтоку клієнтів за історичними даними, надати звіт і код у репозиторії.")
        pg.fill("#new-deal .ms-a >> nth=0", "2"); pg.fill("#new-deal .ms-a >> nth=1", "1"); pg.fill("#new-deal .ms-d >> nth=0", "5"); pg.fill("#new-deal .ms-d >> nth=1", "10")
        pg.click("#btn-create"); pg.wait_for_selector("#txlist li.st-ok >> text=proposeDeal")
        pg.wait_for_function("document.querySelector('[data-deal=\"2\"]')?.textContent.includes('Ризик спору: ') && !document.querySelector('[data-deal=\"2\"]').textContent.includes('очікуємо оцінку')", timeout=60000)
        # --- Аудит з ланцюга ---
        pg.click("#tabs [data-tab=audit]"); pg.wait_for_selector("#audit-table tbody tr >> nth=1"); pg.click("#btn-verify-all"); pg.wait_for_function("[...document.querySelectorAll('.integ')].every(e=>e.textContent.includes('✅'))"); shot("12_audit_integrity_ok")
        # --- Негативний 1: користувач без ролі ---
        connect(6); pg.click("#tabs [data-tab=admin]"); pg.click("#btn-pause-escrow"); pg.wait_for_selector("#txlist li.st-err"); pg.wait_for_selector("#error:not([hidden])"); shot("13_negative_no_role")
        log("Негативний 1 (без ролі):", pg.inner_text("#error"))
        # --- Негативний 2: підмінене ТЗ ---
        row = sqlite3.connect("data/api.db"); h = json.loads(urllib.request.urlopen("http://127.0.0.1:8000/decisions/1").read()) and row.execute("SELECT hash FROM specs ORDER BY created LIMIT 1").fetchone()[0]
        row.execute("UPDATE specs SET text='ПІДМІНЕНЕ ТЗ: зробити щось інше' WHERE hash=?", (h,)); row.commit()
        pg.click("#tabs [data-tab=audit]"); pg.wait_for_selector("#audit-table tbody tr"); pg.click("#btn-verify-all")
        pg.wait_for_function("[...document.querySelectorAll('.integ')].some(e=>e.textContent.includes('❌'))"); shot("14_negative_tampered_spec")
        log("Негативний 2 (підмінене ТЗ):", [e.inner_text() for e in pg.query_selector_all(".integ")])
        b.close()
    # --- Негативний 3: аномальні вхідні дані моделі ---
    code, body = http("http://127.0.0.1:8000/predict", {"category": "web_dev", "budget_usd": -5, "n_milestones": 0, "planned_days": 10, "first_milestone_share": 1.5, "spec_words": 100})
    log("Негативний 3 (аномальний вхід у /predict): HTTP", code, json.dumps(body, ensure_ascii=False)[:300])
    # --- Перезапуск оракула: одна й та сама подія не обробляється двічі ---
    time.sleep(3); cnt = lambda t: open("oracle/oracle.log").read().count(t)
    n_before = cnt("ризик записано")
    os.killpg(os.getpgid(procs[2].pid), signal.SIGTERM); time.sleep(1)
    run("node oracle/oracle.js --once", env={"ORACLE_PRIVATE_KEY": ORACLE_KEY})
    sqlite3.connect("oracle/state.db").execute("UPDATE cursor SET block=0").connection.commit()   # імітація втрати курсора
    run("node oracle/oracle.js --once", env={"ORACLE_PRIVATE_KEY": ORACLE_KEY})
    log(f"Перезапуск оракула (курсор скинуто на 0): записів ризику до {n_before}, після {cnt('ризик записано')}; пропущено як вже оброблені: {cnt('подію вже оброблено')}")
    # --- Збій мережі: повтори з наростаючою паузою ---
    r = run("node oracle/oracle.js --once", env={"ORACLE_PRIVATE_KEY": ORACLE_KEY, "RPC_URL": "http://127.0.0.1:9", "MAX_RETRIES": "3", "RETRY_DELAY_MS": "200", "ORACLE_STATE": "/tmp/retry_state.db", "ORACLE_LOG": "/tmp/retry.log"})
    log("Збій мережі (RPC недоступний):\n" + open("/tmp/retry.log").read())
    log("Журнал оракула:\n" + open("oracle/oracle.log").read())
finally:
    for p in procs:
        try: os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except Exception: pass
    open("reports/e2e_log.txt", "w", encoding="utf8").write("\n".join(LOG))
