import {
  Contract,
  HDNodeWallet,
  JsonRpcProvider,
  Mnemonic,
  NonceManager,
  getAddress,
  type ContractTransactionResponse,
} from "ethers";

/**
 * The buyer's side of a call, run in the browser.
 *
 * The key lives here, in the page, and never reaches the server. That is not a detail:
 * the escrow transaction and the redemption signature are the two things that have to
 * come from the buyer for the design to mean anything. A version of this page that
 * asked the server to sign on the buyer's behalf would demo the same screens and prove
 * nothing.
 *
 * The key itself is a Hardhat development key — see `DEV_MNEMONIC` below.
 */

const ABI = [
  "function quote(bytes32 serviceId, uint32 inputTokens) view returns (uint256)",
  "function openCall(bytes32 callId, bytes32 serviceId, uint32 inputTokens) payable",
  "function balances(address) view returns (uint256)",
  "function withdraw()",
] as const;

interface TollgateMethods {
  quote(serviceId: string, inputTokens: number): Promise<bigint>;
  openCall(
    callId: string,
    serviceId: string,
    inputTokens: number,
    overrides: { value: bigint },
  ): Promise<ContractTransactionResponse>;
  balances(account: string): Promise<bigint>;
  withdraw(): Promise<ContractTransactionResponse>;
}

/**
 * The mnemonic every Hardhat node starts with, printed in its own startup banner.
 * Account 3 is the buyer, matching `packages/demo` so both walkthroughs spend from the
 * same account. These keys are worthless anywhere except a local chain, which is the
 * point: the quickstart needs no wallet, no extension, and no key handling.
 *
 * A real buyer would hold their own key and this module would ask a wallet for the two
 * signatures instead of producing them. Nothing else about the flow would change.
 */
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const BUYER_INDEX = 3;

export const DEFAULT_RPC_URL = "http://127.0.0.1:8545";

/**
 * The message a buyer signs to redeem a call. Must match `redemptionMessage` in
 * `packages/server/src/app.ts` byte for byte, or the server rejects the signature.
 * Both sides carry a test pinning this exact text.
 */
export function redemptionMessage(callId: string, contractAddress: string): string {
  return [
    "Tollgate: redeem call",
    `call: ${callId}`,
    `contract: ${getAddress(contractAddress)}`,
  ].join("\n");
}

export interface Buyer {
  address: string;
  chainId: bigint;
  /** Price this call on-chain, without taking the server's word for it. */
  quote(serviceId: string, inputTokens: number): Promise<bigint>;
  openCall(callId: string, serviceId: string, inputTokens: number, valueWei: bigint): Promise<string>;
  sign(callId: string): Promise<string>;
  balance(): Promise<bigint>;
  /** Native balance of the buyer account, for showing what the escrow came out of. */
  walletBalance(): Promise<bigint>;
  withdraw(): Promise<{ hash: string; amountWei: bigint }>;
}

export async function connect(rpcUrl: string, contractAddress: string): Promise<Buyer> {
  const provider = new JsonRpcProvider(rpcUrl);

  const network = await provider.getNetwork().catch(() => {
    throw new Error(`No chain at ${rpcUrl}. Start one with \`pnpm chain\`.`);
  });

  // A contract address from a previous deployment is the likeliest way for this page to
  // be pointed at the wrong chain, and it fails confusingly much later. Check up front.
  const code = await provider.getCode(contractAddress);
  if (code === "0x") {
    throw new Error(
      `No contract at ${contractAddress} on chain ${network.chainId}. Redeploy with \`pnpm deploy:local\`.`,
    );
  }

  const wallet = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(DEV_MNEMONIC),
    `m/44'/60'/0'/0/${BUYER_INDEX}`,
  ).connect(provider);

  // Escrow and withdrawal are separate transactions from one account, and a buyer can
  // fire them faster than the node updates the nonce it reports.
  const tollgate = new Contract(contractAddress, ABI, new NonceManager(wallet)) as Contract &
    TollgateMethods;

  return {
    address: wallet.address,
    chainId: network.chainId,

    quote: (serviceId, inputTokens) => tollgate.quote(serviceId, inputTokens),

    async openCall(callId, serviceId, inputTokens, valueWei) {
      const tx = await tollgate.openCall(callId, serviceId, inputTokens, { value: valueWei });
      await tx.wait();
      return tx.hash;
    },

    sign: (callId) => wallet.signMessage(redemptionMessage(callId, contractAddress)),

    balance: () => tollgate.balances(wallet.address),

    walletBalance: () => provider.getBalance(wallet.address),

    async withdraw() {
      // `withdraw()` pays out the whole balance and zeroes it, so read the amount before
      // sending. Diffing the account balance afterward would also pick up gas.
      const amountWei = await tollgate.balances(wallet.address);
      const tx = await tollgate.withdraw();
      await tx.wait();
      return { hash: tx.hash, amountWei };
    },
  };
}
