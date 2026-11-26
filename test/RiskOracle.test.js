const { expect } = require("chai");
const { deployAll, MV, IH } = require("./helpers/fixture");

describe("RiskOracle", () => {
  let f;
  beforeEach(async () => { f = await deployAll(); });

  it("призначає ролі й адресу оракула при розгортанні", async () => {
    expect(await f.oracle.oracle()).to.equal(f.oracleSigner.address);
    expect(await f.oracle.hasRole(await f.oracle.ORACLE_ROLE(), f.oracleSigner.address)).to.equal(true);
    expect(await f.oracle.hasRole(await f.oracle.DEFAULT_ADMIN_ROLE(), f.admin.address)).to.equal(true);
  });
  it("submitRisk зберігає ризик, версію моделі, хеш даних і час та видає подію", async () => {
    await expect(f.oracle.connect(f.oracleSigner).submitRisk(1, 4200, MV, IH))
      .to.emit(f.oracle, "RiskSubmitted").withArgs(1, 4200, MV, IH);
    const r = await f.oracle.getRisk(1);
    expect(r.riskBps).to.equal(4200); expect(r.modelVersion).to.equal(MV);
    expect(r.inputHash).to.equal(IH); expect(r.submittedAt).to.be.gt(0);
  });
  it("відхиляє виклик без ролі оракула", async () => {
    await expect(f.oracle.connect(f.outsider).submitRisk(1, 100, MV, IH))
      .to.be.revertedWithCustomError(f.oracle, "AccessControlUnauthorizedAccount");
  });
  it("відхиляє ризик понад 10000", async () => {
    await expect(f.oracle.connect(f.oracleSigner).submitRisk(1, 10001, MV, IH))
      .to.be.revertedWithCustomError(f.oracle, "RiskOutOfRange").withArgs(10001);
  });
  it("приймає межові значення 0 і 10000", async () => {
    await f.oracle.connect(f.oracleSigner).submitRisk(1, 0, MV, IH);
    await f.oracle.connect(f.oracleSigner).submitRisk(2, 10000, MV, IH);
    expect((await f.oracle.getRisk(2)).riskBps).to.equal(10000);
  });
  it("не дозволяє повторну оцінку для тієї самої угоди", async () => {
    await f.oracle.connect(f.oracleSigner).submitRisk(1, 100, MV, IH);
    await expect(f.oracle.connect(f.oracleSigner).submitRisk(1, 200, MV, IH))
      .to.be.revertedWithCustomError(f.oracle, "ReportAlreadyExists").withArgs(1);
  });
  it("replaceOracle передає роль новій адресі та видає подію", async () => {
    await expect(f.oracle.replaceOracle(f.other.address))
      .to.emit(f.oracle, "OracleReplaced").withArgs(f.oracleSigner.address, f.other.address);
    await expect(f.oracle.connect(f.oracleSigner).submitRisk(1, 1, MV, IH))
      .to.be.revertedWithCustomError(f.oracle, "AccessControlUnauthorizedAccount");
    await f.oracle.connect(f.other).submitRisk(1, 1, MV, IH);
    expect(await f.oracle.oracle()).to.equal(f.other.address);
  });
  it("replaceOracle доступна лише адміністратору й не приймає нульову адресу", async () => {
    await expect(f.oracle.connect(f.outsider).replaceOracle(f.other.address))
      .to.be.revertedWithCustomError(f.oracle, "AccessControlUnauthorizedAccount");
    await expect(f.oracle.replaceOracle("0x0000000000000000000000000000000000000000"))
      .to.be.revertedWithCustomError(f.oracle, "ZeroAddress");
  });
  it("пауза блокує подання оцінок, зняття паузи відновлює", async () => {
    await f.oracle.pause();
    await expect(f.oracle.connect(f.oracleSigner).submitRisk(1, 1, MV, IH))
      .to.be.revertedWithCustomError(f.oracle, "EnforcedPause");
    await f.oracle.unpause();
    await f.oracle.connect(f.oracleSigner).submitRisk(1, 1, MV, IH);
  });
  it("депозит залежить від ризику: 2 % — 11 % — 20 %", async () => {
    expect(await f.oracle.depositBps(0)).to.equal(200);
    expect(await f.oracle.depositBps(5000)).to.equal(1100);
    expect(await f.oracle.depositBps(10000)).to.equal(2000);
  });
  it("конструктор відхиляє нульові адреси", async () => {
    const F = await (await require("hardhat").ethers.getContractFactory("RiskOracle"));
    await expect(F.deploy("0x0000000000000000000000000000000000000000", f.other.address))
      .to.be.revertedWithCustomError(f.oracle, "ZeroAddress");
  });
});

describe("RiskOracle: реєстр версій моделі (ЛР3)", () => {
  const { ethers } = require("hardhat");
  const { expect } = require("chai");
  const { deployAll, propose, MV, IH } = require("./helpers/fixture");

  it("registerModel записує час і видає подію; повторна реєстрація відхиляється", async () => {
    const f = await deployAll();
    const v = ethers.keccak256(ethers.toUtf8Bytes("model-v2"));
    await expect(f.oracle.registerModel(v, "card.md")).to.emit(f.oracle, "ModelRegistered").withArgs(v, "card.md");
    expect(await f.oracle.modelRegisteredAt(v)).to.be.gt(0n);
    await expect(f.oracle.registerModel(v, "card.md")).to.be.revertedWithCustomError(f.oracle, "ModelAlreadyRegistered");
  });

  it("registerModel доступна лише адміністратору", async () => {
    const f = await deployAll();
    const v = ethers.keccak256(ethers.toUtf8Bytes("model-v3"));
    await expect(f.oracle.connect(f.outsider).registerModel(v, "x")).to.be.reverted;
    await expect(f.oracle.connect(f.oracleSigner).registerModel(v, "x")).to.be.reverted;
  });

  it("submitRisk з незареєстрованою версією моделі відхиляється", async () => {
    const f = await deployAll();
    const id = await propose(f);
    const bad = ethers.keccak256(ethers.toUtf8Bytes("unknown-model"));
    await expect(f.oracle.connect(f.oracleSigner).submitRisk(id, 1000, bad, IH))
      .to.be.revertedWithCustomError(f.oracle, "UnknownModel").withArgs(bad);
    await f.oracle.connect(f.oracleSigner).submitRisk(id, 1000, MV, IH);
  });
});
