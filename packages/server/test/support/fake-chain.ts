import type { Chain, OnChainCall, OnChainService } from "../../src/chain.js";
import { serviceId } from "../../src/catalogue.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * In-memory stand-in for the contract. Mirrors the parts of Tollgate's behaviour the
 * server relies on — notably that cost is recomputed from the stored rate card, so a
 * test cannot accidentally assert against a price the server invented.
 */
export class FakeChain implements Chain {
  readonly settlerAddress = "0x000000000000000000000000000000000000dEaD";
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

  /** Fund a call the way a buyer would, escrowing exactly the quote. */
  async fundCall(callId: string, slug: string, inputTokens: number, escrow?: bigint): Promise<void> {
    const sid = serviceId(slug);
    const amount = escrow ?? (await this.quote(sid, inputTokens));
    this.calls.set(callId, {
      serviceId: sid,
      buyer: "0x00000000000000000000000000000000000000B0",
      escrowWei: amount,
      quotedInputTokens: inputTokens,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      settled: false,
      missing: false,
    });
  }

  async quote(sid: string, inputTokens: number): Promise<bigint> {
    const s = this.services.get(sid);
    if (!s) throw new Error("NoSuchService");
    return s.baseFeeWei + BigInt(inputTokens) * s.perInputTokenWei + BigInt(s.maxOutputTokens) * s.perOutputTokenWei;
  }

  async getService(sid: string): Promise<OnChainService | undefined> {
    return this.services.get(sid);
  }

  async getCall(callId: string): Promise<OnChainCall> {
    const c = this.calls.get(callId);
    if (c) return c;
    return {
      serviceId: "0x" + "0".repeat(64),
      buyer: ZERO,
      escrowWei: 0n,
      quotedInputTokens: 0,
      expiresAt: 0n,
      settled: false,
      missing: true,
    };
  }

  async settleCall(callId: string, inputTokens: number, outputTokens: number): Promise<{ hash: string }> {
    const call = this.calls.get(callId);
    if (!call) throw new Error("NoSuchCall");
    if (call.settled) throw new Error("AlreadySettled");
    const s = this.services.get(call.serviceId);
    if (!s) throw new Error("NoSuchService");
    if (outputTokens > s.maxOutputTokens) throw new Error("OutputOverCap");

    const cost = s.baseFeeWei + BigInt(inputTokens) * s.perInputTokenWei + BigInt(outputTokens) * s.perOutputTokenWei;
    if (cost > call.escrowWei) throw new Error("CostExceedsEscrow");

    call.settled = true;
    this.balances.set(s.provider, (this.balances.get(s.provider) ?? 0n) + cost);
    this.balances.set(call.buyer, (this.balances.get(call.buyer) ?? 0n) + (call.escrowWei - cost));
    this.settleCalls.push({ callId, inputTokens, outputTokens });
    return { hash: `0xsettle${this.settleCalls.length}` };
  }

  async failCall(callId: string, reason: string): Promise<{ hash: string }> {
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
