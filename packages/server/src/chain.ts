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
  // Mirrors the Call struct field-for-field, in declaration order. A call carries a
  // frozen copy of the terms it was funded under, so these are the terms that govern
  // settlement — not whatever the provider's service says now.
  "function calls(bytes32) view returns (bytes32 serviceId, address buyer, uint32 quotedInputTokens, uint32 maxOutputTokens, bool settled, address provider, uint64 expiresAt, address settler, uint128 escrowWei, uint128 baseFeeWei, uint128 perInputTokenWei, uint128 perOutputTokenWei)",
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

/**
 * A funded call, as the contract has it.
 *
 * This carries the terms the call was funded under, not the provider's current ones.
 * Settlement is checked against these, so anything the server decides about a call in
 * flight — what ceiling to send, what it ended up costing — has to come from here.
 */
export interface OnChainCall {
  serviceId: string;
  buyer: string;
  escrowWei: bigint;
  quotedInputTokens: number;
  maxOutputTokens: number;
  expiresAt: bigint;
  settled: boolean;
  /** The only account the contract will accept a settlement from. */
  settler: string;
  baseFeeWei: bigint;
  perInputTokenWei: bigint;
  perOutputTokenWei: bigint;
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
    quotedInputTokens: bigint;
    maxOutputTokens: bigint;
    settled: boolean;
    provider: string;
    expiresAt: bigint;
    settler: string;
    escrowWei: bigint;
    baseFeeWei: bigint;
    perInputTokenWei: bigint;
    perOutputTokenWei: bigint;
  }>;
  settleCall(callId: string, inputTokens: number, outputTokens: number): Promise<ContractTransactionResponse>;
  failCall(callId: string, reason: string): Promise<ContractTransactionResponse>;
  balances(account: string): Promise<bigint>;
}

export class TollgateChain implements Chain {
  private readonly contract: Contract & TollgateMethods;
  private readonly settler: Wallet;
  private readonly nonces: NonceManager;
  /** Tail of the transaction queue; see `serialize`. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rpcUrl: string, address: string, settlerPrivateKey: string) {
    const provider = new JsonRpcProvider(rpcUrl);
    this.settler = new Wallet(settlerPrivateKey, provider);
    // A node can still be serving a cached transaction count right after one of our own
    // transactions mines, so the nonce is tracked locally rather than re-read.
    this.nonces = new NonceManager(this.settler);
    this.contract = new Contract(address, TOLLGATE_ABI, this.nonces) as Contract &
      TollgateMethods;
  }

  /**
   * Run state-changing transactions one at a time.
   *
   * `NonceManager` advances its local nonce before the transaction is populated or
   * broadcast and never rolls it back — ethers carries a standing `@TODO` about exactly
   * this. So a failure during gas estimation, which is what a revert looks like, leaves
   * a nonce nothing will ever occupy, and every later transaction from this key is
   * submitted above the gap and cannot mine. One reverting settlement would otherwise
   * take out the server's ability to settle or refund anything else, permanently.
   *
   * Recovering means calling `reset()`, and that is only safe when nothing else from
   * this key is in flight — hence the queue. Settlement is a short transaction on a
   * single key; serialising it costs little and removes a whole class of stuck state.
   */
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const started = this.queue.then(job, job);
    this.queue = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
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
      maxOutputTokens: Number(c.maxOutputTokens),
      expiresAt: c.expiresAt,
      settled: c.settled,
      settler: c.settler,
      baseFeeWei: c.baseFeeWei,
      perInputTokenWei: c.perInputTokenWei,
      perOutputTokenWei: c.perOutputTokenWei,
      missing: c.buyer === "0x0000000000000000000000000000000000000000",
    };
  }

  /**
   * Settlement is the one step where a transient failure costs real money.
   *
   * By the time this runs the model call has already happened and the provider has
   * already been billed for it. If the transaction does not land, the call stays open
   * until the buyer reclaims and the provider is simply out of pocket. A blip on the
   * RPC endpoint should not be enough to cause that, so transient failures are retried.
   *
   * A revert is not transient and will fail the same way each time; retrying it costs
   * three quick round trips and then surfaces the real error.
   */
  async settleCall(callId: string, inputTokens: number, outputTokens: number): Promise<TransactionReceipt> {
    return this.serialize(() =>
      this.withRetry(`settleCall ${callId}`, async () => {
        const tx = await this.contract.settleCall(callId, inputTokens, outputTokens);
        return tx.wait();
      }),
    );
  }

  private async withRetry(
    label: string,
    send: () => Promise<TransactionReceipt | null>,
    attempts = 3,
  ): Promise<TransactionReceipt> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const receipt = await send();
        if (!receipt) throw new Error(`${label} produced no receipt`);
        return receipt;
      } catch (error) {
        lastError = error;
        // Whatever went wrong, the local nonce may have moved for a transaction that
        // was never broadcast. Drop it and re-read from the chain before trying again.
        this.nonces.reset();
        if (attempt < attempts) {
          console.warn(`${label} failed (attempt ${attempt}/${attempts}), retrying:`, error);
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    // Loud on the way out: at this point the model call has been paid for and not billed.
    console.error(`${label} did not land after ${attempts} attempts; the call is unsettled`, lastError);
    throw lastError;
  }

  async failCall(callId: string, reason: string): Promise<TransactionReceipt> {
    return this.serialize(async () => {
      try {
        const tx = await this.contract.failCall(callId, reason.slice(0, 200));
        const receipt = await tx.wait();
        if (!receipt) throw new Error(`failCall ${callId} produced no receipt`);
        return receipt;
      } catch (error) {
        this.nonces.reset();
        throw error;
      }
    });
  }

  async balanceOf(account: string): Promise<bigint> {
    return this.contract.balances(account);
  }
}
