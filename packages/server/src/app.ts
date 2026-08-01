import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { hexlify } from "ethers";
import { SERVICES, findService, serviceId, type ServiceDefinition } from "./catalogue.js";
import type { AiClient } from "./ai.js";
import { ModelRefusedError } from "./ai.js";
import type { Chain } from "./chain.js";

/** A quote the server has issued and is waiting to be funded on-chain. */
interface PendingQuote {
  callId: string;
  service: ServiceDefinition;
  input: string;
  inputTokens: number;
  /** Snapshotted from the rate card at quote time, so a mid-flight rate change
   *  cannot move the ceiling out from under a call the buyer already funded. */
  maxOutputTokens: number;
  quoteWei: bigint;
  issuedAt: number;
}

export interface AppDeps {
  ai: AiClient;
  chain: Chain;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createApp({ ai, chain }: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  /**
   * Quotes live in process memory. That is fine for a single server and honest about
   * what this is: a reference implementation. A deployment behind more than one
   * process needs a shared store, since /run must land where /quote was issued.
   */
  const pending = new Map<string, PendingQuote>();

  app.get("/health", (_req, res) => {
    res.json({ ok: true, settler: chain.settlerAddress });
  });

  /** The catalogue, joined with each service's on-chain rate card. */
  app.get("/services", async (_req, res) => {
    const listed = await Promise.all(
      SERVICES.map(async (service) => {
        const onChain = await chain.getService(serviceId(service.slug));
        return {
          slug: service.slug,
          name: service.name,
          description: service.description,
          model: service.model,
          maxOutputTokens: onChain?.maxOutputTokens ?? null,
          maxInputTokens: service.maxInputTokens,
          demoInput: service.demoInput,
          registered: Boolean(onChain),
          rateCard: onChain
            ? {
                provider: onChain.provider,
                active: onChain.active,
                baseFeeWei: onChain.baseFeeWei.toString(),
                perInputTokenWei: onChain.perInputTokenWei.toString(),
                perOutputTokenWei: onChain.perOutputTokenWei.toString(),
              }
            : null,
        };
      }),
    );
    res.json({ services: listed });
  });

  /**
   * Price one call, before it runs.
   *
   * Input tokens are counted exactly; output is bounded by the service ceiling. The
   * price itself comes from the contract, not from arithmetic here, so the number the
   * buyer is told is the number settlement will check against.
   */
  app.post("/quote", async (req: Request, res: Response) => {
    const { service: slug, input } = req.body ?? {};
    if (typeof slug !== "string" || typeof input !== "string" || input.length === 0) {
      throw new HttpError(400, "Body must be { service: string, input: string }");
    }

    const service = findService(slug);
    if (!service) throw new HttpError(404, `Unknown service: ${slug}`);

    const onChain = await chain.getService(serviceId(slug));
    if (!onChain) throw new HttpError(503, `Service ${slug} is not registered on-chain`);
    if (!onChain.active) throw new HttpError(409, `Service ${slug} is not accepting calls`);

    const inputTokens = await ai.countInputTokens(service, input);
    if (inputTokens > service.maxInputTokens) {
      // Rejected before any billable work happens.
      throw new HttpError(413, `Input is ${inputTokens} tokens; limit is ${service.maxInputTokens}`);
    }

    const quoteWei = await chain.quote(serviceId(slug), inputTokens);
    const callId = hexlify(randomBytes(32));

    pending.set(callId, {
      callId,
      service,
      input,
      inputTokens,
      maxOutputTokens: onChain.maxOutputTokens,
      quoteWei,
      issuedAt: Date.now(),
    });

    res.json({
      callId,
      serviceId: serviceId(slug),
      service: slug,
      inputTokens,
      maxOutputTokens: onChain.maxOutputTokens,
      quoteWei: quoteWei.toString(),
    });
  });

  /**
   * Run a funded call and settle it.
   *
   * Everything before the model call is a check that the buyer really escrowed what
   * they were quoted; everything after it is settlement against what the call actually
   * used. If the model fails, the escrow goes back whole — a call that produced nothing
   * should cost nothing.
   */
  app.post("/run", async (req: Request, res: Response) => {
    const { callId } = req.body ?? {};
    if (typeof callId !== "string") throw new HttpError(400, "Body must be { callId: string }");

    const quote = pending.get(callId);
    if (!quote) throw new HttpError(404, "Unknown or already-used callId");

    const onChainCall = await chain.getCall(callId);
    if (onChainCall.missing) throw new HttpError(402, "Call has not been funded on-chain");
    if (onChainCall.settled) throw new HttpError(409, "Call is already settled");
    if (onChainCall.serviceId !== serviceId(quote.service.slug)) {
      throw new HttpError(409, "Funded call is for a different service");
    }
    if (onChainCall.escrowWei < quote.quoteWei) {
      throw new HttpError(402, `Escrow ${onChainCall.escrowWei} is below quote ${quote.quoteWei}`);
    }

    // Consume the quote now: a callId is single-use whatever happens next.
    pending.delete(callId);

    let result;
    try {
      result = await ai.run(quote.service, quote.input, quote.maxOutputTokens);
    } catch (error) {
      const reason = error instanceof ModelRefusedError ? error.message : "service error";
      await chain.failCall(callId, reason);
      throw new HttpError(502, `Call failed and the escrow was refunded in full: ${reason}`);
    }

    /**
     * Settle against the quoted input, not the observed one.
     *
     * These are normally identical — the same payload is counted and sent. If they
     * ever diverge upward, charging the observed count could exceed the escrow and
     * revert, stranding the call after the work was already done. Billing the quoted
     * figure makes the provider absorb its own estimation error, which is the right
     * way round: the provider published the rate card, and the buyer's ceiling stays
     * exactly what they agreed to.
     */
    const billedInputTokens = Math.min(result.inputTokens, quote.inputTokens);
    const billedOutputTokens = Math.min(result.outputTokens, quote.maxOutputTokens);

    const receipt = await chain.settleCall(callId, billedInputTokens, billedOutputTokens);

    const costWei = await costFromRateCard(chain, quote.service.slug, billedInputTokens, billedOutputTokens);
    const refundWei = onChainCall.escrowWei - costWei;

    res.json({
      callId,
      service: quote.service.slug,
      output: result.text,
      usage: {
        inputTokens: billedInputTokens,
        outputTokens: billedOutputTokens,
        maxOutputTokens: quote.maxOutputTokens,
        observedInputTokens: result.inputTokens,
      },
      settlement: {
        escrowedWei: onChainCall.escrowWei.toString(),
        costWei: costWei.toString(),
        refundWei: refundWei.toString(),
        txHash: receipt.hash,
      },
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    res.status(500).json({ error: message });
  });

  return app;
}

/**
 * Recompute what settlement charged, from the same on-chain rate card the contract
 * used. Reported back to the caller so they can see the cost without parsing logs.
 */
async function costFromRateCard(
  chain: Chain,
  slug: string,
  inputTokens: number,
  outputTokens: number,
): Promise<bigint> {
  const s = await chain.getService(serviceId(slug));
  if (!s) return 0n;
  return s.baseFeeWei + BigInt(inputTokens) * s.perInputTokenWei + BigInt(outputTokens) * s.perOutputTokenWei;
}
