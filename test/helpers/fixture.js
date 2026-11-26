const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (x) => ethers.parseEther(String(x));
const DAY = 24 * 3600;
const MV = ethers.keccak256(ethers.toUtf8Bytes("model-v1"));
const IH = ethers.keccak256(ethers.toUtf8Bytes("features-1"));
const SPEC = ethers.keccak256(ethers.toUtf8Bytes("ТЗ: зробити сайт"));
const S = { None: 0, Proposed: 1, Funded: 2, InProgress: 3, Disputed: 4, Completed: 5, Cancelled: 6, Resolved: 7 };
const MS = { Pending: 0, Submitted: 1, Approved: 2, Rejected: 3 };

async function deployAll() {
  const [admin, oracleSigner, client, freelancer, arbiter, outsider, other] = await ethers.getSigners();
  const oracle = await (await ethers.getContractFactory("RiskOracle")).deploy(admin.address, oracleSigner.address);
  await oracle.registerModel(MV, "ml/model/model_card.md");
  const sbt = await (await ethers.getContractFactory("ReputationSBT")).deploy(admin.address);
  const escrow = await (await ethers.getContractFactory("Escrow")).deploy(
    admin.address, await oracle.getAddress(), await sbt.getAddress());
  await sbt.grantRole(await sbt.ESCROW_ROLE(), await escrow.getAddress());
  await escrow.grantRole(await escrow.ARBITER_ROLE(), arbiter.address);
  return { admin, oracleSigner, client, freelancer, arbiter, outsider, other, oracle, sbt, escrow };
}

/** Угода з двома етапами по 1 і 2 ETH, строки 7 і 14 днів. */
async function propose(f, amounts = [E(1), E(2)], days = [7, 14]) {
  await f.escrow.connect(f.client).proposeDeal(f.freelancer.address, amounts, days, SPEC);
  return Number(await f.escrow.dealCount());
}
async function withRisk(f, id, risk = 5000) {
  await f.oracle.connect(f.oracleSigner).submitRisk(id, risk, MV, IH);
}
async function deposit(f, id) {
  const d = await f.escrow.getDeal(id);
  const r = await f.oracle.getRisk(id);
  const bps = await f.oracle.depositBps(r.riskBps);
  return (d.total * bps) / 10000n;
}
async function funded(f, risk = 5000) {
  const id = await propose(f);
  await withRisk(f, id, risk);
  const dep = await deposit(f, id);
  const d = await f.escrow.getDeal(id);
  await f.escrow.connect(f.client).fundDeal(id, { value: d.total + dep });
  return { id, dep, total: d.total };
}
async function inProgress(f, risk = 5000) {
  const x = await funded(f, risk);
  await f.escrow.connect(f.freelancer).acceptDeal(x.id, { value: x.dep });
  return x;
}
module.exports = { E, DAY, MV, IH, SPEC, S, MS, time, ethers, deployAll, propose, withRisk, deposit, funded, inProgress };
