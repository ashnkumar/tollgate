# Tollgate

Auth-and-capture for AI API calls, settled on-chain.

[![ci](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml/badge.svg)](https://github.com/ashnkumar/tollgate/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-20+-blue)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![A terminal run of one call: the price is computed and confirmed against the contract before anything runs, 0.003254 ETH is escrowed, the call produces 181 of its 400 allowed output tokens, and 0.001095 ETH comes back.](docs/demo.gif)

One real call against the Anthropic API. The buyer confirms a 0.003254 ETH maximum before the model
runs. The call uses 181 of its 400 allowed output tokens, settles at 0.002159 ETH, and credits the
remaining 0.001095 ETH back to the buyer. The output length and refund change from run to run; the
maximum charge is fixed before generation.

*See the **[technical post](https://example.com/tollgate-technical-post)** for more details.*

## Quickstart

```bash
git clone https://github.com/ashnkumar/tollgate && cd tollgate
pnpm install
./scripts/walkthrough.sh
```

Needs Node 20+ and [pnpm](https://pnpm.io/). The script builds the packages, starts a local Hardhat
chain, deploys the contract and its 3 demo services, starts the server, and opens the browser
walkthrough. It uses a deterministic fake model and published local development keys, so no API key,
wallet extension, faucet, or account setup is required; Ctrl-C stops the processes it started.

To use the Anthropic API instead:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
USE_FAKE_MODEL=false ./scripts/walkthrough.sh
```

## What this implements

A model call has a variable final token cost because its output length isn't known until generation
ends. Tollgate applies the auth-and-capture pattern used in card payments: fix the buyer's maximum
charge first, then settle the actual charge afterward.

A provider publishes a rate card with a base fee, input-token rate, output-token rate, and hard output
ceiling. The buyer's input is counted before the call. The contract calculates the worst case:

```text
maximum charge = base fee
               + quoted input tokens × input rate
               + output ceiling × output rate
```

The buyer escrows that amount and commits to the rate card that produced it. After generation, the
settler submits the input and output token counts. The contract recomputes the price from the frozen
terms, credits provider earnings and the platform fee, and makes the unused escrow withdrawable by the
buyer.

This repo is a local reference implementation. It uses native-token payments on an EVM chain and can
call the Anthropic API. The contract bounds the server's usage claim but can't verify it. A trustless
version would need an oracle, trusted execution, or a verifiable inference proof.

The output ceiling is also the model's stopping point. Setting it too low reduces escrow but can
truncate an answer that the buyer still pays full price for.

## How one call works

![Three panels. One: the on-chain rate card plus a 254-token input and a 400-token ceiling sum to a 0.003254 ETH maximum. Two: the buyer escrows that amount and signs a redemption message, and the server checks the funded terms before spending anything. Three: the settler submits two token counts, the contract recomputes 0.002179 ETH and credits the remaining 0.001075 ETH back to the buyer.](docs/how-it-works.png)

1. **Quote.** `/quote` counts the input, reads the service ceiling from the chain, and calls the
   contract's public `quote()` function. The browser independently calls the same function and stops
   if the figures disagree.
2. **Commit.** The buyer reads `termsHash()`, escrows the quoted amount through `openCall()`, and signs
   a redemption message containing the call ID and contract address.
3. **Verify.** Before generation, the server checks the funded service, input count, complete frozen
   rate card, settler address, buyer signature, escrow, and remaining settlement time.
4. **Run and settle.** The model receives the ceiling stored with the funded call. The settler submits
   token counts—not a price—and the contract calculates the charge.
5. **Withdraw.** Provider earnings, the platform fee, buyer refunds, and overfunding credits accrue in
   `balances`. Each account pulls its balance with `withdraw()` or sends it to another recipient with
   `withdrawTo()`.

The buyer's key remains in the browser or terminal client. The server holds the settler key, which can
report usage but can't withdraw the provider's earnings unless the provider deliberately uses the
same account for both roles.

### Architecture

![Four layers. The buyer holds their own key and runs either a browser or terminal walkthrough. The metering server holds the settler key and exposes the catalog, quote, and run APIs. Below sit the Anthropic API and Tollgate.sol, which stores services, funded calls, and withdrawable balances.](docs/architecture.png)

| # | Component | Module | Responsibility |
|---|---|---|---|
| **1** | Browser walkthrough | `packages/web/src/main.ts` | Prices against the contract, funds the call, signs, runs, and withdraws |
| **2** | Terminal walkthrough | `packages/demo/src/index.ts` | Runs the same 6-step transaction without a browser |
| **3** | HTTP surface | `packages/server/src/app.ts` | Catalog, quotes, redemption checks, model calls, and settlement |
| **4** | Catalog | `packages/server/src/catalog.ts` | Prompts, models, input limits, and demo inputs; no billing terms |
| **5** | Model client | `packages/server/src/ai.ts` | Builds one request shape for counting and generation |
| **6** | Chain client | `packages/server/src/chain.ts` | Reads contract state and serializes, retries, and reconciles settlement transactions |
| **7** | Contract | `packages/contracts/contracts/Tollgate.sol` | Services, rate cards, escrow, settlement, refunds, and withdrawals |

Start with `packages/contracts/contracts/Tollgate.sol`, then read `packages/server/src/app.ts`.

## What the contract enforces

- **The buyer commits to the formula, not only its result.** `openCall()` receives the hash of every
  billing term. A rate card changed between quote and funding makes the transaction revert, even if
  the new card produces the same maximum for that input.
- **Funded terms don't move.** Each call stores its own provider, settler, rates, input count, and
  output ceiling. Later service changes affect only new calls.
- **The settler never submits an amount.** `settleCall(callId, inputTokens, outputTokens)` recomputes
  cost on-chain. Neither count may exceed the bound used for the quote, and cost may not exceed the
  escrow.
- **Overfunding doesn't raise the ceiling.** The contract records the quote as escrow and immediately
  credits any surplus to the buyer's withdrawable balance.
- **Failed and abandoned calls are refundable.** The settler can mark an upstream failure and return
  the full escrow. The buyer can reclaim an unsettled call after the 1-hour timeout.

## Commands

| Command | What it does |
|---|---|
| `./scripts/walkthrough.sh` | Builds and starts the chain, contract, server, and browser walkthrough |
| `./scripts/smoke.sh` | Runs and asserts the full stack without a browser; this is what CI runs |
| `pnpm chain` | Starts the local Hardhat chain |
| `pnpm deploy:local` | Deploys the contract, registers 3 services, and writes `deployment.json` |
| `USE_FAKE_MODEL=true pnpm serve` | Starts the server without an API key |
| `pnpm demo <service>` | Runs one transaction in the terminal |
| `pnpm web` | Builds the browser client |

The server reads `.env` and `deployment.json` from the repository root. It binds to `127.0.0.1` by
default because `/quote` is unauthenticated and the process may hold an API key and settler key;
`.env.example` documents every override.

## Tests

```bash
pnpm test                   # 48 contract + 39 server + 14 web = 101 offline tests
RUN_LIVE_TESTS=1 pnpm test  # adds 4 tests against the Anthropic API
./scripts/smoke.sh          # full stack against a real local chain
```

The contract suite covers rate-card commitments, escrow, overfunding, settlement bounds, frozen
terms, failure refunds, expiry, and withdrawals. The server suite covers quote validation, buyer
signatures, concurrent redemption, quote expiry and capacity, funded-term checks, model failures, and
single-use call IDs. The smoke test exercises both the terminal and browser clients against a real
Hardhat node.

## Limitations

- **The chain verifies billing, not model execution.** The server supplies the token counts, model,
  prompt, and input sent upstream. The buyer can verify the formula and maximum charge, but still
  trusts the server to perform the advertised work.
- **Quote and output state aren't durable.** Pending quotes and generated text live in one process. A
  crash or lost response after settlement can leave the buyer charged with no way to retrieve the
  output, and multiple server processes would need a shared quote store.
- **This isn't a production deployment.** The contract hasn't been audited, the browser uses a
  published development key, `/quote` has no authentication or rate limit, and native-token prices
  have no fiat oracle. The 5-minute expiry check narrows a settle-versus-reclaim race without removing
  it; the default server remains loopback-only for these reasons.

## License

MIT — see [LICENSE](LICENSE).
