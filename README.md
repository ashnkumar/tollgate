# Tollgate

Auth-and-capture for AI API calls, settled on-chain.

[![ci](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml/badge.svg)](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-20+-blue)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![A terminal run of one call: the price is computed and confirmed against the contract before anything runs, 0.003254 ETH is escrowed, the call produces 181 of its 400 allowed output tokens, and 0.001095 ETH comes back.](docs/demo.gif)

One real call against the Anthropic API, start to finish. The price is agreed and escrowed before
the model starts, the call produces 181 of the 400 output tokens it was allowed, and 33.6% of the
escrow comes back. What comes back depends on how long the answer was, so it moves from run to run.

*See the **[technical post](https://example.com/tollgate-technical-post)** for more details.*

## Quickstart

```bash
git clone https://github.com/ashnkumar/tollgate && cd tollgate
pnpm install
./scripts/walkthrough.sh
```

Needs Node 20+ and [pnpm](https://pnpm.io/). That brings up a local chain, deploys the contract,
starts the server and opens a page that walks one call through all six steps. No API key, wallet,
faucet or account, because it runs against a deterministic fake model by default, and Ctrl-C stops
everything it started.

**For real calls:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
USE_FAKE_MODEL=false ./scripts/walkthrough.sh
```

At Claude Opus 5's [published rates](https://platform.claude.com/docs/en/about-claude/pricing) a
`summarize` call costs about half a cent, and `explain-code`, which nearly fills its budget, about
three. `./scripts/smoke.sh` does the same round trip without a browser and asserts the result — it
is what CI runs.

## The problem

You cannot tell a buyer what one call to a language model costs until it is over, because the
length of the answer is the model's decision, made while it writes. Charge a flat fee and short
answers subsidize long ones; ask the buyer to trust your estimate and you are asking them to trust
a meter only you can read. **Tollgate does what credit cards do: agree a ceiling before the work
starts, then charge what the work actually cost.** A provider publishes per-token rates on-chain,
the buyer escrows the worst case for their own input, and the contract bills what the call consumed
and returns the rest.

## How it works

![Three panels. One: the on-chain rate card plus a 254-token input and a 400-token ceiling sum to a 0.003254 ETH worst case. Two: the buyer escrows that amount and signs a redemption message, and the server checks the funded terms before spending anything. Three: the settler submits two token counts, the contract recomputes 0.002179 ETH and refunds the remaining 0.001075 ETH.](docs/how-it-works.png)

- **The only authoritative price is the contract's, and the buyer can compute it themselves.**
  `quote()` is a public view function. The browser page prices every call against it and refuses to
  escrow when the server's figure disagrees.
- **Escrowing commits to the rate card, not just the total.** A provider can raise the base fee and
  lower the per-token rates so a 254-token quote is unchanged while every short answer costs the
  full ceiling. `openCall` takes the hash of the terms the buyer read and reverts if the card moved.
- **A funded call carries its own copy of those terms.** Reading the live service at settlement
  instead would let a provider strand an in-flight call's escrow by editing the service mid-flight.
- **Refunds and earnings accrue to a balance you withdraw.** At per-call amounts a pushed refund can
  cost more gas than it returns. `withdrawTo()` names the recipient, so a balance owed to an account
  with a non-payable fallback is not stranded.

### Architecture

![Four layers. The buyer holds their own key and runs either a browser or a terminal walkthrough. The metering server holds a separate settler key and exposes four endpoints across four numbered components. Below sit the Anthropic API and Tollgate.sol, which owns the services, calls and balances mappings.](docs/architecture.png)

| # | Component | Module | What it does |
|---|---|---|---|
| **1** | Browser walkthrough | `packages/web/src/main.ts` | Six steps, no framework. Prices each call against the contract before escrowing |
| **2** | Terminal walkthrough | `packages/demo/src/index.ts` | The same six steps without a browser |
| **3** | HTTP surface | `packages/server/src/app.ts` | `/quote` and `/run`, and every check that runs before a token is spent |
| **4** | Catalog | `packages/server/src/catalog.ts` | Prompts, models, input limits. Deliberately holds no prices and no ceiling |
| **5** | Model client | `packages/server/src/ai.ts` | Counts, then calls — both built from one request shape so they cannot drift |
| **6** | Chain client | `packages/server/src/chain.ts` | Holds the settler key. Serializes settlement, and reconciles against the chain before retrying |
| **7** | Contract | `packages/contracts/contracts/Tollgate.sol` | Rate cards, escrow, settlement, withdrawals. The only authoritative price |

Start with `Tollgate.sol`.

## The settler never names a price

`settleCall(callId, inputTokens, outputTokens)` takes two integers and no amount. The contract
recomputes the cost from the rate card frozen into the call and credits the difference back.
Neither count may exceed what the quote was priced for, and the total may not exceed the escrow —
which is the quote itself, not whatever the buyer sent, so overfunding is credited straight back.
A server that wants to overcharge has to lie about token counts, and those bounds are what the lie
is worth.

The buyer's key stays in the page and never reaches the server. The escrow transaction and the
redemption signature are the two things that have to come from a buyer.

**What it costs.** Nothing on a chain can verify that a model emitted 185 tokens. Usage is
self-reported, and this design bounds that rather than fixing it: a dishonest settler can inflate
usage up to the escrow and not one wei past it, and a buyer can recompute the bill from public
numbers. Closing the gap needs an oracle, an enclave, or a proof of inference.

Three properties of the Anthropic API carry the design, so each is asserted rather than assumed
(`RUN_LIVE_TESTS=1 pnpm test`):

| Property | The vendor's wording | Why it matters here |
|---|---|---|
| [`max_tokens`](https://platform.claude.com/docs/en/api/messages) | "the absolute maximum number of tokens to generate" | Without a hard ceiling the worst case is a guess, and there is nothing to escrow |
| [`count_tokens`](https://platform.claude.com/docs/en/build-with-claude/token-counting) | "The token count is an estimate" — and it may include system-added tokens you "are not billed for" | The quote can exceed the eventual bill, so settlement charges `min(observed, quoted)` and the provider absorbs its own estimate |
| [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) | reasoning tokens "count toward `max_tokens` alongside the response text" | With thinking on, a buyer can pay for a full budget and receive a truncated answer, so the catalog disables it |

**[x402](https://www.x402.org/) already does this shape.** Its `upto` scheme authorizes a transfer
"of up to a **maximum amount**" where "the actual amount charged is determined at settlement time
based on resource consumption during the request", and the first use case its spec lists is paying
for LLM token generation. If you want per-request machine payments over HTTP today, use x402. The
narrow thing Tollgate does differently is publish the *formula* rather than only the cap: under
`upto` the resource server "MUST set the `amount` field ... to the desired settlement amount", where
here the unit prices are on-chain and the bill is arithmetic the buyer can repeat. x402 also
specifies batch settlement to amortize gas, which this does not.

`SPEC.md` has the rest: the flow, the trust model, and the decisions considered and dropped.

## Commands

| Command | What it does |
|---|---|
| `./scripts/walkthrough.sh` | The whole thing: chain, deploy, server, browser page |
| `./scripts/smoke.sh` | The same round trip with no browser, asserted. What CI runs |
| `pnpm chain` | A local chain with 20 funded accounts |
| `pnpm deploy:local` | Deploy and list the catalog; writes `deployment.json` |
| `USE_FAKE_MODEL=true pnpm serve` | The metering server. Drop the prefix once `ANTHROPIC_API_KEY` is set |
| `pnpm demo <service>` | One call end to end in the terminal |
| `pnpm web` | Build the browser walkthrough |

`pnpm serve` reads `deployment.json` and the local development key on its own, so nothing has to be
copied between terminals. The model is the one setting with no safe default, which is why the prefix
is there and why `walkthrough.sh` sets it for you. Copy [`.env.example`](.env.example) to `.env` for
the rest, and point `RPC_URL` and `SETTLER_PRIVATE_KEY` at any EVM chain. The server binds loopback,
since `/quote` is unauthenticated and the process holds your key.

## Tests

```bash
pnpm test                   # 48 contract + 39 server + 14 web, all offline
RUN_LIVE_TESTS=1 pnpm test  # adds 4 that call the real API
./scripts/smoke.sh          # the whole stack against a real chain
```

The offline suite runs the entire payment lifecycle against a fake chain and a fake model, down to
concurrent redemptions of one call id, an overfunded call, a rate card swapped for one that prices
the same input identically, and settlement after a mid-flight rate change. The four live tests
assert what the pricing model rests on: a count taken before a call matches what the call reports,
and `max_tokens` is a ceiling rather than a hint.

## Limitations

- **The ceiling that makes the quote safe is the ceiling that truncates the answer.** A provider
  tuning it down to reduce escrow is tuning up the odds of a cut-off response the buyer still pays
  full price for. The three in `packages/contracts/scripts/deploy.ts` — 400, 1200 and 2000 tokens —
  were chosen to make different refund shapes visible, not measured against real traffic.
- **A call can be charged for and the output still lost.** The result is held in process memory
  until settlement lands. If the process dies in that window, or the HTTP response never arrives,
  the buyer has paid on-chain with nothing to re-fetch — the call id is spent.
- **Thinking has to be off, which is not what Anthropic recommends.** Reasoning tokens share the
  `max_tokens` budget, so the escrow only buys a whole answer when thinking is disabled. The
  vendor's [primary mitigation](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
  is "to keep thinking enabled and control token cost with lower effort levels instead" — no help
  here, because effort is a behavioral signal and the ceiling has to be a bound. That means Claude
  Opus 5 at `high` effort or below (`xhigh` and `max` return a 400), and rules out Claude Fable 5.
- **It costs more than a flat price.** A flat fee needs no settlement transaction, no refund path
  and no second signature, and it is the right answer whenever calls are uniform in size. Here the
  buyer's capital sits in escrow they were never going to spend, and one purchase becomes an escrow,
  a settlement and a withdrawal on each side.

`SPEC.md` has the full list: **the trust model** covers what a compromised settler can and cannot
do, the reclaim after a timeout, and the redemption signature not binding the chain id; **decisions
worth recording** covers the in-memory quote store, the capped and unauthenticated `/quote`, and the
expiry headroom, which narrows the settle-versus-reclaim race rather than closing it.

Five things are in neither. **The contract has not been audited.** The browser walkthrough holds a
published development key. The page's price check verifies the price *given* an input count the
server supplied, not the count itself. Provider and settler being separate accounts is a deployment
choice. And prices are in the chain's native token, with no oracle.

## License

MIT — see [LICENSE](LICENSE).
