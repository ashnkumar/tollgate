import { api, ApiError, type ListedService, type Quote, type RunResult } from "./api";
import { formatEth, settlementShares, shortHex, usageShare } from "./money";
import { connect, DEFAULT_RPC_URL, redemptionMessage, type Buyer } from "./wallet";

/**
 * The browser walkthrough.
 *
 * It follows the same six steps as `pnpm demo`, for the same reason: the sequence is
 * the explanation. A buyer sees the price before committing, commits to a worst case,
 * proves who they are, and gets the difference back. Anything that hid a step would
 * make the page prettier and the argument weaker.
 */

// ── DOM helpers ─────────────────────────────────────────────────────────

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function show(id: string, visible = true): void {
  el(id).hidden = !visible;
}

function text(id: string, value: string): void {
  el(id).textContent = value;
}

function figures(id: string, rows: Array<[string, string, string?]>): void {
  const list = el(id);
  list.replaceChildren();
  for (const [label, value, aside] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (aside) {
      const note = document.createElement("em");
      note.textContent = `  ${aside}`;
      dd.append(note);
    }
    list.append(dt, dd);
  }
}

function fail(message: string): void {
  const banner = el("banner");
  banner.textContent = message;
  banner.hidden = false;
}

function clearFailure(): void {
  el("banner").hidden = true;
}

// ── timeline ────────────────────────────────────────────────────────────

/** One line of the live run log. Returns handles for updating it in place. */
function step(label: string) {
  const li = document.createElement("li");
  li.className = "active";

  const tick = document.createElement("span");
  tick.className = "tick";
  tick.textContent = "▸";

  const name = document.createElement("span");
  name.className = "label";
  name.textContent = label;

  const detail = document.createElement("span");
  detail.className = "detail";

  li.append(tick, name, detail);
  el("timeline").append(li);

  return {
    detail(value: string) {
      detail.textContent = value;
    },
    done(value?: string) {
      li.className = "done";
      tick.textContent = "✓";
      if (value !== undefined) detail.textContent = value;
    },
    failed(value: string) {
      li.className = "failed";
      tick.textContent = "✗";
      detail.textContent = value;
    },
  };
}

// ── state ───────────────────────────────────────────────────────────────

interface State {
  buyer: Buyer;
  contractAddress: string;
  services: ListedService[];
  selected: ListedService | undefined;
  quote: Quote | undefined;
  running: boolean;
}

let state: State;

// ── rendering ───────────────────────────────────────────────────────────

/** Replace the header strip wholesale, so it can never show a stale balance. */
function renderStrip(rows: Array<[string, string]>): void {
  const strip = el("chainstrip");
  strip.replaceChildren();
  for (const [label, value] of rows) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    wrap.append(dt, dd);
    strip.append(wrap);
  }
}

async function renderChainStrip(): Promise<void> {
  const [wallet, owed] = await Promise.all([
    state.buyer.walletBalance(),
    state.buyer.balance(),
  ]);

  renderStrip([
    ["buyer", shortHex(state.buyer.address, 8, 6)],
    ["wallet", `${formatEth(wallet, 4)} ETH`],
    ["withdrawable", `${formatEth(owed)} ETH`],
    ["contract", shortHex(state.contractAddress, 8, 6)],
    ["chain", state.buyer.chainId.toString()],
  ]);
}

function renderCatalogue(): void {
  const container = el("services");
  container.replaceChildren();

  for (const service of state.services) {
    const card = document.createElement("button");
    card.className = "service";
    card.type = "button";
    card.setAttribute("aria-pressed", String(state.selected?.slug === service.slug));
    card.disabled = !service.registered || !service.rateCard?.active;

    const name = document.createElement("span");
    name.className = "service-name";
    name.textContent = service.name;

    const description = document.createElement("span");
    description.className = "service-desc";
    description.textContent = service.description;

    const rates = document.createElement("span");
    rates.className = "service-rates";
    if (service.rateCard) {
      const parts = [
        `base ${formatEth(BigInt(service.rateCard.baseFeeWei))}`,
        `in ${formatEth(BigInt(service.rateCard.perInputTokenWei), 9)}/tok`,
        `out ${formatEth(BigInt(service.rateCard.perOutputTokenWei), 9)}/tok`,
        `cap ${service.maxOutputTokens ?? "?"} out`,
      ];
      for (const part of parts) {
        const span = document.createElement("span");
        span.textContent = part;
        rates.append(span);
      }
    } else {
      rates.textContent = "not registered on-chain";
    }

    card.append(name, description, rates);
    card.addEventListener("click", () => selectService(service));
    container.append(card);
  }
}

function selectService(service: ListedService): void {
  state.selected = service;
  state.quote = undefined;
  clearFailure();
  renderCatalogue();

  show("panel-input");
  show("panel-quote", false);
  show("panel-run", false);
  show("panel-settlement", false);
  show("panel-output", false);

  text(
    "input-note",
    `${service.model} · up to ${service.maxInputTokens.toLocaleString()} input tokens · ` +
      `output capped at ${service.maxOutputTokens ?? "?"} tokens`,
  );
  el<HTMLTextAreaElement>("input").value = service.demoInput;
  el("panel-input").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── the flow ────────────────────────────────────────────────────────────

async function getQuote(): Promise<void> {
  const service = state.selected;
  if (!service) return;

  const input = el<HTMLTextAreaElement>("input").value;
  if (input.trim().length === 0) {
    fail("Enter some input first.");
    return;
  }

  const button = el<HTMLButtonElement>("quote-btn");
  button.disabled = true;
  text("quote-hint", "counting tokens…");
  clearFailure();

  try {
    const quote = await api.quote(service.slug, input);
    state.quote = quote;

    const quoteWei = BigInt(quote.quoteWei);
    figures("quote-figures", [
      ["input counted", `${quote.inputTokens.toLocaleString()} tokens`, "exact, before the call runs"],
      ["output ceiling", `${quote.maxOutputTokens.toLocaleString()} tokens`, "enforced as max_tokens"],
      ["worst case", `${formatEth(quoteWei)} ETH`, "what you escrow"],
      ["call id", shortHex(quote.callId, 10, 6), "single use"],
    ]);

    // The buyer does not have to take the server's word for the price: the rate card is
    // on-chain and `quote()` is a public view function. Checking it here is the whole
    // reason the price lives in the contract rather than in the server.
    const verify = el("quote-verify");
    verify.replaceChildren();
    try {
      const onChain = await state.buyer.quote(quote.serviceId, quote.inputTokens);
      const agrees = onChain === quoteWei;
      verify.className = `verify ${agrees ? "ok" : "bad"}`;
      verify.textContent = agrees
        ? "✓ Priced independently from the contract: "
        : "✗ The server and the contract disagree: ";
      const value = document.createElement("b");
      value.textContent = `${formatEth(onChain)} ETH`;
      verify.append(value);
      el<HTMLButtonElement>("run-btn").disabled = !agrees;
      text("run-hint", agrees ? "" : "Refusing to escrow against a price the chain does not confirm.");
    } catch (error) {
      verify.className = "verify bad";
      verify.textContent = `Could not price this call on-chain: ${messageOf(error)}`;
      el<HTMLButtonElement>("run-btn").disabled = true;
    }

    show("panel-quote");
    show("panel-run", false);
    show("panel-settlement", false);
    show("panel-output", false);
    el("panel-quote").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    fail(explain(error));
  } finally {
    button.disabled = false;
    text("quote-hint", "Nothing is charged for a quote.");
  }
}

async function run(): Promise<void> {
  const quote = state.quote;
  const service = state.selected;
  if (!quote || !service || state.running) return;

  state.running = true;
  clearFailure();
  el<HTMLButtonElement>("run-btn").disabled = true;
  el<HTMLButtonElement>("quote-btn").disabled = true;
  el("timeline").replaceChildren();
  show("panel-run");
  show("panel-settlement", false);
  show("panel-output", false);
  show("signed-message", false);

  const quoteWei = BigInt(quote.quoteWei);

  const escrow = step(`Escrow ${formatEth(quoteWei)} ETH`);
  try {
    const hash = await state.buyer.openCall(
      quote.callId,
      quote.serviceId,
      quote.inputTokens,
      quoteWei,
    );
    escrow.done(shortHex(hash, 10, 8));
    await renderChainStrip();
  } catch (error) {
    escrow.failed(messageOf(error));
    fail(`The escrow transaction failed: ${messageOf(error)}`);
    return reset();
  }

  const signing = step("Sign the redemption request");
  let signature: string;
  try {
    signature = await state.buyer.sign(quote.callId);
    signing.done(shortHex(signature, 10, 8));
    text("signed-text", redemptionMessage(quote.callId, state.contractAddress));
    show("signed-message");
  } catch (error) {
    signing.failed(messageOf(error));
    fail(`Could not sign the redemption request: ${messageOf(error)}`);
    return reset();
  }

  const running = step("Run the call and settle");
  const started = Date.now();
  const ticking = window.setInterval(() => {
    running.detail(`${((Date.now() - started) / 1000).toFixed(1)}s`);
  }, 100);

  let result: RunResult;
  try {
    result = await api.run(quote.callId, signature);
    running.done(`${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    running.failed(messageOf(error));
    fail(explain(error));
    return reset();
  } finally {
    window.clearInterval(ticking);
  }

  const settled = step("Settled on-chain");
  settled.done(shortHex(result.settlement.txHash, 10, 8));

  // The quote is spent whatever happens next, so make that visible rather than leaving a
  // stale "Escrow and run" button that would fail with "already-used callId".
  state.quote = undefined;
  renderSettlement(result);
  await renderChainStrip();
  state.running = false;
  el<HTMLButtonElement>("quote-btn").disabled = false;
}

function renderSettlement(result: RunResult): void {
  const escrowedWei = BigInt(result.settlement.escrowedWei);
  const costWei = BigInt(result.settlement.costWei);
  const refundWei = BigInt(result.settlement.refundWei);

  const { paidPercent, refundPercent } = settlementShares({ escrowedWei, costWei, refundWei });

  text("s-escrowed", `${formatEth(escrowedWei)} ETH`);
  text("s-paid", `${formatEth(costWei)} ETH`);
  text("s-refund", `${formatEth(refundWei)} ETH`);
  text("s-back", `${refundPercent.toFixed(1)}% back`);
  el("bar-paid").style.width = `${paidPercent}%`;
  el("bar-refund").style.width = `${refundPercent}%`;

  const { outputTokens, maxOutputTokens, inputTokens } = result.usage;
  text("s-tokens", `${outputTokens.toLocaleString()} of ${maxOutputTokens.toLocaleString()} tokens used`);
  el("bar-used").style.width = `${usageShare(outputTokens, maxOutputTokens)}%`;

  figures("settlement-figures", [
    ["billed input", `${inputTokens.toLocaleString()} tokens`, "counted before the call"],
    ["billed output", `${outputTokens.toLocaleString()} tokens`, "what the call actually produced"],
    ["settlement tx", shortHex(result.settlement.txHash, 12, 8)],
  ]);

  text("output", result.output);
  el<HTMLButtonElement>("withdraw-btn").disabled = refundWei <= 0n;
  text("withdraw-hint", refundWei > 0n ? "Refunds accrue to a balance; you pull them." : "Nothing to withdraw.");

  show("panel-settlement");
  show("panel-output");
  el("panel-settlement").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function withdraw(): Promise<void> {
  const button = el<HTMLButtonElement>("withdraw-btn");
  button.disabled = true;
  text("withdraw-hint", "withdrawing…");
  try {
    const { hash, amountWei } = await state.buyer.withdraw();
    text("withdraw-hint", `${formatEth(amountWei)} ETH withdrawn in ${shortHex(hash, 10, 8)}`);
    await renderChainStrip();
  } catch (error) {
    button.disabled = false;
    text("withdraw-hint", "");
    fail(`Withdrawal failed: ${messageOf(error)}`);
  }
}

function reset(): void {
  state.running = false;
  el<HTMLButtonElement>("quote-btn").disabled = false;
  el<HTMLButtonElement>("run-btn").disabled = state.quote === undefined;
}

function again(): void {
  show("panel-quote", false);
  show("panel-run", false);
  show("panel-settlement", false);
  show("panel-output", false);
  clearFailure();
  el("panel-input").scrollIntoView({ behavior: "smooth", block: "nearest" });
  el<HTMLTextAreaElement>("input").focus();
}

// ── errors ──────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Turn the server's status codes into something a reader can act on. */
function explain(error: unknown): string {
  if (!(error instanceof ApiError)) return messageOf(error);
  switch (error.status) {
    case 402:
      return `${error.message} — the escrow transaction has not been mined yet, or it was for a different amount.`;
    case 413:
      return `${error.message} Trim the input and quote again.`;
    case 503:
      return `${error.message} Check that the service is registered: \`pnpm deploy:local\`.`;
    default:
      return error.message;
  }
}

// ── boot ────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  const rpcUrl = new URLSearchParams(window.location.search).get("rpc") ?? DEFAULT_RPC_URL;

  const health = await api.health();
  const buyer = await connect(rpcUrl, health.contract);

  state = {
    buyer,
    contractAddress: health.contract,
    services: (await api.services()).services,
    selected: undefined,
    quote: undefined,
    running: false,
  };

  renderCatalogue();
  await renderChainStrip();

  el("quote-btn").addEventListener("click", () => void getQuote());
  el("run-btn").addEventListener("click", () => void run());
  el("withdraw-btn").addEventListener("click", () => void withdraw());
  el("again-btn").addEventListener("click", again);

  const first = state.services.find((s) => s.registered && s.rateCard?.active);
  if (first) selectService(first);
}

boot().catch((error: unknown) => {
  // Deliberately touches nothing `boot` may have replaced: an error handler that throws
  // its own error hides the one worth reading.
  renderStrip([["status", "unavailable"]]);
  fail(messageOf(error));
});
