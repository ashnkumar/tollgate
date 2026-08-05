# Tollgate

Auth-and-capture for AI API calls, settled on-chain.

[![ci](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml/badge.svg)](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-20+-blue)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![A terminal run of one call: the price is computed and confirmed against the contract before anything runs, 0.003254 ETH is escrowed, the call produces 181 of its 400 allowed output tokens, and 0.001095 ETH comes back.](docs/demo.gif)

One real call against the Anthropic API. The escrow is fixed *before* the model runs, because
it is arithmetic: a counted input, a capped output, and a rate card the provider published
on-chain. What comes back afterwards is whatever the call did not use — 33.6% here, and it
moves every run, which is the entire reason settlement exists.

## Quickstart

```bash
git clone https://github.com/ashnkumar/tollgate && cd tollgate
pnpm install
./scripts/walkthrough.sh
```

Needs Node 20+ and [pnpm](https://pnpm.io/). That brings up a local chain, deploys the
contract, starts the server and opens a page that walks one call through all six steps.
No API key, no wallet extension, no faucet, no account — it runs against a deterministic
fake model by default. Ctrl-C stops everything it started.

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

A price you agreed to before the call ran, and a bill you can recompute yourself afterwards.
No subscription, no account, no API key on the buyer's side — only a key they already have.

| | Buying an AI call the usual way | With Tollgate |
|---|---|---|
| **Before you commit** | A rate card and an estimate. The real number arrives on the invoice | `quote()` returns the worst case in wei, computed on-chain from the published rates and your exact input size |
| **A short answer** | You pay the flat price whatever the call produced | Settlement charges the tokens actually used and the difference comes back |
| **The bill** | The seller tells you what you owe | The seller reports two token counts. The contract does the arithmetic, and reverts if the result exceeds what you escrowed |
| **Mid-call price changes** | Whatever the seller's current rate card says | The call carries its own frozen copy of the terms it was funded under |
| **The seller vanishes** | You chase a refund | `reclaimCall()` returns the whole escrow after the timeout, and no one can stop it |

The obvious alternative is a flat price per call, which is what most AI marketplaces do and what
this repository's predecessor did. It is simpler, it needs no settlement transaction, and when
your calls are uniform it is the right answer. Tollgate takes the other trade: two on-chain
transactions instead of one, a refund you have to withdraw rather than one that never left, and
a worst-case escrow that ties up more of the buyer's money than the call will actually cost. What
you buy with that is a ceiling the buyer set and a bill neither side has to be trusted for.

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
  amounts a pushed refund can cost more gas than it returns, and `withdrawTo()` lets a holder name
  the recipient, because a balance that is correctly recorded and permanently unreachable — an
  account whose fallback is not payable — is not a refund.

### Architecture

![Four layers. The buyer holds their own key and runs either a browser or a terminal walkthrough. The metering server holds a separate settler key and exposes four endpoints across five modules. Below sit the Anthropic API and Tollgate.sol, which owns the services, calls and balances mappings.](docs/architecture.png)

| # | Component | Module | What it does |
|---|---|---|---|
| **1** | Browser walkthrough | `packages/web/src/main.ts` | Six steps, no framework. Prices each call against the contract before escrowing |
| **2** | Terminal walkthrough | `packages/demo/src/index.ts` | The same six steps without a browser |
| **3** | HTTP surface | `packages/server/src/app.ts` | `/quote` and `/run`, and every check that runs before a token is spent |
| **4** | Catalogue | `packages/server/src/catalogue.ts` | Prompts, models, input limits. Deliberately holds no prices and no ceiling |
| **5** | Model client | `packages/server/src/ai.ts` | Counts, then calls — both built from one request shape so they cannot drift |
| **6** | Chain client | `packages/server/src/chain.ts` | Holds the settler key. Serialises and retries settlement |
| **7** | Contract | `packages/contracts/contracts/Tollgate.sol` | Rate cards, escrow, settlement, withdrawals. The only place a price is computed |

Start with `Tollgate.sol`. It is the whole idea and it is 391 lines.

## The settler never names a price

`settleCall(callId, inputTokens, outputTokens)` takes two integers. There is no argument for an
amount. The contract recomputes the cost from the rate card frozen into the call, reverts if the
result exceeds the escrow, and credits the difference back to the buyer. A server that wants to
overcharge has to lie about token counts, and the escrow is the ceiling on what that lie is worth.

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
| [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) | reasoning tokens "count toward `max_tokens` alongside the response text" | With thinking on, a buyer can pay for a full budget and receive a truncated answer, so the catalogue disables it |

**The honest comparison is [x402](https://www.x402.org/), not the status quo.** Its `upto` scheme
already does the shape of this: it "authorizes up to a maximum per request; the seller settles the
actual usage, up to that cap." If you want per-request machine payments over HTTP today, use x402
— it is a real standard with real infrastructure, and this is a reference implementation. The
narrow thing Tollgate does differently is publish the *formula* rather than only the cap. Under
`upto` the final amount is asserted by the seller and bounded by the ceiling; here the unit prices
are on-chain, the settler submits only counts, and the bill is arithmetic the buyer can repeat.
x402 also settles in batches to amortise gas, which this does not.

**The demo is shaped, and the shape is the finding.** The output ceilings in
`packages/contracts/scripts/deploy.ts` are chosen, not measured — 400, 1200 and 2000 tokens — and
they are what produce the headline. Across 17 real calls: `translate` returned 89.6–89.8% of its
escrow, `summarize` 32.7–34.4%, and `explain-code` 0.0–3.9%. That spread is not a property of
Tollgate. It measures how well each provider's ceiling fits its job, and a badly fitted one costs
somebody either way — set it loose and the buyer's capital sits in escrow they were never going to
spend; set it tight and the answer gets cut off at full price. One of the four `explain-code` runs
returned exactly 1200 of 1200 tokens, which is what truncation looks like, and refunded nothing.

`SPEC.md` has the rest: the flow, the trust model, and the decisions that were considered and dropped.

## The browser walkthrough

![The three panels of the walkthrough page: a quote showing 254 input tokens against a 400-token ceiling, independently priced from the contract at 0.003254 ETH; the escrow, signature and settlement transactions; and a settlement bar splitting the escrow into 0.002144 ETH charged and 0.00111 ETH refunded.](docs/walkthrough.png)

The buyer's key lives in the page and never reaches the server. That is the point rather than a
detail: the escrow transaction and the redemption signature are the two things that have to come
from a buyer, and a page that asked the server to sign on their behalf would show the same screens
and prove nothing. `✓ Priced independently from the contract` is the page calling `quote()` itself
and refusing to escrow if the server's number disagrees.

## Commands

| Command | What it does |
|---|---|
| `./scripts/walkthrough.sh` | The whole thing: chain, deploy, server, browser page |
| `./scripts/smoke.sh` | The same round trip with no browser, asserted. What CI runs |
| `pnpm chain` | A local chain with 20 funded accounts |
| `pnpm deploy:local` | Deploy and list the catalogue; writes `deployment.json` |
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
tests exist because the pricing model rests on API behaviour rather than on our own code: they
assert that a count taken before a call matches what the call reports, and that `max_tokens` is a
ceiling rather than a hint. `smoke.sh` additionally drives the browser client's own modules against
a live stack, so the page's chain logic is covered rather than only its arithmetic.

## Limitations

- **Usage is self-reported.** Settlement takes the server's word for two token counts. The damage
  is bounded — counts not prices, recomputed on-chain, reverting above the escrow — but a
  dishonest settler can over-report up to the escrow.
- **The independent price check does not check the token count.** The page verifies that the price
  is right *given* an input count the server supplied. An inflated count inflates the escrow; it
  does not inflate the bill, because settlement charges `min(observed, quoted)` and the surplus
  comes back. The buyer's capital is briefly over-committed, not overspent.
- **The ceiling that makes the quote safe is the ceiling that truncates the answer.** They are the
  same number. A provider tuning it down to reduce escrow is tuning up the odds of a cut-off
  response the buyer still pays full price for.
- **Thinking has to be off, and cannot always be turned off.** Reasoning tokens share the
  `max_tokens` budget, so the escrow only buys a whole answer when thinking is disabled. Claude
  Opus 5 accepts that only at `high` effort or below — `xhigh` and `max` return a 400 — and Claude
  Fable 5 rejects it outright. The catalogue is confined to what the ceiling can actually bound.
- **Call state lives in process memory, and nothing recovers a call that dies mid-flight.** `/run`
  must reach the process that issued the `/quote`, so scaling out needs shared state — including
  for the single-use guard. If the server dies between the model call and settlement the output is
  lost and the provider has paid for it. The escrow is never lost either way, but "never lost" is
  weaker than "always delivered".
- **The browser walkthrough holds a published development key.** That is what makes the quickstart
  need no wallet. Pointing it at anything but a local node means asking a real wallet for the two
  signatures — a change to `packages/web/src/wallet.ts` and nothing else, but it has not been done.
- **The contract has not been audited.** It is a reference implementation, and thorough tests over
  the paths it covers are not the same thing.

Also: `CALL_TIMEOUT` is a fixed hour rather than a per-service setting; the seed script registers
all three services to one provider address for legibility, though the contract supports any number;
prices are in the chain's native token with no oracle; the model call is deliberately not retried,
because a connection that drops after the API began work still bills for it; and a settlement that
never lands leaves the provider out of pocket until the buyer reclaims.

## License

MIT — see [LICENSE](LICENSE).
