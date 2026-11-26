const { expect } = require("chai");
const { deployAll } = require("./helpers/fixture");

describe("ReputationSBT", () => {
  let f, sbt;
  beforeEach(async () => {
    f = await deployAll(); sbt = f.sbt;
    await sbt.grantRole(await sbt.ESCROW_ROLE(), f.other.address); // «Escrow» для прямих викликів
  });

  it("recordOutcome випускає токен і оновлює статистику", async () => {
    await expect(sbt.connect(f.other).recordOutcome(f.client.address, true, true))
      .to.emit(sbt, "ReputationUpdated").withArgs(f.client.address, 1, 1, 1);
    expect(await sbt.ownerOf(1)).to.equal(f.client.address);
    const s = await sbt.stats(f.client.address);
    expect([s[0], s[1], s[2]]).to.deep.equal([1n, 1n, 1n]);
  });
  it("видає подію Locked (ERC-5192) при випуску", async () => {
    await expect(sbt.connect(f.other).mintIfAbsent(f.client.address)).to.emit(sbt, "Locked").withArgs(1);
  });
  it("не випускає другий токен тій самій адресі", async () => {
    await sbt.connect(f.other).mintIfAbsent(f.client.address);
    await sbt.connect(f.other).mintIfAbsent(f.client.address);
    expect(await sbt.balanceOf(f.client.address)).to.equal(1);
  });
  it("відхиляє виклики без ESCROW_ROLE", async () => {
    await expect(sbt.connect(f.outsider).recordOutcome(f.client.address, false, false))
      .to.be.revertedWithCustomError(sbt, "AccessControlUnauthorizedAccount");
    await expect(sbt.connect(f.outsider).mintIfAbsent(f.client.address))
      .to.be.revertedWithCustomError(sbt, "AccessControlUnauthorizedAccount");
  });
  it("забороняє передачу токена (transferFrom і safeTransferFrom)", async () => {
    await sbt.connect(f.other).mintIfAbsent(f.client.address);
    await expect(sbt.connect(f.client).transferFrom(f.client.address, f.outsider.address, 1))
      .to.be.revertedWithCustomError(sbt, "SoulboundTransfer");
    await expect(sbt.connect(f.client)["safeTransferFrom(address,address,uint256)"](f.client.address, f.outsider.address, 1))
      .to.be.revertedWithCustomError(sbt, "SoulboundTransfer");
  });
  it("locked() повертає true для існуючого токена й відхиляє неіснуючий", async () => {
    await sbt.connect(f.other).mintIfAbsent(f.client.address);
    expect(await sbt.locked(1)).to.equal(true);
    await expect(sbt.locked(99)).to.be.revertedWithCustomError(sbt, "ERC721NonexistentToken");
  });
  it("підтримує інтерфейс ERC-5192 та ERC-721", async () => {
    expect(await sbt.supportsInterface("0xb45a3c0e")).to.equal(true);
    expect(await sbt.supportsInterface("0x80ac58cd")).to.equal(true);
  });
  it("накопичує статистику за кількома угодами", async () => {
    await sbt.connect(f.other).recordOutcome(f.client.address, false, false);
    await sbt.connect(f.other).recordOutcome(f.client.address, true, false);
    const s = await sbt.stats(f.client.address);
    expect([s[0], s[1], s[2]]).to.deep.equal([2n, 1n, 0n]);
  });
});
