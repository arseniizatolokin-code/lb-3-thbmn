const { expect } = require("chai");
const { E, DAY, SPEC, S, MS, time, ethers, deployAll, propose, withRisk, funded, inProgress } = require("./helpers/fixture");

describe("Escrow", () => {
  let f, e;
  beforeEach(async () => { f = await deployAll(); e = f.escrow; });
  const rev = (p, name, ...args) => (args.length ? expect(p).to.be.revertedWithCustomError(e, name).withArgs(...args) : expect(p).to.be.revertedWithCustomError(e, name));

  describe("proposeDeal", () => {
    it("створює угоду, рахує суму та видає подію", async () => {
      await expect(e.connect(f.client).proposeDeal(f.freelancer.address, [E(1), E(2)], [7, 14], SPEC))
        .to.emit(e, "DealProposed").withArgs(1, f.client.address, f.freelancer.address, E(3), SPEC, 2);
      const d = await e.getDeal(1);
      expect(d.state).to.equal(S.Proposed); expect(d.total).to.equal(E(3)); expect(d.milestoneCount).to.equal(2);
      expect((await e.getMilestone(1, 1)).amount).to.equal(E(2));
    });
    it("відхиляє порожній список, різну довжину, нульову суму, незростаючі строки", async () => {
      const p = (a, d) => e.connect(f.client).proposeDeal(f.freelancer.address, a, d, SPEC);
      await rev(p([], []), "InvalidInput");
      await rev(p([E(1)], [1, 2]), "InvalidInput");
      await rev(p([0], [1]), "InvalidInput");
      await rev(p([E(1), E(1)], [5, 5]), "InvalidInput");
    });
    it("відхиляє виконавця = замовник, нульову адресу та понад 10 етапів", async () => {
      await rev(e.connect(f.client).proposeDeal(f.client.address, [E(1)], [1], SPEC), "InvalidInput");
      await rev(e.connect(f.client).proposeDeal(ethers.ZeroAddress, [E(1)], [1], SPEC), "InvalidInput");
      const a = Array(11).fill(E(1)), d = Array.from({ length: 11 }, (_, i) => i + 1);
      await rev(e.connect(f.client).proposeDeal(f.freelancer.address, a, d, SPEC), "InvalidInput");
    });
  });

  describe("fundDeal", () => {
    it("відхиляє фінансування без оцінки ризику", async () => {
      const id = await propose(f);
      await rev(e.connect(f.client).fundDeal(id, { value: E(3) }), "RiskNotReady", id);
    });
    it("відхиляє неправильну суму", async () => {
      const id = await propose(f); await withRisk(f, id, 5000);
      await rev(e.connect(f.client).fundDeal(id, { value: E(3) }), "WrongAmount", E(3) + E(3) * 1100n / 10000n, E(3));
    });
    it("відхиляє виклик не замовником і повторне фінансування", async () => {
      const id = await propose(f); await withRisk(f, id);
      await rev(e.connect(f.outsider).fundDeal(id, { value: 1 }), "NotClient", f.outsider.address);
      const x = await funded(f); // друга угода
      await rev(e.connect(f.client).fundDeal(x.id, { value: 1 }), "WrongState", S.Funded);
    });
    it("враховує ризик у депозиті й видає подію DealFunded", async () => {
      const id = await propose(f); await withRisk(f, id, 10000);
      const dep = E(3) * 2000n / 10000n;
      await expect(e.connect(f.client).fundDeal(id, { value: E(3) + dep }))
        .to.emit(e, "DealFunded").withArgs(id, 10000, dep, dep);
      expect((await e.getDeal(id)).state).to.equal(S.Funded);
    });
  });

  describe("acceptDeal", () => {
    it("виконавець приймає угоду з депозитом", async () => {
      const x = await funded(f);
      await expect(e.connect(f.freelancer).acceptDeal(x.id, { value: x.dep })).to.emit(e, "DealAccepted");
      expect((await e.getDeal(x.id)).state).to.equal(S.InProgress);
    });
    it("відхиляє чужий виклик і неправильний депозит", async () => {
      const x = await funded(f);
      await rev(e.connect(f.outsider).acceptDeal(x.id, { value: x.dep }), "NotFreelancer", f.outsider.address);
      await rev(e.connect(f.freelancer).acceptDeal(x.id, { value: 1 }), "WrongAmount", x.dep, 1);
    });
    it("відхиляє прийняття після закінчення вікна (час)", async () => {
      const x = await funded(f);
      await time.increase(7 * DAY + 10);
      await rev(e.connect(f.freelancer).acceptDeal(x.id, { value: x.dep }), "AcceptWindowClosed");
    });
  });

  describe("cancelDeal", () => {
    it("скасовує угоду без коштів у стані Proposed", async () => {
      const id = await propose(f);
      await expect(e.connect(f.client).cancelDeal(id)).to.emit(e, "DealCancelled").withArgs(id, false);
      expect((await e.getDeal(id)).state).to.equal(S.Cancelled);
    });
    it("повертає внесене на баланс у стані Funded", async () => {
      const x = await funded(f);
      await e.connect(f.client).cancelDeal(x.id);
      expect(await e.pendingWithdrawal(f.client.address)).to.equal(x.total + x.dep);
    });
    it("не дозволяє скасування під час роботи та чужим", async () => {
      const x = await inProgress(f);
      await rev(e.connect(f.client).cancelDeal(x.id), "WrongState", S.InProgress);
      await rev(e.connect(f.outsider).cancelDeal(x.id), "NotClient", f.outsider.address);
    });
  });

  describe("етапи", () => {
    it("повний цикл етапу: здача, схвалення, оплата на баланс", async () => {
      const x = await inProgress(f);
      const h = ethers.keccak256(ethers.toUtf8Bytes("result"));
      await expect(e.connect(f.freelancer).submitMilestone(x.id, 0, h)).to.emit(e, "MilestoneSubmitted").withArgs(x.id, 0, h);
      await expect(e.connect(f.client).approveMilestone(x.id, 0)).to.emit(e, "MilestoneApproved").withArgs(x.id, 0, E(1), false);
      expect(await e.pendingWithdrawal(f.freelancer.address)).to.equal(E(1));
      expect((await e.getDeal(x.id)).current).to.equal(1);
    });
    it("submit: лише виконавець, лише поточний етап, лише з Pending/Rejected", async () => {
      const x = await inProgress(f);
      await rev(e.connect(f.outsider).submitMilestone(x.id, 0, SPEC), "NotFreelancer", f.outsider.address);
      await rev(e.connect(f.freelancer).submitMilestone(x.id, 1, SPEC), "WrongMilestone", 1);
      await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
      await rev(e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC), "WrongMilestoneState", MS.Submitted);
    });
    it("approve: лише замовник і лише здані етапи", async () => {
      const x = await inProgress(f);
      await rev(e.connect(f.client).approveMilestone(x.id, 0), "WrongMilestoneState", MS.Pending);
      await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
      await rev(e.connect(f.outsider).approveMilestone(x.id, 0), "NotClient", f.outsider.address);
    });
    it("відхилений етап можна здати повторно", async () => {
      const x = await inProgress(f);
      await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
      await expect(e.connect(f.client).rejectMilestone(x.id, 0)).to.emit(e, "MilestoneRejected");
      expect((await e.getMilestone(x.id, 0)).state).to.equal(MS.Rejected);
      await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
      await e.connect(f.client).approveMilestone(x.id, 0);
    });
    it("autoApprove: рано відхиляється, через 7 днів виплачує (час)", async () => {
      const x = await inProgress(f);
      await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
      await expect(e.connect(f.freelancer).autoApprove(x.id, 0)).to.be.revertedWithCustomError(e, "NotYetAvailable");
      await time.increase(7 * DAY + 5);
      await expect(e.connect(f.freelancer).autoApprove(x.id, 0)).to.emit(e, "MilestoneApproved").withArgs(x.id, 0, E(1), true);
      await rev(e.connect(f.client).autoApprove(x.id, 1), "NotFreelancer", f.client.address);
    });
    it("cancelOverdue: рано відхиляється, після строку повертає все замовнику (час)", async () => {
      const x = await inProgress(f);
      await expect(e.connect(f.client).cancelOverdue(x.id)).to.be.revertedWithCustomError(e, "NotYetAvailable");
      await time.increase(7 * DAY + 5);
      await expect(e.connect(f.client).cancelOverdue(x.id)).to.emit(e, "DealCancelled").withArgs(x.id, true);
      expect(await e.pendingWithdrawal(f.client.address)).to.equal(x.total + 2n * x.dep);
      expect((await e.getDeal(x.id)).state).to.equal(S.Cancelled);
    });
    it("завершення останнього етапу повертає депозити й видає DealCompleted", async () => {
      const x = await inProgress(f);
      for (const i of [0, 1]) {
        await e.connect(f.freelancer).submitMilestone(x.id, i, SPEC);
        if (i === 1) await expect(e.connect(f.client).approveMilestone(x.id, i)).to.emit(e, "DealCompleted").withArgs(x.id);
        else await e.connect(f.client).approveMilestone(x.id, i);
      }
      expect(await e.pendingWithdrawal(f.freelancer.address)).to.equal(x.total + x.dep);
      expect(await e.pendingWithdrawal(f.client.address)).to.equal(x.dep);
      expect((await e.getDeal(x.id)).state).to.equal(S.Completed);
    });
  });

  describe("спір", () => {
    async function disputed() {
      const x = await inProgress(f);
      await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
      await e.connect(f.client).rejectMilestone(x.id, 0);
      await e.connect(f.freelancer).openDispute(x.id);
      return x;
    }
    it("відкрити спір може лише сторона й лише коли етап здано або відхилено", async () => {
      const x = await inProgress(f);
      await rev(e.connect(f.client).openDispute(x.id), "WrongMilestoneState", MS.Pending);
      await e.connect(f.freelancer).submitMilestone(x.id, 0, SPEC);
      await rev(e.connect(f.outsider).openDispute(x.id), "NotParty", f.outsider.address);
      await expect(e.connect(f.client).openDispute(x.id)).to.emit(e, "DealDisputed").withArgs(x.id, f.client.address);
    });
    it("виграв замовник: отримує залишок і депозит виконавця", async () => {
      const x = await disputed();
      await expect(e.connect(f.arbiter).resolveDispute(x.id, 100)).to.emit(e, "DisputeResolved").withArgs(x.id, 100);
      expect(await e.pendingWithdrawal(f.client.address)).to.equal(x.total + 2n * x.dep);
      expect(await e.pendingWithdrawal(f.freelancer.address)).to.equal(0);
      expect((await f.sbt.stats(f.freelancer.address))[2]).to.equal(1);
    });
    it("виграв виконавець: отримує залишок і депозит замовника", async () => {
      const x = await disputed();
      await e.connect(f.arbiter).resolveDispute(x.id, 0);
      expect(await e.pendingWithdrawal(f.freelancer.address)).to.equal(x.total + 2n * x.dep);
      expect((await f.sbt.stats(f.client.address))[2]).to.equal(1);
    });
    it("рівний розподіл 50/50 повертає депозити власникам", async () => {
      const x = await disputed();
      await e.connect(f.arbiter).resolveDispute(x.id, 50);
      expect(await e.pendingWithdrawal(f.client.address)).to.equal(x.total / 2n + x.dep);
      expect(await e.pendingWithdrawal(f.freelancer.address)).to.equal(x.total / 2n + x.dep);
    });
    it("рішення лише від арбітра, у межах 0..100 і лише для спору", async () => {
      const x = await disputed();
      await expect(e.connect(f.outsider).resolveDispute(x.id, 50)).to.be.revertedWithCustomError(e, "AccessControlUnauthorizedAccount");
      await rev(e.connect(f.arbiter).resolveDispute(x.id, 101), "InvalidInput");
      await e.connect(f.arbiter).resolveDispute(x.id, 50);
      await rev(e.connect(f.arbiter).resolveDispute(x.id, 50), "WrongState", S.Resolved);
    });
  });

  describe("виплати, пауза, безпека", () => {
    it("withdraw виплачує баланс і не дозволяє повтору", async () => {
      const x = await funded(f); await e.connect(f.client).cancelDeal(x.id);
      const tx = e.connect(f.client).withdraw();
      await expect(tx).to.changeEtherBalance(f.client, x.total + x.dep);
      await expect(tx).to.emit(e, "Withdrawn").withArgs(f.client.address, x.total + x.dep);
      await rev(e.connect(f.client).withdraw(), "NothingToWithdraw");
    });
    it("повторний вхід у withdraw неможливий (захист ReentrancyGuard + pull)", async () => {
      const A = await (await ethers.getContractFactory("ReenterAttacker")).deploy(await e.getAddress());
      const addr = await A.getAddress();
      const call = (fn, args, value = 0n) => A.exec(await_e(), value, e.interface.encodeFunctionData(fn, args), { value });
      const await_e = () => e.target;
      await call("proposeDeal", [f.freelancer.address, [E(1)], [3], SPEC]);
      const id = Number(await e.dealCount()); await withRisk(f, id);
      const dep = E(1) * 1100n / 10000n;
      await call("fundDeal", [id], E(1) + dep);
      await call("cancelDeal", [id]);
      expect(await e.pendingWithdrawal(addr)).to.equal(E(1) + dep);
      await expect(call("withdraw", [])).to.be.revertedWith("exec failed"); // внутрішній виклик відхилено ReentrancyGuard, виплата відкотилася
      expect(await e.pendingWithdrawal(addr)).to.equal(E(1) + dep); // стан відкотився, кошти не вкрадено
      expect(await ethers.provider.getBalance(await e.getAddress())).to.equal(E(1) + dep);
    });
    it("пауза блокує зміни стану, але withdraw працює", async () => {
      const x = await funded(f); await e.connect(f.client).cancelDeal(x.id);
      await e.pause();
      await expect(e.connect(f.client).proposeDeal(f.freelancer.address, [E(1)], [1], SPEC)).to.be.revertedWithCustomError(e, "EnforcedPause");
      await expect(e.connect(f.client).withdraw()).to.emit(e, "Withdrawn");
      await e.unpause();
      await propose(f);
    });
    it("pause/unpause лише для адміністратора", async () => {
      await expect(e.connect(f.outsider).pause()).to.be.revertedWithCustomError(e, "AccessControlUnauthorizedAccount");
    });
    it("конструктор відхиляє нульові адреси", async () => {
      const F = await ethers.getContractFactory("Escrow");
      await rev(F.deploy(ethers.ZeroAddress, f.other.address, f.other.address), "InvalidInput");
    });
  });
});
