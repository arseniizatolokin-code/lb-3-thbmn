const { expect } = require("chai");
const { E, DAY, MV, IH, SPEC, S, time, ethers, deployAll, propose, withRisk, deposit } = require("./helpers/fixture");
const { SpecStore } = require("../offchain/store");

describe("Інтеграційні сценарії", () => {
  it("головний сценарій: ТЗ → оракул → фінансування → етапи → виплати → репутація", async () => {
    const f = await deployAll(); const e = f.escrow;
    const store = new SpecStore();
    const spec = store.save("ТЗ: лендінг на 3 екрани, строк 2 тижні");
    await e.connect(f.client).proposeDeal(f.freelancer.address, [E(1), E(2)], [7, 14], spec);
    await f.oracle.connect(f.oracleSigner).submitRisk(1, 3000, MV, IH);
    const dep = await deposit(f, 1);
    await e.connect(f.client).fundDeal(1, { value: E(3) + dep });
    await e.connect(f.freelancer).acceptDeal(1, { value: dep });
    for (const i of [0, 1]) {
      await e.connect(f.freelancer).submitMilestone(1, i, ethers.keccak256(ethers.toUtf8Bytes("файл" + i)));
      await e.connect(f.client).approveMilestone(1, i);
    }
    await e.connect(f.freelancer).withdraw(); await e.connect(f.client).withdraw();
    expect(await ethers.provider.getBalance(await e.getAddress())).to.equal(0);
    expect((await e.getDeal(1)).state).to.equal(S.Completed);
    expect((await f.sbt.stats(f.client.address))[0]).to.equal(1);
    expect((await f.sbt.stats(f.freelancer.address))[0]).to.equal(1);
    expect((await f.oracle.getRisk(1)).modelVersion).to.equal(MV);
  });

  it("спір: арбітр присуджує виконавцю, баланс контракту обнуляється після виплат", async () => {
    const f = await deployAll(); const e = f.escrow;
    const id = await propose(f); await withRisk(f, id, 8000);
    const dep = await deposit(f, id);
    await e.connect(f.client).fundDeal(id, { value: E(3) + dep });
    await e.connect(f.freelancer).acceptDeal(id, { value: dep });
    await e.connect(f.freelancer).submitMilestone(id, 0, SPEC);
    await e.connect(f.client).rejectMilestone(id, 0);
    await e.connect(f.client).openDispute(id);
    await e.connect(f.arbiter).resolveDispute(id, 30); // клієнт отримує 30 %, виконавець 70 %, обидва депозити лишаються за правилами
    await e.connect(f.freelancer).withdraw(); await e.connect(f.client).withdraw();
    expect(await ethers.provider.getBalance(await e.getAddress())).to.equal(0);
    expect((await f.sbt.stats(f.client.address))[2]).to.equal(1);
  });

  it("прострочення: замовник скасовує угоду й повертає кошти та обидва депозити", async () => {
    const f = await deployAll(); const e = f.escrow;
    const id = await propose(f); await withRisk(f, id);
    const dep = await deposit(f, id);
    await e.connect(f.client).fundDeal(id, { value: E(3) + dep });
    await e.connect(f.freelancer).acceptDeal(id, { value: dep });
    await time.increase(8 * DAY);
    await e.connect(f.client).cancelOverdue(id);
    await expect(e.connect(f.client).withdraw()).to.changeEtherBalance(f.client, E(3) + 2n * dep);
  });

  it("заміна оракула: нова адреса подає ризик для наступних угод", async () => {
    const f = await deployAll();
    await f.oracle.replaceOracle(f.other.address);
    const id = await propose(f);
    await f.oracle.connect(f.other).submitRisk(id, 1000, MV, IH);
    const dep = await deposit(f, id);
    await f.escrow.connect(f.client).fundDeal(id, { value: E(3) + dep });
    expect((await f.escrow.getDeal(id)).riskBps).to.equal(1000);
  });
});

describe("Позаланцюгове сховище: перевірка цілісності", () => {
  it("справжній файл проходить перевірку хешу з ланцюга", async () => {
    const f = await deployAll(); const store = new SpecStore();
    const hash = store.save("ТЗ: інтернет-магазин");
    await f.escrow.connect(f.client).proposeDeal(f.freelancer.address, [E(1)], [5], hash);
    const onchain = (await f.escrow.getDeal(1)).specHash;
    expect(SpecStore.verify(store.load(hash), onchain)).to.equal(true);
  });
  it("підмінений файл перевірку не проходить", async () => {
    const f = await deployAll(); const store = new SpecStore();
    const hash = store.save("ТЗ: інтернет-магазин");
    await f.escrow.connect(f.client).proposeDeal(f.freelancer.address, [E(1)], [5], hash);
    store.tamper(hash, "ТЗ: зовсім інше завдання");
    const onchain = (await f.escrow.getDeal(1)).specHash;
    expect(SpecStore.verify(store.load(hash), onchain)).to.equal(false);
  });
});
