import Anthropic from "@anthropic-ai/sdk";
import type { ServiceDefinition } from "./catalog.js";

export interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The two operations metering needs.
 *
 * `countInputTokens` must count exactly the payload `run` will send, or the quote and
 * the settlement disagree. Both methods therefore build the request through the same
 * `buildRequest` helper below rather than assembling messages independently.
 */
export interface AiClient {
  countInputTokens(service: ServiceDefinition, input: string): Promise<number>;
  /**
   * @param maxOutputTokens read from the on-chain rate card — the same number the
   *        contract priced the quote against, so the ceiling the buyer paid for is
   *        exactly the ceiling the API enforces.
   */
  run(service: ServiceDefinition, input: string, maxOutputTokens: number): Promise<RunResult>;
}

export class ModelRefusedError extends Error {
  constructor(readonly category: string | null) {
    super(`Model declined the request${category ? ` (${category})` : ""}`);
    this.name = "ModelRefusedError";
  }
}

/**
 * Everything that affects the input token count, in one place.
 *
 * Both the count and the call are built from this, so the two requests differ only by
 * `max_tokens` — which does not affect the input side. A field set on one and not the
 * other would be a silent divergence between the price quoted and the price charged.
 */
function buildRequest(service: ServiceDefinition, input: string) {
  return {
    model: service.model,
    system: service.systemPrompt,
    messages: [{ role: "user" as const, content: input }],
    thinking: { type: "disabled" as const },
  };
}

/**
 * Ceiling on one generation.
 *
 * Has to stay comfortably inside the settlement headroom in `app.ts`: a call still
 * running when the buyer becomes able to reclaim leaves the provider doing work that
 * can no longer be settled.
 */
const MODEL_TIMEOUT_MS = 120_000;

export class AnthropicClient implements AiClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      /**
       * No automatic retries, deliberately.
       *
       * The SDK retries connection failures and 5xx twice by default. A connection that
       * drops after the API has already begun work bills for that work, so a retry can
       * produce a second billable generation for one call the contract charges once —
       * the same provider-drain shape as running one call id twice, arriving through a
       * different door. `max_tokens` bounds each attempt, not their sum.
       *
       * Failing instead is cheap: a call that produces nothing is refunded in full, so
       * the buyer is never worse off and the provider pays for one generation at most.
       */
      maxRetries: 0,
      timeout: MODEL_TIMEOUT_MS,
    });
  }

  async countInputTokens(service: ServiceDefinition, input: string): Promise<number> {
    /**
     * Free, and available before the call runs — this is what makes a firm quote
     * possible rather than a guess.
     *
     * Anthropic documents the result as an estimate rather than a guarantee, so this is
     * not treated as infallible: settlement bills `min(observed, quoted)`, which leaves
     * the buyer's ceiling exactly what they agreed to and puts any divergence on the
     * provider who published the rate card. `test/live-anthropic.test.ts` asserts the
     * two agree for the payloads this catalog actually sends.
     */
    const res = await this.client.messages.countTokens(buildRequest(service, input));
    return res.input_tokens;
  }

  async run(service: ServiceDefinition, input: string, maxOutputTokens: number): Promise<RunResult> {
    const res = await this.client.messages.create({
      ...buildRequest(service, input),
      // The API enforces this as a hard ceiling, which is what lets the contract
      // treat `maxOutputTokens * outputRate` as a genuine worst case.
      max_tokens: maxOutputTokens,
    });

    // Safety classifiers can decline a request; that arrives as a normal 200 with an
    // empty or partial content array, so check before reading it.
    if (res.stop_reason === "refusal") {
      throw new ModelRefusedError(refusalCategory(res));
    }

    const text = res.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    };
  }
}

/**
 * Deterministic stand-in so the whole payment lifecycle can be exercised — in tests and
 * in the demo — without an API key or network access. Token counts are derived from
 * input length rather than a real tokenizer, which is wrong in detail but exactly
 * right in shape: input is counted before the call, output is bounded by the ceiling.
 */
export class FakeAiClient implements AiClient {
  async countInputTokens(service: ServiceDefinition, input: string): Promise<number> {
    return approximateTokens(service.systemPrompt) + approximateTokens(input);
  }

  async run(service: ServiceDefinition, input: string, maxOutputTokens: number): Promise<RunResult> {
    const inputTokens = await this.countInputTokens(service, input);
    const text =
      `[fake ${service.slug}] ` +
      `${input.slice(0, 120).replace(/\s+/g, " ").trim()}` +
      (input.length > 120 ? "…" : "");
    // Deliberately well under the ceiling, so the demo shows a real refund.
    const outputTokens = Math.min(approximateTokens(text), maxOutputTokens);
    return { text, inputTokens, outputTokens };
  }
}

/** Rough tokens-from-characters heuristic. Only ever used by the fake client. */
function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Read the refusal category off a response.
 *
 * `stop_details` is sent by the API whenever `stop_reason` is `"refusal"`, but the
 * installed SDK version does not declare it on `Message` yet. Reading it structurally
 * keeps the category available without pinning to an SDK release, and degrades to
 * `null` rather than throwing if the shape is not what we expect.
 */
function refusalCategory(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const details = (message as { stop_details?: unknown }).stop_details;
  if (typeof details !== "object" || details === null) return null;
  const category = (details as { category?: unknown }).category;
  return typeof category === "string" ? category : null;
}
