# Tollgate

Auth-and-capture for AI API calls, settled on-chain.

[![ci](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml/badge.svg)](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-20+-blue)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![A terminal run of one call: the price is computed and confirmed against the contract before anything runs, 0.003254 ETH is escrowed, the call produces 181 of its 400 allowed output tokens, and 0.001095 ETH comes back.](docs/demo.gif)

One real call against the Anthropic API. The price is worked out and agreed before the model
starts, because it is arithmetic — a counted input and a capped answer, against rates the
provider published. What comes back at the end is whatever the call did not use: 33.6% here,
and a different figure on every run.

## The problem

You want to sell someone a single call to a language model. They hand you a document, you run
it, you charge them. The trouble is you cannot say what it costs until it is over. You can
measure what they gave you, but the length of the answer is the model's decision, made while
it writes, and on the same service it might be forty words or four hundred.

Every way out of that costs somebody. Charge a flat price and the short answers subsidize the
long ones, so most buyers overpay and the tail still loses you money. Bill afterward at cost
and you have handed the buyer an invoice for a number they never agreed to. Ask them to trust
your estimate and you have asked them to trust a number you produced, on a meter only you can
read.

**Tollgate takes the trade cards took decades ago: agree a ceiling before the work starts, then
charge what the work actually cost.** A gas pump authorizes an amount against your card before
it will dispense a drop, you fill up, and it captures what you pumped. The ceiling is not a
price — it is what lets the pump start without knowing where it will stop.

You pay for that with two payments instead of one, money held that was never going to be spent,
and a refund the buyer has to collect. What you get is a ceiling the buyer worked out themselves
beforehand, and a final bill neither side has to be trusted for.

The rest of this page is how that works and how to run it.

## Quickstart

```bash
git clone https://github.com/ashnkumar/tollgate && cd tollgate
pnpm install
./scripts/walkthrough.sh
```

Needs Node 20+ and [pnpm](https://pnpm.io/). That brings up a local chain, deploys the
contract, starts the server and opens a page that walks one call through all six steps.
There is no API key, no wallet extension, no faucet and no account, because it runs against a
deterministic fake model by default, and Ctrl-C stops everything it started.

**For real calls:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
USE_FAKE_MODEL=false ./scripts/walkthrough.sh
```

At Claude Opus 5's [published rates](https://platform.claude.com/docs/en/about-claude/pricing)
a `summarize` call costs about half a cent; `explain-code`, which nearly fills its budget,
costs about three. Prefer a terminal? `./scripts/smoke.sh` does the same round trip
without a browser and asserts the result — it is what CI runs.

## What you get

| | Buying an AI call the usual way | With Tollgate |
|---|---|---|
| **Before you commit** | A rate card and an estimate. The real number arrives on the invoice | A worst case in wei, computed from published rates and your exact input, that you can check yourself |
| **A short answer** | You pay the flat price whatever the call produced | Settlement charges the tokens actually used and the difference comes back |
| **The bill** | The seller tells you what you owe | The seller reports two token counts. The contract does the arithmetic, and reverts if the result exceeds what you escrowed |
| **Mid-call price changes** | Whatever the seller's current rate card says | The call carries its own frozen copy of the terms it was funded under |
| **The seller vanishes** | You chase a refund | The whole escrow comes back after a timeout, and nobody can stop it |

A flat price per call is the right answer more often than this table makes it sound. It needs
no settlement transaction, no refund path and no second signature, and when your calls are
uniform in size the variance it hides is variance nobody was going to notice. It stops being
right when output length is the dominant cost and it moves by an order of magnitude between
buyers, which is where a single number has to be wrong for almost everybody. The price of
going the other way is real: the buyer's capital sits in escrow they were never going to
spend, gas is paid twice, and a crash between the model call and settlement loses the provider
output it has already been billed for.

## How it works

![Three panels. One: the on-chain rate card plus a 254-token input and a 400-token ceiling sum to a 0.003254 ETH worst case. Two: the buyer escrows that amount and signs a redemption message, and the server checks the funded terms before spending anything. Three: the settler submits two token counts, the contract recomputes 0.002179 ETH and refunds the remaining 0.001075 ETH.](docs/how-it-works.png)

- **The price is computed in exactly one place, and it is not the server.** `quote()` is a public
  view function, so a buyer recomputes the number themselves rather than trusting it. The browser
  page does this on every call and refuses to escrow when the two disagree.
- **A funded call carries its own copy of its terms** — rates, output ceiling, provider, settler.
  Reading the live service at settlement instead would look equivalent and is not: a provider who
  edits a service mid-flight could make an in-flight call impossible to settle, stranding the
  buyer's escrow until it expires and earning nothing themselves.
- **Refunds and earnings accrue to a balance you withdraw**, rather than being pushed. At per-call
  amounts a pushed refund can cost more gas than it returns. `withdrawTo()` lets a holder name the
  recipient, because a balance credited to an account whose fallback is not payable is recorded
  correctly and permanently unreachable.

### Architecture

![Four layers. The buyer holds their own key and runs either a browser or a terminal walkthrough. The metering server holds a separate settler key and exposes four endpoints across five modules. Below sit the Anthropic API and Tollgate.sol, which owns the services, calls and balances mappings.](docs/architecture.png)

| # | Component | Module | What it does |
|---|---|---|---|
| **1** | Browser walkthrough | `packages/web/src/main.ts` | Six steps, no framework. Prices each call against the contract before escrowing |
| **2** | Terminal walkthrough | `packages/demo/src/index.ts` | The same six steps without a browser |
| **3** | HTTP surface | `packages/server/src/app.ts` | `/quote` and `/run`, and every check that runs before a token is spent |
| **4** | Catalog | `packages/server/src/catalog.ts` | Prompts, models, input limits. Deliberately holds no prices and no ceiling |
| **5** | Model client | `packages/server/src/ai.ts` | Counts, then calls — both built from one request shape so they cannot drift |
| **6** | Chain client | `packages/server/src/chain.ts` | Holds the settler key. Serializes and retries settlement |
| **7** | Contract | `packages/contracts/contracts/Tollgate.sol` | Rate cards, escrow, settlement, withdrawals. The only place a price is computed |

Start with `Tollgate.sol`. It is the whole idea and it is 391 lines.

## The settler never names a price

`settleCall(callId, inputTokens, outputTokens)` takes two integers. There is no argument for an
amount. The contract recomputes the cost from the rate card frozen into the call, reverts if the
result exceeds the escrow, and credits the difference back to the buyer. A server that wants to
overcharge has to lie about token counts, and the escrow is the ceiling on what that lie is worth.

The buyer's side of that is `quote()`, which anybody can call. The browser page prices every call
against the contract itself and refuses to escrow if the server's figure disagrees, so the number
on screen is one the page derived rather than one it was told. The buyer's key stays in the page
and never reaches the server, because the escrow transaction and the redemption signature are the
two things that have to come from a buyer, and a page that asked the server to sign on their
behalf would show the same screens and prove nothing.

**What it costs.** Nothing on a chain can verify that a model emitted 185 tokens. Usage is
self-reported, and this design does not fix that — it bounds it. A dishonest settler can inflate
usage up to the escrow and not one wei past it, and a buyer who thinks they were overcharged can
recompute the bill from public numbers. Closing the gap properly needs an oracle, a trusted
enclave, or a proof of inference, and all three are out of scope here.

Three properties of the Anthropic API carry the design, so each is asserted rather than assumed
(`RUN_LIVE_TESTS=1 pnpm test`):

| Property | The vendor's wording | Why it matters here |
|---|---|---|
| [`max_tokens`](https://platform.claude.com/docs/en/api/messages) | "the absolute maximum number of tokens to generate" | Without a hard ceiling the worst case is a guess, and there is nothing to escrow |
| [`count_tokens`](https://platform.claude.com/docs/en/build-with-claude/token-counting) | "The token count is an estimate" — and it may include system-added tokens you "are not billed for" | The quote can exceed the eventual bill, so settlement charges `min(observed, quoted)` and the provider absorbs its own estimate |
| [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) | reasoning tokens "count toward `max_tokens` alongside the response text" | With thinking on, a buyer can pay for a full budget and receive a truncated answer, so the catalog disables it |

**[x402](https://www.x402.org/) already does this shape.** Its `upto` scheme authorizes a transfer
"of up to a **maximum amount**" where "the actual amount charged is determined at settlement time
based on resource consumption during the request" — and the first use case its spec lists is
paying for LLM token generation. If you want per-request machine payments over HTTP today, use
x402 — it is a real standard with real infrastructure, and this is a reference implementation. The
narrow thing Tollgate does differently is publish the *formula* rather than only the cap. Under
`upto` the resource server "MUST set the `amount` field ... to the desired settlement amount";
here the unit prices are on-chain, the settler submits only counts, and the bill is arithmetic the
buyer can repeat. x402 also specifies a batch-settlement scheme to amortize gas, which this does
not.

**The output ceilings are chosen, not measured.** The three in
`packages/contracts/scripts/deploy.ts` — 400, 1200 and 2000 tokens — are what produce the refund
in the recording at the top. Across 17 real calls: `translate` returned 89.6–89.8% of its
escrow, `summarize` 32.7–34.4%, and `explain-code` 0.0–3.9%. That spread is not a property of
Tollgate. It measures how well each provider's ceiling fits its job, and a badly fitted one costs
somebody either way — set it loose and the buyer's capital sits in escrow they were never going to
spend; set it tight and the answer gets cut off at full price. One of the four `explain-code` runs
returned exactly 1200 of 1200 tokens, which is what truncation looks like, and refunded nothing.

`SPEC.md` has the rest: the flow, the trust model, and the decisions that were considered and dropped.

## Commands

| Command | What it does |
|---|---|
| `./scripts/walkthrough.sh` | The whole thing: chain, deploy, server, browser page |
| `./scripts/smoke.sh` | The same round trip with no browser, asserted. What CI runs |
| `pnpm chain` | A local chain with 20 funded accounts |
| `pnpm deploy:local` | Deploy and list the catalog; writes `deployment.json` |
| `pnpm serve` | The metering server |
| `pnpm demo <service>` | One call end to end in the terminal |
| `pnpm web` | Build the browser walkthrough |

`pnpm serve` reads `deployment.json` and the local development key on its own, so nothing has to
be copied between terminals. Every setting has a working local default; [`.env.example`](.env.example)
lists them. Nothing here is chain-specific — point `RPC_URL` and `SETTLER_PRIVATE_KEY` wherever you like.

## Tests

```bash
pnpm test                   # 44 contract + 36 server + 14 web, all offline
RUN_LIVE_TESTS=1 pnpm test  # adds 4 that call the real API
./scripts/smoke.sh          # the whole stack against a real chain
```

The offline suite runs the entire payment lifecycle against a fake chain and a fake model, down to
concurrent redemptions of one call id and settlement after a mid-flight rate change. The four live
tests exist because the pricing model rests on API behavior rather than on our own code: they
assert that a count taken before a call matches what the call reports, and that `max_tokens` is a
ceiling rather than a hint. `smoke.sh` additionally drives the browser client's own modules against
a live stack, so the page's chain logic is covered rather than only its arithmetic.

## Limitations

- **Usage is self-reported.** Settlement takes the server's word for two token counts, bounded
  but not removed, as the section above sets out.
- **The ceiling that makes the quote safe is the ceiling that truncates the answer.** They are the
  same number, so a provider tuning it down to reduce escrow is tuning up the odds of a cut-off
  response the buyer still pays full price for, and the measured spread above is what a badly
  fitted one looks like.
- **Thinking has to be off, and cannot always be turned off.** Reasoning tokens share the
  `max_tokens` budget, so the escrow only buys a whole answer when thinking is disabled. Claude
  Opus 5 accepts that only at `high` effort or below — `xhigh` and `max` return a 400 — and Claude
  Fable 5 rejects it outright. The catalog is confined to what the ceiling can actually bound.

`SPEC.md` carries the rest by name. **The trust model** covers what a compromised settler can and
cannot do. **Decisions worth recording** covers the in-memory quote store, which means `/run` must
reach the process that issued the `/quote` and a crash between the model call and settlement loses
the provider output it already paid for. Not in either, and worth stating here: **the contract has
not been audited**, the browser walkthrough holds a published development key so the quickstart can
skip the wallet, the page's independent price check verifies the price *given* an input count the
server supplied rather than the count itself, `CALL_TIMEOUT` is a fixed hour, and prices are in the
chain's native token with no oracle.

## License

MIT — see [LICENSE](LICENSE).
