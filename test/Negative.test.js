const { expect } = require("chai");
const { E, SPEC, S, MS, time, ethers, deployAll, propose, withRisk, funded, inProgress } = require("./helpers/fixture");

// Негативні сценарії: неприпустимі переходи автомата, пауза, чужі виклики.
describe("Негативні сценарії Escrow", () => {
  let f, e;
  beforeEach(async () => { f = await deployAll(); e = f.escrow; });
  const rv = (p, n) => expect(p).to.be.revertedWithCustomError(e, n);

  it("під паузою відхиляються всі функції зміни стану", async () => {
    const x = await inProgress(f);
    await e.pause();
    await rv(e.connect(f.client).fundDeal(x.id), "EnforcedPause");
    await rv(e.connect(f.freelancer).acceptDeal(x.id), "EnforcedPause");
    await rv(e.connect(f.client).cancelDeal(x.id), "EnforcedPause");
    await rv(e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC), "EnforcedPause");
    await rv(e.connect(f.client).approveMilestone(x.id, 0), "EnforcedPause");
    await rv(e.connect(f.freelancer).autoApprove(x.id, 0), "EnforcedPause");
    await rv(e.connect(f.client).rejectMilestone(x.id, 0), "EnforcedPause");
    await rv(e.connect(f.client).cancelOverdue(x.id), "EnforcedPause");
    await rv(e.connect(f.client).openDispute(x.id), "EnforcedPause");
    await rv(e.connect(f.arbiter).resolveDispute(x.id, 50), "EnforcedPause");
  });

  it("функції відхиляються для неіснуючої угоди (стан None)", async () => {
    await rv(e.connect(f.client).fundDeal(99), "WrongState");
    await rv(e.connect(f.freelancer).acceptDeal(99), "WrongState");
    await rv(e.connect(f.freelancer).submitMilestone(99, 0, SPEC), "WrongState");
    await rv(e.connect(f.client).rejectMilestone(99, 0), "WrongState");
    await rv(e.connect(f.client).cancelOverdue(99), "WrongState");
    await rv(e.connect(f.client).openDispute(99), "WrongState");
    await rv(e.connect(f.arbiter).resolveDispute(99, 50), "WrongState");
  });

  it("approve і autoApprove відхиляються поза станом InProgress", async () => {
    const x = await funded(f);
    await rv(e.connect(f.client).approveMilestone(x.id, 0), "WrongState");
    await time.increase(8 * 86400);
    await rv(e.connect(f.freelancer).autoApprove(x.id, 0), "WrongState");
  });

  it("approve і autoApprove відхиляються для неправильного номера етапу", async () => {
    const x = await inProgress(f);
    await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
    await rv(e.connect(f.client).approveMilestone(x.id, 1), "WrongMilestone");
    await time.increase(8 * 86400);
    await rv(e.connect(f.freelancer).autoApprove(x.id, 1), "WrongMilestone");
  });

  it("reject: чужий, неправильний етап і етап не в стані Submitted", async () => {
    const x = await inProgress(f);
    await rv(e.connect(f.outsider).rejectMilestone(x.id, 0), "NotClient");
    await rv(e.connect(f.client).rejectMilestone(x.id, 1), "WrongMilestone");
    await rv(e.connect(f.client).rejectMilestone(x.id, 0), "WrongMilestoneState");
  });

  it("cancelOverdue: чужий, не в стані Pending, не в стані InProgress", async () => {
    const x = await inProgress(f);
    await rv(e.connect(f.outsider).cancelOverdue(x.id), "NotClient");
    await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
    await time.increase(8 * 86400);
    await rv(e.connect(f.client).cancelOverdue(x.id), "WrongMilestoneState");
    const y = await funded(f);
    await rv(e.connect(f.client).cancelOverdue(y.id), "WrongState");
  });

  it("openDispute відхиляється, поки угода не в роботі", async () => {
    const x = await funded(f);
    await rv(e.connect(f.client).openDispute(x.id), "WrongState");
  });

  it("acceptDeal відхиляється для угоди не у стані Funded", async () => {
    const id = await propose(f);
    await rv(e.connect(f.freelancer).acceptDeal(id), "WrongState");
  });

  it("cancelOverdue: другий етап після схвалення першого, строк рахується від прийняття", async () => {
    const x = await inProgress(f);
    await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
    await e.connect(f.client).approveMilestone(x.id, 0);
    await time.increase(10 * 86400); // строк другого етапу 14 днів — ще не прострочено
    await expect(e.connect(f.client).cancelOverdue(x.id)).to.be.revertedWithCustomError(e, "NotYetAvailable");
    await time.increase(5 * 86400);
    await e.connect(f.client).cancelOverdue(x.id);
    expect((await e.getDeal(x.id)).paid).to.equal(E(1));
  });

  it("конструктор відхиляє кожну нульову адресу окремо", async () => {
    const F = await ethers.getContractFactory("Escrow");
    const a = f.other.address;
    await rv(F.deploy(a, ethers.ZeroAddress, a), "InvalidInput");
    await rv(F.deploy(a, a, ethers.ZeroAddress), "InvalidInput");
  });

  it("unpause та pause у RiskOracle доступні лише адміністратору; депозит обмежено 20 %", async () => {
    await expect(e.connect(f.outsider).unpause()).to.be.revertedWithCustomError(e, "AccessControlUnauthorizedAccount");
    await expect(f.oracle.connect(f.outsider).pause()).to.be.revertedWithCustomError(f.oracle, "AccessControlUnauthorizedAccount");
    await expect(f.oracle.connect(f.outsider).unpause()).to.be.revertedWithCustomError(f.oracle, "AccessControlUnauthorizedAccount");
    expect(await f.oracle.depositBps(20000)).to.equal(2000);
    const R = await ethers.getContractFactory("RiskOracle");
    await expect(R.deploy(f.admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(f.oracle, "ZeroAddress");
  });
});
