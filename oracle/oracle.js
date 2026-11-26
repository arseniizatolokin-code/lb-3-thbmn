// Сервіс-оракул: слухає DealProposed, збирає ознаки через API, надсилає ризик у RiskOracle.
//   ORACLE_PRIVATE_KEY=0x... node oracle/oracle.js          (постійно)   |   node oracle/oracle.js --once
// Надійність: повтори з наростаючою паузою; стан (курсор і оброблені події) у SQLite — після перезапуску
// подія не обробляється двічі; перед надсиланням перевіряється, чи вже є звіт у контракті; журнал — oracle/oracle.log.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ethers } = require("ethers");

const ABI = JSON.parse(fs.readFileSync(path.join(__dirname, "abi.json"), "utf8"));
const cfg = {
  rpc: process.env.RPC_URL || "http://127.0.0.1:8545",
  api: process.env.API_URL || "http://127.0.0.1:8000",
  key: process.env.ORACLE_PRIVATE_KEY,                       // ключ ЛИШЕ зі змінних середовища
  deployment: process.env.DEPLOYMENT || path.join(__dirname, "..", "deployments", "localhost.json"),
  state: process.env.ORACLE_STATE || path.join(__dirname, "state.db"),
  logFile: process.env.ORACLE_LOG || path.join(__dirname, "oracle.log"),
  poll: Number(process.env.POLL_MS || 2000),
  retries: Number(process.env.MAX_RETRIES || 5),
  baseDelay: Number(process.env.RETRY_DELAY_MS || 500),
};
if (!cfg.key) { console.error("Не задано ORACLE_PRIVATE_KEY"); process.exit(1); }

const log = (level, msg, extra = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  fs.appendFileSync(cfg.logFile, line + "\n"); console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(label, fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (e.permanent || i >= cfg.retries) throw e;
      const d = cfg.baseDelay * 2 ** (i - 1);
      log("warn", `${label}: збій (${e.shortMessage || e.message}), повтор ${i}/${cfg.retries - 1} через ${d} мс`);
      await sleep(d);
    }
  }
}
async function api(method, url, body) {
  const r = await fetch(cfg.api + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`API ${r.status}: ${JSON.stringify(j.detail || j)}`); e.permanent = r.status >= 400 && r.status < 500; throw e; }
  return j;
}

const st = new DatabaseSync(cfg.state);
st.exec(`CREATE TABLE IF NOT EXISTS events(key TEXT PRIMARY KEY, deal_id INTEGER, status TEXT, tx TEXT, info TEXT, ts TEXT);
         CREATE TABLE IF NOT EXISTS cursor(id INTEGER PRIMARY KEY CHECK(id=1), block INTEGER);`);
const getCursor = () => (st.prepare("SELECT block FROM cursor WHERE id=1").get() || { block: 0 }).block;
const setCursor = (b) => st.prepare("INSERT INTO cursor(id,block) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET block=excluded.block").run(b);
const done = (key) => st.prepare("SELECT status FROM events WHERE key=?").get(key);
const mark = (key, deal, status, tx, info) =>
  st.prepare("INSERT OR REPLACE INTO events VALUES(?,?,?,?,?,?)").run(key, deal, status, tx || null, info || null, new Date().toISOString());

async function main() {
  const dep = JSON.parse(fs.readFileSync(cfg.deployment, "utf8"));
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const wallet = new ethers.Wallet(cfg.key, provider);
  const escrow = new ethers.Contract(dep.Escrow, ABI.Escrow, provider);
  const sbt = new ethers.Contract(dep.ReputationSBT, ABI.ReputationSBT, provider);
  const oracle = new ethers.Contract(dep.RiskOracle, ABI.RiskOracle, wallet);
  log("info", "оракул запущено", { address: wallet.address, escrow: dep.Escrow, fromBlock: getCursor() });

  async function handle(ev) {
    const key = `${ev.transactionHash}:${ev.index}`, dealId = Number(ev.args.dealId);
    if (done(key)) return log("info", "подію вже оброблено, пропуск", { dealId, status: done(key).status });
    try {
      const existing = await retry("getRisk", () => oracle.getRisk(dealId));
      if (existing.submittedAt > 0n) { mark(key, dealId, "already_on_chain"); return log("info", "звіт уже є в контракті", { dealId }); }
      const deal = await retry("getDeal", () => escrow.getDeal(dealId));
      const ms = await retry("milestones", async () => Promise.all(
        Array.from({ length: Number(ev.args.milestones) }, (_, i) => escrow.getMilestone(dealId, i))));
      const rep = await retry("stats", () => sbt.stats(deal.freelancer));
      const body = {
        deal_id: dealId, spec_hash: deal.specHash, client: deal.client, freelancer: deal.freelancer,
        amounts_eth: ms.map((m) => Number(ethers.formatEther(m.amount))), due_days: ms.map((m) => Number(m.dueDays)),
        freelancer_sbt_deals: Number(rep[0]), freelancer_sbt_disputes: Number(rep[1]),
      };
      const s = await retry("score", () => api("POST", "/score", body));
      const reg = await retry("model", () => oracle.modelRegisteredAt(s.model_version));
      if (reg === 0n) throw Object.assign(new Error(`версія моделі ${s.model_version} не зареєстрована`), { permanent: true });
      const tx = await retry("submitRisk", () => oracle.submitRisk(dealId, s.risk_bps, s.model_version, s.input_hash));
      const rc = await tx.wait();
      await retry("tx→api", () => api("PUT", `/decisions/${dealId}/tx`, { tx_hash: tx.hash })).catch(() => {});
      mark(key, dealId, "submitted", tx.hash, `risk_bps=${s.risk_bps}`);
      log("info", "ризик записано в контракт", { dealId, riskBps: s.risk_bps, modelVersion: s.model_version, tx: tx.hash, block: rc.blockNumber });
    } catch (e) {
      mark(key, dealId, e.permanent ? "rejected" : "failed", null, e.message);
      log("error", "угоду не оброблено", { dealId, error: e.message, permanent: !!e.permanent });
    }
  }

  async function scan() {
    const head = await retry("blockNumber", () => provider.getBlockNumber());
    const from = getCursor();
    if (head < from) return;
    const events = await retry("logs", () => escrow.queryFilter(escrow.filters.DealProposed(), from, head));
    for (const ev of events) {
      const prev = done(`${ev.transactionHash}:${ev.index}`);
      if (prev && prev.status !== "failed") { log("info", "подію вже оброблено, пропуск", { dealId: Number(ev.args.dealId), status: prev.status }); continue; }   // «failed» пробуємо ще раз
      await handle(ev);
    }
    setCursor(head + 1);
  }

  if (process.argv.includes("--once")) { await scan(); return; }
  for (;;) { try { await scan(); } catch (e) { log("error", "цикл опитування", { error: e.message }); } await sleep(cfg.poll); }
}
main().catch((e) => { log("error", "фатальна помилка", { error: e.message }); process.exit(1); });
