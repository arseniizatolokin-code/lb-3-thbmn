const fs = require("fs");
const { ethers, network } = require("hardhat");
const E = (x) => ethers.parseEther(String(x));
async function load() {
  const d = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const s = await ethers.getSigners();
  return {
    d, admin: s[0], oracleSigner: s[1], client: s[2], freelancer: s[3], arbiter: s[4],
    oracle: await ethers.getContractAt("RiskOracle", d.RiskOracle),
    sbt: await ethers.getContractAt("ReputationSBT", d.ReputationSBT),
    escrow: await ethers.getContractAt("Escrow", d.Escrow),
  };
}
/** «Модель-заглушка»: детермінований ризик 1000..8000 з хешу параметрів угоди. Замінюється справжнім сервісом у ЛР 3. */
function stubRisk(deal) {
  const h = BigInt(ethers.keccak256(ethers.solidityPacked(["address", "address", "uint128"], [deal.client, deal.freelancer, deal.total])));
  return Number(1000n + (h % 7001n));
}
module.exports = { load, E, stubRisk };
