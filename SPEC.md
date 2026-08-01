# Tollgate — design notes

What the system does, how the pieces fit, and the decisions that took actual thought.

---

## The problem

An AI call has variable cost. Tokens in, tokens out, and the output length is not known
until the call finishes. A buyer, meanwhile, wants to know the price *before* agreeing
to it. Those two facts are in direct tension, and most of the interesting design work in
a pay-per-call marketplace is in reconciling them.

Three ways out:

| Approach | Buyer certainty | Provider risk | Fails when |
|---|---|---|---|
| Fixed price per call | total | provider eats all variance | inputs vary in size at all |
| Price bands by input size | approximate | provider eats output variance | output is the dominant cost, which it is |
| **Quote a bound, settle actual** | **bounded, exact** | **none** | needs a settlement step |

Tollgate takes the third. It works because of two properties of the Anthropic API, both
verified in `packages/server/test/live-anthropic.test.ts` rather than assumed:

1. **`count_tokens` gives an exact input count before the call**, for free.
2. **`max_tokens` is a hard ceiling, not a hint** — the API stops generation there.

Together those make the worst-case cost of a call *computable in advance*:

```
worst case = baseFee + (inputTokens x inputRate) + (maxOutputTokens x outputRate)
                       ^ exact, counted            ^ exact, enforced
```

That is a bound, not an estimate. The buyer escrows it; the call runs; settlement
charges what was actually used and returns the rest.

---

## Flow

```
  buyer                     server                        chain
    |                          |                            |
    |-- POST /quote ---------->|                            |
    |                          |-- count_tokens ----------->| (Anthropic)
    |                          |-- quote(id, inputTokens) -->|
    |<-- callId, quoteWei -----|                            |
    |                                                       |
    |-- openCall{value: quoteWei} ------------------------->| escrow held
    |                                                       |
    |-- POST /run ------------>|                            |
    |                          |-- read call, check escrow ->|
    |                          |-- messages.create --------->| (Anthropic)
    |                          |-- settleCall(in, out) ----->| charge actual,
    |<-- output, settlement ---|                            |  refund difference
    |                                                       |
    |-- withdraw ------------------------------------------>| refund paid out
```

### Where each number comes from

| Number | Source | Why there |
|---|---|---|
| input tokens | `count_tokens`, before the call | exact and free; an estimate would make the quote a guess |
| output ceiling | on-chain rate card | the contract prices against it, so it must be the same number the API enforces |
| price | `Tollgate.quote()` | if the server did its own arithmetic it could disagree with settlement |
| actual output | `usage.output_tokens` | the only authority on what was really used |

---

## The trust model, stated plainly

Nothing on-chain can verify a token count. Settlement therefore takes the server's word
for usage. That is not hidden — it is bounded:

- **The settler reports token counts, never a price.** Cost is recomputed on-chain from
  the rate card the provider published. A settler cannot invent a number.
- **Settlement reverts if cost exceeds the escrow.** The quote is a hard ceiling on what
  a buyer can be charged, enforced by the contract rather than by good behaviour.
- **`reclaimCall` returns the escrow after a timeout.** A settler that goes offline
  cannot strand a buyer's money.
- **The `settler` address is separate from the `provider` address.** The key that signs
  settlements is not the key that receives earnings, so a compromised server can
  misreport usage but cannot move funds.

What remains is that a dishonest settler can over-report usage up to the escrow. Closing
that gap needs an oracle, a TEE, or a proof of inference — all out of scope here, and all
a much bigger project than this one. Being explicit about the boundary seemed better than
implying a guarantee that isn't there.

---

## What was inherited from the reference, and what wasn't

The reference implementation (a fast build, and it shows) had the right *idea*: a
marketplace of AI services paid for per call, settled on-chain, no subscription and no
account. That idea is intact here. Almost none of the execution is.

**The good idea, kept:** per-call payment, no account, provider earnings accruing on-chain,
a service catalogue, streaming-friendly HTTP surface.

**What had to change:**

| Reference | Problem | Here |
|---|---|---|
| `Service` struct had no price field | a provider could not register a price at all — the marketplace's central claim | rate card on-chain: base fee, per-input-token, per-output-token, output ceiling |
| `makePayment` accepted any `msg.value > 0` | 1 wei bought any service (verified against the original) | `openCall` reverts below the quote; regression test in `Tollgate.test.ts` |
| payment verified by matching a request id only, never the amount | same defect at the HTTP layer | `/run` checks the on-chain escrow against the issued quote before doing billable work |
| `Math.random() > 0.5` faked payment success in dev mode | a coin-flip payment bypass | a fake *model* (`USE_FAKE_MODEL`), never a fake payment |
| `registerService` was `onlyOwner` | no third party could ever list a service | anyone can register; `msg.sender` becomes the provider |
| price = 3-tier step function on input **character** count | ignored output entirely, which is the dominant cost | priced per token, input and output separately |
| price computed, displayed, then never enforced anywhere | advisory pricing | the quote is escrowed and settlement checks against it |
| `deploy.sh` read gitignored `.env.testnet` and prompted for a pasted address | broken from a clean clone | `pnpm deploy:local` writes `deployment.json`; the server reads it |
| three `.env` files across three packages | quickstart tax | one `.env.example`, all values optional locally |
| 8 crypto-themed services, several stubs | padding | 3 services that work |

---

## Decisions worth recording

**A local chain is the default, and no vendor chain is named.** The original targeted a
specific L1 because of where it was built. Nothing in the design needs one — it is plain
EVM. `pnpm chain` gives a funded chain in about twelve seconds with no signup, no faucet
and no card, which is the difference between a repo a stranger runs and one they don't.
`RPC_URL` and `PRIVATE_KEY` point it anywhere else.

**Refunds accrue; they are not pushed.** `settleCall` credits a balance rather than
transferring. For per-call amounts this is not a style preference: a push refund can cost
more in gas than the refund is worth. Pull-withdrawal also keeps `settleCall` free of
external calls, so there is no reentrancy surface on the settlement path. One `balances`
mapping serves provider earnings, buyer refunds, and the platform fee.

**Settlement bills the quoted input count, not the observed one.** They are the same in
practice — the same payload is counted and sent. If they ever diverged upward, billing
the observed figure could exceed the escrow and revert *after* the work was done, leaving
the provider unpaid and the buyer's money locked until timeout. Billing the quoted figure
makes the provider absorb its own estimation error, which is the right way round: the
provider published the rate card.

**The output ceiling lives on-chain only.** It is tempting to keep a copy in the service
catalogue next to the prompt. But that number does two jobs — the contract prices against
it and the API enforces it — and if the two copies drifted, the quote would silently stop
being an upper bound. So there is one copy, on-chain, and the server reads it.

**Thinking is disabled on every service.** This is a metering decision, not a quality one.
`max_tokens` bounds thinking and visible output *together*, so with thinking on a buyer
can pay for a full budget and receive a truncated answer. Disabling it makes the budget
the buyer escrows the budget they get. The documented cost is that internal tags can
occasionally leak into output; the system prompts carry the standard mitigation.

**No `docker compose`.** It was in the original plan and was dropped on contact with
reality. The only genuinely external dependency is the Anthropic API, which a container
does not help with; the chain is a local process. Docker would mainly pin a Node version,
at the cost of requiring a running Docker daemon. `pnpm install` plus a four-line
quickstart is tested from clean; an untested compose file would have been worse than none.

**In-memory quote store.** `/run` must land on the process that issued the `/quote`, so
this does not survive horizontal scaling. It is called out in the code rather than
papered over — the alternative is a Redis dependency that adds a service to the quickstart
in exchange for a property a reference implementation does not need.

---

## Layout

```
packages/contracts   Tollgate.sol, 34 tests, deploy + registration script
packages/server      quote/run/settle HTTP surface, Anthropic client, chain client
packages/demo        end-to-end walkthrough, prints what a call cost
scripts/smoke.sh     full stack against a real chain; what CI runs
```

## Testing

| Suite | Covers | Needs |
|---|---|---|
| `packages/contracts` (34) | escrow, settlement arithmetic, fee split, refunds, expiry, withdrawal, access control | nothing |
| `packages/server` (18) | quoting, escrow verification, single-use call ids, failure refunds, input clamping | nothing |
| `live-anthropic.test.ts` (4) | count-before matches count-after; `max_tokens` is enforced | `RUN_LIVE_TESTS=1` + key |
| `scripts/smoke.sh` | the whole stack against a real chain | nothing |

The default suite is offline and free. The two live tests exist because the entire
pricing model rests on those two API properties, and asserting them beats assuming them.
