# Tollgate — specification

Tollgate is a local reference implementation for buying one AI service call with a maximum charge
agreed before generation and an actual charge settled afterward.

A provider publishes a rate card on an EVM contract. The server counts the input, and the buyer reads
the contract's worst-case quote for that count, commits to the rate card, and escrows the quoted
amount. After the model call, a settler reports input and output token counts. The contract calculates
the final charge from the terms frozen at funding and credits the unused escrow back to the buyer.

The contract is authoritative for the pricing formula and movement of funds. The server remains
authoritative for off-chain usage. Nothing on-chain verifies a model's token counts.

---

## 1. Scope

The implementation includes:

- an EVM contract for service registration, quotes, escrow, settlement, refunds, and withdrawals;
- an HTTP server that counts input tokens, runs a model, checks funded calls, and submits usage;
- a static catalog of 3 working AI services;
- browser and terminal clients that independently verify prices and fund calls; and
- a deterministic fake model and local Hardhat deployment for offline use.

It doesn't include a general service-discovery protocol, provider onboarding UI, authenticated quote
API, durable output store, stablecoin pricing, fiat oracle, proof of inference, or production key
management. Although anyone can register a service in the contract, the server exposes only services
present in its local catalog.

---

## 2. Actors and authority

| Actor | Holds | Can do | Cannot prove or control |
|---|---|---|---|
| Buyer | Buyer key and native token | Verify quotes, fund calls, sign redemptions, reclaim expired calls, withdraw refunds | Actual model usage |
| Provider | Provider key and service rate card | Register, update, activate, or deactivate a service; withdraw earnings | Settlement counts unless also registered as settler |
| Settler | Hot key on the metering server | Settle or fail calls for which it was registered | Name a price, exceed quoted counts, withdraw provider earnings unless it's also the provider |
| Treasury | Treasury address | Withdraw the platform fee | Change the fee after deployment |
| Model provider | Model execution and usage response | Count and generate | Move escrow or settle the contract |
| Tollgate contract | Services, funded calls, balances, fee | Calculate quotes and charges, enforce bounds, move balances | Verify off-chain token usage |

`provider` and `settler` are separate fields, not a required separation of control. A provider may
register itself as settler. The local deployment uses different accounts so the server's hot key
doesn't hold earnings.

The buyer has no Tollgate account. Funding the call and signing its redemption message prove control
of the buyer key.

---

## 3. On-chain state

### 3.1 Service

Each `Service` stores:

- provider address;
- settler address;
- base fee in wei;
- wei per input token;
- wei per output token;
- maximum output tokens; and
- active status.

Any address may register a new service ID. The registering address becomes its provider. Only that
provider can update the rate card or active status.

### 3.2 Call

Each funded `Call` stores:

- service ID and buyer;
- quoted input tokens and maximum output tokens;
- provider and settler;
- base fee and both token rates;
- escrowed amount;
- expiry timestamp; and
- whether the call has reached a terminal state.

The provider, settler, rates, and ceiling are copied from the service when the call is funded. Updating
or deactivating a service afterward doesn't change existing calls.

### 3.3 Balances

Provider earnings, buyer refunds, overfunding credits, and the platform fee accrue in one
`balances(address)` mapping. Transfers are pull-based:

- `withdraw()` sends the caller's full balance to the caller;
- `withdrawTo(recipient)` sends it to another address; and
- the balance is set to 0 before the external call.

`withdrawTo()` lets a contract account whose fallback rejects native transfers direct its balance to
an address that can receive it.

---

## 4. Pricing and commitments

For service `s` and quoted input count `i`, the maximum charge is:

```text
quote(s, i) = baseFee
            + i × perInputToken
            + maxOutputTokens × perOutputToken
```

`quote()` is a public view function. The server uses it, and both clients call it independently before
funding.

### 4.1 Rate-card commitment

A total doesn't identify the formula that produced it. Two rate cards can quote the same maximum for
one input and charge different amounts for a short answer.

`termsHash(serviceId)` covers:

- service ID;
- provider and settler;
- base fee;
- input and output rates; and
- output ceiling.

The buyer passes that hash to `openCall()`. Funding reverts if the live service terms no longer match.
The active flag isn't included: `openCall()` checks it directly, and toggling availability shouldn't
change the billing agreement.

The hash commits billing terms, not the service implementation. Model ID, system prompt, input limit,
and input contents remain in the server's catalog or pending quote. The buyer trusts the server to run
the advertised model and prompt on the input it submitted.

### 4.2 Escrow

`openCall(callId, serviceId, inputTokens, expectedTerms)` requires:

- an existing active service;
- an unused call ID;
- a matching terms hash;
- at least the contract quote in `msg.value`; and
- a quote that fits the call's `uint128` escrow field.

The recorded escrow is the quote, not `msg.value`. Any surplus is immediately credited to the buyer's
withdrawable balance and doesn't increase the settlement ceiling.

Each call expires 1 hour after funding.

---

## 5. Quote, run, and settlement flow

### 5.1 Quote

`POST /quote` accepts:

```json
{ "service": "summarize", "input": "..." }
```

The server:

1. validates the service against the local catalog and on-chain registration;
2. rejects inactive services;
3. prunes expired quotes and checks quote-store capacity;
4. counts the input with the same request shape generation will use;
5. rejects input above the catalog limit;
6. asks the contract for the maximum charge;
7. creates a random 32-byte call ID; and
8. stores the input, count, complete rate card, quote, ceiling, and issue time in memory.

An unredeemed quote expires after 15 minutes. At most 1000 pending quotes are stored. The JSON body
limit is 1 MB. Capacity is checked before token counting because `/quote` is unauthenticated and token
counting is rate-limited.

### 5.2 Fund

The browser and terminal clients independently call `quote()` and `termsHash()`. They submit
`openCall()` directly to the chain and escrow the contract's figure.

The buyer then signs this message:

```text
Tollgate: redeem call
call: <callId>
contract: <checksummed contract address>
```

The signature binds the call ID and contract address. It doesn't include the chain ID, so the message
isn't domain-separated between chains that happen to share a deployment address.

### 5.3 Redeem

`POST /run` accepts the call ID and redemption signature. Before model work, the server checks:

- the quote exists, hasn't expired, and isn't already in flight;
- the call exists on-chain and isn't terminal;
- service ID, quoted input count, escrow, and every frozen rate-card term match the issued quote;
- the funded call names this server's settler address;
- the signature recovers the on-chain buyer; and
- more than 5 minutes remain before the call expires.

The in-flight claim is recorded synchronously before the first `await`. Concurrent requests for one
call ID can't both reach the model. The pending quote is deleted immediately before generation, so
the call ID remains single-use even when generation fails.

### 5.4 Generate

The model request uses:

- model and system prompt from the catalog;
- the buyer's input;
- `thinking: { type: "disabled" }`; and
- `max_tokens` read from the funded call's frozen output ceiling.

The real client has a 120-second timeout and sets SDK retries to 0. A single purchase therefore starts
at most one model generation through this process.

The fake client derives repeatable approximate counts from string length and returns output at or below the
ceiling. It reproduces the payment flow, not the vendor's tokenization or model quality.

### 5.5 Settle

The server bills:

```text
billed input  = min(observed input, quoted input)
billed output = min(observed output, funded output ceiling)
```

It calls `settleCall(callId, billedInput, billedOutput)`. The contract independently enforces each
count and calculates:

```text
cost = frozen base fee
     + billed input × frozen input rate
     + billed output × frozen output rate
```

The platform fee is `cost × feeBps / 10,000`, rounded down. The provider receives the rest. Any
escrow above `cost` is credited to the buyer.

The settler reports counts, never an amount. The contract can't verify that the counts describe the
real model call; it can only keep them inside the terms the buyer funded.

---

## 6. Failure and recovery behavior

### Model failure or refusal

If generation throws or returns a model refusal, the server calls `failCall()`. A successful failure
transaction marks the call terminal and credits the entire escrow to the buyer. If that transaction
doesn't land, the call remains open and the buyer can reclaim it after expiry.

The server doesn't enable refusal fallback. A fallback would start another generation on a model
different from the one advertised in the catalog; this implementation refunds instead.

### Settlement transaction failure

The chain client serializes state-changing transactions from the settler key. This prevents concurrent
nonce allocation and makes nonce reset safe.

Settlement and failure transactions are attempted up to 3 times. After any error, the client reads
the call from the chain before retrying. If the call is already terminal, it treats the transaction as
successful rather than submitting a duplicate.

These retries apply only to chain transactions. The model request itself isn't retried.

### Expiry

The buyer may call `reclaimCall()` after the 1-hour timeout. The contract doesn't prohibit settlement
after expiry, so settlement and reclaim become first-transaction-wins. The server's 5-minute headroom
reduces this race but doesn't remove it.

### Output delivery

The generated text isn't stored durably. The server waits for settlement before returning it. A crash
or lost HTTP response after settlement can leave the buyer charged without a way to fetch the output.
A settlement that ultimately fails leaves the provider with the model cost and the buyer with an open
escrow that can later be reclaimed.

---

## 7. Metering assumptions

### Input count

Anthropic documents [`count_tokens`](https://platform.claude.com/docs/en/build-with-claude/token-counting)
as an estimate. It can include system-added tokens that aren't billed. Tollgate therefore uses the
pre-call count as the buyer's maximum billable input and charges the lower of observed and quoted
input.

The browser and terminal clients don't reproduce the model's tokenization. They verify the contract's
price for the input count returned by the server. The formula is independently checkable; the input
measurement is still trusted.

Counting and generation both use `buildRequest()` in `ai.ts`, so model, system prompt, messages, and
thinking configuration can't drift between them accidentally.

### Output ceiling

The [Messages API](https://platform.claude.com/docs/en/api/messages/create) defines `max_tokens` as an
absolute maximum, though generation may stop sooner. The contract stores the same number used in the
request.

`max_tokens` limits total model output, including thinking tokens when thinking is enabled. Tollgate
disables thinking so the purchased output budget applies to visible response tokens. On Claude Opus
5, disabling thinking is supported only at `high` effort or below and can expose internal tags in
visible output; the catalog includes the documented output-hygiene instruction.

This is a metering tradeoff. It makes the ceiling legible and can reduce model quality. Models that
don't allow thinking to be disabled can't provide Tollgate's stronger claim that the ceiling buys a
visible-output budget, although the cost ceiling still holds.

### Usage report

The server's observed usage is trusted. A dishonest settler can report any input and output counts
within the frozen per-count limits and charge up to the escrow. Preventing that requires an oracle,
trusted execution, or a verifiable inference system outside this implementation.

---

## 8. Interfaces and components

### HTTP endpoints

| Endpoint | Purpose | Authentication |
|---|---|---|
| `GET /health` | Process status, settler address, and contract address | None |
| `GET /services` | Local catalog joined with on-chain rate cards | None |
| `POST /quote` | Count input and issue a pending quote | None |
| `POST /run` | Verify the buyer, run one funded call, and settle it | Buyer signature |

The server binds `127.0.0.1:4000` by default. Setting `HOST` exposes it deliberately.

### Repository layout

| Path | Responsibility |
|---|---|
| `packages/contracts` | `Tollgate.sol`, deployment, service registration, contract tests |
| `packages/server` | Catalog, quote/run HTTP surface, Anthropic client, EVM client |
| `packages/web` | Browser walkthrough and presentation arithmetic |
| `packages/demo` | Terminal walkthrough |
| `scripts/walkthrough.sh` | Starts the interactive local stack |
| `scripts/smoke.sh` | Runs the asserted end-to-end stack used by CI |

### Local deployment defaults

| Setting | Default |
|---|---|
| Chain | Hardhat at `http://127.0.0.1:8545` |
| Server | `http://127.0.0.1:4000` |
| Contract call timeout | 1 hour |
| Pending quote TTL | 15 minutes |
| Settlement headroom | 5 minutes |
| Pending quote cap | 1000 |
| Platform fee | 2.5% |
| Model mode | Fake in the walkthrough and smoke scripts |
| Live model | `claude-opus-5` for all 3 catalog services |

`pnpm deploy:local` writes `deployment.json`. The server and clients search upward for it. `.env` is
loaded from the repository root on Node 20.12+; already-exported variables take precedence.

---

## 9. Verified properties and boundaries

The offline suites contain 48 contract tests, 39 server tests, and 14 web tests. They verify:

- public quoting and exact rate-card commitment;
- underfunding, overfunding, and per-count settlement bounds;
- frozen funded terms across service changes;
- fee, earnings, refund, reclaim, and withdrawal accounting;
- buyer-bound redemption signatures;
- quote TTL, capacity, and input limits;
- concurrent single-use redemption;
- model-error and refusal refunds;
- settlement figures based on funded rather than live terms; and
- display arithmetic that accounts for the entire escrow.

Four opt-in live tests check the current model integration: pre-call counting, agreement between the
count and reported input on the catalog payload, output-ceiling enforcement, and usable text.

`scripts/smoke.sh` builds the browser client, deploys to a real local node, runs a terminal call,
withdraws the refund, and drives the browser client's own modules through the same transaction.

Not verified by the unit suites:

- failure modes in the real EVM chain client's retry and reconciliation paths;
- correctness of self-reported model usage;
- output durability after settlement;
- the settle-versus-reclaim race under delayed transactions; or
- production safety of the contract, server, keys, or deployment.

Run the offline verification with:

```bash
pnpm test
pnpm lint
./scripts/smoke.sh
```
