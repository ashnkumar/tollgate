import { describe, it, expect } from "vitest";
import { AnthropicClient } from "../src/ai.js";
import { findService } from "../src/catalogue.js";

/**
 * Exercises the real Anthropic API.
 *
 * Skipped unless RUN_LIVE_TESTS=1 and a key is present, so the default suite stays
 * offline and free. Run with:
 *
 *   RUN_LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... pnpm test
 *
 * What matters here is not that the model gives a good answer — it is that the two
 * numbers the pricing model depends on behave as assumed: the pre-flight count matches
 * what the call actually reports, and max_tokens is a real ceiling.
 */

const live = process.env.RUN_LIVE_TESTS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
const maybe = live ? describe : describe.skip;

maybe("Anthropic API (live)", () => {
  const client = new AnthropicClient(process.env.ANTHROPIC_API_KEY as string);
  const service = findService("summarize")!;
  const input = "Raft is a consensus protocol designed to be easier to understand than Paxos.";

  it("counts input tokens before the call", async () => {
    const tokens = await client.countInputTokens(service, input);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(1000);
  }, 60_000);

  /**
   * The load-bearing assumption of the whole quote. If the count taken before the call
   * did not match what the call reports, the quote would be an estimate rather than a
   * bound, and settlement could exceed the escrow.
   */
  it("counts the same input the call reports", async () => {
    const counted = await client.countInputTokens(service, input);
    const result = await client.run(service, input, 128);
    expect(result.inputTokens).toBe(counted);
  }, 120_000);

  /** The other load-bearing assumption: max_tokens is enforced, not advisory. */
  it("never exceeds the output ceiling", async () => {
    const cap = 32;
    const result = await client.run(
      service,
      "Write an exhaustive history of distributed systems research.",
      cap,
    );
    expect(result.outputTokens).toBeLessThanOrEqual(cap);
  }, 120_000);

  it("returns usable text", async () => {
    const result = await client.run(service, input, 256);
    expect(result.text.length).toBeGreaterThan(0);
  }, 120_000);
});
