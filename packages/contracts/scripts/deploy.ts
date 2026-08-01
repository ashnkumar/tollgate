import { ethers } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Deploy Tollgate and list the catalogue on it.
 *
 * The rate cards live here rather than in the server, because the chain is the
 * authoritative source for anything that affects billing — the server reads prices
 * and the output ceiling back out of the contract rather than keeping its own copy.
 *
 * Rates are chosen to be legible at a glance rather than realistic: output costs 5x
 * input, which mirrors the shape of real model pricing, and the ceilings are set so
 * that a typical call visibly refunds a large fraction of what it escrowed.
 */

const ETH = 10n ** 18n;
const MICRO = ETH / 1_000_000n; // 1e12 wei

interface RateCard {
  slug: string;
  baseFeeWei: bigint;
  perInputTokenWei: bigint;
  perOutputTokenWei: bigint;
  maxOutputTokens: number;
}

const RATE_CARDS: RateCard[] = [
  {
    slug: "summarize",
    baseFeeWei: ETH / 1000n, // 0.001
    perInputTokenWei: MICRO,
    perOutputTokenWei: 5n * MICRO,
    maxOutputTokens: 400,
  },
  {
    slug: "explain-code",
    baseFeeWei: ETH / 1000n,
    perInputTokenWei: MICRO,
    perOutputTokenWei: 5n * MICRO,
    maxOutputTokens: 1200,
  },
  {
    slug: "translate",
    baseFeeWei: ETH / 2000n, // 0.0005
    perInputTokenWei: MICRO,
    perOutputTokenWei: 4n * MICRO,
    maxOutputTokens: 2000,
  },
];

const FEE_BPS = 250; // 2.5% platform cut

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, provider, settler, buyer] = signers;
  if (!deployer || !provider || !settler || !buyer) {
    throw new Error("Need at least 4 funded accounts; the local Hardhat node provides 20.");
  }

  const factory = await ethers.getContractFactory("Tollgate");
  const tollgate = await factory.connect(deployer).deploy(deployer.address, FEE_BPS);
  await tollgate.waitForDeployment();
  const address = await tollgate.getAddress();

  console.log(`Tollgate deployed at ${address}`);
  console.log(`  treasury ${deployer.address} (fee ${FEE_BPS / 100}%)`);
  console.log(`  provider ${provider.address}`);
  console.log(`  settler  ${settler.address}`);

  for (const card of RATE_CARDS) {
    const serviceId = ethers.id(card.slug);
    const existing = await tollgate.services(serviceId);
    if (existing.provider !== ethers.ZeroAddress) {
      console.log(`  = ${card.slug} already registered, skipping`);
      continue;
    }
    const tx = await tollgate
      .connect(provider)
      .registerService(
        serviceId,
        settler.address,
        card.baseFeeWei,
        card.perInputTokenWei,
        card.perOutputTokenWei,
        card.maxOutputTokens,
      );
    await tx.wait();
    const ceiling = await tollgate.quote(serviceId, 200);
    console.log(
      `  + ${card.slug.padEnd(13)} max ${String(card.maxOutputTokens).padStart(4)} out` +
        `  |  200-token call quotes at ${ethers.formatEther(ceiling)} ETH`,
    );
  }

  const network = await ethers.provider.getNetwork();
  const record = {
    address,
    chainId: Number(network.chainId),
    feeBps: FEE_BPS,
    treasury: deployer.address,
    provider: provider.address,
    settler: settler.address,
    buyer: buyer.address,
    services: RATE_CARDS.map((c) => ({
      slug: c.slug,
      serviceId: ethers.id(c.slug),
      maxOutputTokens: c.maxOutputTokens,
      baseFeeWei: c.baseFeeWei.toString(),
      perInputTokenWei: c.perInputTokenWei.toString(),
      perOutputTokenWei: c.perOutputTokenWei.toString(),
    })),
  };

  // Written to the repo root so the server and the demo can pick it up without
  // anyone copying an address between terminals.
  const out = resolve(__dirname, "../../../deployment.json");
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nWrote ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
