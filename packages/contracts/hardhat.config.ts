import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

/**
 * Chain-agnostic by design.
 *
 * The default target is the local Hardhat node, which needs no signup, no faucet and
 * no card — `pnpm chain` gives you a funded chain in a few seconds. Point RPC_URL and
 * PRIVATE_KEY at any EVM network to deploy there instead; nothing in the contract is
 * specific to a particular chain.
 */
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    // Follows RPC_URL so a chain started on a non-default port is still reachable.
    // `scripts/smoke.sh` tells you to move RPC_PORT when 8545 is taken, which only
    // works if the deploy step moves with it. Same address as before when unset.
    localhost: {
      url: RPC_URL,
    },
    custom: {
      url: RPC_URL,
      ...(CHAIN_ID ? { chainId: CHAIN_ID } : {}),
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};

export default config;
