import { formatEther } from "ethers";

/**
 * Presentation arithmetic, kept apart from the DOM so it can be tested directly.
 *
 * Everything here works in wei as bigint and only becomes a string at the edge. The
 * settlement figures are the point of the whole interface, so rounding them early —
 * or through a float — would undercut the one number the page exists to show.
 */

/** ETH, trimmed of trailing zeros, with a floor so tiny amounts do not render as "0". */
export function formatEth(wei: bigint, maxDecimals = 6): string {
  const [whole = "0", fraction = ""] = formatEther(wei).split(".");

  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  if (trimmed.length > 0) return `${whole}.${trimmed}`;

  // Nothing survived the cut. Either the amount is whole, or its entire value sits
  // below the places shown — and rendering something non-zero as "0" is the one thing
  // a payment interface must never do.
  if (whole !== "0") return whole;
  return /[1-9]/.test(fraction) ? `<0.${"0".repeat(maxDecimals - 1)}1` : "0";
}

export interface Settlement {
  escrowedWei: bigint;
  costWei: bigint;
  refundWei: bigint;
}

export interface SettlementShares {
  /** Share of the escrow that was actually charged, 0-100. */
  paidPercent: number;
  /** Share of the escrow that came back, 0-100. */
  refundPercent: number;
}

/**
 * Split an escrow into the part that was charged and the part that came back.
 *
 * Computed in basis points against the escrow so the two shares always sum to 100 and
 * the bar can never render a sliver of empty space that the numbers do not explain.
 */
export function settlementShares({ escrowedWei, costWei }: Settlement): SettlementShares {
  if (escrowedWei <= 0n) return { paidPercent: 0, refundPercent: 0 };

  const clampedCost = costWei < 0n ? 0n : costWei > escrowedWei ? escrowedWei : costWei;
  const paidBps = (clampedCost * 10_000n) / escrowedWei;
  const paidPercent = Number(paidBps) / 100;
  return { paidPercent, refundPercent: 100 - paidPercent };
}

/** Fraction of a token budget that was used, 0-100. */
export function usageShare(used: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  return Math.min(100, (used / ceiling) * 100);
}

/** `0x1234…9abc` — enough to compare two hashes by eye, short enough to sit inline. */
export function shortHex(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
