import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HDNodeWallet, Mnemonic } from "ethers";

/** Configuration, from the environment. See `.env.example` at the repo root. */

export interface Config {
  port: number;
  rpcUrl: string;
  tollgateAddress: string;
  /** Key the server signs settlements with. Must be the service's registered `settler`. */
  settlerPrivateKey: string;
  anthropicApiKey: string | undefined;
  /** When true, run against a deterministic fake model instead of the Anthropic API. */
  useFakeModel: boolean;
  /** True when the contract address or settler key came from local dev defaults. */
  usingLocalDefaults: boolean;
}

/**
 * The mnemonic every Hardhat node starts with; account 2 is the settler the deploy
 * script registers. These keys are printed in Hardhat's own startup banner and are
 * worthless off a local chain.
 *
 * This exists so the quickstart needs no key handling at all. Anything other than a
 * local node must set SETTLER_PRIVATE_KEY explicitly.
 */
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const DEV_SETTLER_INDEX = 2;

function devSettlerKey(): string {
  return HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(DEV_MNEMONIC),
    `m/44'/60'/0'/0/${DEV_SETTLER_INDEX}`,
  ).privateKey;
}

/**
 * Written by `pnpm deploy:local`. Reading it means the quickstart never asks anyone to
 * copy a contract address between terminals — the step the reference implementation
 * got wrong by prompting for it interactively.
 *
 * Searched upward from the working directory, because `pnpm --filter` runs scripts
 * with the cwd set to the package rather than the repo root.
 */
function readDeployment(): { address?: string } | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      return JSON.parse(readFileSync(resolve(dir, "deployment.json"), "utf8")) as { address?: string };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export function loadConfig(): Config {
  const deployment = readDeployment();

  const tollgateAddress = process.env.TOLLGATE_ADDRESS ?? deployment?.address;
  if (!tollgateAddress) {
    throw new Error(
      "No contract address. Set TOLLGATE_ADDRESS, or run `pnpm deploy:local` to write deployment.json.",
    );
  }

  const explicitKey = process.env.SETTLER_PRIVATE_KEY;
  const isLocalRpc = (process.env.RPC_URL ?? "http://127.0.0.1:8545").includes("127.0.0.1");
  if (!explicitKey && !isLocalRpc) {
    throw new Error("SETTLER_PRIVATE_KEY is required when RPC_URL is not a local node.");
  }

  return {
    port: Number(process.env.PORT ?? 4000),
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    tollgateAddress,
    settlerPrivateKey: explicitKey ?? devSettlerKey(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    useFakeModel: process.env.USE_FAKE_MODEL === "true",
    usingLocalDefaults: !process.env.TOLLGATE_ADDRESS || !explicitKey,
  };
}
