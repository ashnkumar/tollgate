import {
  Contract,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  type ContractTransactionResponse,
  type TransactionReceipt,
} from "ethers";

/**
 * Human-readable ABI for the slice of Tollgate the server touches. Kept here rather
 * than imported from build artifacts so the server has no compile-order dependency on
 * the contracts package.
 */
export const TOLLGATE_ABI = [
  "function quote(bytes32 serviceId, uint32 inputTokens) view returns (uint256)",
  "function services(bytes32) view returns (address provider, uint32 maxOutputTokens, bool active, address settler, uint128 baseFeeWei, uint128 perInputTokenWei, uint128 perOutputTokenWei)",
  "function calls(bytes32) view returns (bytes32 serviceId, address buyer, uint128 escrowWei, uint32 quotedInputTokens, uint64 expiresAt, bool settled)",
  "function settleCall(bytes32 callId, uint32 inputTokens, uint32 outputTokens)",
  "function failCall(bytes32 callId, string reason)",
  "function balances(address) view returns (uint256)",
  "function feeBps() view returns (uint16)",
] as const;

export interface OnChainService {
  provider: string;
  settler: string;
  maxOutputTokens: number;
  active: boolean;
  baseFeeWei: bigint;
  perInputTokenWei: bigint;
  perOutputTokenWei: bigint;
}

export interface OnChainCall {
  serviceId: string;
  buyer: string;
  escrowWei: bigint;
  quotedInputTokens: number;
  expiresAt: bigint;
  settled: boolean;
  /** True when nobody has opened this call yet. */
  missing: boolean;
}

/**
 * The chain operations the app needs. `TollgateChain` below is the real
 * implementation; tests substitute an in-memory one so the HTTP layer can be
 * exercised without an RPC endpoint.
 */
export interface Chain {
  readonly settlerAddress: string;
  quote(serviceId: string, inputTokens: number): Promise<bigint>;
  getService(serviceId: string): Promise<OnChainService | undefined>;
  getCall(callId: string): Promise<OnChainCall>;
  settleCall(callId: string, inputTokens: number, outputTokens: number): Promise<{ hash: string }>;
  failCall(callId: string, reason: string): Promise<{ hash: string }>;
  balanceOf(account: string): Promise<bigint>;
}

/**
 * The contract's methods, typed. `ethers.Contract` exposes ABI methods through an
 * index signature, which under `noUncheckedIndexedAccess` is `possibly undefined` at
 * every call site. Declaring the shape once and casting on construction keeps the rest
 * of this file readable and still type-checked.
 */
interface TollgateMethods {
  quote(serviceId: string, inputTokens: number): Promise<bigint>;
  services(serviceId: string): Promise<{
    provider: string;
    maxOutputTokens: bigint;
    active: boolean;
    settler: string;
    baseFeeWei: bigint;
    perInputTokenWei: bigint;
    perOutputTokenWei: bigint;
  }>;
  calls(callId: string): Promise<{
    serviceId: string;
    buyer: string;
    escrowWei: bigint;
    quotedInputTokens: bigint;
    expiresAt: bigint;
    settled: boolean;
  }>;
  settleCall(callId: string, inputTokens: number, outputTokens: number): Promise<ContractTransactionResponse>;
  failCall(callId: string, reason: string): Promise<ContractTransactionResponse>;
  balances(account: string): Promise<bigint>;
}

export class TollgateChain implements Chain {
  private readonly contract: Contract & TollgateMethods;
  private readonly settler: Wallet;

  constructor(rpcUrl: string, address: string, settlerPrivateKey: string) {
    const provider = new JsonRpcProvider(rpcUrl);
    this.settler = new Wallet(settlerPrivateKey, provider);
    // Settlements are independent transactions from one key, so concurrent calls can
    // otherwise collide on a stale nonce. NonceManager serialises them.
    this.contract = new Contract(
      address,
      TOLLGATE_ABI,
      new NonceManager(this.settler),
    ) as Contract & TollgateMethods;
  }

  get settlerAddress(): string {
    return this.settler.address;
  }

  /**
   * The authoritative price. Deliberately read from the chain rather than recomputed
   * here: if the server did its own arithmetic, the server and the contract could
   * disagree and a buyer could escrow an amount that settlement then rejects.
   */
  async quote(serviceId: string, inputTokens: number): Promise<bigint> {
    return this.contract.quote(serviceId, inputTokens);
  }

  async getService(serviceId: string): Promise<OnChainService | undefined> {
    const s = await this.contract.services(serviceId);
    if (s.provider === "0x0000000000000000000000000000000000000000") return undefined;
    return {
      provider: s.provider,
      settler: s.settler,
      maxOutputTokens: Number(s.maxOutputTokens),
      active: s.active,
      baseFeeWei: s.baseFeeWei,
      perInputTokenWei: s.perInputTokenWei,
      perOutputTokenWei: s.perOutputTokenWei,
    };
  }

  async getCall(callId: string): Promise<OnChainCall> {
    const c = await this.contract.calls(callId);
    return {
      serviceId: c.serviceId,
      buyer: c.buyer,
      escrowWei: c.escrowWei,
      quotedInputTokens: Number(c.quotedInputTokens),
      expiresAt: c.expiresAt,
      settled: c.settled,
      missing: c.buyer === "0x0000000000000000000000000000000000000000",
    };
  }

  async settleCall(callId: string, inputTokens: number, outputTokens: number): Promise<TransactionReceipt> {
    const tx = await this.contract.settleCall(callId, inputTokens, outputTokens);
    const receipt = await tx.wait();
    if (!receipt) throw new Error(`settleCall ${callId} produced no receipt`);
    return receipt;
  }

  async failCall(callId: string, reason: string): Promise<TransactionReceipt> {
    const tx = await this.contract.failCall(callId, reason.slice(0, 200));
    const receipt = await tx.wait();
    if (!receipt) throw new Error(`failCall ${callId} produced no receipt`);
    return receipt;
  }

  async balanceOf(account: string): Promise<bigint> {
    return this.contract.balances(account);
  }
}
