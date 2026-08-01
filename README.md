# Tollgate

A marketplace of AI services billed per call: a provider publishes a price, a buyer
escrows the worst case before the call runs, and settlement charges what was actually
used and refunds the rest.

No subscription, no account, no API key for the buyer.

---

## The idea in one screen

An AI call costs a variable amount — tokens in, tokens out, and you don't know the
output length until it's finished. A buyer wants a price *before* they agree. Tollgate
resolves that by splitting price into two moments:

**Before the call**, input tokens are counted exactly and output is capped, so the worst
case is arithmetic rather than a guess:

```
worst case = baseFee + (inputTokens x inputRate) + (maxOutputTokens x outputRate)
                       ^ counted exactly          ^ enforced as max_tokens
```

**After the call**, the same rate card is applied to what was really used, and the
difference goes back to the buyer.

The buyer's exposure is capped at a number they agreed to. The provider is never paid
less than cost. Neither side has to trust the other's arithmetic, because the price is
computed on-chain from a rate card the provider published.

---

## Quickstart

Requires Node 20+ and pnpm. No chain account, no faucet, no card.

```bash
pnpm install
./scripts/smoke.sh          # chain + deploy + server + one metered call, then cleans up
```

That runs the whole thing against a deterministic fake model, so it needs no API key.
To watch it with a real model:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
USE_FAKE_MODEL=false ./scripts/smoke.sh
```

### Running it interactively

Four terminals, if you want to poke at it:

```bash
pnpm chain                  # 1. local chain, 20 funded accounts, ~12s
pnpm deploy:local           # 2. deploy + list the catalogue (writes deployment.json)
pnpm serve                  # 3. the metering server
pnpm demo summarize         # 4. one call, end to end
```

`pnpm serve` reads `deployment.json` and the local dev key automatically — nothing to
copy between terminals. Set `ANTHROPIC_API_KEY` before step 3 for real calls, or
`USE_FAKE_MODEL=true` for fake ones. Try `pnpm demo explain-code` or `pnpm demo translate`.

---

## What a call looks like

Real output, `pnpm demo explain-code` against the Anthropic API:

```
2. Quote
  input counted    174 tokens (exact, before the call runs)
  output ceiling   1200 tokens (enforced as max_tokens)
  worst case       0.007174 ETH
  chain agrees     0.007174 ETH ✓

3. Escrow
  escrowed 0.007174 ETH in 0x2ecc65dc8ab0c31c...

4. Run
  completed in 16.7s
  [...the model's answer...]

5. Settlement
  output used      1150 of 1200 tokens
  escrowed         0.007174 ETH
  actually paid    0.006924 ETH
  refunded         0.00025 ETH  (3.5% back)
```

That call nearly filled its budget, so little came back. A short one behaves very
differently — the same demo on `translate` with a one-line input refunds 91%. That gap
is the entire argument for settling against usage instead of charging the ceiling.

---

## How it works

```
packages/contracts   Tollgate.sol — rate cards, escrow, settlement, withdrawals
packages/server      /quote, /run — counts tokens, verifies escrow, settles
packages/demo        end-to-end walkthrough
scripts/smoke.sh     full stack against a real chain; what CI runs
```

The contract holds the rate card, so `quote()` is a public view function: a buyer can
recompute the price themselves and never has to trust the server's number. The demo
checks this on every run (the `chain agrees` line above).

A funded call carries its own frozen copy of the terms it was quoted under, so a
provider changing prices, the output ceiling, or the settler cannot disturb a call that
is already in flight. Redeeming a call's output requires a signature from the account
that funded it — the call id travels over HTTP and is not, on its own, authorisation.

At settlement the server reports **token counts, never a price**. Cost is recomputed
on-chain from the published rate card, and settlement reverts if it would exceed the
escrow. So the quote is a hard ceiling enforced by the contract, not a promise.

Refunds and earnings accrue to a withdrawable balance rather than being transferred. For
per-call amounts that matters: a pushed refund can cost more gas than it returns.

Design decisions and their reasoning are in **[SPEC.md](SPEC.md)**.

---

## Configuration

Everything has a working local default; `.env` is only needed to override something. See
[`.env.example`](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required unless `USE_FAKE_MODEL=true` |
| `USE_FAKE_MODEL` | `false` | deterministic fake model; exercises payment without spending |
| `RPC_URL` | `http://127.0.0.1:8545` | any EVM endpoint |
| `TOLLGATE_ADDRESS` | from `deployment.json` | |
| `SETTLER_PRIVATE_KEY` | Hardhat dev key on a local node | required for any other network |
| `PORT` | `4000` | |

Nothing here is specific to a particular chain. It is plain EVM; point `RPC_URL` and
`PRIVATE_KEY` wherever you like.

---

## Tests

```bash
pnpm test                   # 39 contract tests + 27 server tests, all offline
./scripts/smoke.sh          # the whole stack against a real chain
RUN_LIVE_TESTS=1 pnpm test  # adds 4 tests against the real Anthropic API
```

The live tests are worth calling out: they assert the two API properties the pricing
model depends on — that a token count taken before a call matches what the call reports,
and that `max_tokens` is a hard ceiling rather than a hint. The whole design collapses if
either is false, so they are asserted rather than assumed.

---

## Limitations

Stated plainly, because a payment system with unstated assumptions is worse than an
honest one.

- **Usage is self-reported.** Nothing on-chain can verify a token count, so settlement
  takes the server's word for it. The damage is bounded: the settler reports counts and
  never a price, cost is recomputed on-chain, and settlement reverts above the escrow —
  so a dishonest settler can over-report up to the escrow but no further. Closing that
  gap properly needs an oracle, a TEE, or a proof of inference. All out of scope.
- **Quotes are held in process memory**, so `/run` must reach the process that issued the
  `/quote`. Fine for one server; a horizontally scaled deployment needs a shared store —
  and note the single-use guard is per-process too, so scaling out without moving both
  to shared state would reopen the duplicate-execution window.
- **One provider identity in the demo.** The contract supports any number — anyone can
  call `registerService` — but the seed script registers all three services to one
  address for legibility.
- **A settlement that never lands costs the provider.** By the time settlement runs, the
  model call has happened and the provider has been billed for it. Transient failures are
  retried, but if the transaction ultimately does not land the call stays open until the
  buyer reclaims and the provider is out of pocket. A production deployment would persist
  unsettled calls and retry them out of band rather than only within the request.
- **The contract has not been audited.** It is a reference implementation. The tests are
  thorough about the paths they cover; that is not the same thing.
- **`CALL_TIMEOUT` is a fixed hour.** Long enough for any call here, but it is a constant
  rather than a per-service setting.
- **Prices are in the chain's native token**, with no oracle. A production version pricing
  in stable terms would need one.

---

## License

MIT — see [LICENSE](LICENSE).

<!-- TODO: repository URL, and a recorded GIF of the demo, once settled. -->
