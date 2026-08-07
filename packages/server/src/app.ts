import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { getAddress, hexlify, verifyMessage } from "ethers";
import { SERVICES, findService, serviceId, type ServiceDefinition } from "./catalog.js";
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
  /**
   * The whole rate card this quote was priced against, not just the total it produced.
   *
   * Comparing totals is not enough. A provider can move `baseFeeWei` up and
   * `perOutputTokenWei` down so the quote for this one input size is unchanged while
   * every short answer now costs the full ceiling. The buyer's own commitment is the
   * hash they pass to `openCall`; this is the server refusing to spend tokens on a call
   * whose frozen terms are not the terms it quoted.
   */
  terms: RateCard;
  quoteWei: bigint;
  issuedAt: number;
}

/** The fields a price is computed from, plus who is paid and who may settle. */
interface RateCard {
  provider: string;
  settler: string;
  baseFeeWei: bigint;
  perInputTokenWei: bigint;
  perOutputTokenWei: bigint;
  maxOutputTokens: number;
}

/** Which term changed, or undefined when the two cards are identical. */
function firstDifference(quoted: RateCard, funded: RateCard): string | undefined {
  if (getAddress(quoted.provider) !== getAddress(funded.provider)) return "provider";
  if (getAddress(quoted.settler) !== getAddress(funded.settler)) return "settler";
  if (quoted.baseFeeWei !== funded.baseFeeWei) return "base fee";
  if (quoted.perInputTokenWei !== funded.perInputTokenWei) return "input rate";
  if (quoted.perOutputTokenWei !== funded.perOutputTokenWei) return "output rate";
  if (quoted.maxOutputTokens !== funded.maxOutputTokens) return "output ceiling";
  return undefined;
}

export interface AppDeps {
  ai: AiClient;
  chain: Chain;
  /** Address of the deployed Tollgate, bound into the message a buyer signs. */
  contractAddress: string;
  /** Quote-store bounds. Overridable so tests can exercise them cheaply. */
  limits?: { maxPendingQuotes?: number; quoteTtlMs?: number };
  /**
   * Directory of the built browser client, served as static files at `/`. Omitted when
   * it has not been built, and by the tests, which exercise the API alone.
   */
  webRoot?: string;
}

/**
 * The message a buyer signs to redeem a call.
 *
 * A call id alone must not authorise anything. It is minted by the server and handed
 * back over HTTP, so it can end up in a proxy log, a browser history, or a shared
 * client — and whoever held it could otherwise collect output somebody else paid for.
 * Signing proves possession of the key that funded the call, which the buyer already
 * has. It stays account-free: there is nothing to sign up for, only a key to prove.
 *
 * The contract address is included so a signature cannot be replayed against a
 * different deployment.
 */
export function redemptionMessage(callId: string, contractAddress: string): string {
  return [
    "Tollgate: redeem call",
    `call: ${callId}`,
    `contract: ${getAddress(contractAddress)}`,
  ].join("\n");
}

/**
 * Refuse to start work that cannot be settled. `reclaimCall` becomes available at
 * `expiresAt`, and a buyer who reclaims while the model is mid-flight leaves the
 * provider having done the work for nothing — `settleCall` reverts once the call is
 * marked settled.
 *
 * This narrows that race rather than closing it. The check happens once, against this
 * machine's clock, before a generation that may take two minutes and a settlement that
 * queues behind every other settlement on the same key. Clock skew, a slow node, or a
 * backlog can still carry a call past its expiry, and after expiry settlement and the
 * buyer's reclaim are simply first transaction wins. Closing it properly means either
 * reserving the window on-chain or refusing settlement after expiry, and the contract
 * does neither.
 */
const SETTLEMENT_HEADROOM_SECONDS = 300n;

/**
 * How long an unredeemed quote is kept. Comfortably shorter than the contract's
 * one-hour `CALL_TIMEOUT`, so a quote can never outlive the call it priced.
 */
const QUOTE_TTL_MS = 15 * 60 * 1000;

/**
 * Ceiling on unredeemed quotes held at once. `/quote` is unauthenticated and each entry
 * pins the caller's input string, so without a cap it is an unbounded allocation
 * controlled by whoever is calling.
 */
const MAX_PENDING_QUOTES = 1000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createApp({ ai, chain, contractAddress, limits, webRoot }: AppDeps): Express {
  const maxPendingQuotes = limits?.maxPendingQuotes ?? MAX_PENDING_QUOTES;
  const quoteTtlMs = limits?.quoteTtlMs ?? QUOTE_TTL_MS;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  /**
   * Quotes live in process memory. That is fine for a single server and honest about
   * what this is: a reference implementation. A deployment behind more than one
   * process needs a shared store, since /run must land where /quote was issued.
   */
  const pending = new Map<string, PendingQuote>();

  /**
   * Call ids currently being redeemed. Claimed synchronously so two concurrent requests
   * cannot both pass the pending-quote check before either has consumed it.
   */
  const inFlight = new Set<string>();

  /** Drop quotes nobody funded. Cheap, and runs on the path that creates them. */
  const pruneExpiredQuotes = () => {
    const cutoff = Date.now() - quoteTtlMs;
    for (const [id, quote] of pending) {
      if (quote.issuedAt < cutoff) pending.delete(id);
    }
  };

  /**
   * The contract address is published here because the browser client needs it and it
   * is not a secret — it is the address every buyer sends escrow to, and the address
   * bound into the message they sign.
   */
  app.get("/health", (_req, res) => {
    res.json({ ok: true, settler: chain.settlerAddress, contract: getAddress(contractAddress) });
  });

  /** The catalog, joined with each service's on-chain rate card. */
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
   * Input tokens are counted up front; output is bounded by the service ceiling. The
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

    // Capacity is checked before the token count, not after. Counting is a call to
    // Anthropic — free, but rate-limited per account — and `/quote` is unauthenticated,
    // so doing it first would let anyone consume that limit against a store they were
    // never going to be admitted to.
    pruneExpiredQuotes();
    if (pending.size >= maxPendingQuotes) {
      throw new HttpError(503, "Too many unredeemed quotes outstanding; retry shortly");
    }

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
      terms: {
        provider: onChain.provider,
        settler: onChain.settler,
        baseFeeWei: onChain.baseFeeWei,
        perInputTokenWei: onChain.perInputTokenWei,
        perOutputTokenWei: onChain.perOutputTokenWei,
        maxOutputTokens: onChain.maxOutputTokens,
      },
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
    const { callId, signature } = req.body ?? {};
    if (typeof callId !== "string" || typeof signature !== "string") {
      throw new HttpError(400, "Body must be { callId: string, signature: string }");
    }

    const quote = pending.get(callId);
    if (!quote) throw new HttpError(404, "Unknown or already-used callId");

    // Expiry is enforced here as well as swept in `/quote`. Sweeping alone only runs
    // when someone asks for a new quote, so on a quiet server an old quote would stay
    // redeemable for as long as the process lived.
    if (Date.now() - quote.issuedAt >= quoteTtlMs) {
      pending.delete(callId);
      throw new HttpError(410, "This quote has expired; take a fresh one");
    }

    // Claimed before the first await. Everything below runs at most once per call id,
    // however many requests arrive together.
    if (inFlight.has(callId)) throw new HttpError(409, "This call is already being run");
    inFlight.add(callId);
    try {
      return await redeem(callId, quote, signature, res);
    } finally {
      inFlight.delete(callId);
    }
  });

  /** The body of a redemption, once the call id has been exclusively claimed. */
  async function redeem(
    callId: string,
    quote: PendingQuote,
    signature: string,
    res: Response,
  ): Promise<void> {
    const onChainCall = await chain.getCall(callId);
    if (onChainCall.missing) throw new HttpError(402, "Call has not been funded on-chain");
    if (onChainCall.settled) throw new HttpError(409, "Call is already settled");
    if (onChainCall.serviceId !== serviceId(quote.service.slug)) {
      throw new HttpError(409, "Funded call is for a different service");
    }
    if (onChainCall.escrowWei < quote.quoteWei) {
      throw new HttpError(402, `Escrow ${onChainCall.escrowWei} is below quote ${quote.quoteWei}`);
    }

    /**
     * Check the terms the call was actually funded under before doing any billable work.
     *
     * The contract freezes a call's terms at funding, but a quote is issued a moment
     * earlier. If the provider changed the rate card in between, the buyer can fund a
     * call whose frozen ceiling or input count is below what this quote was priced
     * against — and settlement, which is validated against the frozen copy, would then
     * revert after the model call had already happened and been billed for. Refusing
     * here costs a re-quote; discovering it at settlement costs the provider a call.
     */
    if (onChainCall.quotedInputTokens !== quote.inputTokens) {
      throw new HttpError(
        409,
        `Funded for ${onChainCall.quotedInputTokens} input tokens, quoted ${quote.inputTokens} — take a fresh quote`,
      );
    }
    // The whole rate card, term by term, not just the ceiling and not just the total.
    // The contract already refuses to fund a call whose terms moved after the buyer read
    // them; this is the same check from the other side, and it is what stops the server
    // spending tokens on a call priced by a formula it never quoted.
    const changed = firstDifference(quote.terms, {
      provider: onChainCall.provider,
      settler: onChainCall.settler,
      baseFeeWei: onChainCall.baseFeeWei,
      perInputTokenWei: onChainCall.perInputTokenWei,
      perOutputTokenWei: onChainCall.perOutputTokenWei,
      maxOutputTokens: onChainCall.maxOutputTokens,
    });
    if (changed) {
      throw new HttpError(
        409,
        `The ${changed} changed after this quote was issued — take a fresh quote`,
      );
    }
    // Nothing else can settle this call. Running it would mean doing the work and then
    // being unable to charge for it.
    if (getAddress(onChainCall.settler) !== getAddress(chain.settlerAddress)) {
      throw new HttpError(409, "This call is settled by a different server");
    }

    // Only the account that funded the call may redeem its output.
    let signer: string;
    try {
      signer = verifyMessage(redemptionMessage(callId, contractAddress), signature);
    } catch {
      throw new HttpError(401, "Malformed signature");
    }
    if (getAddress(signer) !== getAddress(onChainCall.buyer)) {
      throw new HttpError(403, "Signature is not from the account that funded this call");
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (onChainCall.expiresAt <= now + SETTLEMENT_HEADROOM_SECONDS) {
      throw new HttpError(
        409,
        "Too close to expiry to run safely — reclaim the escrow and take a fresh quote",
      );
    }

    // Consume the quote now: a callId is single-use whatever happens next.
    pending.delete(callId);

    let result;
    try {
      // The ceiling comes from the funded call, not the quote. They were just checked
      // to be equal; taking it from the chain keeps the authority in one place.
      result = await ai.run(quote.service, quote.input, onChainCall.maxOutputTokens);
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
    const billedInputTokens = Math.min(result.inputTokens, onChainCall.quotedInputTokens);
    const billedOutputTokens = Math.min(result.outputTokens, onChainCall.maxOutputTokens);

    const receipt = await chain.settleCall(callId, billedInputTokens, billedOutputTokens);

    /**
     * Report the cost from the call's frozen terms — the same numbers the contract just
     * settled against.
     *
     * Reading the provider's live rate card here instead would be the same mistake the
     * contract avoids: a rate change after funding would make these figures disagree
     * with the balances that actually moved, and a raised rate could even report a
     * negative refund. It also keeps a fallible extra round trip off the path after the
     * buyer has been charged, where a failure would lose them the output they paid for.
     */
    const costWei =
      onChainCall.baseFeeWei +
      BigInt(billedInputTokens) * onChainCall.perInputTokenWei +
      BigInt(billedOutputTokens) * onChainCall.perOutputTokenWei;
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
  }

  // Mounted after the API so a stray file in the bundle can never shadow a route, and
  // before the catch-all so a missing asset still 404s as JSON like everything else.
  if (webRoot) app.use(express.static(webRoot));

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

