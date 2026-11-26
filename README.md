# Freelance Escrow + ML (ЛР 3, тема 38)

Фріланс-біржа з ескроу: смарт-контракти (ЛР 2) + ML-оцінка ризику спору + сервіс-оракул + API + вебінтерфейс.

## Структура
`contracts/` Escrow, RiskOracle (реєстр версій моделі), ReputationSBT · `test/` 69 тестів · `ml/` дані, ознаки, навчання, модель і картка · `api/` FastAPI (+ `api/tests`, 21 тест) · `oracle/oracle.js` · `frontend/` вебінтерфейс · `e2e/run.py` наскрізний сценарій у браузері · `docs/` діаграми, OpenAPI · `reports/` графіки, скріншоти, журнали

## Запуск 
```bash
npm install && pip install -r requirements.txt && npx playwright install chromium   # один раз
python ml/pipeline.py          # дані (один запуск, seed=42, результат відтворюється)
python ml/train.py             # навчання, підбір, графіки, ml/model/model.joblib + model.sha256
python ml/make_card.py         # картка моделі
npx hardhat node                                                     # термінал 1
npx hardhat run scripts/deploy.js --network localhost                # термінал 2
npx hardhat run scripts/register-model.js --network localhost        # реєстрація версії моделі в контракті
python -m uvicorn api.main:app --port 8000                           # термінал 3 (API + інтерфейс на http://127.0.0.1:8000)
ORACLE_PRIVATE_KEY=<ключ акаунта #1 Hardhat> node oracle/oracle.js   # термінал 4
```
Інтерфейс: http://127.0.0.1:8000 → «MetaMask» або «Локальний вузол» (демо-акаунти Hardhat). Документація API: http://127.0.0.1:8000/docs
Якщо solc не завантажується (закрита мережа), перед командами hardhat додайте `USE_SOLCJS=1`.

Одна команда для всього наскрізного сценарію зі скріншотами: `python e2e/run.py`.

## Тести
`npx hardhat test` (контракти) · `python -m pytest api/tests -q` (API)

## Не виконано
Розгортання в Sepolia (скрипт готовий: `.env`, `npx hardhat run scripts/deploy.js --network sepolia`), `docker compose` (не реалізовано).
