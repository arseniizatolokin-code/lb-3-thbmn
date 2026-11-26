// Розгортання: RiskOracle, ReputationSBT, Escrow + видача ролей. Адреси зберігаються в deployments/<мережа>.json.
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia      (потрібен .env)
const fs = require("fs");
const { ethers, network } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const oracleAddr = process.env.ORACLE_ADDRESS || (signers[1] || admin).address;
  const arbiterAddr = process.env.ARBITER_ADDRESS || (signers[4] || admin).address;
  console.log(`Мережа: ${network.name}, адміністратор: ${admin.address}`);
  const deploy = async (name, args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    console.log(`  ${name.padEnd(14)} ${await c.getAddress()}`);
    return c;
  };
  const oracle = await deploy("RiskOracle", [admin.address, oracleAddr]);
  const sbt = await deploy("ReputationSBT", [admin.address]);
  const escrow = await deploy("Escrow", [admin.address, await oracle.getAddress(), await sbt.getAddress()]);
  await (await sbt.grantRole(await sbt.ESCROW_ROLE(), await escrow.getAddress())).wait();
  await (await escrow.grantRole(await escrow.ARBITER_ROLE(), arbiterAddr)).wait();
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    admin: admin.address, oracleSigner: oracleAddr, arbiter: arbiterAddr,
    RiskOracle: await oracle.getAddress(), ReputationSBT: await sbt.getAddress(), Escrow: await escrow.getAddress(),
  };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/${network.name}.json`, JSON.stringify(out, null, 2));
  console.log(`Записано deployments/${network.name}.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
