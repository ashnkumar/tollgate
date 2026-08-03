import { Wallet } from "ethers";
import type { Chain, OnChainCall, OnChainService } from "../../src/chain.js";
import { serviceId } from "../../src/catalogue.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Yield to the macrotask queue, the way a real RPC call would. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * In-memory stand-in for the contract. Mirrors the parts of Tollgate's behaviour the
 * server relies on — notably that cost is recomputed from the stored rate card, so a
 * test cannot accidentally assert against a price the server invented.
 *
 * Every method yields to the event loop before returning. This is not decoration: an
 * `async` method that resolves immediately only yields to the microtask queue, while
 * inbound HTTP requests arrive as macrotasks. A fake built that way lets one request
 * run start-to-finish before the next handler is even entered, so concurrency bugs
 * that a real RPC round trip would expose become invisible. `tick()` makes the fake
 * behave like the network it stands in for.
 */
export class FakeChain implements Chain {
  readonly settlerAddress = "0x000000000000000000000000000000000000dEaD";
  /** A real key, so tests can produce a valid redemption signature. */
  readonly buyerWallet = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  readonly contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  readonly services = new Map<string, OnChainService>();
  readonly calls = new Map<string, OnChainCall>();
  readonly balances = new Map<string, bigint>();

  settleCalls: Array<{ callId: string; inputTokens: number; outputTokens: number }> = [];
  failCalls: Array<{ callId: string; reason: string }> = [];

  addService(slug: string, overrides: Partial<OnChainService> = {}): OnChainService {
    const service: OnChainService = {
      provider: "0x00000000000000000000000000000000000000A1",
      settler: this.settlerAddress,
      maxOutputTokens: 400,
      active: true,
      baseFeeWei: 1_000_000_000_000_000n, // 0.001
      perInputTokenWei: 1_000_000_000_000n, // 1e12
      perOutputTokenWei: 5_000_000_000_000n, // 5e12
      ...overrides,
    };
    this.services.set(serviceId(slug), service);
    return service;
  }

  /**
   * Fund a call the way a buyer would, escrowing exactly the quote.
   *
   * The terms are copied onto the call, because that is what `openCall` does: a funded
   * call carries the rate card it was funded under, and everything downstream is
   * checked against that copy rather than against whatever the provider says now.
   */
  async fundCall(callId: string, slug: string, inputTokens: number, escrow?: bigint): Promise<void> {
    const sid = serviceId(slug);
    const amount = escrow ?? (await this.quote(sid, inputTokens));
    const s = this.services.get(sid);
    if (!s) throw new Error("NoSuchService");
    this.calls.set(callId, {
      serviceId: sid,
      buyer: this.buyerWallet.address,
      escrowWei: amount,
      quotedInputTokens: inputTokens,
      maxOutputTokens: s.maxOutputTokens,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      settled: false,
      settler: s.settler,
      baseFeeWei: s.baseFeeWei,
      perInputTokenWei: s.perInputTokenWei,
      perOutputTokenWei: s.perOutputTokenWei,
      missing: false,
    });
  }

  async quote(sid: string, inputTokens: number): Promise<bigint> {
    await tick();
    const s = this.services.get(sid);
    if (!s) throw new Error("NoSuchService");
    return s.baseFeeWei + BigInt(inputTokens) * s.perInputTokenWei + BigInt(s.maxOutputTokens) * s.perOutputTokenWei;
  }

  async getService(sid: string): Promise<OnChainService | undefined> {
    await tick();
    return this.services.get(sid);
  }

  async getCall(callId: string): Promise<OnChainCall> {
    await tick();
    const c = this.calls.get(callId);
    if (c) return c;
    return {
      serviceId: "0x" + "0".repeat(64),
      buyer: ZERO,
      escrowWei: 0n,
      quotedInputTokens: 0,
      maxOutputTokens: 0,
      expiresAt: 0n,
      settled: false,
      settler: ZERO,
      baseFeeWei: 0n,
      perInputTokenWei: 0n,
      perOutputTokenWei: 0n,
      missing: true,
    };
  }

  /** Settles against the call's frozen terms, exactly as the contract does. */
  async settleCall(callId: string, inputTokens: number, outputTokens: number): Promise<{ hash: string }> {
    await tick();
    const call = this.calls.get(callId);
    if (!call) throw new Error("NoSuchCall");
    if (call.settled) throw new Error("AlreadySettled");
    if (inputTokens > call.quotedInputTokens) throw new Error("InputOverQuote");
    if (outputTokens > call.maxOutputTokens) throw new Error("OutputOverCap");

    const cost =
      call.baseFeeWei +
      BigInt(inputTokens) * call.perInputTokenWei +
      BigInt(outputTokens) * call.perOutputTokenWei;
    if (cost > call.escrowWei) throw new Error("CostExceedsEscrow");

    // The provider is still read live: the contract stores it on the call too, but the
    // server never reads it, so there is nothing here for it to get wrong.
    const s = this.services.get(call.serviceId);
    if (!s) throw new Error("NoSuchService");

    call.settled = true;
    this.balances.set(s.provider, (this.balances.get(s.provider) ?? 0n) + cost);
    this.balances.set(call.buyer, (this.balances.get(call.buyer) ?? 0n) + (call.escrowWei - cost));
    this.settleCalls.push({ callId, inputTokens, outputTokens });
    return { hash: `0xsettle${this.settleCalls.length}` };
  }

  async failCall(callId: string, reason: string): Promise<{ hash: string }> {
    await tick();
    const call = this.calls.get(callId);
    if (!call) throw new Error("NoSuchCall");
    call.settled = true;
    this.balances.set(call.buyer, (this.balances.get(call.buyer) ?? 0n) + call.escrowWei);
    this.failCalls.push({ callId, reason });
    return { hash: `0xfail${this.failCalls.length}` };
  }

  async balanceOf(account: string): Promise<bigint> {
    return this.balances.get(account) ?? 0n;
  }
}
