import { describe, expect, it } from "vitest";
import { parseEther } from "ethers";
import { formatEth, settlementShares, shortHex, usageShare } from "../src/money";
import { redemptionMessage } from "../src/wallet";

describe("formatEth", () => {
  it("trims trailing zeros", () => {
    expect(formatEth(parseEther("1.5000"))).toBe("1.5");
    expect(formatEth(parseEther("2"))).toBe("2");
  });

  it("does not round a non-zero amount down to zero", () => {
    // One wei is far below six decimal places. Rendering it as "0" would say the buyer
    // paid nothing, which is the one thing a payment interface must never do.
    expect(formatEth(1n)).toBe("<0.000001");
    expect(formatEth(0n)).toBe("0");
  });

  it("does not mistake a whole amount for a hidden one", () => {
    // "2.0" trims to nothing, the same as a sub-threshold amount does. Only the second
    // of these is actually being hidden.
    expect(formatEth(parseEther("2"))).toBe("2");
    expect(formatEth(parseEther("2.0000000001"))).toBe("2");
  });

  it("keeps small per-token rates legible at higher precision", () => {
    expect(formatEth(parseEther("0.000000004"), 9)).toBe("0.000000004");
  });
});

describe("settlementShares", () => {
  it("splits an escrow into what was charged and what came back", () => {
    const shares = settlementShares({
      escrowedWei: parseEther("1"),
      costWei: parseEther("0.25"),
      refundWei: parseEther("0.75"),
    });
    expect(shares.paidPercent).toBeCloseTo(25);
    expect(shares.refundPercent).toBeCloseTo(75);
  });

  it("always sums to 100 so the bar has no unexplained gap", () => {
    const escrowedWei = 3n;
    const costWei = 1n; // 33.33…%, which cannot be represented exactly
    const { paidPercent, refundPercent } = settlementShares({
      escrowedWei,
      costWei,
      refundWei: escrowedWei - costWei,
    });
    expect(paidPercent + refundPercent).toBe(100);
  });

  it("clamps a cost that exceeds the escrow instead of overflowing the bar", () => {
    // The contract reverts before this can happen. If it ever did, the interface should
    // show a full bar rather than one that runs off the end of its container.
    const shares = settlementShares({
      escrowedWei: parseEther("1"),
      costWei: parseEther("2"),
      refundWei: 0n,
    });
    expect(shares.paidPercent).toBe(100);
    expect(shares.refundPercent).toBe(0);
  });

  it("handles a zero escrow without dividing by zero", () => {
    expect(settlementShares({ escrowedWei: 0n, costWei: 0n, refundWei: 0n })).toEqual({
      paidPercent: 0,
      refundPercent: 0,
    });
  });
});

describe("usageShare", () => {
  it("reports the fraction of the output budget used", () => {
    expect(usageShare(300, 1200)).toBe(25);
  });

  it("never exceeds the budget it is drawn against", () => {
    expect(usageShare(2000, 1200)).toBe(100);
    expect(usageShare(10, 0)).toBe(0);
  });
});

describe("shortHex", () => {
  it("keeps enough of a hash to compare two by eye", () => {
    expect(shortHex("0x1234567890abcdef1234567890abcdef")).toBe("0x1234…cdef");
  });

  it("leaves short values alone", () => {
    expect(shortHex("0x1234")).toBe("0x1234");
  });
});

describe("redemptionMessage", () => {
  /**
   * Pinned deliberately. The server builds this string independently in
   * `packages/server/src/app.ts` and rejects any signature that does not verify against
   * its own copy, so the two must stay byte-identical. A matching test lives there; if
   * either side is edited alone, one of them fails.
   */
  it("matches the exact text the server verifies against", () => {
    const message = redemptionMessage(
      "0xabc123",
      "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    );
    expect(message).toBe(
      "Tollgate: redeem call\ncall: 0xabc123\ncontract: 0x5FbDB2315678afecb367f032d93F642f64180aa3",
    );
  });

  it("checksums the contract address so case cannot change the signature", () => {
    const lower = redemptionMessage("0xa", "0x5fbdb2315678afecb367f032d93f642f64180aa3");
    const upper = redemptionMessage("0xa", "0x5FBDB2315678AFECB367F032D93F642F64180AA3");
    expect(lower).toBe(upper);
  });
});
