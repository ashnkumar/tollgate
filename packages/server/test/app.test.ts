import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { FakeAiClient, ModelRefusedError, type AiClient } from "../src/ai.js";
import { serviceId, type ServiceDefinition } from "../src/catalogue.js";
import { FakeChain } from "./support/fake-chain.js";

describe("payment guards", () => {
  let chain: FakeChain;
  let app: Express;

  beforeEach(() => {
    chain = new FakeChain();
    chain.addService("summarize");
    app = createApp({ ai: new FakeAiClient(), chain });
  });

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
      const res = await request(app).post("/run").send({ callId: q.callId });
      expect(res.status).toBe(402);
      expect(chain.settleCalls).toHaveLength(0);
    });

    // The defect that motivated the rebuild, at the HTTP layer: the reference server
    // matched a request id and never checked the amount behind it.
    it("refuses to run when the escrow is below the quote", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens, BigInt(q.quoteWei) - 1n);
      const res = await request(app).post("/run").send({ callId: q.callId });
      expect(res.status).toBe(402);
      expect(chain.settleCalls).toHaveLength(0);
    });

    it("refuses a call funded against a different service", async () => {
      chain.addService("translate");
      const q = await quoteFor();
      await chain.fundCall(q.callId, "translate", q.inputTokens, BigInt(q.quoteWei) * 2n);
      const res = await request(app).post("/run").send({ callId: q.callId });
      expect(res.status).toBe(409);
    });

    it("runs and settles a properly funded call", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);

      const res = await request(app).post("/run").send({ callId: q.callId });
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
      const res = await request(app).post("/run").send({ callId: q.callId });
      expect(res.body.usage.outputTokens).toBeLessThan(res.body.usage.maxOutputTokens);
      expect(chain.settleCalls[0]!.outputTokens).toBe(res.body.usage.outputTokens);
    });

    it("treats a call id as single-use", async () => {
      const q = await quoteFor();
      await chain.fundCall(q.callId, "summarize", q.inputTokens);
      expect((await request(app).post("/run").send({ callId: q.callId })).status).toBe(200);
      expect((await request(app).post("/run").send({ callId: q.callId })).status).toBe(404);
      expect(chain.settleCalls).toHaveLength(1);
    });

    it("rejects an unknown call id", async () => {
      const res = await request(app).post("/run").send({ callId: "0x" + "1".repeat(64) });
      expect(res.status).toBe(404);
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
      const brokenApp = createApp({ ai, chain });
      const q = await request(brokenApp).post("/quote").send({ service: "summarize", input: "x" });
      expect(q.status).toBe(200);
      await chain.fundCall(q.body.callId, "summarize", q.body.inputTokens);
      return { brokenApp, quote: q.body as { callId: string; quoteWei: string } };
    };

    it("refunds the whole escrow and charges nothing", async () => {
      const { brokenApp, quote } = await fundedCallOn(new Error("upstream 503"));

      const res = await request(brokenApp).post("/run").send({ callId: quote.callId });

      expect(res.status).toBe(502);
      expect(chain.failCalls).toHaveLength(1);
      expect(chain.settleCalls).toHaveLength(0);
      // Buyer whole again; provider earned nothing.
      expect(await chain.balanceOf("0x00000000000000000000000000000000000000B0")).toBe(
        BigInt(quote.quoteWei),
      );
      expect(await chain.balanceOf("0x00000000000000000000000000000000000000A1")).toBe(0n);
    });

    it("refunds a model refusal too", async () => {
      const { brokenApp, quote } = await fundedCallOn(new ModelRefusedError("cyber"));
      const res = await request(brokenApp).post("/run").send({ callId: quote.callId });
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
      const app2 = createApp({ ai, chain });

      const q = await request(app2).post("/quote").send({ service: "summarize", input: "x" });
      await chain.fundCall(q.body.callId, "summarize", q.body.inputTokens);

      const res = await request(app2).post("/run").send({ callId: q.body.callId });
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
