import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Wallet } from "ethers";
import type { Express } from "express";
import { createApp, redemptionMessage } from "../src/app.js";
import { FakeAiClient, ModelRefusedError, type AiClient } from "../src/ai.js";
import { serviceId, type ServiceDefinition } from "../src/catalogue.js";
import { FakeChain } from "./support/fake-chain.js";

describe("payment guards", () => {
  let chain: FakeChain;
  let app: Express;

  beforeEach(() => {
    chain = new FakeChain();
    chain.addService("summarize");
    app = createApp({ ai: new FakeAiClient(), chain, contractAddress: chain.contractAddress });
  });

  /** Sign as the account FakeChain records as the buyer. */
  const sign = (callId: string) =>
    chain.buyerWallet.signMessage(redemptionMessage(callId, chain.contractAddress));

  const runCall = async (target: Express, callId: string) =>
    request(target).post("/run").send({ callId, signature: await sign(callId) });

  const quoteFor = async (input = "hello world") => {
    const res = await request(app).post("/quote").send({ service: "summarize", input });
    expect(res.status).toBe(200);
    return res.body as { callId: string; inputTokens: number; quoteWei: string; maxOutputTokens: number };
  };

  describe("quoting", () => {
    it("prices the worst case and hands back a call id", async () => {
      const q = await quoteFor();
      expect(q.callId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(q.inputTokens).toBeGreaterThan(0);
      expect(BigInt(q.quoteWei)).toBeGreaterThan(0n);
      // Worst case = base + input + the full output ceiling.
      const expected = await chain.quote(serviceId("summarize"), q.inputTokens);
      expect(BigInt(q.quoteWei)).toBe(expected);
    });

    it("takes the output ceiling from the chain, not from local config", async () => {
      chain.addService("explain-code", { maxOutputTokens: 1200 });
      const res = await request(app)
        .post("/quote")
        .send({ service: "explain-code", input: "function f() {}" });
      expect(res.body.maxOutputTokens).toBe(1200);
    });

    it("mints a distinct call id per quote", async () => {
      const [a, b] = [await quoteFor(), await quoteFor()];
      expect(a.callId).not.toBe(b.callId);
    });

    it("rejects an unknown service", async () => {
      const res = await request(app).post("/quote").send({ service: "nope", input: "x" });
      expect(res.status).toBe(404);
    });

    it("rejects a service that is not registered on-chain", async () => {
      const res = await request(app).post("/quote").send({ service: "translate", input: "x" });
      expect(res.status).toBe(503);
    });

    it("rejects a deactivated service", async () => {
      chain.addService("summarize", { active: false });
      const res = await request(app).post("/quote").send({ service: "summarize", input: "x" });
      expect(res.status).toBe(409);
    });

    it("rejects a malformed body", async () => {
      expect((await request(app).post("/quote").send({})).status).toBe(400);
      expect((await request(app).post("/quote").send({ service: "summarize", input: "" })).status).toBe(400);
    });
  });

  describe("running a call", () => {
    it("refuses to run before the buyer has funded it", async () => {
      const q = await quoteFor();
      const res = await runCall(app, q.callId);
      expect(res.status).toBe(402);
      expect(chain.settleCalls).toHaveLength(0);
    });

    // The defect that motivated the rebuild, at the HTTP layer: the reference server
    // matched a request id and never checked the amount behind it.
    it("refuses to run when the escrow is below the quote", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens, BigInt(q.quoteWei) - 1n);
      const res = await runCall(app, q.callId);
      expect(res.status).toBe(402);
      expect(chain.settleCalls).toHaveLength(0);
    });

    it("refuses a call funded against a different service", async () => {
      chain.addService("translate");
      const q = await quoteFor();
      await chain.fundCall(q.callId, "translate", q.inputTokens, BigInt(q.quoteWei) * 2n);
      const res = await runCall(app, q.callId);
      expect(res.status).toBe(409);
    });

    it("runs and settles a properly funded call", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);

      const res = await runCall(app, q.callId);
      expect(res.status).toBe(200);
      expect(res.body.output).toContain("[fake summarize]");
      expect(chain.settleCalls).toHaveLength(1);

      // Charged less than escrowed, and the difference came back.
      const { escrowedWei, costWei, refundWei } = res.body.settlement;
      expect(BigInt(costWei)).toBeLessThan(BigInt(escrowedWei));
      expect(BigInt(refundWei)).toBe(BigInt(escrowedWei) - BigInt(costWei));
      expect(BigInt(refundWei)).toBeGreaterThan(0n);
    });

    it("bills the output actually produced, not the ceiling", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);
      const res = await runCall(app, q.callId);
      expect(res.body.usage.outputTokens).toBeLessThan(res.body.usage.maxOutputTokens);
      expect(chain.settleCalls[0]!.outputTokens).toBe(res.body.usage.outputTokens);
    });

    it("treats a call id as single-use", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);
      expect((await runCall(app, q.callId)).status).toBe(200);
      expect((await runCall(app, q.callId)).status).toBe(404);
      expect(chain.settleCalls).toHaveLength(1);
    });

    it("rejects an unknown call id", async () => {
      const res = await request(app)
        .post("/run")
        .send({ callId: "0x" + "1".repeat(64), signature: await sign("0x" + "1".repeat(64)) });
      expect(res.status).toBe(404);
    });
  });

  /**
   * A call id travels over HTTP and can be observed. On its own it must not entitle the
   * holder to output somebody else escrowed for, so redeeming requires proving control
   * of the account that funded the call.
   */
  describe("redemption is bound to the buyer", () => {
    it("refuses a call id presented without a signature", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);
      const res = await request(app).post("/run").send({ callId: q.callId });
      expect(res.status).toBe(400);
      expect(chain.settleCalls).toHaveLength(0);
    });

    it("refuses a signature from anyone other than the funder", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);

      const thief = Wallet.createRandom();
      const res = await request(app).post("/run").send({
        callId: q.callId,
        signature: await thief.signMessage(redemptionMessage(q.callId, chain.contractAddress)),
      });

      expect(res.status).toBe(403);
      expect(chain.settleCalls).toHaveLength(0);
    });

    it("refuses a signature bound to a different deployment", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);

      const elsewhere = "0x000000000000000000000000000000000000BEEF";
      const res = await request(app).post("/run").send({
        callId: q.callId,
        signature: await chain.buyerWallet.signMessage(redemptionMessage(q.callId, elsewhere)),
      });

      expect(res.status).toBe(403);
    });

    it("refuses a signature for a different call", async () => {
      const [a, b] = [await quoteFor(), await quoteFor()];
      await chain.fundCall(a.callId, "summarize", a.inputTokens);
      const res = await request(app)
        .post("/run")
        .send({ callId: a.callId, signature: await sign(b.callId) });
      expect(res.status).toBe(403);
    });

    it("rejects a malformed signature", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);
      const res = await request(app).post("/run").send({ callId: q.callId, signature: "0xnope" });
      expect(res.status).toBe(401);
    });
  });

  /**
   * Single-use has to mean single-use under concurrency, not just in sequence.
   *
   * The check and the claim are separated by awaits, so without an explicit guard two
   * simultaneous requests can both pass the "is this id still pending" test and both
   * reach the model. The second settlement then reverts as already-settled — but the
   * provider has already been billed by Anthropic twice and can only charge once, so
   * this is a direct drain on the provider rather than a harmless duplicate.
   */
  describe("concurrent redemption", () => {
    it("runs the model once when the same call id is redeemed twice at once", async () => {
      let modelCalls = 0;
      const ai: AiClient = {
        countInputTokens: async () => 50,
        run: async (_s, _i, maxOut) => {
          modelCalls += 1;
          await new Promise((r) => setTimeout(r, 25)); // hold the turn open
          return { text: "ok", inputTokens: 50, outputTokens: Math.min(10, maxOut) };
        },
      };
      const slowApp = createApp({ ai, chain, contractAddress: chain.contractAddress });

      /**
       * Driven over a real socket rather than through supertest. Supertest awaits each
       * request to completion, so requests issued from one `Promise.all` still arrive
       * one after another and a genuine overlap never occurs — this assertion is
       * meaningless without a listening server.
       */
      const server = slowApp.listen(0);
      try {
        await new Promise((resolve) => server.once("listening", resolve));
        const port = (server.address() as { port: number }).port;
        const post = (path: string, body: unknown) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });

        const quoted = await (await post("/quote", { service: "summarize", input: "x" })).json();
        await chain.fundCall(quoted.callId, "summarize", quoted.inputTokens);
        const signature = await sign(quoted.callId);

        const responses = await Promise.all(
          Array.from({ length: 5 }, () => post("/run", { callId: quoted.callId, signature })),
        );

        // The provider is billed by Anthropic per model call but can only charge once.
        expect(modelCalls).toBe(1);
        expect(chain.settleCalls).toHaveLength(1);
        expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  /**
   * Quotes are held in memory until redeemed. Without a bound, anyone can mint them for
   * free and each one pins the caller's input string, so the map is an unbounded
   * allocation an unauthenticated caller controls.
   */
  describe("quote store is bounded", () => {
    it("expires quotes that were never funded", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const q = await quoteFor();

        // Past the TTL, then mint another quote — pruning runs on that path.
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);
        await request(app).post("/quote").send({ service: "summarize", input: "later" });

        await chain.fundCall(q.callId, "summarize", q.inputTokens);
        const res = await runCall(app, q.callId);
        expect(res.status).toBe(404);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses to mint unbounded quotes", async () => {
      // Far more than the cap, minted without ever funding any of them.
      let rejected = 0;
      for (let i = 0; i < 1200; i += 1) {
        const res = await request(app).post("/quote").send({ service: "summarize", input: `x${i}` });
        if (res.status === 503) rejected += 1;
      }
      expect(rejected).toBeGreaterThan(0);
    });
  });

  /**
   * `reclaimCall` opens at `expiresAt`. Starting a model call that close to the line
   * risks the buyer reclaiming mid-flight, which would leave the provider having paid
   * for work it can no longer settle.
   */
  describe("expiry headroom", () => {
    it("refuses to start a call too close to expiry", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);
      const call = chain.calls.get(q.callId)!;
      call.expiresAt = BigInt(Math.floor(Date.now() / 1000) + 60);

      const res = await runCall(app, q.callId);
      expect(res.status).toBe(409);
      expect(chain.settleCalls).toHaveLength(0);
    });
  });

  describe("when the model fails", () => {
    /**
     * Quote and run must go through the same app instance — pending quotes are held
     * per-process, so a quote issued elsewhere is simply an unknown call id.
     */
    const fundedCallOn = async (error: Error) => {
      const ai: AiClient = {
        countInputTokens: async () => 50,
        run: async () => {
          throw error;
        },
      };
      const brokenApp = createApp({ ai, chain, contractAddress: chain.contractAddress });
      const q = await request(brokenApp).post("/quote").send({ service: "summarize", input: "x" });
      expect(q.status).toBe(200);
      await chain.fundCall(q.body.callId, "summarize", q.body.inputTokens);
      return { brokenApp, quote: q.body as { callId: string; quoteWei: string } };
    };

    it("refunds the whole escrow and charges nothing", async () => {
      const { brokenApp, quote } = await fundedCallOn(new Error("upstream 503"));

      const res = await runCall(brokenApp, quote.callId);

      expect(res.status).toBe(502);
      expect(chain.failCalls).toHaveLength(1);
      expect(chain.settleCalls).toHaveLength(0);
      // Buyer whole again; provider earned nothing.
      expect(await chain.balanceOf(chain.buyerWallet.address)).toBe(
        BigInt(quote.quoteWei),
      );
      expect(await chain.balanceOf("0x00000000000000000000000000000000000000A1")).toBe(0n);
    });

    it("refunds a model refusal too", async () => {
      const { brokenApp, quote } = await fundedCallOn(new ModelRefusedError("cyber"));
      const res = await runCall(brokenApp, quote.callId);
      expect(res.status).toBe(502);
      expect(chain.failCalls[0]!.reason).toContain("declined");
    });
  });

  describe("input clamping", () => {
    it("never settles more input tokens than were quoted", async () => {
      // A model reporting more input than was counted must not be able to push the
      // charge past the escrow. The provider absorbs the difference instead.
      const ai: AiClient = {
        countInputTokens: async () => 100,
        run: async (_s: ServiceDefinition, _i: string, maxOut: number) => ({
          text: "ok",
          inputTokens: 100_000, // wildly over what was quoted
          outputTokens: Math.min(10, maxOut),
        }),
      };
      const app2 = createApp({ ai, chain, contractAddress: chain.contractAddress });

      const q = await request(app2).post("/quote").send({ service: "summarize", input: "x" });
      await chain.fundCall(q.body.callId, "summarize", q.body.inputTokens);

      const res = await runCall(app2, q.body.callId);
      expect(res.status).toBe(200);
      expect(chain.settleCalls[0]!.inputTokens).toBe(100);
      expect(res.body.usage.observedInputTokens).toBe(100_000);
    });
  });

  describe("catalogue", () => {
    it("reports registration state and rate cards", async () => {
      const res = await request(app).get("/services");
      expect(res.status).toBe(200);
      const summarize = res.body.services.find((s: { slug: string }) => s.slug === "summarize");
      expect(summarize.registered).toBe(true);
      expect(summarize.rateCard.perOutputTokenWei).toBe("5000000000000");
      // Not registered in this fixture.
      const translate = res.body.services.find((s: { slug: string }) => s.slug === "translate");
      expect(translate.registered).toBe(false);
      expect(translate.rateCard).toBeNull();
    });
  });
});
