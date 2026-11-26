// Реєструє хеш файлу моделі в RiskOracle:  npx hardhat run scripts/register-model.js --network localhost
const fs = require("fs");
const { ethers, network } = require("hardhat");
async function main() {
  const d = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const meta = JSON.parse(fs.readFileSync("ml/model/meta.json", "utf8"));
  const oracle = await ethers.getContractAt("RiskOracle", d.RiskOracle);
  const v = "0x" + meta.sha256;
  if ((await oracle.modelRegisteredAt(v)) > 0n) return console.log("Версію вже зареєстровано:", v);
  const tx = await oracle.registerModel(v, "ml/model/model_card.md");
  await tx.wait();
  console.log("Зареєстровано версію моделі", v, "tx", tx.hash);
}
main().catch((e) => { console.error(e); process.exit(1); });
