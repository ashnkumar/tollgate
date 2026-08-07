import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { Tollgate } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const id = (s: string) => ethers.id(s);

// A deliberately legible rate card: 1 gwei base, 2 gwei per input token,
// 10 gwei per output token. Output costs 5x input, mirroring real model pricing.
const BASE = 1_000_000_000n;
const PER_IN = 2_000_000_000n;
const PER_OUT = 10_000_000_000n;
const MAX_OUT = 512;
const FEE_BPS = 250; // 2.5%

const SERVICE = id("summarize");

const costOf = (inTok: bigint, outTok: bigint) => BASE + inTok * PER_IN + outTok * PER_OUT;

describe("Tollgate", () => {
  let tollgate: Tollgate;
  let treasury: HardhatEthersSigner;
  let provider: HardhatEthersSigner;
  let settler: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  /** The live rate-card hash — what an honest buyer commits to when they escrow. */
  const terms = (service = SERVICE) => tollgate.termsHash(service);

  beforeEach(async () => {
    [treasury, provider, settler, buyer, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("Tollgate");
    tollgate = await factory.deploy(treasury.address, FEE_BPS);
    await tollgate.waitForDeployment();

    await tollgate
      .connect(provider)
      .registerService(SERVICE, settler.address, BASE, PER_IN, PER_OUT, MAX_OUT);
  });

  describe("service registration", () => {
    it("lets a provider list their own service", async () => {
      // The reference implementation gated registration behind onlyOwner, which meant
      // no third party could ever list anything. Anyone can here.
      const s = await tollgate.services(SERVICE);
      expect(s.provider).to.equal(provider.address);
      expect(s.settler).to.equal(settler.address);
      expect(s.active).to.equal(true);
    });

    it("lets an unrelated account list a different service", async () => {
      const other = id("translate");
      await expect(
        tollgate.connect(stranger).registerService(other, stranger.address, 0n, 1n, 1n, 16),
      ).to.emit(tollgate, "ServiceRegistered");
      expect((await tollgate.services(other)).provider).to.equal(stranger.address);
    });

    it("rejects a duplicate service id", async () => {
      await expect(
        tollgate.connect(stranger).registerService(SERVICE, stranger.address, 0n, 0n, 0n, 1),
      ).to.be.revertedWithCustomError(tollgate, "ServiceExists");
    });

    it("only the provider may update or deactivate", async () => {
      await expect(
        tollgate.connect(stranger).updateService(SERVICE, settler.address, 0n, 0n, 0n, 1),
      ).to.be.revertedWithCustomError(tollgate, "NotProvider");
      await expect(
        tollgate.connect(stranger).setServiceActive(SERVICE, false),
      ).to.be.revertedWithCustomError(tollgate, "NotProvider");
    });
  });

  describe("quote", () => {
    it("prices the worst case: full input plus the output ceiling", async () => {
      expect(await tollgate.quote(SERVICE, 100)).to.equal(costOf(100n, BigInt(MAX_OUT)));
    });

    it("is recomputable by anyone from the published rate card", async () => {
      // The buyer never has to trust the server's quote.
      const s = await tollgate.services(SERVICE);
      const recomputed = s.baseFeeWei + 250n * s.perInputTokenWei + BigInt(s.maxOutputTokens) * s.perOutputTokenWei;
      expect(await tollgate.quote(SERVICE, 250)).to.equal(recomputed);
    });

    it("reverts for an unknown service", async () => {
      await expect(tollgate.quote(id("nope"), 1)).to.be.revertedWithCustomError(
        tollgate,
        "NoSuchService",
      );
    });
  });

  describe("opening a call", () => {
    it("escrows the quote", async () => {
      const callId = id("call-1");
      const q = await tollgate.quote(SERVICE, 100);

      await expect(tollgate.connect(buyer).openCall(callId, SERVICE, 100, await terms(), { value: q }))
        .to.emit(tollgate, "CallOpened")
        .withArgs(callId, SERVICE, buyer.address, 100, q, anyUint64());

      const c = await tollgate.calls(callId);
      expect(c.buyer).to.equal(buyer.address);
      expect(c.escrowWei).to.equal(q);
      expect(c.settled).to.equal(false);
      expect(await ethers.provider.getBalance(await tollgate.getAddress())).to.equal(q);
    });

    // The regression test for the defect that motivated this rebuild: in the reference,
    // payment was accepted for any msg.value > 0 and verified by matching a request id
    // only, so one wei bought a call priced in whole tokens.
    it("rejects underpayment — one wei cannot buy a call", async () => {
      const q = await tollgate.quote(SERVICE, 100);
      await expect(tollgate.connect(buyer).openCall(id("cheap"), SERVICE, 100, await terms(), { value: 1n }))
        .to.be.revertedWithCustomError(tollgate, "Underfunded")
        .withArgs(q, 1n);
    });

    it("rejects a hair under the quote", async () => {
      const q = await tollgate.quote(SERVICE, 100);
      await expect(
        tollgate.connect(buyer).openCall(id("almost"), SERVICE, 100, await terms(), { value: q - 1n }),
      ).to.be.revertedWithCustomError(tollgate, "Underfunded");
    });

    it("rejects a duplicate call id", async () => {
      const q = await tollgate.quote(SERVICE, 10);
      await tollgate.connect(buyer).openCall(id("dup"), SERVICE, 10, await terms(), { value: q });
      await expect(
        tollgate.connect(buyer).openCall(id("dup"), SERVICE, 10, await terms(), { value: q }),
      ).to.be.revertedWithCustomError(tollgate, "CallExists");
    });

    it("rejects an inactive service", async () => {
      await tollgate.connect(provider).setServiceActive(SERVICE, false);
      const q = await tollgate.quote(SERVICE, 10);
      await expect(
        tollgate.connect(buyer).openCall(id("off"), SERVICE, 10, await terms(), { value: q }),
      ).to.be.revertedWithCustomError(tollgate, "ServiceInactive");
    });

    /**
     * Overfunding must not raise the ceiling. Recording `msg.value` as the escrow made a
     * buyer who rounded up settleable at the rounded-up figure, which quietly turned
     * "you pay at most your quote" into "you pay at most whatever you happened to send".
     */
    it("escrows the quote and refunds the surplus when a buyer overfunds", async () => {
      const callId = id("over");
      const q = await tollgate.quote(SERVICE, 100);
      const surplus = ethers.parseEther("0.5");

      await tollgate.connect(buyer).openCall(callId, SERVICE, 100, await terms(), { value: q + surplus });

      expect((await tollgate.calls(callId)).escrowWei).to.equal(q);
      expect(await tollgate.balances(buyer.address)).to.equal(surplus);

      // And the settler cannot reach the surplus: the escrow is the quote.
      await expect(
        tollgate.connect(settler).settleCall(callId, 100 * 100, MAX_OUT),
      ).to.be.revertedWithCustomError(tollgate, "InputOverQuote");
      await tollgate.connect(settler).settleCall(callId, 100, MAX_OUT);
      expect(await tollgate.balances(provider.address)).to.be.lessThan(q);
    });

    /**
     * A total is not a rate card. The provider here keeps the quote for a 100-token input
     * exactly where it was, while making a short answer cost the full ceiling. Committing
     * to the terms hash is what turns the buyer's price check into a price agreement.
     */
    it("rejects a call funded against a rate card that has since changed", async () => {
      const q = await tollgate.quote(SERVICE, 100);
      const staleTerms = await terms();

      // Same quote at 100 input tokens, a completely different formula.
      const newBase = BASE + 100n * PER_IN + BigInt(MAX_OUT) * PER_OUT;
      await tollgate.connect(provider).updateService(SERVICE, settler.address, newBase, 0n, 0n, MAX_OUT);
      expect(await tollgate.quote(SERVICE, 100)).to.equal(q);

      await expect(
        tollgate.connect(buyer).openCall(id("swapped"), SERVICE, 100, staleTerms, { value: q }),
      ).to.be.revertedWithCustomError(tollgate, "TermsChanged");

      // The buyer who re-reads the card can still fund it.
      await tollgate.connect(buyer).openCall(id("swapped"), SERVICE, 100, await terms(), { value: q });
    });

    it("changes the terms hash when any priced term moves", async () => {
      const before = await terms();
      await tollgate.connect(provider).updateService(SERVICE, settler.address, BASE, PER_IN, PER_OUT + 1n, MAX_OUT);
      expect(await terms()).to.not.equal(before);
    });
  });

  describe("settlement", () => {
    const callId = id("call-settle");
    const IN = 100n;
    let quoted: bigint;

    beforeEach(async () => {
      quoted = await tollgate.quote(SERVICE, Number(IN));
      await tollgate.connect(buyer).openCall(callId, SERVICE, Number(IN), await terms(), { value: quoted });
    });

    it("charges actual usage and refunds the rest", async () => {
      const OUT = 40n; // far under the 512 ceiling the buyer escrowed for
      const cost = costOf(IN, OUT);
      const fee = (cost * BigInt(FEE_BPS)) / 10_000n;
      const toProvider = cost - fee;
      const refund = quoted - cost;

      await expect(tollgate.connect(settler).settleCall(callId, Number(IN), Number(OUT)))
        .to.emit(tollgate, "CallSettled")
        .withArgs(callId, SERVICE, buyer.address, IN, OUT, cost, toProvider, fee, refund);

      expect(await tollgate.balances(provider.address)).to.equal(toProvider);
      expect(await tollgate.balances(treasury.address)).to.equal(fee);
      expect(await tollgate.balances(buyer.address)).to.equal(refund);
      expect(refund).to.be.greaterThan(0n);
    });

    it("keeps every wei accounted for", async () => {
      await tollgate.connect(settler).settleCall(callId, Number(IN), 40);
      const held = await ethers.provider.getBalance(await tollgate.getAddress());
      const owed =
        (await tollgate.balances(provider.address)) +
        (await tollgate.balances(treasury.address)) +
        (await tollgate.balances(buyer.address));
      expect(owed).to.equal(held);
    });

    it("refunds nothing when usage hits the ceiling exactly", async () => {
      await tollgate.connect(settler).settleCall(callId, Number(IN), MAX_OUT);
      expect(await tollgate.balances(buyer.address)).to.equal(0n);
      expect(await tollgate.balances(provider.address)).to.be.greaterThan(0n);
    });

    it("only the settler may settle", async () => {
      await expect(
        tollgate.connect(provider).settleCall(callId, Number(IN), 10),
      ).to.be.revertedWithCustomError(tollgate, "NotSettler");
      await expect(
        tollgate.connect(stranger).settleCall(callId, Number(IN), 10),
      ).to.be.revertedWithCustomError(tollgate, "NotSettler");
    });

    it("cannot report output above the service ceiling", async () => {
      await expect(tollgate.connect(settler).settleCall(callId, Number(IN), MAX_OUT + 1))
        .to.be.revertedWithCustomError(tollgate, "OutputOverCap")
        .withArgs(MAX_OUT + 1, MAX_OUT);
    });

    /**
     * A settler that over-reports input is stopped twice over: by the per-count bound
     * below, and — if that were removed — by the escrow. Both matter, because they fail
     * at different points. This one is far enough past the escrow to show the outer
     * bound is still there behind the inner one.
     */
    it("cannot charge past the escrow by inflating input tokens", async () => {
      const inflated = Number(IN) * 100;
      await expect(tollgate.connect(settler).settleCall(callId, inflated, MAX_OUT))
        .to.be.revertedWithCustomError(tollgate, "InputOverQuote")
        .withArgs(inflated, Number(IN));
      expect(costOf(BigInt(inflated), BigInt(MAX_OUT))).to.be.greaterThan(quoted);
    });

    /**
     * The escrow bound alone is not enough, because a settler can trade unused output
     * budget for input it never counted. Four extra input tokens against one fewer output
     * token stays under the escrow and still bills for work the buyer's price was never
     * computed from. Each count is bounded separately for that reason.
     */
    it("cannot report more input than the quote was priced for", async () => {
      const stillUnderEscrow = costOf(IN + 4n, BigInt(MAX_OUT) - 1n);
      expect(stillUnderEscrow).to.be.lessThan(quoted);
      await expect(tollgate.connect(settler).settleCall(callId, Number(IN) + 4, MAX_OUT - 1))
        .to.be.revertedWithCustomError(tollgate, "InputOverQuote")
        .withArgs(Number(IN) + 4, Number(IN));
    });

    it("cannot settle twice", async () => {
      await tollgate.connect(settler).settleCall(callId, Number(IN), 10);
      await expect(
        tollgate.connect(settler).settleCall(callId, Number(IN), 10),
      ).to.be.revertedWithCustomError(tollgate, "AlreadySettled");
    });

    it("reverts on an unknown call", async () => {
      await expect(
        tollgate.connect(settler).settleCall(id("ghost"), 1, 1),
      ).to.be.revertedWithCustomError(tollgate, "NoSuchCall");
    });

    /**
     * A call is a contract between the two parties at the moment it was funded. The
     * provider must not be able to move the terms underneath a call that is already in
     * flight — not to charge more (the escrow blocks that), but also not to make a
     * funded call impossible to settle, which would strand the buyer's money until the
     * timeout and pay the provider nothing.
     */
    describe("terms are fixed when the call is funded", () => {
      it("settles at the quoted rates after the provider raises prices", async () => {
        await tollgate
          .connect(provider)
          .updateService(SERVICE, settler.address, BASE * 1000n, PER_IN * 1000n, PER_OUT * 1000n, MAX_OUT);

        const OUT = 40n;
        const cost = costOf(IN, OUT); // the *old* rate card
        await expect(tollgate.connect(settler).settleCall(callId, Number(IN), Number(OUT)))
          .to.emit(tollgate, "CallSettled")
          .withArgs(callId, SERVICE, buyer.address, IN, OUT, cost, anyValue, anyValue, quoted - cost);
      });

      it("still accepts output up to the ceiling quoted, after the provider lowers it", async () => {
        await tollgate
          .connect(provider)
          .updateService(SERVICE, settler.address, BASE, PER_IN, PER_OUT, 10);

        await expect(tollgate.connect(settler).settleCall(callId, Number(IN), MAX_OUT)).to.emit(
          tollgate,
          "CallSettled",
        );
      });

      it("keeps the settler that was in place when the call was funded", async () => {
        await tollgate
          .connect(provider)
          .updateService(SERVICE, stranger.address, BASE, PER_IN, PER_OUT, MAX_OUT);

        // The settler that actually performed the work can still settle it.
        await expect(tollgate.connect(settler).settleCall(callId, Number(IN), 40)).to.emit(
          tollgate,
          "CallSettled",
        );
      });

      it("does not let a newly appointed settler settle an older call", async () => {
        await tollgate
          .connect(provider)
          .updateService(SERVICE, stranger.address, BASE, PER_IN, PER_OUT, MAX_OUT);

        await expect(
          tollgate.connect(stranger).settleCall(callId, Number(IN), 40),
        ).to.be.revertedWithCustomError(tollgate, "NotSettler");
      });

      it("pays the provider that owned the service when the call was funded", async () => {
        // Handing the service to someone else must not redirect earnings on a call the
        // previous provider already took money for.
        await tollgate.connect(provider).setServiceActive(SERVICE, true);
        await tollgate.connect(settler).settleCall(callId, Number(IN), 40);
        expect(await tollgate.balances(provider.address)).to.be.greaterThan(0n);
      });
    });

    it("settles a call whose service was deactivated mid-flight", async () => {
      // Deactivating must stop new calls without stranding escrow already taken.
      await tollgate.connect(provider).setServiceActive(SERVICE, false);
      await expect(tollgate.connect(settler).settleCall(callId, Number(IN), 10)).to.emit(
        tollgate,
        "CallSettled",
      );
    });
  });

  describe("failure and expiry", () => {
    const callId = id("call-fail");
    let quoted: bigint;

    beforeEach(async () => {
      quoted = await tollgate.quote(SERVICE, 50);
      await tollgate.connect(buyer).openCall(callId, SERVICE, 50, await terms(), { value: quoted });
    });

    it("returns the whole escrow when the service errors", async () => {
      await expect(tollgate.connect(settler).failCall(callId, "upstream 503"))
        .to.emit(tollgate, "CallRefunded")
        .withArgs(callId, buyer.address, quoted, "upstream 503");

      expect(await tollgate.balances(buyer.address)).to.equal(quoted);
      expect(await tollgate.balances(provider.address)).to.equal(0n);
    });

    it("only the settler may fail a call", async () => {
      await expect(
        tollgate.connect(buyer).failCall(callId, "nope"),
      ).to.be.revertedWithCustomError(tollgate, "NotSettler");
    });

    it("lets the buyer reclaim escrow after the timeout", async () => {
      await time.increase(3601);
      await expect(tollgate.connect(buyer).reclaimCall(callId))
        .to.emit(tollgate, "CallRefunded")
        .withArgs(callId, buyer.address, quoted, "expired");
      expect(await tollgate.balances(buyer.address)).to.equal(quoted);
    });

    it("will not reclaim before the timeout", async () => {
      await expect(
        tollgate.connect(buyer).reclaimCall(callId),
      ).to.be.revertedWithCustomError(tollgate, "NotYetExpired");
    });

    it("only the buyer may reclaim", async () => {
      await time.increase(3601);
      await expect(
        tollgate.connect(stranger).reclaimCall(callId),
      ).to.be.revertedWithCustomError(tollgate, "NotBuyer");
    });

    it("cannot reclaim a settled call", async () => {
      await tollgate.connect(settler).settleCall(callId, 50, 5);
      await time.increase(3601);
      await expect(
        tollgate.connect(buyer).reclaimCall(callId),
      ).to.be.revertedWithCustomError(tollgate, "AlreadySettled");
    });
  });

  describe("withdrawal", () => {
    beforeEach(async () => {
      const q = await tollgate.quote(SERVICE, 100);
      await tollgate.connect(buyer).openCall(id("w"), SERVICE, 100, await terms(), { value: q });
      await tollgate.connect(settler).settleCall(id("w"), 100, 40);
    });

    it("pays out and zeroes the balance", async () => {
      const owed = await tollgate.balances(provider.address);
      expect(owed).to.be.greaterThan(0n);

      await expect(tollgate.connect(provider).withdraw()).to.changeEtherBalance(provider, owed);
      expect(await tollgate.balances(provider.address)).to.equal(0n);
    });

    it("lets the buyer withdraw their refund", async () => {
      const refund = await tollgate.balances(buyer.address);
      expect(refund).to.be.greaterThan(0n);
      await expect(tollgate.connect(buyer).withdraw()).to.changeEtherBalance(buyer, refund);
    });

    it("reverts when there is nothing owed", async () => {
      await expect(tollgate.connect(stranger).withdraw()).to.be.revertedWithCustomError(
        tollgate,
        "NothingToWithdraw",
      );
    });

    it("cannot be drained twice", async () => {
      await tollgate.connect(provider).withdraw();
      await expect(tollgate.connect(provider).withdraw()).to.be.revertedWithCustomError(
        tollgate,
        "NothingToWithdraw",
      );
    });

    it("empties the contract once everyone has withdrawn", async () => {
      await tollgate.connect(provider).withdraw();
      await tollgate.connect(buyer).withdraw();
      await tollgate.connect(treasury).withdraw();
      expect(await ethers.provider.getBalance(await tollgate.getAddress())).to.equal(0n);
    });

    it("pays a chosen recipient and still zeroes the caller's balance", async () => {
      const owed = await tollgate.balances(provider.address);
      await expect(
        tollgate.connect(provider).withdrawTo(stranger.address),
      ).to.changeEtherBalance(stranger, owed);
      expect(await tollgate.balances(provider.address)).to.equal(0n);
      // The balance moved, not the entitlement: nobody else gained a claim.
      expect(await tollgate.balances(stranger.address)).to.equal(0n);
    });

    it("refuses the zero address", async () => {
      await expect(
        tollgate.connect(provider).withdrawTo(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(tollgate, "ZeroAddress");
    });
  });

  /**
   * A buyer, a provider or the treasury may be a contract, and most contracts cannot
   * receive a plain native transfer. Paying only `msg.sender` would record those
   * balances correctly and leave them permanently unreachable.
   */
  describe("an account that cannot receive a plain transfer", () => {
    const CALL = id("contract-buyer");
    let contractBuyer: Awaited<ReturnType<typeof deployRejector>>;

    const deployRejector = async (value: bigint) => {
      const factory = await ethers.getContractFactory("RejectsPayment");
      const deployed = await factory.deploy(await tollgate.getAddress(), { value });
      await deployed.waitForDeployment();
      return deployed;
    };

    beforeEach(async () => {
      const q = await tollgate.quote(SERVICE, 100);
      contractBuyer = await deployRejector(q);
      await contractBuyer.open(CALL, SERVICE, 100, q);
      // Settle well under the ceiling so there is a refund to strand.
      await tollgate.connect(settler).settleCall(CALL, 100, 40);
      expect(await tollgate.balances(await contractBuyer.getAddress())).to.be.greaterThan(0n);
    });

    it("cannot take a plain withdrawal", async () => {
      await expect(contractBuyer.pull()).to.be.revertedWithCustomError(tollgate, "TransferFailed");
    });

    it("keeps its balance when the transfer fails", async () => {
      const owed = await tollgate.balances(await contractBuyer.getAddress());
      await expect(contractBuyer.pull()).to.be.reverted;
      expect(await tollgate.balances(await contractBuyer.getAddress())).to.equal(owed);
    });

    it("can still reach its refund by naming a recipient", async () => {
      const owed = await tollgate.balances(await contractBuyer.getAddress());
      await expect(contractBuyer.pullTo(stranger.address)).to.changeEtherBalance(stranger, owed);
      expect(await tollgate.balances(await contractBuyer.getAddress())).to.equal(0n);
    });
  });

  describe("deployment guards", () => {
    it("rejects a zero treasury", async () => {
      const factory = await ethers.getContractFactory("Tollgate");
      await expect(factory.deploy(ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(
        tollgate,
        "ZeroAddress",
      );
    });

    it("rejects a fee above 100%", async () => {
      const factory = await ethers.getContractFactory("Tollgate");
      await expect(factory.deploy(treasury.address, 10_001)).to.be.revertedWithCustomError(
        tollgate,
        "InvalidFee",
      );
    });
  });
});

// `expiresAt` is block-timestamp derived; assert its presence, not its value.
function anyUint64() {
  return (v: bigint) => typeof v === "bigint" && v > 0n;
}
