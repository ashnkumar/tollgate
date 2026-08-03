/**
 * Drive the browser client's own modules against a running stack.
 *
 * The unit tests cover the arithmetic the page displays; this covers the part that
 * talks to a real chain and a real server — pricing a call independently of the server,
 * escrowing, signing, and pulling the refund back. It is the same code the page runs.
 * Only the DOM is missing.
 *
 * Run by `scripts/smoke.sh`. Standalone:
 *   pnpm --filter @tollgate/web exec tsx scripts/live-check.mts
 */
import { Wallet } from "ethers";
import { api } from "../src/api";
import { connect, redemptionMessage } from "../src/wallet";
import { formatEth, settlementShares, usageShare } from "../src/money";

const SERVER = process.env.SERVER_URL ?? "http://127.0.0.1:4000";
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

// The client uses same-origin relative paths because the server serves it. Node has no
// origin, so give those paths one.
const inner = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  inner(typeof input === "string" && input.startsWith("/") ? `${SERVER}${input}` : input, init)) as typeof fetch;

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) failures += 1;
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
}

/** Expect a request to be refused, and with the right status. */
async function refused(label: string, status: number, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt();
    check(label, false, "it was allowed");
  } catch (error) {
    check(label, (error as { status?: number }).status === status, `${status}`);
  }
}

const health = await api.health();
const buyer = await connect(RPC_URL, health.contract);
check("connected", buyer.address.startsWith("0x"), `buyer ${buyer.address} on chain ${buyer.chainId}`);

const { services } = await api.services();
const service = services.find((s) => s.registered && s.rateCard?.active);
if (!service) throw new Error("no active service is registered on-chain");

const quote = await api.quote(service.slug, service.demoInput);
const quoteWei = BigInt(quote.quoteWei);
check("quoted before running", quoteWei > 0n, `${formatEth(quoteWei)} ETH for ${quote.inputTokens} input tokens`);

// The buyer prices the call themselves. This is the reason the rate card lives on-chain.
const onChain = await buyer.quote(quote.serviceId, quote.inputTokens);
check("the chain agrees with the server", onChain === quoteWei, `${formatEth(onChain)} ETH`);

const walletBefore = await buyer.walletBalance();
const escrowHash = await buyer.openCall(quote.callId, quote.serviceId, quote.inputTokens, quoteWei);
check("escrow landed", escrowHash.startsWith("0x"));

const signature = await buyer.sign(quote.callId);
check("the redemption signature is well formed", signature.length === 132);

// The message the page builds must be the one the server verifies, or nothing redeems.
const stranger = await Wallet.createRandom().signMessage(
  redemptionMessage(quote.callId, health.contract),
);
await refused("a stranger's signature is refused", 403, () => api.run(quote.callId, stranger));

const result = await api.run(quote.callId, signature);
const escrowedWei = BigInt(result.settlement.escrowedWei);
const costWei = BigInt(result.settlement.costWei);
const refundWei = BigInt(result.settlement.refundWei);

check("the call ran and settled", result.output.length > 0, result.settlement.txHash);
check("paid + refunded == escrowed", costWei + refundWei === escrowedWei);
check("charged below the ceiling", costWei < escrowedWei, `${formatEth(costWei)} of ${formatEth(escrowedWei)} ETH`);

const shares = settlementShares({ escrowedWei, costWei, refundWei });
check(
  "the settlement bar accounts for the whole escrow",
  Math.abs(shares.paidPercent + shares.refundPercent - 100) < 1e-9,
  `${shares.paidPercent.toFixed(1)}% charged / ${shares.refundPercent.toFixed(1)}% back`,
);
check(
  "the output meter stays within its budget",
  usageShare(result.usage.outputTokens, result.usage.maxOutputTokens) <= 100,
  `${result.usage.outputTokens} of ${result.usage.maxOutputTokens} tokens`,
);

await refused("a spent call id is refused", 404, () => api.run(quote.callId, signature));

check("the refund is withdrawable", (await buyer.balance()) === refundWei, `${formatEth(refundWei)} ETH`);

const withdrawal = await buyer.withdraw();
check("withdrawal paid out the whole balance", withdrawal.amountWei === refundWei);
check("nothing is left owing", (await buyer.balance()) === 0n);

const walletAfter = await buyer.walletBalance();
check(
  "the escrow left the wallet and most of it came back",
  walletAfter < walletBefore && walletAfter > walletBefore - escrowedWei,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("  web client ok");
