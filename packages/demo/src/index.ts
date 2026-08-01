import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, HDNodeWallet, JsonRpcProvider, Mnemonic, NonceManager, formatEther } from "ethers";

/**
 * Walks one call end to end and prints what it cost.
 *
 * The point of the output is the last block: what the buyer escrowed, what the call
 * actually cost, and what came back. That gap is the whole design — a buyer commits to
 * a worst case up front and pays for what they used.
 */

const ABI = [
  "function quote(bytes32 serviceId, uint32 inputTokens) view returns (uint256)",
  "function openCall(bytes32 callId, bytes32 serviceId, uint32 inputTokens) payable",
  "function balances(address) view returns (uint256)",
  "function withdraw()",
];

/**
 * The mnemonic every Hardhat node starts with. These keys are published in Hardhat's
 * own startup banner and are worthless anywhere except a local chain — which is the
 * point: the quickstart needs no key management at all.
 */
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const BUYER_INDEX = 3;

interface Deployment {
  address: string;
  chainId: number;
  provider: string;
  settler: string;
  buyer: string;
  services: Array<{ slug: string; serviceId: string; maxOutputTokens: number }>;
}

const SERVER = process.env.SERVER_URL ?? "http://localhost:4000";
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

function heading(text: string) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

/**
 * Search upward for the deployment record. `pnpm --filter` runs scripts with the cwd
 * set to the package directory, so a plain cwd-relative read misses the repo root.
 */
function findDeployment(): Deployment | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      return JSON.parse(readFileSync(resolve(dir, "deployment.json"), "utf8")) as Deployment;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

async function main() {
  const deployment = findDeployment();
  if (!deployment) {
    throw new Error("No deployment.json found. Run `pnpm deploy:local` first.");
  }

  const slug = process.argv[2] ?? "summarize";
  const chosen = deployment.services.find((s) => s.slug === slug);
  if (!chosen) {
    throw new Error(
      `Unknown service "${slug}". Available: ${deployment.services.map((s) => s.slug).join(", ")}`,
    );
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const buyer = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(DEV_MNEMONIC),
    `m/44'/60'/0'/0/${BUYER_INDEX}`,
  ).connect(provider);
  // The demo sends two transactions from the same account (openCall, then withdraw).
  // NonceManager tracks the nonce locally instead of re-reading it, which the provider
  // may still be serving from cache immediately after the previous transaction mined.
  const tollgate = new Contract(deployment.address, ABI, new NonceManager(buyer));

  // ── 1. what is on offer ────────────────────────────────────────────────
  heading("1. Catalogue");
  const { services } = await api<{
    services: Array<{
      slug: string;
      name: string;
      maxOutputTokens: number | null;
      demoInput: string;
      rateCard: { perInputTokenWei: string; perOutputTokenWei: string; baseFeeWei: string } | null;
    }>;
  }>("/services");

  for (const s of services) {
    if (!s.rateCard) continue;
    const marker = s.slug === slug ? "→" : " ";
    console.log(
      `  ${marker} ${s.slug.padEnd(13)} base ${formatEther(s.rateCard.baseFeeWei).padStart(8)}` +
        `  in ${formatEther(s.rateCard.perInputTokenWei)}/tok` +
        `  out ${formatEther(s.rateCard.perOutputTokenWei)}/tok` +
        `  cap ${s.maxOutputTokens} out`,
    );
  }

  const service = services.find((s) => s.slug === slug);
  const input = process.env.DEMO_INPUT ?? service?.demoInput ?? "Hello.";

  // ── 2. quote before running ────────────────────────────────────────────
  heading("2. Quote");
  const quote = await api<{
    callId: string;
    serviceId: string;
    inputTokens: number;
    maxOutputTokens: number;
    quoteWei: string;
  }>("/quote", { service: slug, input });

  console.log(`  input counted    ${quote.inputTokens} tokens (exact, before the call runs)`);
  console.log(`  output ceiling   ${quote.maxOutputTokens} tokens (enforced as max_tokens)`);
  console.log(`  worst case       ${formatEther(quote.quoteWei)} ETH`);

  // The buyer does not have to take the server's word for the price.
  const onChainQuote: bigint = await tollgate.quote(quote.serviceId, quote.inputTokens);
  console.log(
    `  chain agrees     ${formatEther(onChainQuote)} ETH ${onChainQuote === BigInt(quote.quoteWei) ? "✓" : "✗ MISMATCH"}`,
  );

  // ── 3. escrow ──────────────────────────────────────────────────────────
  heading("3. Escrow");
  const openTx = await tollgate.openCall(quote.callId, quote.serviceId, quote.inputTokens, {
    value: onChainQuote,
  });
  await openTx.wait();
  console.log(`  buyer ${buyer.address}`);
  console.log(`  escrowed ${formatEther(onChainQuote)} ETH in ${openTx.hash}`);

  // ── 4. run and settle ──────────────────────────────────────────────────
  heading("4. Run");
  const started = Date.now();
  const run = await api<{
    output: string;
    usage: { inputTokens: number; outputTokens: number; maxOutputTokens: number };
    settlement: { escrowedWei: string; costWei: string; refundWei: string; txHash: string };
  }>("/run", { callId: quote.callId });
  console.log(`  completed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  console.log(
    run.output
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );

  // ── 5. the point ───────────────────────────────────────────────────────
  const { escrowedWei, costWei, refundWei } = run.settlement;
  const pct = (BigInt(refundWei) * 10000n) / BigInt(escrowedWei);

  heading("5. Settlement");
  console.log(`  output used      ${run.usage.outputTokens} of ${run.usage.maxOutputTokens} tokens`);
  console.log(`  escrowed         ${formatEther(escrowedWei)} ETH`);
  console.log(`  actually paid    ${formatEther(costWei)} ETH`);
  console.log(
    `  refunded         ${formatEther(refundWei)} ETH  (${(Number(pct) / 100).toFixed(1)}% back)`,
  );
  console.log(`  settled in       ${run.settlement.txHash}`);

  heading("6. Balances");
  const providerOwed: bigint = await tollgate.balances(deployment.provider);
  const buyerOwed: bigint = await tollgate.balances(buyer.address);
  console.log(`  provider earned  ${formatEther(providerOwed)} ETH`);
  console.log(`  buyer refund     ${formatEther(buyerOwed)} ETH  (withdrawable)`);

  if (buyerOwed > 0n) {
    const tx = await tollgate.withdraw();
    const receipt = await tx.wait();
    const gas = receipt ? BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice) : 0n;
    // `withdraw()` pays out the whole balance and zeroes it, so the amount moved is
    // exactly what was owed. Confirm against the contract rather than diffing wallet
    // balances, which also move with gas.
    const remaining: bigint = await tollgate.balances(buyer.address);
    console.log(
      `  buyer withdrew   ${formatEther(buyerOwed)} ETH  (gas ${formatEther(gas)}, balance now ${formatEther(remaining)})`,
    );
  }

  console.log();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
