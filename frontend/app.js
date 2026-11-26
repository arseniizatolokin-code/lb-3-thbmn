const { ethers } = window;
const $ = (s) => document.querySelector(s);
const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
const STATES = ["—", "Запропоновано", "Профінансовано", "У роботі", "Спір", "Завершено", "Скасовано", "Вирішено"];
const MSTATES = ["очікує", "здано", "прийнято", "відхилено"];
const CATS = { web_dev: "Веброзробка", mobile_dev: "Мобільна розробка", design: "Дизайн", copywriting: "Копірайтинг",
  translation: "Переклад", data_science: "Аналіз даних", video: "Відео", marketing: "Маркетинг" };
const ERR = {
  AccessControlUnauthorizedAccount: "Недостатньо прав: для цієї дії потрібна відповідна роль (адміністратор, арбітр або оракул).",
  NotClient: "Цю дію може виконати лише замовник угоди.", NotFreelancer: "Цю дію може виконати лише виконавець угоди.",
  NotParty: "Цю дію можуть виконати лише сторони угоди.", WrongState: "Угода зараз в іншому стані, ця дія недоступна.",
  WrongMilestone: "Неправильний номер етапу.", WrongMilestoneState: "Етап в іншому стані, ця дія недоступна.",
  RiskNotReady: "Оракул ще не надіслав оцінку ризику. Зачекайте кілька секунд.", WrongAmount: "Неправильна сума: потрібно рівно «сума угоди + депозит».",
  AcceptWindowClosed: "Вікно прийняття угоди закрито.", NotYetAvailable: "Ця дія ще недоступна: не настав потрібний час.",
  InvalidInput: "Некоректні дані угоди.", NothingToWithdraw: "Немає коштів для виведення.", EnforcedPause: "Контракт призупинено адміністратором.",
  UnknownModel: "Версію моделі не зареєстровано в контракті.", ModelAlreadyRegistered: "Цю версію моделі вже зареєстровано.",
  ReportAlreadyExists: "Для цієї угоди оцінку вже записано.", TransferFailed: "Не вдалося перерахувати кошти.",
};
let cfg, abi, provider, signer, account, chainOk = false, C = {}, roles = {};
const short = (x) => (x ? x.slice(0, 8) + "…" + x.slice(-6) : "—");
const eth = (w) => Number(ethers.formatEther(w)).toLocaleString("uk-UA", { maximumFractionDigits: 6 });
const txLink = (h) => (cfg.chainId === 11155111 ? `<a href="https://sepolia.etherscan.io/tx/${h}" target="_blank">${short(h)}</a>` : `<code title="${h}">${short(h)}</code>`);

function showError(e) {
  let msg = typeof e === "string" ? e : null;
  if (!msg) {
    const name = e.revert?.name || (() => { try { return C.escrow.interface.parseError(e.data || e.info?.error?.data)?.name; } catch { return null; } })();
    msg = ERR[name] || (e.code === "ACTION_REJECTED" ? "Ви скасували підпис у гаманці." : null) ||
      (name ? `Контракт відхилив дію: ${name}` : (e.shortMessage || e.message || "Невідома помилка"));
  }
  const b = $("#error"); b.textContent = "⚠ " + msg; b.hidden = false; return msg;
}
const clearError = () => { $("#error").hidden = true; };

// ---------- гаманець ----------
async function init() {
  cfg = await (await fetch("/config.json")).json(); abi = await (await fetch("/static/abi.json")).json();
  $("#f-category").innerHTML = Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  addMs(0.2, 7); addMs(0.4, 14);
  const lp = new ethers.JsonRpcProvider(cfg.rpc);
  try {
    const accs = await lp.send("eth_accounts", []);
    const names = { [cfg.admin?.toLowerCase()]: "адмін", [cfg.oracleSigner?.toLowerCase()]: "оракул", [cfg.arbiter?.toLowerCase()]: "арбітр" };
    $("#local-accounts").innerHTML += accs.map((a, i) => `<option value="${a}">#${i} ${names[a.toLowerCase()] || "користувач"} ${short(a)}</option>`).join("");
  } catch { /* локальний вузол недоступний */ }
  $("#local-accounts").onchange = async (e) => { if (e.target.value) await connectLocal(lp, e.target.value); };
  $("#btn-metamask").onclick = connectMetaMask;
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
  $("#btn-create").onclick = createDeal; $("#ms-add").onclick = () => addMs(0.1, 7); $("#btn-refresh").onclick = refreshAll;
  $("#btn-verify-all").onclick = verifyAll; $("#dec-deal").onchange = (e) => showDecision(Number(e.target.value));
  $("#btn-pause-escrow").onclick = () => send("Escrow.pause", () => C.escrow.pause()); $("#btn-unpause-escrow").onclick = () => send("Escrow.unpause", () => C.escrow.unpause());
  $("#btn-pause-oracle").onclick = () => send("RiskOracle.pause", () => C.oracle.pause()); $("#btn-unpause-oracle").onclick = () => send("RiskOracle.unpause", () => C.oracle.unpause());
  $("#btn-register-model").onclick = () => send("registerModel", () => C.oracle.registerModel($("#adm-model").value.trim(), "ml/model/model_card.md"));
  setInterval(() => { if (account && !document.hidden) refreshAll(true); }, 4000);
}
async function connectMetaMask() {
  clearError();
  if (!window.ethereum) return showError("MetaMask не знайдено. Встановіть розширення або оберіть локальний акаунт зі списку.");
  try {
    provider = new ethers.BrowserProvider(window.ethereum); await provider.send("eth_requestAccounts", []);
    const id = Number((await provider.getNetwork()).chainId);
    if (id !== cfg.chainId) {
      try { await provider.send("wallet_switchEthereumChain", [{ chainId: "0x" + cfg.chainId.toString(16) }]); }
      catch { return setNet(id, false); }
      provider = new ethers.BrowserProvider(window.ethereum);
    }
    signer = await provider.getSigner(); await afterConnect();
  } catch (e) { showError(e); }
}
async function connectLocal(lp, addr) {
  clearError(); provider = lp; signer = await lp.getSigner(addr); await afterConnect();
}
function setNet(id, ok) { const n = $("#net"); n.textContent = ok ? `мережа: ${id} ✓` : `неправильна мережа: ${id}, потрібна ${cfg.chainId}`; n.className = "badge " + (ok ? "ok" : "bad"); chainOk = ok; if (!ok) showError(`Неправильна мережа (${id}). Перемкніть гаманець на мережу ${cfg.chainId}.`); }
async function afterConnect() {
  const id = Number((await provider.getNetwork()).chainId); setNet(id, id === cfg.chainId); if (!chainOk) return;
  account = await signer.getAddress();
  C.escrow = new ethers.Contract(cfg.Escrow, abi.Escrow, signer); C.oracle = new ethers.Contract(cfg.RiskOracle, abi.RiskOracle, signer);
  C.sbt = new ethers.Contract(cfg.ReputationSBT, abi.ReputationSBT, signer);
  const [a, o, r] = await Promise.all([C.oracle.hasRole(ethers.ZeroHash, account), C.oracle.hasRole(await C.oracle.ORACLE_ROLE(), account), C.escrow.hasRole(await C.escrow.ARBITER_ROLE(), account)]);
  roles = { admin: a, oracle: o, arbiter: r };
  $("#acct").textContent = "акаунт: " + short(account); $("#acct").className = "badge ok";
  const rl = [a && "адміністратор", o && "оракул", r && "арбітр"].filter(Boolean);
  $("#roles").textContent = "ролі: " + (rl.length ? rl.join(", ") : "користувач (замовник/виконавець)"); $("#roles").className = "badge ok";
  if (roles.arbiter) tab("admin"); await refreshAll();
}
function tab(t) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  ["deals", "decision", "audit", "admin"].forEach((x) => ($(`#tab-${x}`).hidden = x !== t)); clearError(); refreshAll();
}
const activeTab = () => document.querySelector("#tabs .active").dataset.tab;

// ---------- транзакції ----------
async function send(label, fn) {
  clearError();
  if (!signer) return showError("Спочатку підключіть гаманець.");
  const li = el(`<li class="st-wait">⏳ ${label}: очікуємо підпис…</li>`); $("#txlist").prepend(li);
  try {
    const tx = await fn(); li.innerHTML = `⛓ ${label}: надіслано <b>${tx.hash}</b>, чекаємо блок…`;
    const rc = await tx.wait(); li.className = "st-ok"; li.innerHTML = `✅ ${label}: підтверджено, блок ${rc.blockNumber}, газ ${rc.gasUsed}, tx <b>${tx.hash}</b>`;
    await refreshAll(); return rc;
  } catch (e) { li.className = "st-err"; li.textContent = `❌ ${label}: ${showError(e)}`; }
}

// ---------- угоди ----------
function addMs(a, d) {
  const r = el(`<div class="ms-row"><input class="ms-a" type="number" step="0.01" min="0" value="${a}"><span class="muted">ETH, строк</span><input class="ms-d" type="number" min="1" value="${d}"><span class="muted">днів</span><button class="ghost">×</button></div>`);
  r.querySelector("button").onclick = () => r.remove(); $("#ms-rows").append(r);
}
async function createDeal() {
  clearError();
  if (!signer) return showError("Спочатку підключіть гаманець.");
  const fr = $("#f-freelancer").value.trim(), text = $("#f-spec").value.trim();
  if (!ethers.isAddress(fr)) return showError("Вкажіть правильну адресу виконавця.");
  if (text.length < 10) return showError("Технічне завдання надто коротке (мінімум 10 символів).");
  const amounts = [...document.querySelectorAll(".ms-a")].map((i) => ethers.parseEther(String(i.value || 0)));
  const days = [...document.querySelectorAll(".ms-d")].map((i) => Number(i.value));
  if (!amounts.length || amounts.some((a) => a <= 0n)) return showError("Суми етапів мають бути більшими за нуль.");
  const r = await fetch("/specs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, category: $("#f-category").value }) });
  if (!r.ok) return showError("Сховище ТЗ відхилило запит: " + JSON.stringify((await r.json()).detail));
  const { spec_hash } = await r.json();
  const rc = await send("proposeDeal", () => C.escrow.proposeDeal(fr, amounts, days, spec_hash));
  if (rc) { $("#f-spec").value = ""; }
}
async function pendingBox(addr) { const p = await C.escrow.pendingWithdrawal(addr); return p; }
async function refreshDeals() {
  const n = Number(await C.escrow.dealCount()), box = $("#deals"), cards = []; const me = account.toLowerCase();
  const pend = await C.escrow.pendingWithdrawal(account);
  for (let id = n; id >= 1; id--) {
    const d = await C.escrow.getDeal(id); const isC = d.client.toLowerCase() === me, isF = d.freelancer.toLowerCase() === me;
    if (!isC && !isF && !roles.arbiter && !roles.admin) continue;
    const rk = await C.oracle.getRisk(id), st = Number(d.state), ms = [];
    for (let i = 0; i < Number(d.milestoneCount); i++) ms.push(await C.escrow.getMilestone(id, i));
    const dep = rk.submittedAt > 0n ? (d.total * (await C.oracle.depositBps(rk.riskBps))) / 10000n : 0n;
    const act = [];
    if (isC && st === 1) act.push(rk.submittedAt > 0n ? ["Профінансувати", () => C.escrow.fundDeal(id, { value: d.total + dep }), "primary"] : null, ["Скасувати", () => C.escrow.cancelDeal(id)]);
    if (isC && st === 2) act.push(["Скасувати", () => C.escrow.cancelDeal(id)]);
    if (isF && st === 2) act.push(["Прийняти (депозит " + eth(dep) + " ETH)", () => C.escrow.acceptDeal(id, { value: d.freelancerDeposit > 0n ? d.freelancerDeposit : dep }), "primary"]);
    if (st === 3) {
      const cur = Number(d.current), m = ms[cur];
      if (isF && m && (Number(m.state) === 0 || Number(m.state) === 3)) act.push([`Здати етап ${cur + 1}`, () => C.escrow.submitMilestone(id, cur, ethers.keccak256(ethers.toUtf8Bytes(`result-${id}-${cur}`))), "primary"]);
      if (isC && m && Number(m.state) === 1) act.push([`Прийняти етап ${cur + 1}`, () => C.escrow.approveMilestone(id, cur), "primary"], [`Відхилити етап ${cur + 1}`, () => C.escrow.rejectMilestone(id, cur)]);
      if ((isC || isF) && m && Number(m.state) === 1) act.push(["Відкрити спір", () => C.escrow.openDispute(id)]);
    }
    const stateCls = st === 4 ? "hi" : st === 5 || st === 7 ? "lo" : "";
    const c = el(`<div class="card" data-deal="${id}"><h3>Угода #${id} <span class="pill ${stateCls}">${STATES[st]}</span> <span class="muted">${isC ? "ви — замовник" : isF ? "ви — виконавець" : ""}</span></h3>
      <div class="row"><span>Сума: <b>${eth(d.total)} ETH</b></span><span>Замовник: <code>${short(d.client)}</code></span><span>Виконавець: <code>${short(d.freelancer)}</code></span>
      <span>Ризик спору: ${rk.submittedAt > 0n ? `<b>${(Number(rk.riskBps) / 100).toFixed(1)} %</b> (депозит ${eth(dep)} ETH)` : '<span class="muted">очікуємо оцінку оракула…</span>'}</span></div>
      <div class="row">${ms.map((m, i) => `<span class="pill">етап ${i + 1}: ${eth(m.amount)} ETH, ${MSTATES[Number(m.state)]}</span>`).join("")}</div><div class="row actions"></div></div>`);
    for (const a of act.filter(Boolean)) { const b = el(`<button class="${a[2] || ""}">${a[0]}</button>`); b.onclick = () => send(`${a[0]} (#${id})`, a[1]); c.querySelector(".actions").append(b); }
    const bd = el(`<button class="ghost">Рішення моделі →</button>`); bd.onclick = () => { tab("decision"); $("#dec-deal").value = id; showDecision(id); }; c.querySelector(".actions").append(bd);
    cards.push(c);
  }
  box.replaceChildren(...cards);
  if (pend > 0n) { const w = el(`<div class="card" id="withdraw-box"><b>Доступно до виведення: ${eth(pend)} ETH</b> </div>`); const b = el(`<button class="primary">Вивести</button>`); b.onclick = () => send("withdraw", () => C.escrow.withdraw()); w.append(b); box.prepend(w); }
  if (!cards.length && pend === 0n) box.innerHTML = '<p class="muted">Угод поки немає.</p>';
}

// ---------- екран рішення моделі ----------
async function riskLogs() { return C.oracle.queryFilter(C.oracle.filters.RiskSubmitted(), 0, "latest"); }
async function fillDealSelect() {
  const n = Number(await C.escrow.dealCount()), sel = $("#dec-deal"), cur = sel.value;
  sel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">Угода #${i + 1}</option>`).join(""); if (cur) sel.value = cur;
}
async function showDecision(id) {
  const box = $("#decision"); if (!id) { box.innerHTML = '<p class="muted">Угод поки немає.</p>'; return; }
  const rk = await C.oracle.getRisk(id);
  if (rk.submittedAt === 0n) { box.innerHTML = '<div class="card">Оракул ще не оцінив цю угоду…</div>'; return; }
  const logs = (await riskLogs()).filter((l) => Number(l.args.dealId) === id), tx = logs.length ? logs[logs.length - 1].transactionHash : null;
  const r = await fetch(`/decisions/${id}`), dec = r.ok ? await r.json() : null, bps = Number(rk.riskBps);
  const dep = await C.oracle.depositBps(rk.riskBps), hi = dec ? dec.label === "високий" : bps >= 3000;
  const factors = (dec?.factors || []).map((f) => { const w = Math.min(Math.abs(f.effect) / 0.15, 1) * 50, pos = f.effect >= 0;
    return `<div class="factor"><span>${f.label} <span class="muted">(${typeof f.value === "number" ? +f.value.toFixed(2) : f.value})</span></span><div class="bar"><span class="mid"></span><i style="${pos ? "left:50%" : `left:${50 - w}%`};width:${w}%;background:${pos ? "var(--bad)" : "var(--ok)"}"></i></div><b>${pos ? "+" : ""}${(f.effect * 100).toFixed(1)} п.п.</b></div>`; }).join("");
  box.innerHTML = `<div class="card" id="decision-card"><div class="row"><div><div class="big">${(bps / 100).toFixed(1)} %</div><div class="muted">ймовірність спору</div></div>
    <div><span class="pill ${hi ? "hi" : "lo"}">ризик: ${dec ? dec.label : hi ? "високий" : "низький"}</span><div class="muted">упевненість моделі: <b>${dec ? (dec.confidence * 100).toFixed(0) + " %" : "—"}</b></div>
    <div class="muted">депозит з кожної сторони: <b>${(Number(dep) / 100).toFixed(1)} %</b> суми угоди</div></div></div>
    <h3>Головні чинники рішення</h3><div class="muted">Зміна ризику (відсоткові пункти), якщо ознаку прибрати: червоне підвищує ризик, зелене знижує.</div>${factors || '<p class="muted">Пояснення недоступне.</p>'}
    <h3>Запис у ланцюгу</h3><div class="row"><span>Версія моделі: <code>${rk.modelVersion}</code></span></div>
    <div class="row"><span>Хеш вхідних даних: <code>${rk.inputHash}</code></span></div><div class="row"><span>Транзакція оракула: ${tx ? txLink(tx) : "—"}</span><span>Час: ${new Date(Number(rk.submittedAt) * 1000).toLocaleString("uk-UA")}</span></div></div>`;
}

// ---------- аудит ----------
const sha256hex = async (s) => "0x" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function verifyDeal(id) {
  const rk = await C.oracle.getRisk(id), d = await C.escrow.getDeal(id); const out = [];
  const sp = await fetch(`/specs/${d.specHash}`);
  if (!sp.ok) out.push("❌ ТЗ не знайдено");
  else out.push((ethers.keccak256(ethers.toUtf8Bytes((await sp.json()).text)) === d.specHash.toLowerCase()) ? "✅ ТЗ" : "❌ ТЗ підмінено");
  const dr = await fetch(`/decisions/${id}`);
  if (!dr.ok) out.push("❌ входи моделі не знайдено");
  else { const dec = await dr.json(); out.push((await sha256hex(dec.features_canonical)) === rk.inputHash.toLowerCase() ? "✅ вхід моделі" : "❌ вхід моделі змінено"); }
  return out;
}
async function verifyAll() { for (const tr of document.querySelectorAll("#audit-table tbody tr")) tr.querySelector(".integ").textContent = (await verifyDeal(Number(tr.dataset.deal))).join("  "); }
async function refreshAudit() {
  const logs = await riskLogs(), mlogs = await C.oracle.queryFilter(C.oracle.filters.ModelRegistered(), 0, "latest");
  $("#models").innerHTML = `<div class="card"><b>Зареєстровані версії моделі</b>${mlogs.map((l) => `<div class="row"><code>${l.args.modelVersion}</code><span class="muted">${l.args.uri} · блок ${l.blockNumber}</span></div>`).join("") || " —"}</div>`;
  const rows = [];
  for (const l of logs) {
    const id = Number(l.args.dealId), tr = el(`<tr data-deal="${id}"><td>#${id}</td><td><b>${(Number(l.args.riskBps) / 100).toFixed(1)} %</b></td><td><code title="${l.args.modelVersion}">${short(l.args.modelVersion)}</code></td><td><code title="${l.args.inputHash}">${short(l.args.inputHash)}</code></td><td>${l.blockNumber}</td><td>${txLink(l.transactionHash)}</td><td><span class="integ muted">—</span> <button class="ghost">Перевірити</button></td></tr>`);
    tr.querySelector("button").onclick = async () => (tr.querySelector(".integ").textContent = (await verifyDeal(id)).join("  ")); rows.push(tr);
  }
  $("#audit-table tbody").replaceChildren(...rows);
}

// ---------- арбітр / адмін ----------
async function refreshAdmin() {
  $("#adm-oracle").textContent = await C.oracle.oracle();
  const n = Number(await C.escrow.dealCount()), cards = [];
  for (let id = 1; id <= n; id++) {
    const d = await C.escrow.getDeal(id); if (Number(d.state) !== 4) continue;
    const c = el(`<div class="card"><h3>Спір в угоді #${id}</h3><div class="row"><span>Сума: ${eth(d.total)} ETH, виплачено ${eth(d.paid)} ETH</span><label>Частка замовника: <b class="pv">50</b> %<input type="range" min="0" max="100" value="50"></label><button class="primary">Винести рішення</button></div></div>`);
    const rg = c.querySelector("input"); rg.oninput = () => (c.querySelector(".pv").textContent = rg.value);
    c.querySelector("button").onclick = () => send(`resolveDispute (#${id})`, () => C.escrow.resolveDispute(id, Number(rg.value))); cards.push(c);
  }
  $("#disputes").replaceChildren(...(cards.length ? cards : [el('<p class="muted">Відкритих спорів немає.</p>')]));
}

async function refreshAll(silent) {
  if (!C.escrow) return;
  try {
    const t = activeTab();
    if (t === "deals") await refreshDeals(); if (t === "decision") { await fillDealSelect(); if (!silent) await showDecision(Number($("#dec-deal").value)); }
    if (t === "audit") await refreshAudit(); if (t === "admin") await refreshAdmin();
  } catch (e) { if (!silent) showError(e); }
}
init().catch((e) => showError(e));
