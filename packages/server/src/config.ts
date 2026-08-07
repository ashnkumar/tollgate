import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HDNodeWallet, Mnemonic } from "ethers";

/** Configuration, from the environment. See `.env.example` at the repo root. */

export interface Config {
  port: number;
  /**
   * Interface to bind. Loopback by default.
   *
   * `listen(port)` with no host binds every interface, so the obvious version of this
   * put an unauthenticated endpoint holding an API key on the local network while
   * printing `http://localhost:4000` and looking like a private demo. Exposing it is
   * fine; it should be something you typed.
   */
  host: string;
  rpcUrl: string;
  tollgateAddress: string;
  /** Key the server signs settlements with. Must be the service's registered `settler`. */
  settlerPrivateKey: string;
  anthropicApiKey: string | undefined;
  /** When true, run against a deterministic fake model instead of the Anthropic API. */
  useFakeModel: boolean;
  /** True when the contract address or settler key came from local dev defaults. */
  usingLocalDefaults: boolean;
  /** Built browser client, served at `/` when it exists. Undefined until `pnpm web`. */
  webRoot: string | undefined;
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
 * Located by walking upward from the working directory, because `pnpm --filter` runs
 * scripts with the cwd set to the package rather than the repo root.
 */
function readDeployment(): { address?: string } | undefined {
  const path = findUpwards("deployment.json");
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { address?: string };
  } catch {
    return undefined;
  }
}

/** Walk up from the working directory looking for `relativePath`. */
function findUpwards(relativePath: string): string | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = resolve(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The built browser client, served at `/` when it is there. Optional on purpose: the
 * server is useful without it, and making an API refuse to start without a bundling
 * step would be the wrong trade.
 */
function findWebRoot(): string | undefined {
  const index = findUpwards("packages/web/dist/index.html");
  return index ? dirname(index) : undefined;
}

/**
 * Load `.env` from the repo root, if there is one.
 *
 * `.env.example` told people to copy this file and nothing read it, so every override
 * they wrote was silently ignored. `process.loadEnvFile` landed in Node 20.12; on
 * anything older the file is skipped, and that is worth saying out loud rather than
 * failing later with a value the user believes they set. Real environment variables
 * always win — the loader does not overwrite what is already set.
 */
function loadDotEnv(): void {
  const path = findUpwards(".env");
  if (!path) return;
  const load = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (!load) {
    console.warn(`Found ${path} but this Node cannot read it (needs 20.12+). Pass the variables inline instead.`);
    return;
  }
  load.call(process, path);
}

export function loadConfig(): Config {
  loadDotEnv();
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
    host: process.env.HOST ?? "127.0.0.1",
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    tollgateAddress,
    settlerPrivateKey: explicitKey ?? devSettlerKey(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    useFakeModel: process.env.USE_FAKE_MODEL === "true",
    usingLocalDefaults: !process.env.TOLLGATE_ADDRESS || !explicitKey,
    webRoot: findWebRoot(),
  };
}
